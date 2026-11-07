/** @jsxImportSource hono/jsx */
/**
 * End-to-end test of the admin routes against a real Postgres.
 *
 * Runs the committed migrations into an in-process Postgres (pglite),
 * creates an account, and drives the actual Hono routes — login, session
 * cookie, overview, services. No mocks, no stubs.
 *
 * It exists because the login failure was diagnosed three times by
 * reasoning about the code and three times wrongly. Reading a route is
 * not the same as running it.
 *
 *   npm run test:e2e
 *
 * The one gap: pglite has no pgvector, so the `intents` table is skipped.
 * Nothing in the dashboard touches it.
 */
import { PGlite } from '@electric-sql/pglite';

import { drizzle } from 'drizzle-orm/pglite';
import { Hono } from 'hono';
import { readFileSync, readdirSync } from 'node:fs';
import { admin } from '../src/admin/routes';
import { adminUsers } from '../src/db/schema';
import { hashPassword } from '../src/admin/auth';

const pg = await PGlite.create();
// vector unavailable in pglite; the intents table is skipped below.

// Apply every committed migration, exactly as production would.
for (const f of readdirSync('drizzle').filter((n) => n.endsWith('.sql')).sort()) {
  const sqlText = readFileSync(`drizzle/${f}`, 'utf8');
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    const s = stmt.trim();
    if (!s) continue;
    try { await pg.exec(s); }
    catch (e) { console.log(`  migration ${f}: ${(e as Error).message}`); }
  }
  console.log(`applied ${f}`);
}

const db = drizzle(pg as never) as never;

const email = 'test@nueltek.dev';
const password = 'anchor-basalt-cobalt-4821';
await (db as any).insert(adminUsers).values({ email, passwordHash: await hashPassword(password), role: 'admin' });
console.log('\nadmin user created');

const app = new Hono<any>();
app.use('/admin/*', async (c, next) => { c.set('db', db); await next(); });
app.route('/admin', admin);
app.onError((err, c) => {
  console.log('\n*** THREW ***');
  console.log((err as Error).stack ?? String(err));
  return c.text('error', 500);
});

const env = { DATABASE_URL: 'unused' };

console.log('\n--- GET /admin/login ---');
let r = await app.request('/admin/login', {}, env);
console.log('status', r.status);

console.log('\n--- POST /admin/login (correct password) ---');
r = await app.request('/admin/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email, password }).toString(),
}, env);
console.log('status', r.status, '| location:', r.headers.get('location'));
const cookie = r.headers.get('set-cookie');
console.log('set-cookie present:', Boolean(cookie));

if (cookie) {
  const token = cookie.split(';')[0];
  console.log('\n--- GET /admin (with session) ---');
  r = await app.request('/admin', { headers: { cookie: token! } }, env);
  console.log('status', r.status);
  if (r.status !== 200) console.log((await r.text()).slice(0, 400));

  console.log('\n--- GET /admin/services ---');
  r = await app.request('/admin/services', { headers: { cookie: token! } }, env);
  console.log('status', r.status);
}
