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
import { MAX_PLATFORM_ITERATIONS, createSession, hashPassword } from '../src/admin/auth';
import { base32Decode, currentStep, hotp } from '../src/admin/totp';
import { adminSessions } from '../src/db/schema';

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

// A throwaway key, generated per run. Never a real one.
const env = {
  DATABASE_URL: 'unused',
  TOTP_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
};
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

/* --- Sign-in, step one ---------------------------------------------- */
console.log('\nSign-in: password');
let r = await app.request('/admin/login', {}, env);
check('login page renders', r.status === 200);

r = await app.request('/admin/login', form({ email, password: 'wrong-password-here' }), env);
check('wrong password is refused with 401', r.status === 401);
check('wrong password sets no session', !r.headers.get('set-cookie'));

r = await app.request('/admin/login', form({ email: 'nobody@nueltek.dev', password }), env);
check('an unknown account gets the same message as a wrong password',
  r.status === 401 && (await r.text()).includes('Email or password is incorrect.'));

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';
let token = '';
const get = (path: string, auth = true, e: object = env) => app.request(path, auth ? { headers: { cookie: token } } : {}, e);
const post = (path: string, fields: Record<string, string>, auth = true) => {
  const init = form(fields) as RequestInit & { headers: Record<string, string> };
  if (auth) init.headers.cookie = token;
  return app.request(path, init, env);
};
const login = async () => {
  const res = await app.request('/admin/login', form({ email, password }), env);
  token = cookieOf(res);
  return res;
};
const where = (res: Response) => `${res.status} ${res.headers.get('location') ?? ''}`;

r = await login();
const cookie = r.headers.get('set-cookie');
check('a correct password alone does not reach the dashboard: it goes to 2FA setup',
  r.status === 302 && r.headers.get('location') === '/admin/2fa/setup', where(r));
check('session cookie is HttpOnly, Secure and SameSite=Strict',
  Boolean(cookie && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie)));
check('the setup session lasts minutes, not hours',
  Boolean(cookie) && new Date(/Expires=([^;]+)/.exec(cookie!)![1]!).getTime() - Date.now() <= 10 * 60_000 + 5_000);
if (!token) { console.log('\nCannot continue without a session.'); process.exit(1); }

r = await get('/admin/agencies', false);
check('pages redirect to login without a session', where(r) === '302 /admin/login', where(r));
r = await post('/admin/agencies/new', { name: 'Should Not Exist' }, false);
let sneaked = await q.select().from(agencies).where(eq(agencies.name, 'Should Not Exist'));
check('writes without a session are refused and save nothing', r.status === 302 && sneaked.length === 0);

/* --- Enrolment ------------------------------------------------------- */
console.log('\nSign-in: setting up 2FA');
for (const path of ['/admin', '/admin/audit', '/admin/2fa']) {
  r = await get(path);
  check(`before setup, ${path} sends you back to setup`, where(r) === '302 /admin/2fa/setup', where(r));
}
r = await post('/admin/agencies/new', { name: 'Should Not Exist' });
sneaked = await q.select().from(agencies).where(eq(agencies.name, 'Should Not Exist'));
check('before setup, writes are refused and save nothing', where(r) === '302 /admin/2fa/setup' && sneaked.length === 0);

r = await get('/admin/2fa/setup');
let body = await r.text();
const secret = /data-secret[^>]*>([A-Z2-7 ]+)</.exec(body)?.[1]?.replace(/ /g, '') ?? '';
check('setup page shows a QR code', r.status === 200 && body.includes('<svg'));
check('setup page shows the key for typing in by hand', secret.length === 32, `got "${secret}"`);
if (secret.length !== 32) { console.log('\nCannot continue without the key.'); process.exit(1); }
check('dashboard pages are marked no-store', r.headers.get('cache-control') === 'no-store');

r = await get('/admin/2fa/setup');
check('reloading setup shows the same key, not a new one', (await r.text()).includes(secret.slice(0, 4) + ' ' + secret.slice(4, 8)));

const [pendingRow] = await q.select().from(adminUsers).where(eq(adminUsers.email, email));
check('the key is stored encrypted, not as typed', Boolean(pendingRow.totpPendingSecret) && !pendingRow.totpPendingSecret.includes(secret));

const key = base32Decode(secret);
const codeAt = (step: number) => hotp(key, step);
async function wrongCode(): Promise<string> {
  const now = currentStep();
  const valid = new Set(await Promise.all([now - 1, now, now + 1, now + 2].map(codeAt)));
  for (const c of ['000000', '111111', '222222']) if (!valid.has(c)) return c;
  throw new Error('unreachable');
}

r = await post('/admin/2fa/setup', { code: await wrongCode() });
check('a wrong setup code is refused, with attempts left', r.status === 422 && (await r.text()).includes('4 attempts left'));

const setupStep = currentStep();
const enrolToken = token;
r = await post('/admin/2fa/setup', { code: await codeAt(setupStep) });
body = await r.text();
const recoveryCodes = [...body.matchAll(/<span>([A-Z2-9]{5}-[A-Z2-9]{5})<\/span>/g)].map((m) => m[1]!);
check('the right code finishes setup and shows the recovery codes', r.status === 200 && recoveryCodes.length === 10, `got ${r.status}, ${recoveryCodes.length} codes`);
check('the recovery codes page is no-store', r.headers.get('cache-control') === 'no-store');
token = cookieOf(r);
check('finishing setup issues a new session token', Boolean(token) && token !== enrolToken);

const [enrolled] = await q.select().from(adminUsers).where(eq(adminUsers.email, email));
check('2FA is recorded as on', enrolled.totpEnabledAt !== null && enrolled.totpSecret && enrolled.totpPendingSecret === null);
check('recovery codes are stored only as hashes', enrolled.recoveryCodeHashes.length === 10 &&
  !enrolled.recoveryCodeHashes.some((h: string) => recoveryCodes.some((c) => h.includes(c.replace('-', '')))));
check('a completed sign-in updates "last sign-in"', enrolled.lastLoginAt !== null);

r = await app.request('/admin', { headers: { cookie: enrolToken } }, env);
check('the setup-stage token is dead once setup is done', where(r) === '302 /admin/login', where(r));

r = await get('/admin/2fa');
check('once signed in, the 2FA pages send you to the dashboard', where(r) === '302 /admin', where(r));
r = await get('/admin/2fa/setup');
check('once signed in, setup cannot be run again to replace the app', where(r) === '302 /admin', where(r));

r = await post('/admin/logout', {});
check('signing out redirects to the sign-in page', where(r) === '302 /admin/login?signedout=1', where(r));
r = await get('/admin');
check('the token is dead after signing out', where(r) === '302 /admin/login', where(r));

/* --- Challenge -------------------------------------------------------- */
console.log('\nSign-in: entering a code');
r = await login();
check('with 2FA on, a correct password goes to the code page', where(r) === '302 /admin/2fa', where(r));
for (const path of ['/admin', '/admin/2fa/setup', '/admin/services/new']) {
  r = await get(path);
  check(`before the code, ${path} sends you to the code page`, where(r) === '302 /admin/2fa', where(r));
}

r = await post('/admin/2fa', { code: await codeAt(setupStep) });
check('the code used for setup cannot be used again (replay)', r.status === 422 && (await r.text()).includes('already been used'));

const nextCode = await codeAt(currentStep() + 1);
r = await post('/admin/2fa', { code: nextCode });
check('a fresh code signs in', where(r) === '302 /admin', where(r));
token = cookieOf(r);
r = await get('/admin');
check('the dashboard opens after the code', r.status === 200);
await post('/admin/logout', {});

/* --- Lockout ---------------------------------------------------------- */
console.log('\nSign-in: wrong codes');
await login();
r = await post('/admin/2fa', { code: nextCode });
check('a code that already signed someone in is refused', r.status === 422 && (await r.text()).includes('already been used'));
const lockToken = token;
for (let i = 0; i < 3; i++) await post('/admin/2fa', { code: await wrongCode() });
r = await post('/admin/2fa', { code: await wrongCode() });
check('the fifth wrong code ends the sign-in', where(r) === '302 /admin/login?locked=1', where(r));
check('and clears the cookie', /Max-Age=0/.test(r.headers.get('set-cookie') ?? ''));
r = await app.request('/admin/2fa', { headers: { cookie: lockToken } }, env);
check('the locked-out token cannot be used to keep guessing', where(r) === '302 /admin/login', where(r));
r = await app.request('/admin/login?locked=1', {}, env);
check('the sign-in page explains why', (await r.text()).includes('Too many incorrect codes'));

/* --- Recovery codes --------------------------------------------------- */
console.log('\nSign-in: recovery codes');
await login();
const typedLoosely = recoveryCodes[0]!.toLowerCase().replace('-', ' ');
r = await post('/admin/2fa', { code: typedLoosely });
check('a recovery code signs in, however it is typed', where(r) === '302 /admin?recovery=9', where(r));
token = cookieOf(r);
r = await get('/admin?recovery=9');
check('the overview warns that a recovery code was used', (await r.text()).includes('You signed in with a recovery code'));
await post('/admin/logout', {});

await login();
r = await post('/admin/2fa', { code: recoveryCodes[0]! });
check('a recovery code works only once', r.status === 422 && (await r.text()).includes('already been used'));
r = await post('/admin/2fa', { code: recoveryCodes[1]! });
check('another recovery code still works', where(r) === '302 /admin?recovery=8', where(r));
token = cookieOf(r);
const [afterRecovery] = await q.select().from(adminUsers).where(eq(adminUsers.email, email));
check('used recovery codes are removed', afterRecovery.recoveryCodeHashes.length === 8);

/* --- Race ------------------------------------------------------------- */
console.log('\nSign-in: the same code twice at once');
// Two sign-ins racing with one code — an attacker who watched it being
// typed. Reading "last used step" and then writing it is not enough: both
// requests can read before either writes. Only one may get through.
// The last-used step is cleared first so that a fresh code is available
// whatever the clock says.
await q.update(adminUsers).set({ totpLastStep: null }).where(eq(adminUsers.email, email));
await login(); const raceA = token;
await login(); const raceB = token;
const raceCode = await codeAt(currentStep());
const raced = await Promise.all([raceA, raceB].map((t) => {
  const init = form({ code: raceCode }) as RequestInit & { headers: Record<string, string> };
  init.headers.cookie = t;
  return app.request('/admin/2fa', init, env);
}));
const winners = raced.filter((res) => where(res) === '302 /admin').length;
check('exactly one of two simultaneous sign-ins with the same code succeeds', winners === 1, raced.map(where).join(' | '));
token = cookieOf(raced.find((res) => where(res) === '302 /admin') ?? raced[0]!);

/* --- Older sessions and missing configuration ------------------------- */
console.log('\nSign-in: edge cases');
const legacyEmail = 'legacy@nueltek.dev';
const [legacy] = await q.insert(adminUsers).values({ email: legacyEmail, passwordHash, role: 'admin' }).returning();
const legacySession = await createSession(db, legacy.id, {}, 'full');
r = await app.request('/admin', { headers: { cookie: `myimoguide_session=${legacySession.token}` } }, env);
check('a full session from before 2FA is sent to setup, not let in', where(r) === '302 /admin/2fa/setup', where(r));
r = await app.request('/admin/2fa/setup', { headers: { cookie: `myimoguide_session=${legacySession.token}` } }, { DATABASE_URL: 'unused' });
body = await r.text();
check('without the encryption key, setup explains the problem instead of crashing',
  r.status === 503 && body.includes('TOTP_ENCRYPTION_KEY'), `got ${r.status}`);

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
body = await r.text();
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
check('completed sign-ins are recorded (setup, code, 2 recovery, race winner)', count('login') === 5, `got ${count('login')}`);
check('sign-outs are recorded', count('logout') === 3, `got ${count('logout')}`);
check('2FA setup is recorded', count('twofa_enabled') === 1);
check('every wrong code is recorded (1 setup, 1 replay, 5 lockout, 1 reused recovery code, 1 race loser)', count('twofa_failed') === 9, `got ${count('twofa_failed')}`);
check('the lockout is recorded', count('twofa_locked') === 1);
check('recovery code use is recorded', count('recovery_code_used') === 2);
check('failed passwords are recorded, with the reason', count('login_failed') === 2 &&
  log.some((x: any) => x.action === 'login_failed' && x.actorEmail === 'nobody@nueltek.dev' && x.after?.reason === 'unknown_account'));
check('every create is recorded (agency, 2 services, 2 facilities, fact)', count('create') === 6, `got ${count('create')}`);
check('every update is recorded (agency, service, fact)', count('update') === 3, `got ${count('update')}`);
check('every dashboard entry names who did it',
  log.filter((x: any) => x.action !== 'login_failed').every((x: any) => x.actorEmail === email));
const svcUpdate = log.find((x: any) => x.action === 'update' && x.tableName === 'services');
check('updates keep the before and after values', svcUpdate?.before?.feeAmount === '15000.00' && svcUpdate?.after?.feeAmount === '20000.00');
const known = ['login', 'logout', 'twofa_enabled', 'twofa_failed', 'twofa_locked', 'recovery_code_used', 'login_failed', 'create', 'update'];
check('failed validations wrote nothing to the audit log', log.every((x: any) => known.includes(x.action)) &&
  log.length === 5 + 3 + 1 + 9 + 1 + 2 + 2 + 6 + 3, `got ${log.length}`);

r = await get('/admin/audit');
body = await r.text();
check('the audit page labels events in plain words', body.includes('Sign-in failed') && body.includes('Locked out') && body.includes('wrong password'));

/* --- Password throttling (last: it locks the account) --------------- */
console.log('\nPassword throttling');
let attempts = 0;
for (; attempts < 10; attempts++) {
  r = await app.request('/admin/login', form({ email, password: 'still-the-wrong-one' }), env);
  if (r.status === 429) break;
}
const failures = (await q.select().from(auditLog).where(eq(auditLog.action, 'login_failed')))
  .filter((x: any) => x.actorEmail === email).length;
check('the account locks after 5 failed passwords in 15 minutes', failures === 5 && r.status === 429, `${failures} failures, status ${r.status}`);
r = await app.request('/admin/login', form({ email, password }), env);
check('while locked, even the right password is refused', r.status === 429 && !r.headers.get('set-cookie'));
check('the message says to wait, without saying whether the password was right', (await r.text()).includes('Wait 15 minutes'));
r = await app.request('/admin/login', form({ email: legacyEmail, password }), env);
check('other accounts are not locked by it', where(r) === '302 /admin/2fa/setup', where(r));

void adminSessions;

console.log(failed ? `\n${failed} FAILED\n` : '\ne2e passed\n');
process.exit(failed || process.exitCode ? 1 : 0);
