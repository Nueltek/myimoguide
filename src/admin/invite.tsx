import { Hono, type Context } from 'hono';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { adminInvites, adminUsers } from '../db/schema';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, asRole } from './access';
import { createSession, hashPassword, hashToken, passwordProblem, sessionCookie } from './auth';
import { audit, isUniqueViolation, type Ctx } from './context';
import { ErrorSummary, TextField } from './forms';
import { AuthCard, Icon, formatDateTime } from './layout';
import type { Errors } from './validate';

/**
 * Accepting an invitation. Reached without a session: the link itself is
 * the credential, 256 random bits that work once.
 *
 * The person chooses their own password here, then goes straight to
 * setting up two-step sign-in. Nobody else ever knows their password, and
 * there is no temporary one that someone else could use first.
 */
export const invite = new Hono<Ctx>();

type Invite = typeof adminInvites.$inferSelect;

const LABELS = { fullName: 'Your full name', password: 'Choose a password', confirm: 'Type it again' };

async function lookup(c: Context<Ctx>, token: string): Promise<{ invite: Invite } | { problem: Problem }> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { problem: 'unknown' };
  const [row] = await c
    .get('db')
    .select()
    .from(adminInvites)
    .where(eq(adminInvites.tokenHash, await hashToken(token)))
    .limit(1);
  if (!row) return { problem: 'unknown' };
  if (row.acceptedAt) return { problem: 'used' };
  if (row.revokedAt) return { problem: 'revoked' };
  if (row.expiresAt.getTime() <= Date.now()) return { problem: 'expired' };
  return { invite: row };
}

invite.get('/:token', async (c) => {
  const found = await lookup(c, c.req.param('token'));
  if ('problem' in found) return c.html(<Unusable problem={found.problem} />, found.problem === 'unknown' ? 404 : 410);
  return c.html(<AcceptPage invite={found.invite} token={c.req.param('token')} values={{}} errors={{}} />);
});

invite.post('/:token', async (c) => {
  const token = c.req.param('token');
  const found = await lookup(c, token);
  if ('problem' in found) return c.html(<Unusable problem={found.problem} />, found.problem === 'unknown' ? 404 : 410);
  const inv = found.invite;

  const form = await c.req.formData();
  const fullName = String(form.get('fullName') ?? '').trim().replace(/\s+/g, ' ');
  const password = String(form.get('password') ?? '');
  const confirmPassword = String(form.get('confirm') ?? '');

  const errors: Errors = {};
  if (!fullName) errors.fullName = 'Enter your full name, as colleagues would recognise it.';
  else if (fullName.length > 120) errors.fullName = 'Your name must be 120 characters or fewer.';
  const problem = passwordProblem(password, inv.email);
  if (problem) errors.password = problem;
  else if (password !== confirmPassword) errors.confirm = 'The two passwords do not match.';

  if (Object.keys(errors).length > 0) {
    // The name comes back; passwords never do.
    return c.html(<AcceptPage invite={inv} token={token} values={{ fullName }} errors={errors} />, 422);
  }

  const db = c.get('db');
  const role = asRole(inv.role) ?? 'viewer';

  // Hash before claiming the invitation: it is the slow step, and a
  // failure here should leave the link still usable.
  const passwordHash = await hashPassword(password);

  // Claim the invitation in one statement, so the link works exactly once
  // even if it is submitted twice at the same moment.
  const [claimed] = await db
    .update(adminInvites)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(adminInvites.id, inv.id),
        isNull(adminInvites.acceptedAt),
        isNull(adminInvites.revokedAt),
        gt(adminInvites.expiresAt, new Date()),
      ),
    )
    .returning({ id: adminInvites.id });
  if (!claimed) return c.html(<Unusable problem="used" />, 410);

  let user: typeof adminUsers.$inferSelect;
  try {
    [user] = (await db
      .insert(adminUsers)
      .values({ email: inv.email, passwordHash, role, fullName })
      .returning()) as [typeof adminUsers.$inferSelect];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return c.html(<Unusable problem="exists" />, 409);
  }

  await db.update(adminInvites).set({ acceptedUserId: user.id }).where(eq(adminInvites.id, inv.id));

  c.set('user', { id: user.id, email: user.email, role: user.role, fullName: user.fullName });
  await audit(c, 'user_joined', 'admin_users', user.id, null, {
    email: user.email,
    role,
    fullName,
    invitedBy: inv.invitedByEmail,
  });

  // Straight into two-step setup. Until that is done, this session can
  // reach nothing else.
  const { token: session, expiresAt } = await createSession(
    db,
    user.id,
    { ip: c.req.header('cf-connecting-ip'), userAgent: c.req.header('user-agent') },
    'enrolling',
  );
  c.header('Set-Cookie', sessionCookie(session, expiresAt));
  return c.redirect('/admin/2fa/setup');
});

/* ------------------------------------------------------------------ */

const AcceptPage = ({
  invite: inv,
  token,
  values,
  errors,
}: {
  invite: Invite;
  token: string;
  values: { fullName?: string };
  errors: Errors;
}) => {
  const role = asRole(inv.role) ?? 'viewer';
  return (
    <AuthCard title="Accept your invitation" step="Step 1 of 2">
      <h1 class="auth-title">Create your account</h1>
      <p class="auth-lede">
        {inv.invitedByEmail} has invited you to the MyImoGuide administration dashboard as {role === 'viewer' ? 'a' : 'an'}{' '}
        <strong>{ROLE_LABELS[role]}</strong>. {ROLE_DESCRIPTIONS[role]}
      </p>
      <ErrorSummary errors={errors} labels={LABELS} />
      <form method="post" action={`/admin/invite/${token}`} novalidate={Object.keys(errors).length > 0 ? true : undefined}>
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" value={inv.email} readonly autocomplete="username" aria-describedby="email-hint" />
          <div class="hint" id="email-hint">
            You will sign in with this address. To use a different one, ask for a new invitation.
          </div>
        </div>
        <TextField name="fullName" label={LABELS.fullName} required value={values.fullName} error={errors.fullName} maxLength={120} autocomplete="name" hint="Shown to other administrators and in the audit log." />
        <TextField name="password" label={LABELS.password} type="password" required error={errors.password} maxLength={200} autocomplete="new-password" hint="At least 12 characters. Three or four ordinary words is strong and easy to remember." />
        <TextField name="confirm" label={LABELS.confirm} type="password" required error={errors.confirm} maxLength={200} autocomplete="new-password" />
        <button class="btn primary" type="submit" data-busy-label="Creating your account..." style="width:100%;justify-content:center">
          <Icon name="check" /> Create account and continue
        </button>
      </form>
      <p class="auth-foot">
        Next you will set up an authenticator app on your phone. This invitation expires{' '}
        {formatDateTime(inv.expiresAt)} WAT.
      </p>
    </AuthCard>
  );
};

type Problem = 'unknown' | 'used' | 'revoked' | 'expired' | 'exists';

const PROBLEMS: Record<Problem, { title: string; body: string; signIn?: boolean }> = {
  unknown: {
    title: 'This invitation link is not valid',
    body: 'Check that the whole link was copied. If it still does not work, ask the administrator who invited you to send a new one.',
  },
  used: {
    title: 'This invitation has already been used',
    body: 'Each invitation link works once. If you created your account with it, sign in. If you did not, tell the administrator who invited you straight away.',
    signIn: true,
  },
  revoked: {
    title: 'This invitation was withdrawn',
    body: 'An administrator cancelled it. Ask them for a new one if you still need access.',
  },
  expired: {
    title: 'This invitation has expired',
    body: 'Invitations last 72 hours. Ask the administrator who invited you to send a new one.',
  },
  exists: {
    title: 'An account already exists for this email',
    body: 'Sign in with your existing password. If you have forgotten it, ask an administrator to help.',
    signIn: true,
  },
};

const Unusable = ({ problem }: { problem: Problem }) => {
  const p = PROBLEMS[problem];
  return (
    <AuthCard title={p.title}>
      <h1 class="auth-title">{p.title}</h1>
      <p class="auth-lede">{p.body}</p>
      {p.signIn ? (
        <a class="btn primary" href="/admin/login" style="width:100%;justify-content:center">
          Go to sign in
        </a>
      ) : null}
    </AuthCard>
  );
};
