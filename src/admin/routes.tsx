import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { desc, eq, sql } from 'drizzle-orm';
import type { Env } from '../types';
import { createDb, type Db } from '../db/client';
import { auditLog, adminUsers, agencies, queries, services } from '../db/schema';
import {
  SESSION_COOKIE,
  clearedCookie,
  createSession,
  destroySession,
  resolveSession,
  sessionCookie,
  verifyPassword,
  type SessionUser,
} from './auth';
import { ConfidenceBadge, Icon, LoginPage, Shell, formatDate } from './layout';

type Ctx = { Bindings: Env; Variables: { db: Db; user: SessionUser } };

export const admin = new Hono<Ctx>();

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

  const path = new URL(c.req.url).pathname;
  if (path === '/admin/login') return next();

  const user = await resolveSession(c.get('db'), getCookie(c, SESSION_COOKIE));
  if (!user) {
    if (path === '/admin/logout') return c.redirect('/admin/login');
    return c.redirect('/admin/login');
  }
  c.set('user', user);
  return next();
});

admin.get('/login', (c) => c.html(<LoginPage />));

admin.post('/login', async (c) => {
  const form = await c.req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');

  const db = c.get('db');
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  // One message for every failure. Distinguishing "no such account" from
  // "wrong password" tells an attacker which emails are real.
  const bad = () => c.html(<LoginPage error="Email or password is incorrect." />, 401);

  if (!user || !user.isActive) return bad();
  if (!(await verifyPassword(password, user.passwordHash))) return bad();

  const { token, expiresAt } = await createSession(db, user.id, {
    ip: c.req.header('cf-connecting-ip'),
    userAgent: c.req.header('user-agent'),
  });

  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, user.id));
  await record(db, user, 'login', 'admin_users', user.id, null, null, c.req.header('cf-connecting-ip'));

  c.header('Set-Cookie', sessionCookie(token, expiresAt));
  return c.redirect('/admin');
});

admin.post('/logout', async (c) => {
  await destroySession(c.get('db'), getCookie(c, SESSION_COOKIE));
  c.header('Set-Cookie', clearedCookie());
  return c.redirect('/admin/login');
});

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

  return c.html(
    <Shell title="Overview" path="/admin" email={user.email}>
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
                  <td class="num t-dim">{q.createdAt.toLocaleString('en-GB')}</td>
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

admin.get('/services', async (c) => {
  const db = c.get('db');
  const rows = await db
    .select({
      id: services.id,
      name: services.name,
      agency: agencies.shortName,
      feeAmount: services.feeAmount,
      confidence: services.confidence,
      verifiedAt: services.verifiedAt,
      isPublished: services.isPublished,
    })
    .from(services)
    .leftJoin(agencies, eq(services.agencyId, agencies.id))
    .orderBy(services.name);

  const saved = c.req.query('saved');

  return c.html(
    <Shell title="Services" path="/admin/services" email={c.get('user').email}>
      {saved ? (
        <div class="flash ok">
          <Icon name="check" /> Saved. The assistant is already using the new value.
        </div>
      ) : null}

      <div class="panel">
        <div class="panel-h">
          <div>
            <h2>Service catalogue</h2>
            <p>What the assistant answers from. A fee left blank is never guessed.</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th style="width:110px">Agency</th>
              <th style="width:130px">Fee</th>
              <th style="width:120px">Confidence</th>
              <th style="width:120px">Verified</th>
              <th style="width:80px"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr>
                <td class="t-strong">
                  {s.name}
                  {!s.isPublished ? <span class="badge muted" style="margin-left:8px">Hidden</span> : null}
                </td>
                <td class="t-dim">{s.agency ?? '—'}</td>
                <td class="num">
                  {s.feeAmount ? (
                    `₦${Number(s.feeAmount).toLocaleString('en-NG')}`
                  ) : (
                    <span class="t-dim">Not confirmed</span>
                  )}
                </td>
                <td><ConfidenceBadge value={s.confidence} /></td>
                <td class="num t-dim">{formatDate(s.verifiedAt)}</td>
                <td><a class="btn" href={`/admin/services/${s.id}`}>Edit</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>,
  );
});

admin.get('/services/:id', async (c) => {
  const db = c.get('db');
  const [row] = await db.select().from(services).where(eq(services.id, c.req.param('id'))).limit(1);
  if (!row) return c.notFound();

  return c.html(
    <Shell title={row.name} path="/admin/services" email={c.get('user').email}>
      <a class="btn" href="/admin/services" style="margin-bottom:18px">
        <Icon name="back" /> All services
      </a>

      <form method="post" action={`/admin/services/${row.id}`}>
        <div class="panel">
          <div class="panel-h">
            <div>
              <h2>Edit service</h2>
              <p>Changes take effect on the next question. Every edit is recorded in the audit log.</p>
            </div>
          </div>

          <div style="padding:18px 16px">
            <div class="field">
              <label for="name">Service name</label>
              <input id="name" name="name" type="text" value={row.name} required />
            </div>

            <div class="field">
              <label for="summary">Summary</label>
              <textarea id="summary" name="summary" required>{row.summary}</textarea>
              <div class="hint">One or two sentences. This is read out to the user verbatim.</div>
            </div>

            <div class="grid2">
              <div class="field">
                <label for="feeAmount">Fee (₦)</label>
                <input
                  id="feeAmount"
                  name="feeAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.feeAmount ?? ''}
                />
                <div class="hint">Leave blank if not confirmed. A blank fee is never guessed.</div>
              </div>
              <div class="field">
                <label for="confidence">Confidence</label>
                <select id="confidence" name="confidence">
                  <option value="confirmed" selected={row.confidence === 'confirmed'}>
                    Confirmed — checked by phone with a named officer
                  </option>
                  <option value="published" selected={row.confidence === 'published'}>
                    Published — from the agency's own site
                  </option>
                  <option value="unverified" selected={row.confidence === 'unverified'}>
                    Unverified — secondary source
                  </option>
                </select>
              </div>
            </div>

            <div class="field">
              <label for="feeNote">Fee note</label>
              <textarea id="feeNote" name="feeNote">{row.feeNote ?? ''}</textarea>
              <div class="hint">Shown when the fee varies, or to explain why it is not stated.</div>
            </div>

            <div class="grid2">
              <div class="field">
                <label for="paymentChannel">Where to pay</label>
                <input id="paymentChannel" name="paymentChannel" type="text" value={row.paymentChannel ?? ''} />
              </div>
              <div class="field">
                <label for="turnaround">How long it takes</label>
                <input id="turnaround" name="turnaround" type="text" value={row.turnaround ?? ''} />
              </div>
            </div>

            <div class="field">
              <label for="requiredDocuments">Required documents</label>
              <textarea id="requiredDocuments" name="requiredDocuments">
                {row.requiredDocuments.join('\n')}
              </textarea>
              <div class="hint">One per line.</div>
            </div>

            <div class="field">
              <label for="steps">Steps</label>
              <textarea id="steps" name="steps" style="min-height:120px">
                {row.steps.join('\n')}
              </textarea>
              <div class="hint">One per line, in order.</div>
            </div>

            <div class="grid2">
              <div class="field">
                <label for="sourceUrl">Source URL</label>
                <input id="sourceUrl" name="sourceUrl" type="text" value={row.sourceUrl ?? ''} />
              </div>
              <div class="field">
                <label for="verifiedBy">Verified by</label>
                <input
                  id="verifiedBy"
                  name="verifiedBy"
                  type="text"
                  value={row.verifiedBy ?? ''}
                  placeholder="Name of the officer who confirmed it"
                />
              </div>
            </div>

            <div class="field" style="margin-bottom:0">
              <label>
                <input
                  type="checkbox"
                  name="isPublished"
                  value="1"
                  checked={row.isPublished}
                  style="width:auto;margin-right:8px"
                />
                Visible to users
              </label>
              <div class="hint">Uncheck to withdraw this service from answers without deleting it.</div>
            </div>
          </div>

          <div class="form-foot">
            <button class="btn primary" type="submit" data-busy-label="Saving...">
              <Icon name="check" /> Save changes
            </button>
            <span class="t-dim">
              Last verified {formatDate(row.verifiedAt)}. Saving updates this to today.
            </span>
          </div>
        </div>
      </form>
    </Shell>,
  );
});

admin.post('/services/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const id = c.req.param('id');

  const [before] = await db.select().from(services).where(eq(services.id, id)).limit(1);
  if (!before) return c.notFound();

  const form = await c.req.formData();
  const str = (k: string) => String(form.get(k) ?? '').trim();
  const lines = (k: string) =>
    str(k)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const fee = str('feeAmount');
  const confidence = str('confidence');

  const after = {
    name: str('name'),
    summary: str('summary'),
    feeAmount: fee === '' ? null : fee,
    feeNote: str('feeNote') || null,
    paymentChannel: str('paymentChannel') || null,
    turnaround: str('turnaround') || null,
    requiredDocuments: lines('requiredDocuments'),
    steps: lines('steps'),
    sourceUrl: str('sourceUrl') || null,
    verifiedBy: str('verifiedBy') || null,
    confidence: (['confirmed', 'published', 'unverified'].includes(confidence)
      ? confidence
      : 'unverified') as 'confirmed' | 'published' | 'unverified',
    isPublished: form.get('isPublished') === '1',
    // A save is a statement that someone looked at this today.
    verifiedAt: new Date(),
    updatedAt: new Date(),
  };

  await db.update(services).set(after).where(eq(services.id, id));
  await record(db, user, 'update', 'services', id, before, after, c.req.header('cf-connecting-ip'));

  return c.redirect('/admin/services?saved=1');
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
                  <td class="num t-dim">{q.createdAt.toLocaleString('en-GB')}</td>
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
            <p>Append-only. Every sign-in and every change to published data, with who and when.</p>
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
                <th style="width:100px">Action</th>
                <th>Record</th>
                <th style="width:120px">From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr>
                  <td class="num t-dim">{a.createdAt.toLocaleString('en-GB')}</td>
                  <td>{a.actorEmail}</td>
                  <td><span class="badge muted">{a.action}</span></td>
                  <td class="t-dim">{a.tableName}{a.rowId ? ` · ${a.rowId.slice(0, 8)}` : ''}</td>
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
for (const [path, label] of [
  ['/facilities', 'Facilities'],
  ['/facts', 'State facts'],
] as const) {
  admin.get(path, (c) =>
    c.html(
      <Shell title={label} path={`/admin${path}`} email={c.get('user').email}>
        <div class="panel">
          <div class="empty">
            {label} editing is not built yet. Records are managed through the seed scripts for now.
          </div>
        </div>
      </Shell>,
    ),
  );
}

/* ------------------------------------------------------------------ */

/**
 * Append-only audit entry. Never updated, never deleted.
 *
 * Doing double duty: a real security control, and the thing a government
 * buyer asks about first — who changed this published fee, and when.
 */
async function record(
  db: Db,
  user: { id: string; email: string },
  action: string,
  table: string,
  rowId: string | null,
  before: unknown,
  after: unknown,
  ip?: string,
): Promise<void> {
  await db.insert(auditLog).values({
    actorId: user.id,
    actorEmail: user.email,
    action,
    tableName: table,
    rowId,
    before: before ?? null,
    after: after ?? null,
    ipAddress: ip ?? null,
  });
}

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
