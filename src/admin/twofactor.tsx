import { Hono, type Context } from 'hono';
import type { HtmlEscapedString } from 'hono/utils/html';
import { raw } from 'hono/html';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { renderSVG } from 'uqr';
import { adminUsers } from '../db/schema';
import {
  clearedCookie,
  destroySessionById,
  promoteToFull,
  recordFailedCode,
  sessionCookie,
} from './auth';
import { audit, type Ctx } from './context';
import { AuthCard, Icon } from './layout';
import { MissingKeyError, loadKey, open, seal } from './secretbox';
import {
  formatSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp';

/**
 * Two-step sign-in. Mandatory for every account.
 *
 * The middleware only lets a partial session reach these pages: an
 * 'enrolling' session can reach /setup, a 'pending' one can reach the code
 * page. Neither can touch anything else in the dashboard.
 */
export const twoFactor = new Hono<Ctx>();

/** Wrong codes allowed per sign-in before the session is thrown away. */
export const MAX_CODE_ATTEMPTS = 5;

const meta = (c: Context<Ctx>) => ({ ip: c.req.header('cf-connecting-ip'), userAgent: c.req.header('user-agent') });

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

twoFactor.get('/setup', async (c) => {
  const key = await keyOrExplain(c);
  if (key instanceof Response) return key;

  const db = c.get('db');
  const user = c.get('user');
  const [row] = await db
    .select({ pending: adminUsers.totpPendingSecret })
    .from(adminUsers)
    .where(eq(adminUsers.id, user.id))
    .limit(1);

  // Reuse the secret if setup was already started, so a reload shows the
  // same QR code instead of silently invalidating the one already scanned.
  let secret: string;
  if (row?.pending) {
    secret = await open(row.pending, key, user.id);
  } else {
    secret = generateSecret();
    await db
      .update(adminUsers)
      .set({ totpPendingSecret: await seal(secret, key, user.id) })
      .where(eq(adminUsers.id, user.id));
  }
  return c.html(<SetupPage email={user.email} secret={secret} />);
});

twoFactor.post('/setup', async (c) => {
  const key = await keyOrExplain(c);
  if (key instanceof Response) return key;

  const db = c.get('db');
  const user = c.get('user');
  const code = String((await c.req.formData()).get('code') ?? '');

  const [row] = await db
    .select({ pending: adminUsers.totpPendingSecret })
    .from(adminUsers)
    .where(eq(adminUsers.id, user.id))
    .limit(1);
  if (!row?.pending) return c.redirect('/admin/2fa/setup');

  const secret = await open(row.pending, key, user.id);
  const result = await verifyTotp(secret, code, null);
  if (!result.ok) {
    return failed(c, (remaining) => (
      <SetupPage email={user.email} secret={secret} error={codeError(result.reason, remaining)} />
    ));
  }

  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map(hashRecoveryCode));

  // The pending value is already sealed and bound to this user, so it
  // becomes the live secret as it is.
  await db
    .update(adminUsers)
    .set({
      totpSecret: row.pending,
      totpPendingSecret: null,
      totpEnabledAt: new Date(),
      totpLastStep: result.step,
      recoveryCodeHashes: hashes,
    })
    .where(eq(adminUsers.id, user.id));

  const { token, expiresAt } = await promoteToFull(db, c.get('session').sessionId, user.id, meta(c));
  await audit(c, 'twofa_enabled', 'admin_users', user.id, null, { recoveryCodes: codes.length });
  await audit(c, 'login', 'admin_users', user.id, null, { method: 'totp', firstTime: true });

  c.header('Set-Cookie', sessionCookie(token, expiresAt));
  // Rendered directly, never via redirect: the codes must not be
  // retrievable again from any URL.
  return c.html(<RecoveryCodesPage codes={codes} email={user.email} />);
});

/* ------------------------------------------------------------------ */
/* Sign-in challenge                                                   */
/* ------------------------------------------------------------------ */

twoFactor.get('/', (c) => c.html(<ChallengePage />));

twoFactor.post('/', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const input = String((await c.req.formData()).get('code') ?? '').trim();

  if (looksLikeRecoveryCode(input)) {
    const hash = await hashRecoveryCode(input);
    // Check and consume in one statement, so a code can be used once
    // even if two requests race with it.
    const [used] = await db
      .update(adminUsers)
      .set({ recoveryCodeHashes: sql`array_remove(${adminUsers.recoveryCodeHashes}, ${hash})` })
      .where(and(eq(adminUsers.id, user.id), sql`${hash} = any(${adminUsers.recoveryCodeHashes})`))
      .returning({ remaining: sql<number>`cardinality(${adminUsers.recoveryCodeHashes})` });

    if (!used) return failed(c, (remaining) => <ChallengePage error={codeError('recovery', remaining)} />);

    const { token, expiresAt } = await promoteToFull(db, c.get('session').sessionId, user.id, meta(c));
    await audit(c, 'recovery_code_used', 'admin_users', user.id, null, { remaining: used.remaining });
    await audit(c, 'login', 'admin_users', user.id, null, { method: 'recovery_code' });
    c.header('Set-Cookie', sessionCookie(token, expiresAt));
    return c.redirect(`/admin?recovery=${used.remaining}`);
  }

  const key = await keyOrExplain(c);
  if (key instanceof Response) return key;

  const [row] = await db
    .select({ secret: adminUsers.totpSecret, lastStep: adminUsers.totpLastStep })
    .from(adminUsers)
    .where(eq(adminUsers.id, user.id))
    .limit(1);
  if (!row?.secret) return c.redirect('/admin/2fa/setup');

  const result = await verifyTotp(await open(row.secret, key, user.id), input, row.lastStep);
  if (!result.ok) return failed(c, (remaining) => <ChallengePage error={codeError(result.reason, remaining)} />);

  // Record the step only if it is newer than the last one. If a second
  // request with the same code got here first, this updates nothing and
  // the code is treated as the replay it is.
  const [claimed] = await db
    .update(adminUsers)
    .set({ totpLastStep: result.step })
    .where(
      and(
        eq(adminUsers.id, user.id),
        or(isNull(adminUsers.totpLastStep), lt(adminUsers.totpLastStep, result.step)),
      ),
    )
    .returning({ id: adminUsers.id });
  if (!claimed) return failed(c, (remaining) => <ChallengePage error={codeError('replay', remaining)} />);

  const { token, expiresAt } = await promoteToFull(db, c.get('session').sessionId, user.id, meta(c));
  await audit(c, 'login', 'admin_users', user.id, null, { method: 'totp' });
  c.header('Set-Cookie', sessionCookie(token, expiresAt));
  return c.redirect('/admin');
});

/* ------------------------------------------------------------------ */

/**
 * A wrong code. Counted against this sign-in; at the limit the partial
 * session is destroyed and the password must be entered again. A 6-digit
 * code has a million values, and without a cap it is guessable.
 */
async function failed(c: Context<Ctx>, page: (remaining: number) => HtmlEscapedString | Promise<HtmlEscapedString>) {
  const db = c.get('db');
  const session = c.get('session');
  const n = await recordFailedCode(db, session.sessionId);
  await audit(c, 'twofa_failed', 'admin_users', c.get('user').id, null, { attempt: n });

  if (n >= MAX_CODE_ATTEMPTS) {
    await destroySessionById(db, session.sessionId);
    await audit(c, 'twofa_locked', 'admin_users', c.get('user').id, null, { attempts: n });
    c.header('Set-Cookie', clearedCookie());
    return c.redirect('/admin/login?locked=1');
  }
  return c.html(page(MAX_CODE_ATTEMPTS - n), 422);
}

function codeError(reason: 'format' | 'mismatch' | 'replay' | 'recovery', remaining: number): string {
  const left = remaining === 1 ? '1 attempt left' : `${remaining} attempts left`;
  switch (reason) {
    case 'format':
      return `Enter the 6-digit code from your app. ${left}.`;
    case 'replay':
      return `That code has already been used. Wait for the next one to appear. ${left}.`;
    case 'recovery':
      return `That recovery code is not valid, or has already been used. ${left}.`;
    default:
      return `That code is not correct. Check the time on your phone is set automatically. ${left}.`;
  }
}

/**
 * The encryption key is a deploy-time secret. If it is missing, say so
 * plainly on the page instead of failing with a generic error halfway
 * through someone's sign-in.
 */
async function keyOrExplain(c: Context<Ctx>): Promise<CryptoKey | Response> {
  try {
    return await loadKey(c.env.TOTP_ENCRYPTION_KEY);
  } catch (err) {
    if (!(err instanceof MissingKeyError)) throw err;
    console.error('2fa: ' + err.message);
    return c.html(
      <AuthCard title="Two-step sign-in unavailable">
        <h1 class="auth-title">Two-step sign-in is not configured</h1>
        <p class="auth-lede">
          The server is missing its encryption key, so codes cannot be set up or checked. Nobody can sign in until it
          is added. This is a deployment problem, not a problem with your account.
        </p>
        <p class="auth-lede">
          For the administrator: set the <code>TOTP_ENCRYPTION_KEY</code> secret and redeploy.
        </p>
      </AuthCard>,
      503,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

const SignOut = () => (
  <form method="post" action="/admin/logout" class="no-print" style="margin:16px 0 0">
    <button class="btn ghost sm" type="submit" data-busy-label="Signing out..." style="padding-left:0">
      <Icon name="exit" size={14} /> Sign out and start again
    </button>
  </form>
);

const Err = ({ error }: { error?: string | undefined }) =>
  error ? (
    <div class="flash bad" role="alert">
      <Icon name="alert" /> {error}
    </div>
  ) : null;

const SetupPage = ({ email, secret, error }: { email: string; secret: string; error?: string }) => (
  <AuthCard title="Set up two-step sign-in" wide step="Step 2 of 2">
    <h1 class="auth-title">Set up two-step sign-in</h1>
    <p class="auth-lede">
      Every account must use an authenticator app. With it, a stolen password is not enough to open your account —
      your phone is needed too.
    </p>
    <Err error={error} />
    <ol class="steps-list">
      <li>
        <strong>Install an authenticator app</strong> on your phone. Google Authenticator and Microsoft Authenticator
        are free on Android and iPhone.
      </li>
      <li>
        <strong>Scan this code</strong> with the app.
        <span class="qr" role="img" aria-label="QR code for setting up your authenticator app">
          {raw(renderSVG(otpauthUri(secret, email), { border: 1 }))}
        </span>
        <span class="t-dim" style="display:block;margin-bottom:6px">Cannot scan it? Enter this key in the app instead:</span>
        <span class="secret" data-secret>
          {formatSecret(secret)}
        </span>
      </li>
      <li>
        <strong>Enter the 6-digit code</strong> the app now shows for MyImoGuide.
        <form method="post" action="/admin/2fa/setup" style="margin-top:10px">
          <div class="field">
            <label for="code">Code</label>
            <input
              id="code"
              name="code"
              type="text"
              class="code-input"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxlength={7}
              required
              autofocus
            />
          </div>
          <button class="btn primary" type="submit" data-busy-label="Checking..." style="width:100%;justify-content:center">
            <Icon name="check" /> Verify and finish
          </button>
        </form>
      </li>
    </ol>
    <SignOut />
  </AuthCard>
);

const ChallengePage = ({ error }: { error?: string }) => (
  <AuthCard title="Enter your code" step="Step 2 of 2">
    <h1 class="auth-title">Enter your code</h1>
    <p class="auth-lede">Open your authenticator app and enter the 6-digit code for MyImoGuide.</p>
    <Err error={error} />
    <form method="post" action="/admin/2fa">
      <div class="field">
        <label for="code">Code</label>
        <input
          id="code"
          name="code"
          type="text"
          class="code-input"
          autocomplete="one-time-code"
          maxlength={20}
          required
          autofocus
          aria-describedby="code-hint"
        />
        <div class="hint" id="code-hint">
          Lost your phone? Enter one of your recovery codes here instead.
        </div>
      </div>
      <button class="btn primary" type="submit" data-busy-label="Checking..." style="width:100%;justify-content:center">
        <Icon name="lock" /> Verify
      </button>
    </form>
    <SignOut />
  </AuthCard>
);

const RecoveryCodesPage = ({ codes, email }: { codes: string[]; email: string }) => {
  const file = [
    'MyImoGuide administration — recovery codes',
    `Account: ${email}`,
    `Issued: ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })} WAT`,
    '',
    'Each code signs you in once if you lose your phone.',
    '',
    ...codes,
    '',
  ].join('\n');
  return (
    <AuthCard title="Save your recovery codes" wide>
      <h1 class="auth-title">Save your recovery codes</h1>
      <p class="auth-lede">
        Two-step sign-in is on. If you ever lose your phone, each of these codes will sign you in once.
        <strong> They are shown only now.</strong>
      </p>
      <div class="warn-box">
        Keep them somewhere safe and offline — printed and filed, or in a password manager. Anyone who has these codes
        and your password can sign in as you.
      </div>
      <div class="codes" aria-label="Recovery codes">
        {codes.map((code) => (
          <span>{code}</span>
        ))}
      </div>
      <div class="btn-row" style="margin-bottom:18px">
        <a class="btn" href={`data:text/plain;charset=utf-8,${encodeURIComponent(file)}`} download="myimoguide-recovery-codes.txt">
          Download as a file
        </a>
        <button class="btn" type="button" onclick="window.print()">
          Print
        </button>
      </div>
      <a class="btn primary no-print" href="/admin" style="width:100%;justify-content:center">
        I have saved them — continue
      </a>
    </AuthCard>
  );
};
