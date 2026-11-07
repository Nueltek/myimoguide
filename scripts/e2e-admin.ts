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
import { adminUsers, agencies, auditLog, facilities, services, stateFacts } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { MAX_PLATFORM_ITERATIONS, hashPassword } from '../src/admin/auth';

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
const passwordHash = await hashPassword(password);

// Guard against the bug that shipped once: hashes written above
// Cloudflare's production PBKDF2 cap verify fine here in Node, then fail
// on every real login. Local workerd does not enforce the cap either, so
// this assertion is the only thing that catches it before production.
const iterations = Number(passwordHash.split('$')[1]);
if (!(iterations <= MAX_PLATFORM_ITERATIONS)) {
  console.error(`FAIL: hash uses ${iterations} iterations; Cloudflare production caps at ${MAX_PLATFORM_ITERATIONS}`);
  process.exit(1);
}
console.log(`hash iterations: ${iterations} (cap ${MAX_PLATFORM_ITERATIONS}) ok`);

await (db as any).insert(adminUsers).values({ email, passwordHash, role: 'admin' });
console.log('\nadmin user created');

const app = new Hono<any>();
app.use('/admin/*', async (c, next) => { c.set('db', db); await next(); });
app.route('/admin', admin);
app.onError((err, c) => {
  console.log('\n*** THREW ***');
  console.log((err as Error).stack ?? String(err));
  // Any unhandled error in a route is a failed test, not a printed line.
  process.exitCode = 1;
  return c.text('error', 500);
});

const env = { DATABASE_URL: 'unused' };
const q = db as any;

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  pass  ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

let token = '';
const get = (path: string, auth = true) => app.request(path, auth ? { headers: { cookie: token } } : {}, env);
const post = (path: string, fields: Record<string, string>, auth = true) => {
  const init = form(fields) as RequestInit & { headers: Record<string, string> };
  if (auth) init.headers.cookie = token;
  return app.request(path, init, env);
};

/* --- Auth ----------------------------------------------------------- */
console.log('\nAuth');
let r = await app.request('/admin/login', {}, env);
check('login page renders', r.status === 200);

r = await app.request('/admin/login', form({ email, password: 'wrong-password-here' }), env);
check('wrong password is refused with 401', r.status === 401);
check('wrong password sets no session', !r.headers.get('set-cookie'));

r = await app.request('/admin/login', form({ email, password }), env);
const cookie = r.headers.get('set-cookie');
check('correct password redirects to the overview', r.status === 302 && r.headers.get('location') === '/admin');
check('correct password sets a session cookie', Boolean(cookie));
check('session cookie is HttpOnly, Secure and SameSite=Strict',
  Boolean(cookie && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie)));
token = cookie?.split(';')[0] ?? '';
if (!token) { console.log('\nCannot continue without a session.'); process.exit(1); }

r = await get('/admin/agencies', false);
check('pages redirect to login without a session', r.status === 302 && r.headers.get('location') === '/admin/login');
r = await post('/admin/agencies/new', { name: 'Should Not Exist' }, false);
const sneaked = await q.select().from(agencies).where(eq(agencies.name, 'Should Not Exist'));
check('writes without a session are refused and save nothing', r.status === 302 && sneaked.length === 0);

/* --- Every page renders --------------------------------------------- */
console.log('\nPages');
for (const path of ['/admin', '/admin/queries', '/admin/audit',
  '/admin/services', '/admin/services/new', '/admin/agencies', '/admin/agencies/new',
  '/admin/facilities', '/admin/facilities/new', '/admin/facts', '/admin/facts/new']) {
  r = await get(path);
  check(`${path} renders`, r.status === 200, `got ${r.status}`);
}
r = await get('/admin/services/not-a-uuid');
check('a malformed id is a 404, not a 500', r.status === 404, `got ${r.status}`);
r = await get('/admin/agencies/00000000-0000-4000-8000-000000000000');
check('an unknown id is a 404', r.status === 404, `got ${r.status}`);

/* --- Agencies ------------------------------------------------------- */
console.log('\nAgencies');
const youth = {
  name: 'Imo State Ministry of Youth and Sports Development',
  shortName: 'Ministry of Youth',
  headTitle: 'Honourable Commissioner',
  responsibilities: 'Youth empowerment schemes, skills acquisition and sports development.',
  lga: 'Owerri Municipal',
  latitude: '5.4836',
  longitude: '7.0333',
  confidence: 'unverified',
  isPublished: '1',
};

r = await post('/admin/agencies/new', { ...youth, name: '' });
let body = await r.text();
check('missing name returns 422', r.status === 422, `got ${r.status}`);
check('missing name shows the error', body.includes('Full name is required.'));
check('missing name keeps what was typed', body.includes('Youth empowerment schemes, skills acquisition'));
check('missing name lists the problem in the summary', body.includes('id="error-summary"'));
check('the summary does not repeat the field name', !body.includes('Full name: Full name'));

r = await post('/admin/agencies/new', { ...youth, latitude: '7.0333', longitude: '5.4836' });
body = await r.text();
check('swapped coordinates are caught with a hint', r.status === 422 && body.includes('look swapped'));

r = await post('/admin/agencies/new', { ...youth, email: 'not-an-email', website: 'ftp://x' });
body = await r.text();
check('bad email and website are both reported', r.status === 422 && body.includes('does not look like an email') && body.includes('starting with https://'));

r = await post('/admin/agencies/new', youth);
check('valid agency is created', r.status === 302 && r.headers.get('location') === '/admin/agencies?saved=created', `got ${r.status}`);
const [agency] = await q.select().from(agencies).where(eq(agencies.name, youth.name));
check('agency slug comes from the short name', agency?.slug === 'ministry-of-youth', `got ${agency?.slug}`);
check('agency head title and remit are stored', agency?.headTitle === youth.headTitle && agency?.responsibilities === youth.responsibilities);
check('head name is left empty, not invented', agency?.headName === null);

r = await post('/admin/agencies/new', youth);
check('a duplicate agency name is a field error, not a 500', r.status === 422 && (await r.text()).includes('already exists'), `got ${r.status}`);

r = await post(`/admin/agencies/${agency.id}`, { ...youth, headName: 'Jane Doe', confidence: 'confirmed', verifiedBy: 'Desk officer' });
const [agencyAfter] = await q.select().from(agencies).where(eq(agencies.id, agency.id));
check('editing an agency saves the head name', r.status === 302 && agencyAfter.headName === 'Jane Doe');
check('editing does not change the slug', agencyAfter.slug === 'ministry-of-youth');

/* --- Services ------------------------------------------------------- */
console.log('\nServices');
const scheme = {
  name: 'Youth empowerment scheme registration',
  summary: 'How to register for the state youth empowerment programme.',
  agencyId: agency.id,
  aliases: 'youth scheme, empowerment, YES',
  feeAmount: '₦15,000',
  requiredDocuments: 'Valid ID\nPassport photograph\n\n',
  steps: 'Visit the ministry\nFill the form\nSubmit documents',
  confidence: 'unverified',
  isPublished: '1',
};

r = await post('/admin/services/new', { ...scheme, agencyId: '00000000-0000-4000-8000-000000000000' });
check('an agency that does not exist is refused', r.status === 422 && (await r.text()).includes('Choose an agency from the list.'));

r = await post('/admin/services/new', { ...scheme, feeAmount: 'fifteen' });
check('a non-numeric fee is refused', r.status === 422 && (await r.text()).includes('Fee must be a number.'));

r = await post('/admin/services/new', scheme);
check('valid service is created', r.status === 302, `got ${r.status}`);
const created = await q.select().from(services).where(eq(services.name, scheme.name));
const svc = created[0];
check('fee "₦15,000" is stored as 15000.00', svc?.feeAmount === '15000.00', `got ${svc?.feeAmount}`);
check('service is linked to the new agency', svc?.agencyId === agency.id);
check('blank lines are dropped from lists', svc?.requiredDocuments.length === 2 && svc?.steps.length === 3);
check('aliases are split on commas', svc?.aliases.length === 3);

r = await post('/admin/services/new', scheme);
const twins = await q.select().from(services).where(eq(services.name, scheme.name));
check('a second service with the same name gets a distinct slug', twins.length === 2 && twins.some((s: any) => s.slug.endsWith('-2')),
  `slugs: ${twins.map((s: any) => s.slug).join(', ')}`);

r = await post(`/admin/services/${svc.id}`, { ...scheme, feeAmount: '20000' });
const [svcAfter] = await q.select().from(services).where(eq(services.id, svc.id));
check('editing a service updates the fee', r.status === 302 && svcAfter.feeAmount === '20000.00');

/* --- Facilities ----------------------------------------------------- */
console.log('\nFacilities');
const fmc = {
  name: 'Federal Medical Centre, Owerri',
  type: 'hospital',
  lga: 'Owerri Municipal',
  address: 'Orlu Road, Owerri',
  phone: '+234 800 000 0000',
  isTwentyFourHour: 'yes',
  latitude: '5.4980',
  longitude: '7.0270',
  confidence: 'unverified',
  isPublished: '1',
};

r = await post('/admin/facilities/new', { name: 'Incomplete' });
body = await r.text();
check('missing type, LGA and address are all reported', r.status === 422 &&
  body.includes('Type is required.') && body.includes('LGA is required.') && body.includes('Address is required.'));

r = await post('/admin/facilities/new', fmc);
check('valid facility is created', r.status === 302, `got ${r.status}`);
const [fac] = await q.select().from(facilities).where(eq(facilities.name, fmc.name));
check('24-hour "yes" is stored as true', fac?.isTwentyFourHour === true);

r = await post('/admin/facilities/new', fmc);
check('same name in the same LGA is a field error', r.status === 422 && (await r.text()).includes('already exists in this LGA'));

r = await post('/admin/facilities/new', { ...fmc, name: 'Unknown Hours Clinic', type: 'clinic', isTwentyFourHour: '' });
const [unk] = await q.select().from(facilities).where(eq(facilities.name, 'Unknown Hours Clinic'));
check('24-hour "not known" is stored as unknown, not as no', unk?.isTwentyFourHour === null);

r = await get('/admin/facilities?type=hospital');
body = await r.text();
check('the type filter narrows the list', body.includes(fmc.name) && !body.includes('Unknown Hours Clinic'));

/* --- Facts ---------------------------------------------------------- */
console.log('\nState facts');
const fact = {
  topic: 'who the current governor of Imo State is',
  answer: '*Hope Uzodimma (APC)* is the Governor of Imo State.',
  category: 'government',
  aliases: 'governor, who runs Imo',
  confidence: 'published',
  isPublished: '1',
};
r = await post('/admin/facts/new', fact);
check('valid fact is created', r.status === 302, `got ${r.status}`);
const [f1] = await q.select().from(stateFacts).where(eq(stateFacts.topic, fact.topic));
check('fact slug comes from the topic', f1?.slug === 'who-the-current-governor-of-imo-state-is', `got ${f1?.slug}`);

r = await post(`/admin/facts/${f1.id}`, { ...fact, topic: 'the governor of Imo State' });
const [f2] = await q.select().from(stateFacts).where(eq(stateFacts.id, f1.id));
check('editing the topic leaves the slug alone', f2.slug === f1.slug && f2.topic === 'the governor of Imo State');

r = await post('/admin/facts/new', { ...fact, answer: 'x'.repeat(2001) });
check('an over-long answer is refused', r.status === 422 && (await r.text()).includes('2000 characters or fewer'));

/* --- Audit trail ---------------------------------------------------- */
console.log('\nAudit');
const log = await q.select().from(auditLog);
const count = (a: string) => log.filter((x: any) => x.action === a).length;
check('sign-in is recorded', count('login') >= 1);
check('every create is recorded (agency, 2 services, 2 facilities, fact)', count('create') === 6, `got ${count('create')}`);
check('every update is recorded (agency, service, fact)', count('update') === 3, `got ${count('update')}`);
check('every entry names who did it', log.every((x: any) => x.actorEmail === email));
const svcUpdate = log.find((x: any) => x.action === 'update' && x.tableName === 'services');
check('updates keep the before and after values', svcUpdate?.before?.feeAmount === '15000.00' && svcUpdate?.after?.feeAmount === '20000.00');
check('failed validations wrote nothing to the audit log', log.length === count('login') + 6 + 3);

console.log(failed ? `\n${failed} FAILED\n` : '\ne2e passed\n');
process.exit(failed || process.exitCode ? 1 : 0);
