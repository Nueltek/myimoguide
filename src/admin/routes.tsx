import { Hono, type Context, type Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { desc, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { auditLog, adminUsers, queries, services } from '../db/schema';
import {
  SESSION_COOKIE,
  clearedCookie,
  createSession,
  destroySessionById,
  resolveSession,
  sessionCookie,
  verifyPassword,
  type ResolvedSession,
} from './auth';
import { ConfidenceBadge, Icon, LoginPage, Shell, formatDate, formatDateTime } from './layout';

import { audit, type Ctx } from './context';
import { isThrottled, recordFailedLogin } from './throttle';
import { twoFactor } from './twofactor';
import { agenciesAdmin } from './resources/agencies';
import { facilitiesAdmin } from './resources/facilities';
import { factsAdmin } from './resources/facts';
import { servicesAdmin } from './resources/services';

export const admin = new Hono<Ctx>();

/**
 * Where a session at each stage of sign-in may go. Anything else
 * redirects to the one page that stage is for.
 *
 *   No authenticator yet  -> /admin/2fa/setup only. This includes full
 *                            sessions issued before 2FA existed: they are
 *                            sent to set it up, not waved through.
 *   Password given        -> /admin/2fa only.
 *   Fully signed in       -> everything except the sign-in steps.
 *
 * Sign-out is open to every stage, so nobody is trapped half-way.
 */
export function routeFor(session: ResolvedSession, path: string): 'allow' | string {
  if (path === '/admin/logout') return 'allow';
  if (!session.totpEnabled) return path === '/admin/2fa/setup' ? 'allow' : '/admin/2fa/setup';
  if (session.stage !== 'full') return path === '/admin/2fa' ? 'allow' : '/admin/2fa';
  return path.startsWith('/admin/2fa') ? '/admin' : 'allow';
}

/**
 * Everything under /admin requires a session, except the login routes.
 *
 * Failing closed is the point: a new page added later is protected by
 * default rather than by remembering to protect it.
 */
admin.use('*', async (c, next) => {
  // Use an injected connection if one is already set. This is the seam
  // the test harness uses to run these exact routes against a real
  // Postgres, rather than reasoning about them from the outside.
  if (!c.get('db')) c.set('db', createDb(c.env.DATABASE_URL));

  await gate(c, next);

  // Nothing in the dashboard may be kept by a browser or proxy cache: not
  // the records, and above all not the recovery codes page. Without this,
  // Back after signing out can show a page that should be gone.
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Referrer-Policy', 'same-origin');
  c.res.headers.set('X-Frame-Options', 'DENY');
});

async function gate(c: Context<Ctx>, next: Next): Promise<void> {
  const path = new URL(c.req.url).pathname;
  if (path === '/admin/login') return next();

  const session = await resolveSession(c.get('db'), getCookie(c, SESSION_COOKIE));
  if (!session) {
    c.res = c.redirect('/admin/login');
    return;
  }

  const verdict = routeFor(session, path);
  if (verdict !== 'allow') {
    c.res = c.redirect(verdict);
    return;
  }
  c.set('session', session);
  c.set('user', session.user);
  return next();
}

admin.get('/login', (c) => {
  const notice = c.req.query('locked')
    ? undefined
    : c.req.query('signedout')
      ? 'You have signed out.'
      : undefined;
  const error = c.req.query('locked')
    ? 'Too many incorrect codes. For your security, sign in again with your password.'
    : undefined;
  return c.html(<LoginPage error={error} notice={notice} />);
});

admin.post('/login', async (c) => {
  const form = await c.req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const db = c.get('db');

  // Checked before the password, so a locked account gives no signal
  // about whether a guess was right.
  const throttle = await isThrottled(db, email, ip);
  if (throttle.blocked) {
    return c.html(
      <LoginPage
        error={`Too many failed sign-in attempts. Wait ${throttle.minutes} minutes and try again.`}
      />,
      429,
    );
  }

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);

  // One message for every failure. Distinguishing "no such account" from
  // "wrong password" tells an attacker which emails are real. The reason
  // is kept in the audit log, where only staff can read it.
  const bad = async (reason: string) => {
    await recordFailedLogin(db, email, ip, reason);
    return c.html(<LoginPage error="Email or password is incorrect." />, 401);
  };

  if (!user) return bad('unknown_account');
  if (!user.isActive) return bad('inactive_account');
  if (!(await verifyPassword(password, user.passwordHash))) return bad('wrong_password');

  // The password alone never grants a full session. It grants ten minutes
  // to give the second factor, or to set one up if this account has none.
  const enrolled = user.totpEnabledAt !== null;
  const { token, expiresAt } = await createSession(
    db,
    user.id,
    { ip: ip ?? undefined, userAgent: c.req.header('user-agent') },
    enrolled ? 'pending' : 'enrolling',
  );

  c.header('Set-Cookie', sessionCookie(token, expiresAt));
  return c.redirect(enrolled ? '/admin/2fa' : '/admin/2fa/setup');
});

admin.post('/logout', async (c) => {
  const session = c.get('session');
  if (session.stage === 'full') await audit(c, 'logout', 'admin_users', session.user.id, null, null);
  await destroySessionById(c.get('db'), session.sessionId);
  c.header('Set-Cookie', clearedCookie());
  return c.redirect('/admin/login?signedout=1');
});

admin.route('/2fa', twoFactor);

/* ------------------------------------------------------------------ */

admin.get('/', async (c) => {
  const db = c.get('db');
  const user = c.get('user');

  // Sequential, not db.batch(). batch() is driver-specific — it exists on
  // neon-http but not on every Drizzle driver, which made this page
  // untestable against a local Postgres. The overview is opened by a
  // handful of staff, so three round trips cost nothing worth having an
  // untestable page for. The hot path in the agent still batches.
  const serviceStats = await db
    .select({
      total: sql<number>`count(*)::int`,
      confirmed: sql<number>`count(*) filter (where ${services.confidence} = 'confirmed')::int`,
    })
    .from(services);

  const tierStats = await db
    .select({ tier: queries.answerTier, n: sql<number>`count(*)::int` })
    .from(queries)
    .groupBy(queries.answerTier);

  const recent = await db
    .select({
      question: queries.question,
      tier: queries.answerTier,
      provider: queries.provider,
      createdAt: queries.createdAt,
    })
    .from(queries)
    .orderBy(desc(queries.createdAt))
    .limit(8);

  const stats = serviceStats[0] ?? { total: 0, confirmed: 0 };
  const byTier = Object.fromEntries(tierStats.map((r) => [r.tier ?? 'unknown', r.n]));
  const totalQ = tierStats.reduce((sum, r) => sum + r.n, 0);
  const verified = byTier.verified ?? 0;
  const sourced = byTier.sourced ?? 0;
  const unresolved = (byTier.unknown ?? 0) + (byTier.error ?? 0);

  const recovery = c.req.query('recovery');
  const left = recovery === undefined ? null : Number(recovery);

  return c.html(
    <Shell title="Overview" path="/admin" email={user.email}>
      {left !== null && Number.isFinite(left) ? (
        <div class="flash warn" role="status">
          <Icon name="alert" /> You signed in with a recovery code. That code no longer works;{' '}
          {left === 1 ? '1 remains' : `${left} remain`}. If you no longer have your phone, ask the system administrator
          to reset your two-step sign-in so you can set up a new one.
        </div>
      ) : null}
      <div class="cards">
        <Stat k="Questions asked" v={totalQ} />
        <Stat
          k="From verified records"
          v={verified}
          note={totalQ ? `${pct(verified, totalQ)}% of all questions` : 'No questions yet'}
        />
        <Stat
          k="From cited sources"
          v={sourced}
          note={totalQ ? `${pct(sourced, totalQ)}% — candidates for verification` : '—'}
        />
        <Stat
          k="Unanswered"
          v={unresolved}
          note={totalQ ? `${pct(unresolved, totalQ)}% — the gap list` : '—'}
        />
        <Stat
          k="Services"
          v={stats.total}
          note={`${stats.confirmed} phone-confirmed`}
        />
      </div>

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>Recent questions</h2>
            <p>What residents are actually asking, newest first.</p>
          </div>
          <a class="btn" href="/admin/queries">View all</a>
        </div>
        {recent.length === 0 ? (
          <div class="empty">No questions yet. Send a message to the WhatsApp number to see it here.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Question</th>
                <th style="width:120px">Answered by</th>
                <th style="width:110px">Provider</th>
                <th style="width:150px">When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((q) => (
                <tr>
                  <td>{q.question}</td>
                  <td><TierBadge tier={q.tier} /></td>
                  <td class="t-dim">{q.provider ?? '—'}</td>
                  <td class="num t-dim">{formatDateTime(q.createdAt)}</td>
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

admin.get('/queries', async (c) => {
  const db = c.get('db');
  const filter = c.req.query('tier');

  const base = db
    .select({
      question: queries.question,
      tier: queries.answerTier,
      provider: queries.provider,
      model: queries.model,
      latencyMs: queries.latencyMs,
      createdAt: queries.createdAt,
    })
    .from(queries);

  const rows = await (filter
    ? base.where(eq(queries.answerTier, filter))
    : base
  )
    .orderBy(desc(queries.createdAt))
    .limit(200);

  return c.html(
    <Shell title="Questions" path="/admin/queries" email={c.get('user').email}>
      <div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
        <a class="btn" href="/admin/queries">All</a>
        <a class="btn" href="/admin/queries?tier=verified">Verified</a>
        <a class="btn" href="/admin/queries?tier=sourced">Cited sources</a>
        <a class="btn" href="/admin/queries?tier=unknown">Unanswered</a>
        <a class="btn" href="/admin/queries?tier=withheld">Withheld</a>
      </div>

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>{filter ? `Questions answered: ${filter}` : 'All questions'}</h2>
            <p>
              Unanswered questions are the gap list — what residents want that no record covers yet.
            </p>
          </div>
        </div>
        {rows.length === 0 ? (
          <div class="empty">Nothing here yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Question</th>
                <th style="width:120px">Answered by</th>
                <th style="width:150px">Model</th>
                <th style="width:90px">Latency</th>
                <th style="width:150px">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr>
                  <td>{q.question}</td>
                  <td><TierBadge tier={q.tier} /></td>
                  <td class="t-dim">{q.model ?? '—'}</td>
                  <td class="num t-dim">{q.latencyMs ? `${(q.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td class="num t-dim">{formatDateTime(q.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>,
  );
});

admin.get('/audit', async (c) => {
  const db = c.get('db');
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(200);

  return c.html(
    <Shell title="Audit log" path="/admin/audit" email={c.get('user').email}>
      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>Audit log</h2>
            <p>Append-only. Every sign-in attempt and every change to published data, with who, when and from where.</p>
          </div>
        </div>
        {rows.length === 0 ? (
          <div class="empty">No activity recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style="width:150px">When</th>
                <th style="width:200px">Who</th>
                <th style="width:140px">Action</th>
                <th>Record</th>
                <th style="width:120px">From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr>
                  <td class="num t-dim">{formatDateTime(a.createdAt)}</td>
                  <td>{a.actorEmail}</td>
                  <td><ActionBadge action={a.action} /></td>
                  <td class="t-dim">
                    {a.tableName}
                    {a.rowId ? ` · ${a.rowId.slice(0, 8)}` : ''}
                    {reasonOf(a.after) ? ` · ${reasonOf(a.after)}` : ''}
                  </td>
                  <td class="num t-dim">{a.ipAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>,
  );
});

/* Stubs so the navigation is never a dead link. */

/* ------------------------------------------------------------------ */


/* Record management. Each module is behind the same auth middleware. */
admin.route('/services', servicesAdmin);
admin.route('/agencies', agenciesAdmin);
admin.route('/facilities', facilitiesAdmin);
admin.route('/facts', factsAdmin);

/* ------------------------------------------------------------------ */

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

const Stat = ({ k, v, note }: { k: string; v: number; note?: string }) => (
  <div class="card">
    <div class="card-k">{k}</div>
    <div class="card-v">{v.toLocaleString('en-GB')}</div>
    {note ? <div class="card-n">{note}</div> : null}
  </div>
);

const TierBadge = ({ tier }: { tier: string | null }) => {
  const map: Record<string, { cls: string; label: string }> = {
    verified: { cls: 'ok', label: 'Verified' },
    sourced: { cls: 'warn', label: 'Cited source' },
    withheld: { cls: 'muted', label: 'Withheld' },
    unknown: { cls: 'bad', label: 'Unanswered' },
    error: { cls: 'bad', label: 'Error' },
  };
  const v = map[tier ?? 'unknown'] ?? map.unknown!;
  return <span class={`badge ${v.cls}`}>{v.label}</span>;
};

const ACTIONS: Record<string, { cls: string; label: string }> = {
  create: { cls: 'ok', label: 'Created' },
  update: { cls: 'muted', label: 'Updated' },
  login: { cls: 'ok', label: 'Signed in' },
  logout: { cls: 'muted', label: 'Signed out' },
  login_failed: { cls: 'bad', label: 'Sign-in failed' },
  twofa_enabled: { cls: 'ok', label: '2FA set up' },
  twofa_failed: { cls: 'warn', label: 'Wrong code' },
  twofa_locked: { cls: 'bad', label: 'Locked out' },
  twofa_reset: { cls: 'warn', label: '2FA reset' },
  recovery_code_used: { cls: 'warn', label: 'Recovery code' },
};

const ActionBadge = ({ action }: { action: string }) => {
  const v = ACTIONS[action] ?? { cls: 'muted', label: action };
  return <span class={`badge ${v.cls}`}>{v.label}</span>;
};

const REASONS: Record<string, string> = {
  unknown_account: 'no such account',
  inactive_account: 'account disabled',
  wrong_password: 'wrong password',
};

function reasonOf(after: unknown): string | null {
  const r = (after as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? (REASONS[r] ?? r) : null;
}
