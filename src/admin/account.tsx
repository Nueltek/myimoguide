import { Hono, type Context } from 'hono';
import { and, desc, eq, gt } from 'drizzle-orm';
import { adminSessions, adminUsers } from '../db/schema';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, asRole } from './access';
import { destroyUserSessions, hashPassword, passwordProblem, verifyPassword } from './auth';
import { audit, type Ctx } from './context';
import { ErrorSummary, TextField } from './forms';
import { Icon, Shell, formatDate, formatDateTime } from './layout';
import { isThrottled, recordFailedLogin } from './throttle';
import { generateRecoveryCodes, hashRecoveryCode } from './totp';
import { RecoveryCodesPage } from './twofactor';
import type { Errors } from './validate';

/**
 * Your own account, whatever your role: name, password, recovery codes
 * and where you are signed in.
 *
 * Changing the password needs the current one. Wrong guesses count
 * against the same limit as the sign-in page, so a session left open
 * cannot be used to work out the password.
 */
export const account = new Hono<Ctx>();

const LABELS = { fullName: 'Your name', current: 'Current password', password: 'New password', confirm: 'Type the new password again' };

const SAVED: Record<string, string> = {
  name: 'Your name has been updated.',
  password: 'Password changed. You have been signed out everywhere else.',
  codes: 'New recovery codes issued. The old ones no longer work.',
  sessions: 'You have been signed out everywhere else.',
};

account.get('/', (c) => page(c, {}, {}));

account.post('/name', async (c) => {
  const user = c.get('user');
  const fullName = String((await c.req.formData()).get('fullName') ?? '').trim().replace(/\s+/g, ' ');
  if (!fullName || fullName.length > 120) {
    return page(c, { fullName }, { fullName: 'Enter your name, up to 120 characters.' }, 422);
  }
  await c.get('db').update(adminUsers).set({ fullName }).where(eq(adminUsers.id, user.id));
  await audit(c, 'update', 'admin_users', user.id, { fullName: user.fullName }, { fullName });
  return c.redirect('/admin/account?saved=name');
});

account.post('/password', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const form = await c.req.formData();
  const current = String(form.get('current') ?? '');
  const password = String(form.get('password') ?? '');
  const confirmPassword = String(form.get('confirm') ?? '');

  const throttle = await isThrottled(db, user.email, ip);
  if (throttle.blocked) {
    return page(c, {}, { current: `Too many wrong passwords. Wait ${throttle.minutes} minutes and try again.` }, 429);
  }

  const [row] = await db.select({ hash: adminUsers.passwordHash }).from(adminUsers).where(eq(adminUsers.id, user.id)).limit(1);
  if (!row || !(await verifyPassword(current, row.hash))) {
    await recordFailedLogin(db, user.email, ip, 'wrong_current_password');
    return page(c, {}, { current: 'Your current password is not correct.' }, 422);
  }

  const errors: Errors = {};
  const problem = passwordProblem(password, user.email);
  if (problem) errors.password = problem;
  else if (password === current) errors.password = 'Choose a password different from your current one.';
  else if (password !== confirmPassword) errors.confirm = 'The two new passwords do not match.';
  if (Object.keys(errors).length > 0) return page(c, {}, errors, 422);

  await db.update(adminUsers).set({ passwordHash: await hashPassword(password) }).where(eq(adminUsers.id, user.id));
  // If the change is because the old password leaked, a session opened
  // with it must not survive. This one is kept: it just proved both.
  const ended = await destroyUserSessions(db, user.id, c.get('session').sessionId);
  await audit(c, 'password_changed', 'admin_users', user.id, null, { otherSessionsEnded: ended });
  return c.redirect('/admin/account?saved=password');
});

// The middleware asks for a fresh 2FA code before this runs.
account.post('/recovery-codes', async (c) => {
  const user = c.get('user');
  const codes = generateRecoveryCodes();
  await c
    .get('db')
    .update(adminUsers)
    .set({ recoveryCodeHashes: await Promise.all(codes.map(hashRecoveryCode)) })
    .where(eq(adminUsers.id, user.id));
  await audit(c, 'recovery_codes_replaced', 'admin_users', user.id, null, { recoveryCodes: codes.length });
  return c.html(<RecoveryCodesPage codes={codes} email={user.email} replaced />);
});

account.post('/sessions/end-others', async (c) => {
  const user = c.get('user');
  const ended = await destroyUserSessions(c.get('db'), user.id, c.get('session').sessionId);
  await audit(c, 'sessions_ended', 'admin_users', user.id, null, { sessionsEnded: ended, own: true });
  return c.redirect('/admin/account?saved=sessions');
});

/* ------------------------------------------------------------------ */

async function page(c: Context<Ctx>, values: { fullName?: string }, errors: Errors, status: 200 | 422 | 429 = 200) {
  const db = c.get('db');
  const me = c.get('user');
  const [person] = await db.select().from(adminUsers).where(eq(adminUsers.id, me.id)).limit(1);
  const sessions = await db
    .select()
    .from(adminSessions)
    .where(and(eq(adminSessions.userId, me.id), eq(adminSessions.stage, 'full'), gt(adminSessions.expiresAt, new Date())))
    .orderBy(desc(adminSessions.createdAt));

  const role = asRole(me.role);
  const codesLeft = person?.recoveryCodeHashes.length ?? 0;
  const saved = SAVED[c.req.query('saved') ?? ''];
  const current = c.get('session').sessionId;

  return c.html(
    <Shell title="Your account" path="/admin/account" user={me}>
      {saved ? (
        <div class="flash ok" role="status">
          <Icon name="check" /> {saved}
        </div>
      ) : null}
      <ErrorSummary errors={errors} labels={LABELS} />

      <div class="panel" style="margin-bottom:20px">
        <div class="panel-h">
          <h2>Profile</h2>
        </div>
        <div class="form-body" style="padding:16px">
          <dl class="kv" style="margin-bottom:16px">
            <dt>Email</dt>
            <dd>{me.email}</dd>
            <dt>Role</dt>
            <dd>
              {role ? ROLE_LABELS[role] : 'No role'}{' '}
              <span class="t-dim">{role ? `· ${ROLE_DESCRIPTIONS[role]}` : ''}</span>
            </dd>
            <dt>Two-step sign-in</dt>
            <dd>On since {formatDate(person?.totpEnabledAt ?? null)}</dd>
            <dt>Last sign-in</dt>
            <dd>{formatDateTime(person?.lastLoginAt ?? null)}</dd>
          </dl>
          <form method="post" action="/admin/account/name" style="max-width:420px">
            <TextField name="fullName" label={LABELS.fullName} required value={values.fullName ?? me.fullName ?? ''} error={errors.fullName} maxLength={120} autocomplete="name" hint="Shown to administrators and in the audit log." />
            <button class="btn" type="submit" data-busy-label="Saving...">
              Save name
            </button>
          </form>
        </div>
      </div>

      <div class="panel" style="margin-bottom:20px">
        <div class="panel-h">
          <div>
            <h2>Change password</h2>
            <p>You will be signed out everywhere except here.</p>
          </div>
        </div>
        <form method="post" action="/admin/account/password" class="form-body" style="padding:16px;max-width:452px" novalidate={Object.keys(errors).length > 0 ? true : undefined}>
          <input type="email" value={me.email} autocomplete="username" hidden readonly />
          <TextField name="current" label={LABELS.current} type="password" required error={errors.current} maxLength={200} autocomplete="current-password" />
          <TextField name="password" label={LABELS.password} type="password" required error={errors.password} maxLength={200} autocomplete="new-password" hint="At least 12 characters. Three or four ordinary words is strong and easy to remember." />
          <TextField name="confirm" label={LABELS.confirm} type="password" required error={errors.confirm} maxLength={200} autocomplete="new-password" />
          <button class="btn primary" type="submit" data-busy-label="Changing...">
            <Icon name="key" /> Change password
          </button>
        </form>
      </div>

      <div class="panel" style="margin-bottom:20px">
        <div class="panel-h">
          <h2>Recovery codes</h2>
        </div>
        <div class="form-body" style="padding:0 16px">
          <div class="action-row">
            <div class="what">
              <strong>
                {codesLeft} of 10 left
                {codesLeft <= 3 ? (
                  <span class="badge warn" style="margin-left:8px">
                    Running low
                  </span>
                ) : null}
              </strong>
              <span>
                Issuing new codes makes the old ones stop working. Do it if you have used several, or think someone may
                have seen them. You will be asked for a code from your app first.
              </span>
            </div>
            <form method="post" action="/admin/account/recovery-codes" style="margin:0">
              <button class="btn" type="submit" data-busy-label="Issuing...">
                Issue new codes
              </button>
            </form>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>Where you are signed in</h2>
            <p>If you see one you do not recognise, sign out everywhere else and change your password.</p>
          </div>
          {sessions.length > 1 ? (
            <form method="post" action="/admin/account/sessions/end-others" style="margin:0">
              <button class="btn sm" type="submit" data-busy-label="Signing out...">
                Sign out everywhere else
              </button>
            </form>
          ) : null}
        </div>
        <table>
          <thead>
            <tr>
              <th style="width:170px">Signed in</th>
              <th style="width:140px">Network address</th>
              <th>Browser</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr>
                <td class="num t-dim">{formatDateTime(s.createdAt)}</td>
                <td class="num t-dim">{s.ipAddress ?? '—'}</td>
                <td class="t-dim">
                  {describeAgent(s.userAgent)}
                  {s.id === current ? (
                    <span class="badge ok" style="margin-left:8px">
                      This session
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>,
    status,
  );
}

/** "Chrome on Windows", from a user-agent string. Approximate by nature, and only ever shown to its owner. */
export function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iPhone or iPad'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'an unknown system';
  return `${browser} on ${os}`;
}
