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
import { base32Decode, currentStep, hotp, hashRecoveryCode } from '../src/admin/totp';
import { permits, returnPathFor, safeNext } from '../src/admin/access';
import { adminInvites, queries } from '../src/db/schema';
import { adminSessions } from '../src/db/schema';

const pg = await PGlite.create();
// vector unavailable in pglite; the intents table is skipped below.

// Apply every committed migration, exactly as production would. The
// only errors tolerated are pgvector's, which pglite lacks; anything else
// is a migration that would fail in production too.
const migrations = readdirSync('drizzle').filter((n) => n.endsWith('.sql')).sort();
async function migrate(files: string[]) {
  for (const f of files) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (!s) continue;
      try {
        await pg.exec(s);
      } catch (e) {
        const msg = (e as Error).message;
        if (/vector|intents/.test(msg)) continue;
        console.log(`FAIL: migration ${f}: ${msg}`);
        process.exit(1);
      }
    }
    console.log(`applied ${f}`);
  }
}

const email = 'test@nueltek.dev';
let password = 'anchor-basalt-cobalt-4821';
const originalPassword = password;
const passwordHash = await hashPassword(password);

// Upgrade path, as the live database will take it: an account created
// before roles existed has role 'admin'. Migrate up to just before roles,
// create that account the old way, then apply the rest.
const ROLES_MIGRATION = migrations.findIndex((f) => f.startsWith('0007_'));
await migrate(migrations.slice(0, ROLES_MIGRATION));
await pg.query(`insert into admin_users (email, password_hash, role) values ($1, $2, 'admin')`, [email, passwordHash]);
await migrate(migrations.slice(ROLES_MIGRATION));

const db = drizzle(pg as never) as never;

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

const q0 = db as any;
const [upgraded] = await q0.select().from(adminUsers).where(eq(adminUsers.email, email));
if (upgraded?.role !== 'administrator') {
  console.error(`FAIL: an 'admin' account from before roles became '${upgraded?.role}', not 'administrator'`);
  process.exit(1);
}
console.log("pre-roles 'admin' account migrated to 'administrator' ok");

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
const [legacy] = await q.insert(adminUsers).values({ email: legacyEmail, passwordHash, role: 'administrator' }).returning();
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

/* --- Questions, including voice notes ------------------------------- */
console.log('\nQuestions and voice notes');
await q.insert(queries).values([
  { userHash: 'a'.repeat(64), messageId: 'wamid.text1', question: 'Where do I pay my tax?', wasVoice: false, answerTier: 'verified', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { userHash: 'b'.repeat(64), messageId: 'wamid.voice1', question: 'Abeg how I go get Certificate of Occupancy?', wasVoice: true, audioSeconds: 9.4, answerTier: 'sourced', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { userHash: 'c'.repeat(64), messageId: 'wamid.voice2', question: '(Voice note: no speech heard)', wasVoice: true, audioSeconds: 50.6, answerTier: 'unheard', provider: 'openai', model: 'gpt-transcribe' },
]);
r = await get('/admin');
body = await r.text();
check('the overview counts voice notes, failures and minutes', body.includes('Voice notes') && body.includes('1 not understood · 60 s of audio'));
r = await get('/admin/queries?tier=voice');
body = await r.text();
check('the voice filter shows only voice notes', body.includes('Certificate of Occupancy') && !body.includes('Where do I pay my tax?'));
check('voice questions are marked, with their length', body.includes('aria-label="Voice note"') && body.includes('9s'));
r = await get('/admin/queries?tier=unheard');
body = await r.text();
check('the "not understood" filter shows why', body.includes('(Voice note: no speech heard)') && body.includes('Not understood') && !body.includes('Certificate of Occupancy'));
r = await get('/admin/queries?tier=%27%3B+drop+table+queries%3B--');
check('an unknown filter falls back to all questions', r.status === 200 && (await r.text()).includes('Where do I pay my tax?'));

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

/* --- Access rules, as pure functions ------------------------------- */
console.log('\nAccess rules');
check('viewers can read but not write', permits('viewer', 'GET', '/admin/services') && !permits('viewer', 'POST', '/admin/services/new'));
check('viewers cannot open blank forms', !permits('viewer', 'GET', '/admin/facts/new'));
check('viewers can still manage their own account', permits('viewer', 'POST', '/admin/account/password') && permits('viewer', 'POST', '/admin/logout'));
check('editors write records but cannot reach Users', permits('editor', 'POST', '/admin/agencies/new') && !permits('editor', 'GET', '/admin/users'));
check('administrators reach Users', permits('administrator', 'POST', '/admin/users/invite'));
check('an unknown role can do nothing but sign out', !permits('admin', 'GET', '/admin') && permits('admin', 'POST', '/admin/logout'));
check('"/admin/usersX" is not mistaken for the Users area', permits('editor', 'GET', '/admin/usersX'));
check('the confirm page refuses to send anyone off-site',
  safeNext('https://evil.example') === '/admin' && safeNext('//evil.example') === '/admin' && safeNext('/admin/users') === '/admin/users');
check('the confirm page cannot be sent back to itself', safeNext('/admin/confirm?next=/admin') === '/admin');
check('an interrupted POST returns to its page', returnPathFor('POST', '/admin/users/0b3c5f2e-8a1d-4c6e-9f00-123456789abc/role') === '/admin/users/0b3c5f2e-8a1d-4c6e-9f00-123456789abc');

/* --- Users and roles ------------------------------------------------- */
console.log('\nUsers: confirming before managing accounts');
const adminTok = token;
const [me] = await q.select().from(adminUsers).where(eq(adminUsers.email, email));
const as = (cookie: string, path: string) => app.request(path, { headers: { cookie } }, env);
const send = (cookie: string, path: string, fields: Record<string, string>) => {
  const init = form(fields) as RequestInit & { headers: Record<string, string> };
  if (cookie) init.headers.cookie = cookie;
  return app.request(path, init, env);
};
const ageConfirmation = (userId: string) =>
  q.update(adminSessions).set({ confirmedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(adminSessions.userId, userId));

await ageConfirmation(me.id);
r = await as(adminTok, '/admin/users');
check('Users asks for a fresh code when the last one is over 15 minutes old', where(r) === '302 /admin/confirm?next=%2Fadmin%2Fusers', where(r));
r = await as(adminTok, '/admin/confirm?next=%2Fadmin%2Fusers');
body = await r.text();
check('the confirm page carries where to go next', r.status === 200 && body.includes('value="/admin/users"'));
r = await send(adminTok, '/admin/confirm', { code: '000000', next: '/admin/users' });
check('a wrong code on the confirm page counts as a failed attempt', r.status === 422 && (await r.text()).includes('attempts left'));
r = await send(adminTok, '/admin/confirm', { code: recoveryCodes[2]!, next: '/admin/users' });
check('a right code returns to Users', where(r) === '302 /admin/users', where(r));

r = await as(adminTok, '/admin/users');
body = await r.text();
check('Users lists the accounts', r.status === 200 && body.includes(email) && body.includes(legacyEmail) && body.includes('Invite someone'));

console.log('\nUsers: invitations');
r = await send(adminTok, '/admin/users/invite', { email, role: 'editor' });
check('inviting someone who already has an account is refused', r.status === 422 && (await r.text()).includes('already has an account'));
r = await send(adminTok, '/admin/users/invite', { email: '', role: '' });
body = await r.text();
check('a blank invitation reports both fields', r.status === 422 && body.includes('Enter the email address') && body.includes('Role is required.'));

const linkIn = (html: string) => /value="(https?:\/\/[^"]+\/admin\/invite\/([0-9a-f]{64}))"/.exec(html);
const editorEmail = 'chiamaka.eze@nueltek.dev';
r = await send(adminTok, '/admin/users/invite', { email: editorEmail, role: 'editor' });
body = await r.text();
const editorLink = linkIn(body);
check('an invitation shows its link once', r.status === 200 && Boolean(editorLink), `status ${r.status}`);
check('the invitation page is no-store', r.headers.get('cache-control') === 'no-store');
const editorPath = `/admin/invite/${editorLink?.[2]}`;
const [inviteRow] = await q.select().from(adminInvites).where(eq(adminInvites.email, editorEmail));
check('only a hash of the link is stored', inviteRow && !JSON.stringify(inviteRow).includes(editorLink![2]!));
check('the invitation expires in 72 hours', Math.abs(inviteRow.expiresAt.getTime() - Date.now() - 72 * 3_600_000) < 60_000);

const viewerEmail = 'reviewer@nueltek.dev';
r = await send(adminTok, '/admin/users/invite', { email: viewerEmail, role: 'viewer' });
const firstViewerPath = `/admin/invite/${linkIn(await r.text())?.[2]}`;
r = await send(adminTok, '/admin/users/invite', { email: viewerEmail, role: 'viewer' });
const viewerPath = `/admin/invite/${linkIn(await r.text())?.[2]}`;
r = await app.request(firstViewerPath, {}, env);
check('inviting the same person again withdraws the earlier link', r.status === 410 && (await r.text()).includes('withdrawn'));

console.log('\nUsers: accepting an invitation');
r = await app.request(editorPath, {}, env);
body = await r.text();
check('the link opens without signing in, and says the role', r.status === 200 && body.includes('as an <strong>Editor</strong>'));
r = await app.request('/admin/invite/' + 'f'.repeat(64), {}, env);
check('a made-up link is refused', r.status === 404);

r = await send('', editorPath, { fullName: 'Chiamaka Eze', password: 'short', confirm: 'short' });
body = await r.text();
check('a short password is refused, and the name is kept', r.status === 422 && body.includes('must be at least 12 characters') && body.includes('value="Chiamaka Eze"'));
r = await send('', editorPath, { fullName: 'Chiamaka Eze', password: 'chiamaka-river-stone', confirm: 'chiamaka-river-stone' });
check('a password containing their name is refused', r.status === 422 && (await r.text()).includes('name or email address'));
const editorPassword = 'harbour-indigo-lantern-77';
r = await send('', editorPath, { fullName: 'Chiamaka Eze', password: editorPassword, confirm: 'harbour-indigo-lantern-78' });
body = await r.text();
check('mismatched passwords are refused, and never echoed back', r.status === 422 && body.includes('do not match') && !body.includes(editorPassword));

r = await send('', editorPath, { fullName: 'Chiamaka Eze', password: editorPassword, confirm: editorPassword });
check('accepting goes straight to 2FA setup', where(r) === '302 /admin/2fa/setup', where(r));
let editorTok = cookieOf(r);
r = await app.request(editorPath, {}, env);
check('the link works only once', r.status === 410 && (await r.text()).includes('already been used'));
r = await send('', editorPath, { fullName: 'Someone Else', password: 'quarry-rampart-sable', confirm: 'quarry-rampart-sable' });
check('a used link cannot create a second account', r.status === 410);
const [editor] = await q.select().from(adminUsers).where(eq(adminUsers.email, editorEmail));
check('the account has the invited role and their name', editor?.role === 'editor' && editor?.fullName === 'Chiamaka Eze');
r = await as(editorTok, '/admin/services');
check('a new account reaches nothing before 2FA setup', where(r) === '302 /admin/2fa/setup', where(r));

async function enrol(cookie: string): Promise<{ cookie: string; secret: Uint8Array }> {
  const page = await (await as(cookie, '/admin/2fa/setup')).text();
  const b32 = /data-secret[^>]*>([A-Z2-7 ]+)</.exec(page)![1]!.replace(/ /g, '');
  const k = base32Decode(b32);
  const res = await send(cookie, '/admin/2fa/setup', { code: await hotp(k, currentStep()) });
  return { cookie: cookieOf(res), secret: k };
}
editorTok = (await enrol(editorTok)).cookie;
r = await as(editorTok, '/admin');
check('after setup the editor is signed in', r.status === 200);

r = await send('', viewerPath, { fullName: 'Ngozi Reviewer', password: 'pewter-quarry-thistle', confirm: 'pewter-quarry-thistle' });
let viewerTok = (await enrol(cookieOf(r))).cookie;
const [viewer] = await q.select().from(adminUsers).where(eq(adminUsers.email, viewerEmail));

console.log('\nUsers: what each role can do');
r = await as(editorTok, '/admin/services');
check('editors see the New button', (await r.text()).includes('New service'));
r = await as(editorTok, '/admin');
check('editors do not see Users in the navigation', !(await r.text()).includes('href="/admin/users"'));
r = await as(editorTok, '/admin/users');
check('editors cannot open Users', r.status === 403 && (await r.text()).includes('Your role does not allow this'));
r = await send(editorTok, '/admin/users/invite', { email: 'sneaky@nueltek.dev', role: 'administrator' });
const sneakyInvite = await q.select().from(adminInvites).where(eq(adminInvites.email, 'sneaky@nueltek.dev'));
check('editors cannot invite, even by posting directly', r.status === 403 && sneakyInvite.length === 0);
r = await send(editorTok, '/admin/facts/new', { ...fact, topic: 'when Imo State was created' });
check('editors can add records', r.status === 302, `got ${r.status}`);

r = await as(viewerTok, '/admin/services');
body = await r.text();
check('viewers see records, with View instead of Edit and no New button', r.status === 200 && !body.includes('New service') && body.includes('>View<'));
r = await as(viewerTok, `/admin/services/${svc.id}`);
body = await r.text();
check('a record opens read-only for viewers', r.status === 200 && body.includes('<fieldset disabled') && !body.includes('Save changes'));
r = await as(viewerTok, '/admin/services/new');
check('viewers cannot open a blank form', r.status === 403);
const [feeBefore] = await q.select().from(services).where(eq(services.id, svc.id));
r = await send(viewerTok, `/admin/services/${svc.id}`, { ...scheme, feeAmount: '1' });
const [feeAfter] = await q.select().from(services).where(eq(services.id, svc.id));
check('viewers cannot change a record, even by posting directly', r.status === 403 && feeAfter.feeAmount === feeBefore.feeAmount);
r = await send(viewerTok, '/admin/agencies/new', { ...youth, name: 'Viewer Agency' });
const viewerAgency = await q.select().from(agencies).where(eq(agencies.name, 'Viewer Agency'));
check('viewers cannot create a record', r.status === 403 && viewerAgency.length === 0);
r = await as(viewerTok, '/admin/audit');
check('viewers can read the audit log', r.status === 200);
r = await send(viewerTok, '/admin/account/name', { fullName: 'Ngozi Okeke' });
check('viewers can still update their own name', where(r) === '302 /admin/account?saved=name', where(r));

console.log('\nUsers: managing other people');
r = await send(adminTok, `/admin/users/${viewer.id}/role`, { role: 'editor' });
check('an administrator can change a role', where(r) === `302 /admin/users/${viewer.id}?saved=role`, where(r));
r = await as(viewerTok, '/admin/services/new');
check('a role change applies on their next click, without signing out', r.status === 200);
await send(adminTok, `/admin/users/${viewer.id}/role`, { role: 'viewer' });

for (const action of ['role', 'deactivate', 'reset-2fa']) {
  r = await send(adminTok, `/admin/users/${me.id}/${action}`, { role: 'viewer' });
  check(`an administrator cannot ${action} their own account`, where(r) === `302 /admin/users/${me.id}?error=self`, where(r));
}
const [meAfter] = await q.select().from(adminUsers).where(eq(adminUsers.id, me.id));
check('...and nothing about their account changed', meAfter.role === 'administrator' && meAfter.isActive && meAfter.totpEnabledAt);

r = await send(adminTok, `/admin/users/${legacy.id}/deactivate`, {});
check('another account can be deactivated', where(r) === `302 /admin/users/${legacy.id}?saved=deactivated`, where(r));
r = await app.request('/admin', { headers: { cookie: `myimoguide_session=${legacySession.token}` } }, env);
check('deactivating ends their sessions at once', where(r) === '302 /admin/login', where(r));
const legacySessionsLeft = await q.select().from(adminSessions).where(eq(adminSessions.userId, legacy.id));
check('...by deleting them, so reactivating cannot bring them back', legacySessionsLeft.length === 0, `${legacySessionsLeft.length} left`);
r = await app.request('/admin/login', form({ email: legacyEmail, password: originalPassword }), env);
check('a deactivated account cannot sign in', r.status === 401);
r = await as(adminTok, '/admin/users');
check('Users warns when only one administrator is left', (await r.text()).includes('only one active administrator'));
r = await send(adminTok, '/admin/users/invite', { email: legacyEmail, role: 'editor' });
check('a deactivated person is reactivated, not re-invited', r.status === 422 && (await r.text()).includes('reactivate it instead'));
r = await send(adminTok, `/admin/users/${legacy.id}/reactivate`, {});
const [legacyBack] = await q.select().from(adminUsers).where(eq(adminUsers.id, legacy.id));
check('a deactivated account can be reactivated', where(r) === `302 /admin/users/${legacy.id}?saved=reactivated` && legacyBack.isActive);

r = await send(adminTok, `/admin/users/${editor.id}/reset-2fa`, {});
check('an administrator can reset someone else\'s 2FA', where(r) === `302 /admin/users/${editor.id}?saved=reset`, where(r));
const [editorReset] = await q.select().from(adminUsers).where(eq(adminUsers.id, editor.id));
check('...which removes their app and recovery codes', editorReset.totpEnabledAt === null && editorReset.totpSecret === null && editorReset.recoveryCodeHashes.length === 0);
r = await as(editorTok, '/admin');
check('...and signs them out', where(r) === '302 /admin/login', where(r));
r = await app.request('/admin/login', form({ email: editorEmail, password: editorPassword }), env);
check('...so their next sign-in sets up a new phone', where(r) === '302 /admin/2fa/setup', where(r));

r = await send(adminTok, `/admin/users/${viewer.id}/sign-out`, {});
r = await as(viewerTok, '/admin');
check('an administrator can sign someone out everywhere', where(r) === '302 /admin/login', where(r));

r = await send(adminTok, '/admin/users/invite', { email: 'wrong.person@nueltek.dev', role: 'editor' });
const wrongPath = `/admin/invite/${linkIn(await r.text())?.[2]}`;
const [wrongInvite] = await q.select().from(adminInvites).where(eq(adminInvites.email, 'wrong.person@nueltek.dev'));
r = await send(adminTok, `/admin/users/invites/${wrongInvite.id}/revoke`, {});
check('an invitation can be withdrawn', where(r) === '302 /admin/users?saved=revoked', where(r));
r = await app.request(wrongPath, {}, env);
check('...and its link stops working', r.status === 410);

r = await send(adminTok, '/admin/users/invite', { email: 'late.reader@nueltek.dev', role: 'viewer' });
const latePath = `/admin/invite/${linkIn(await r.text())?.[2]}`;
await q.update(adminInvites).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(adminInvites.email, 'late.reader@nueltek.dev'));
r = await app.request(latePath, {}, env);
check('an expired invitation says it has expired', r.status === 410 && (await r.text()).includes('has expired'));
r = await send('', latePath, { fullName: 'Late Reader', password: 'umber-verdant-willow', confirm: 'umber-verdant-willow' });
const lateAccount = await q.select().from(adminUsers).where(eq(adminUsers.email, 'late.reader@nueltek.dev'));
check('...and cannot be used', r.status === 410 && lateAccount.length === 0);

await ageConfirmation(me.id);
r = await send(adminTok, `/admin/users/${viewer.id}/role`, { role: 'administrator' });
const [viewerStill] = await q.select().from(adminUsers).where(eq(adminUsers.id, viewer.id));
check('a change after the confirmation expires is not carried out', where(r) === `302 /admin/confirm?next=%2Fadmin%2Fusers%2F${viewer.id}&repeat=1` && viewerStill.role === 'viewer', where(r));
r = await send(adminTok, '/admin/confirm', { code: recoveryCodes[3]!, next: `/admin/users/${viewer.id}` });
check('after confirming, it returns to that person\'s page', where(r) === `302 /admin/users/${viewer.id}`, where(r));

console.log('\nYour account');
r = await as(adminTok, '/admin/account');
body = await r.text();
check('the account page shows where you are signed in', r.status === 200 && body.includes('This session'));

await ageConfirmation(me.id);
r = await send(adminTok, '/admin/account/recovery-codes', {});
check('new recovery codes need a fresh code', where(r) === '302 /admin/confirm?next=%2Fadmin%2Faccount&repeat=1', where(r));
await send(adminTok, '/admin/confirm', { code: recoveryCodes[4]!, next: '/admin/account' });
r = await send(adminTok, '/admin/account/recovery-codes', {});
body = await r.text();
const newCodes = [...body.matchAll(/<span>([A-Z2-9]{5}-[A-Z2-9]{5})<\/span>/g)].map((m) => m[1]!);
const [afterRegen] = await q.select().from(adminUsers).where(eq(adminUsers.id, me.id));
check('new recovery codes are shown once', r.status === 200 && newCodes.length === 10 && body.includes('old ones no longer work'));
check('the old codes stop working', !afterRegen.recoveryCodeHashes.includes(await hashRecoveryCode(recoveryCodes[5]!)) &&
  afterRegen.recoveryCodeHashes.includes(await hashRecoveryCode(newCodes[0]!)));

const other = await createSession(db, me.id, {}, 'full');
r = await send(adminTok, '/admin/account/password', { current: 'not-my-password-at-all', password: 'juniper-kestrel-marble-9', confirm: 'juniper-kestrel-marble-9' });
check('changing password needs the current one', r.status === 422 && (await r.text()).includes('current password is not correct'));
const wrongCurrent = await q.select().from(auditLog).where(eq(auditLog.action, 'login_failed'));
check('...and a wrong current password counts towards the sign-in limit', wrongCurrent.some((x: any) => x.actorEmail === email && x.after?.reason === 'wrong_current_password'));
r = await send(adminTok, '/admin/account/password', { current: password, password: 'short', confirm: 'short' });
check('a weak new password is refused', r.status === 422 && (await r.text()).includes('must be at least 12 characters'));
r = await send(adminTok, '/admin/account/password', { current: password, password: 'juniper-kestrel-marble-9', confirm: 'juniper-kestrel-marble-9' });
check('the password can be changed', where(r) === '302 /admin/account?saved=password', where(r));
password = 'juniper-kestrel-marble-9';
r = await app.request('/admin', { headers: { cookie: `myimoguide_session=${other.token}` } }, env);
check('changing it signs you out everywhere else', where(r) === '302 /admin/login', where(r));
r = await as(adminTok, '/admin');
check('...but not here', r.status === 200);

const other2 = await createSession(db, me.id, {}, 'full');
r = await send(adminTok, '/admin/account/sessions/end-others', {});
r = await app.request('/admin', { headers: { cookie: `myimoguide_session=${other2.token}` } }, env);
check('you can sign yourself out everywhere else', where(r) === '302 /admin/login' && (await as(adminTok, '/admin')).status === 200);

console.log('\nUsers: the record');
const record = await q.select().from(auditLog);
const has = (action: string, pred: (x: any) => boolean = () => true) => record.some((x: any) => x.action === action && pred(x));
check('invitations are recorded against who sent them', has('user_invited', (x) => x.actorEmail === email && x.after?.email === editorEmail));
check('joining is recorded against the new person', has('user_joined', (x) => x.actorEmail === editorEmail && x.after?.invitedBy === email));
check('role changes keep before and after', has('role_changed', (x) => x.before?.role === 'viewer' && x.after?.role === 'editor'));
check('deactivation, reactivation, 2FA reset, remote sign-out and withdrawn invites are recorded',
  ['user_deactivated', 'user_reactivated', 'twofa_reset', 'sessions_ended', 'invite_revoked', 'password_changed', 'recovery_codes_replaced'].every((a) => has(a)));
r = await as(adminTok, '/admin/audit');
body = await r.text();
check('the audit page labels them in plain words', ['Invited', 'Joined', 'Role changed', 'Deactivated', 'Viewer → Editor'].every((t) => body.includes(t)));
r = await as(adminTok, `/admin/users/${editor.id}`);
check('each person\'s page shows what they have done', (await r.text()).includes('Recent activity'));

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
r = await app.request('/admin/login', form({ email: legacyEmail, password: originalPassword }), env);
check('other accounts are not locked by it', where(r) === '302 /admin/2fa/setup', where(r));

void adminSessions;

console.log(failed ? `\n${failed} FAILED\n` : '\ne2e passed\n');
process.exit(failed || process.exitCode ? 1 : 0);
