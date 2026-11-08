import { Hono, type Context } from 'hono';
import { and, asc, count, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { adminInvites, adminSessions, adminUsers, auditLog } from '../db/schema';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, asRole, withArticle, type Role } from './access';
import { destroyUserSessions, hashToken, newToken } from './auth';
import { audit, type Ctx } from './context';
import { ErrorSummary, TextField } from './forms';
import { ActionBadge, Icon, Shell, formatDate, formatDateTime } from './layout';
import { isUuid } from './resources/util';
import { Form } from './validate';

/**
 * Managing who can use the dashboard. Administrators only; the middleware
 * enforces that, and asks for a fresh 2FA code before any of it.
 *
 * Three rules hold throughout:
 *   - Nobody changes their own role, access or 2FA here. That stops one
 *     mis-click locking someone out of their own account, and means every
 *     change to an account is made by a second person, on the record.
 *   - There is always at least one active administrator.
 *   - Accounts are deactivated, never deleted, so the audit log keeps
 *     resolving every past change to a named person.
 */
export const users = new Hono<Ctx>();

/** How long an invitation link works. Long enough to span a weekend. */
export const INVITE_HOURS = 72;

const FLASH: Record<string, { cls: 'ok' | 'bad'; text: string }> = {
  revoked: { cls: 'ok', text: 'Invitation withdrawn. The link no longer works.' },
  role: { cls: 'ok', text: 'Role changed. It applies from their next click.' },
  deactivated: { cls: 'ok', text: 'Account deactivated and signed out everywhere. Their history stays in the audit log.' },
  reactivated: { cls: 'ok', text: 'Account reactivated. They sign in with their existing password and authenticator app.' },
  reset: { cls: 'ok', text: 'Two-step sign-in removed and all their sessions ended. They will set up a new phone at their next sign-in.' },
  signedout: { cls: 'ok', text: 'All their sessions have been ended.' },
  self: { cls: 'bad', text: 'You cannot change your own role, access or two-step sign-in here. Ask another administrator.' },
  'last-admin': { cls: 'bad', text: 'This is the only active administrator. Make someone else an administrator first.' },
  'no-2fa': { cls: 'bad', text: 'This account has not set up two-step sign-in yet, so there is nothing to reset.' },
};

const Flash = ({ c }: { c: Context<Ctx> }) => {
  const key = c.req.query('saved') ?? c.req.query('error');
  const f = key ? FLASH[key] : undefined;
  if (!f) return null;
  return (
    <div class={`flash ${f.cls}`} role={f.cls === 'bad' ? 'alert' : 'status'}>
      <Icon name={f.cls === 'bad' ? 'alert' : 'check'} /> {f.text}
    </div>
  );
};

const RoleBadge = ({ role }: { role: string }) => {
  const r = asRole(role);
  return <span class={`badge ${r === 'administrator' ? 'ok' : 'muted'}`}>{r ? ROLE_LABELS[r] : 'No role'}</span>;
};

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

users.get('/', async (c) => {
  const db = c.get('db');
  const me = c.get('user');

  const people = await db
    .select()
    .from(adminUsers)
    .orderBy(desc(adminUsers.isActive), asc(adminUsers.role), asc(adminUsers.email));

  const invites = await db
    .select()
    .from(adminInvites)
    .where(and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), gt(adminInvites.expiresAt, new Date())))
    .orderBy(desc(adminInvites.createdAt));

  const activeAdmins = people.filter((p) => p.isActive && p.role === 'administrator').length;

  return c.html(
    <Shell title="Users" path="/admin/users" user={me}>
      <Flash c={c} />
      {activeAdmins < 2 ? (
        <div class="flash warn" role="status">
          <Icon name="alert" /> There is only one active administrator. Make a second person an administrator, so that
          one can restore the other's access if a phone is lost.
        </div>
      ) : null}
      <div class="toolbar">
        <p class="lede" style="margin:0">
          Who can use this dashboard, and what they can do. Every change here is recorded in the audit log.
        </p>
        <span class="spacer" />
        <a class="btn primary" href="/admin/users/invite">
          <Icon name="plus" /> Invite someone
        </a>
      </div>

      <div class="panel" style="margin-bottom:20px">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th style="width:130px">Role</th>
              <th style="width:170px">Status</th>
              <th style="width:150px">Last sign-in</th>
              <th style="width:90px"></th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr>
                <td>
                  <div class="t-strong">
                    {p.fullName ?? p.email}
                    {p.id === me.id ? (
                      <span class="badge muted" style="margin-left:8px">
                        You
                      </span>
                    ) : null}
                  </div>
                  {p.fullName ? <div class="t-dim">{p.email}</div> : null}
                </td>
                <td>
                  <RoleBadge role={p.role} />
                </td>
                <td>
                  {!p.isActive ? (
                    <span class="badge bad">Deactivated</span>
                  ) : p.totpEnabledAt ? (
                    <span class="badge ok">
                      <span class="dot" />
                      Active
                    </span>
                  ) : (
                    <span class="badge warn">2FA not set up</span>
                  )}
                </td>
                <td class="num t-dim">{formatDateTime(p.lastLoginAt)}</td>
                <td>
                  <a class="btn sm" href={`/admin/users/${p.id}`}>
                    Manage
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>Open invitations</h2>
            <p>Links that have not been used yet. Withdraw one if it went to the wrong person.</p>
          </div>
        </div>
        {invites.length === 0 ? (
          <div class="empty">No open invitations.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th style="width:130px">Role</th>
                <th style="width:200px">Invited by</th>
                <th style="width:150px">Expires</th>
                <th style="width:100px"></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr>
                  <td class="t-strong">{i.email}</td>
                  <td>
                    <RoleBadge role={i.role} />
                  </td>
                  <td class="t-dim">{i.invitedByEmail}</td>
                  <td class="num t-dim">{formatDateTime(i.expiresAt)}</td>
                  <td>
                    <form method="post" action={`/admin/users/invites/${i.id}/revoke`} style="margin:0">
                      <button class="btn sm danger" type="submit" data-busy-label="Withdrawing...">
                        Withdraw
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>,
  );
});

/* ------------------------------------------------------------------ */
/* Invite                                                              */
/* ------------------------------------------------------------------ */

const INVITE_LABELS = { email: 'Their email address', role: 'Role' };

users.get('/invite', (c) => c.html(<InviteForm c={c} values={{ role: 'editor' }} errors={{}} />));

users.post('/invite', async (c) => {
  const db = c.get('db');
  const me = c.get('user');
  const form = new Form(await c.req.formData());
  const email = form.email('email', 'Email address');
  if (!form.raw('email')) form.errors.email = 'Enter the email address of the person you are inviting.';
  const role = form.oneOf('role', ROLES, { required: true, label: INVITE_LABELS.role });

  if (email) {
    const [existing] = await db
      .select({ id: adminUsers.id, isActive: adminUsers.isActive })
      .from(adminUsers)
      .where(eq(adminUsers.email, email))
      .limit(1);
    if (existing?.isActive) form.errors.email = 'This person already has an account.';
    else if (existing) form.errors.email = 'This person has a deactivated account. Open it from the Users list and reactivate it instead.';
  }

  if (!form.ok || !email || !role) {
    return c.html(<InviteForm c={c} values={{ email: form.raw('email'), role: form.raw('role') }} errors={form.errors} />, 422);
  }

  // A new invitation replaces any still-open one for the same address, so
  // at most one working link exists per person.
  await db
    .update(adminInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminInvites.email, email), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt)));

  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 3_600_000);
  const [row] = await db
    .insert(adminInvites)
    .values({ email, role, tokenHash: await hashToken(token), invitedBy: me.id, invitedByEmail: me.email, expiresAt })
    .returning({ id: adminInvites.id });
  await audit(c, 'user_invited', 'admin_invites', row!.id, null, { email, role, expiresAt });

  const link = `${new URL(c.req.url).origin}/admin/invite/${token}`;
  // Rendered directly, never via redirect: the link must not be
  // retrievable again from any URL. Only its hash is stored.
  return c.html(<InviteCreated c={c} email={email} role={role} link={link} expiresAt={expiresAt} />);
});

users.post('/invites/:id/revoke', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const [row] = await c
    .get('db')
    .update(adminInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminInvites.id, id), isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt)))
    .returning();
  if (row) await audit(c, 'invite_revoked', 'admin_invites', id, null, { email: row.email, role: row.role });
  return c.redirect('/admin/users?saved=revoked');
});

const InviteForm = ({ c, values, errors }: { c: Context<Ctx>; values: Record<string, string>; errors: Record<string, string> }) => (
  <Shell title="Invite someone" path="/admin/users" user={c.get('user')}>
    <a class="btn ghost" href="/admin/users" style="margin-bottom:16px">
      <Icon name="back" /> All users
    </a>
    <ErrorSummary errors={errors} labels={INVITE_LABELS} />
    <form method="post" action="/admin/users/invite" novalidate={Object.keys(errors).length > 0 ? true : undefined}>
      <div class="panel" style="max-width:680px">
        <div class="panel-h">
          <div>
            <h2>Invite someone</h2>
            <p>They choose their own password and set up two-step sign-in when they open the link.</p>
          </div>
        </div>
        <div class="form-body">
          <div style="height:12px" />
          <TextField
            name="email"
            label={INVITE_LABELS.email}
            type="email"
            required
            value={values.email}
            error={errors.email}
            maxLength={160}
            autocomplete="off"
            inputmode="email"
            hint="Use their official address where they have one. They will sign in with it."
          />
          <fieldset class={`field${errors.role ? ' has-error' : ''}`} style="border:0;padding:0;margin:0 0 14px">
            <legend style="font-size:13px;font-weight:500;margin-bottom:6px" id="role">
              {INVITE_LABELS.role}
            </legend>
            {errors.role ? (
              <div class="err" id="role-error">
                <Icon name="alert" size={13} /> {errors.role}
              </div>
            ) : null}
            <RoleOptions selected={values.role ?? 'editor'} />
          </fieldset>
        </div>
        <div class="form-foot">
          <button class="btn primary" type="submit" data-busy-label="Creating link...">
            <Icon name="check" /> Create invitation link
          </button>
          <a class="btn ghost" href="/admin/users">
            Cancel
          </a>
        </div>
      </div>
    </form>
  </Shell>
);

const RoleOptions = ({ selected }: { selected: string }) => (
  <div class="role-options">
    {ROLES.map((r) => (
      <label class="role-option">
        <input type="radio" name="role" value={r} checked={selected === r} required />
        <div>
          <strong>{ROLE_LABELS[r]}</strong>
          <span>{ROLE_DESCRIPTIONS[r]}</span>
        </div>
      </label>
    ))}
  </div>
);

const COPY_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;
var i=document.getElementById(b.getAttribute('data-copy'));i.select();
(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).then(function(){b.lastChild.textContent=' Copied';},
function(){document.execCommand('copy');b.lastChild.textContent=' Copied';});});`;

const InviteCreated = ({
  c,
  email,
  role,
  link,
  expiresAt,
}: {
  c: Context<Ctx>;
  email: string;
  role: Role;
  link: string;
  expiresAt: Date;
}) => (
  <Shell title="Invitation created" path="/admin/users" user={c.get('user')}>
    <div class="panel" style="max-width:720px">
      <div class="panel-h">
        <div>
          <h2>Send this link to {email}</h2>
          <p>
            Invited as {withArticle(role)}. It works once and expires{' '}
            {formatDateTime(expiresAt)} WAT.
          </p>
        </div>
      </div>
      <div class="form-body" style="padding-top:14px">
        <div class="link-box">
          <input id="invite-link" type="text" value={link} readonly aria-label="Invitation link" />
          <button class="btn" type="button" data-copy="invite-link">
            <Icon name="copy" />
            <span> Copy</span>
          </button>
        </div>
        <div class="warn-box">
          <strong>This link is shown only now.</strong> Anyone who has it can create this account, so send it only to{' '}
          {email}, through a channel you trust: their official email, or a direct message to a number you already have
          for them. If it goes to the wrong person, withdraw it from the Users page.
        </div>
      </div>
      <div class="form-foot">
        <a class="btn primary" href="/admin/users">
          <Icon name="check" /> Done
        </a>
      </div>
    </div>
    <script dangerouslySetInnerHTML={{ __html: COPY_JS }} />
  </Shell>
);

/* ------------------------------------------------------------------ */
/* One person                                                          */
/* ------------------------------------------------------------------ */

users.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return c.notFound();
  const db = c.get('db');
  const me = c.get('user');

  const [person] = await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  if (!person) return c.notFound();

  const [sessions] = await db
    .select({ n: count() })
    .from(adminSessions)
    .where(and(eq(adminSessions.userId, id), eq(adminSessions.stage, 'full'), gt(adminSessions.expiresAt, new Date())));

  const activity = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.actorId, id))
    .orderBy(desc(auditLog.createdAt))
    .limit(15);

  const self = person.id === me.id;
  const role = asRole(person.role);

  return c.html(
    <Shell title={person.fullName ?? person.email} path="/admin/users" user={me}>
      <a class="btn ghost" href="/admin/users" style="margin-bottom:16px">
        <Icon name="back" /> All users
      </a>
      <Flash c={c} />

      <div class="panel" style="margin-bottom:20px">
        <div class="panel-h">
          <h2>Account</h2>
        </div>
        <div class="form-body" style="padding:16px">
          <dl class="kv">
            <dt>Name</dt>
            <dd>{person.fullName ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{person.email}</dd>
            <dt>Role</dt>
            <dd>
              <RoleBadge role={person.role} /> <span class="t-dim">{role ? ROLE_DESCRIPTIONS[role] : ''}</span>
            </dd>
            <dt>Status</dt>
            <dd>{person.isActive ? 'Active' : `Deactivated ${formatDate(person.deactivatedAt)}`}</dd>
            <dt>Two-step sign-in</dt>
            <dd>
              {person.totpEnabledAt
                ? `On since ${formatDate(person.totpEnabledAt)} · ${person.recoveryCodeHashes.length} recovery codes left`
                : 'Not set up yet'}
            </dd>
            <dt>Last sign-in</dt>
            <dd>{formatDateTime(person.lastLoginAt)}</dd>
            <dt>Signed in now</dt>
            <dd>{sessions?.n ? `${sessions.n} active session${sessions.n === 1 ? '' : 's'}` : 'No'}</dd>
            <dt>Account created</dt>
            <dd>{formatDate(person.createdAt)}</dd>
          </dl>
        </div>
      </div>

      {self ? (
        <div class="flash" role="note">
          <Icon name="user" /> This is your account. Another administrator has to change your role or access. Your
          password, recovery codes and sessions are on <a href="/admin/account">your account page</a>.
        </div>
      ) : (
        <div class="panel" style="margin-bottom:20px">
          <div class="panel-h">
            <h2>Manage access</h2>
          </div>
          <div class="form-body" style="padding:0 16px">
            {person.isActive ? (
              <div class="action-row">
                <div class="what">
                  <strong>Role</strong>
                  <span>Takes effect from their next click. No need for them to sign out.</span>
                  <form method="post" action={`/admin/users/${id}/role`} style="margin-top:10px">
                    <RoleOptions selected={person.role} />
                    <button class="btn" type="submit" data-busy-label="Saving..." style="margin-top:8px">
                      Change role
                    </button>
                  </form>
                </div>
              </div>
            ) : null}

            <div class="action-row">
              <div class="what">
                <strong>Sign out everywhere</strong>
                <span>Ends every session they have. They can sign in again straight away.</span>
              </div>
              <form method="post" action={`/admin/users/${id}/sign-out`} style="margin:0">
                <button class="btn" type="submit" data-busy-label="Signing out...">
                  Sign them out
                </button>
              </form>
            </div>

            {person.totpEnabledAt ? (
              <div class="action-row">
                <div class="what">
                  <strong>Reset two-step sign-in</strong>
                  <span>
                    For someone who has lost their phone and their recovery codes. Confirm who is asking, in person or by
                    calling a number you already have, before doing this.
                  </span>
                  <details style="margin-top:10px">
                    <summary class="btn sm danger" style="display:inline-flex">Reset…</summary>
                    <form method="post" action={`/admin/users/${id}/reset-2fa`} style="margin-top:10px">
                      <p class="t-dim" style="margin:0 0 8px">
                        Their authenticator app and recovery codes stop working and they are signed out. At their next
                        sign-in they set up a new phone.
                      </p>
                      <button class="btn danger" type="submit" data-busy-label="Resetting...">
                        Reset two-step sign-in
                      </button>
                    </form>
                  </details>
                </div>
              </div>
            ) : null}

            <div class="action-row">
              <div class="what">
                {person.isActive ? (
                  <>
                    <strong>Deactivate account</strong>
                    <span>
                      Removes their access immediately and signs them out. Their past changes stay in the audit log
                      under their name. You can reactivate the account later.
                    </span>
                    <details style="margin-top:10px">
                      <summary class="btn sm danger" style="display:inline-flex">Deactivate…</summary>
                      <form method="post" action={`/admin/users/${id}/deactivate`} style="margin-top:10px">
                        <button class="btn danger" type="submit" data-busy-label="Deactivating...">
                          Deactivate {person.fullName ?? person.email}
                        </button>
                      </form>
                    </details>
                  </>
                ) : (
                  <>
                    <strong>Reactivate account</strong>
                    <span>They sign in with their existing password and authenticator app.</span>
                    <form method="post" action={`/admin/users/${id}/reactivate`} style="margin-top:10px">
                      <button class="btn" type="submit" data-busy-label="Reactivating...">
                        Reactivate
                      </button>
                    </form>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>Recent activity</h2>
            <p>The last 15 things this account did. The full record is in the audit log.</p>
          </div>
        </div>
        {activity.length === 0 ? (
          <div class="empty">Nothing yet.</div>
        ) : (
          <table>
            <tbody>
              {activity.map((a) => (
                <tr>
                  <td class="num t-dim" style="width:170px">
                    {formatDateTime(a.createdAt)}
                  </td>
                  <td style="width:170px">
                    <ActionBadge action={a.action} />
                  </td>
                  <td class="t-dim">{a.tableName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>,
  );
});

/* ------------------------------------------------------------------ */
/* Changes to one person                                               */
/* ------------------------------------------------------------------ */

/**
 * Loads the person being changed, refusing if it is the administrator
 * making the change. Returns a Response to send instead when refused.
 */
async function target(c: Context<Ctx>) {
  const id = c.req.param('id') ?? '';
  if (!isUuid(id)) return c.notFound();
  if (id === c.get('user').id) return c.redirect(`/admin/users/${id}?error=self`);
  const [person] = await c.get('db').select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  return person ?? c.notFound();
}

/**
 * Active administrators other than this one.
 *
 * In normal use this guard cannot trigger: the administrator making a
 * change is an active administrator and cannot target themselves, so one
 * always remains. It is kept so the rule holds even if the self-change
 * rule is ever relaxed, and as a backstop the break-glass script covers.
 */
async function otherAdministrators(c: Context<Ctx>, excluding: string): Promise<number> {
  const [row] = await c
    .get('db')
    .select({ n: count() })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, 'administrator'), eq(adminUsers.isActive, true), ne(adminUsers.id, excluding)));
  return row?.n ?? 0;
}

users.post('/:id/role', async (c) => {
  const person = await target(c);
  if (person instanceof Response) return person;
  const role = asRole(String((await c.req.formData()).get('role') ?? ''));
  if (!role) return c.redirect(`/admin/users/${person.id}`);
  if (role === person.role) return c.redirect(`/admin/users/${person.id}`);
  if (person.role === 'administrator' && (await otherAdministrators(c, person.id)) === 0) {
    return c.redirect(`/admin/users/${person.id}?error=last-admin`);
  }

  await c.get('db').update(adminUsers).set({ role }).where(eq(adminUsers.id, person.id));
  await audit(c, 'role_changed', 'admin_users', person.id, { role: person.role }, { role });
  return c.redirect(`/admin/users/${person.id}?saved=role`);
});

users.post('/:id/deactivate', async (c) => {
  const person = await target(c);
  if (person instanceof Response) return person;
  if (!person.isActive) return c.redirect(`/admin/users/${person.id}`);
  if (person.role === 'administrator' && (await otherAdministrators(c, person.id)) === 0) {
    return c.redirect(`/admin/users/${person.id}?error=last-admin`);
  }

  const db = c.get('db');
  await db.update(adminUsers).set({ isActive: false, deactivatedAt: new Date() }).where(eq(adminUsers.id, person.id));
  const ended = await destroyUserSessions(db, person.id);
  await audit(c, 'user_deactivated', 'admin_users', person.id, { isActive: true }, { isActive: false, sessionsEnded: ended });
  return c.redirect(`/admin/users/${person.id}?saved=deactivated`);
});

users.post('/:id/reactivate', async (c) => {
  const person = await target(c);
  if (person instanceof Response) return person;
  if (person.isActive) return c.redirect(`/admin/users/${person.id}`);

  await c.get('db').update(adminUsers).set({ isActive: true, deactivatedAt: null }).where(eq(adminUsers.id, person.id));
  await audit(c, 'user_reactivated', 'admin_users', person.id, { isActive: false }, { isActive: true });
  return c.redirect(`/admin/users/${person.id}?saved=reactivated`);
});

users.post('/:id/reset-2fa', async (c) => {
  const person = await target(c);
  if (person instanceof Response) return person;
  if (!person.totpEnabledAt) return c.redirect(`/admin/users/${person.id}?error=no-2fa`);

  const db = c.get('db');
  await db
    .update(adminUsers)
    .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodeHashes: [] })
    .where(eq(adminUsers.id, person.id));
  const ended = await destroyUserSessions(db, person.id);
  await audit(c, 'twofa_reset', 'admin_users', person.id, null, { sessionsEnded: ended });
  return c.redirect(`/admin/users/${person.id}?saved=reset`);
});

users.post('/:id/sign-out', async (c) => {
  const person = await target(c);
  if (person instanceof Response) return person;
  const ended = await destroyUserSessions(c.get('db'), person.id);
  await audit(c, 'sessions_ended', 'admin_users', person.id, null, { sessionsEnded: ended });
  return c.redirect(`/admin/users/${person.id}?saved=signedout`);
});
