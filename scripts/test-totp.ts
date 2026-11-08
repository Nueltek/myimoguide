/**
 * TOTP and recovery codes, checked against the specifications' own
 * published test vectors — not against values this code produced.
 *
 *   RFC 4226 Appendix D: HOTP, secret "12345678901234567890", 6 digits
 *   RFC 6238 Appendix B: TOTP SHA-1, same secret, 8 digits
 *
 *   npm run test:totp
 */
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  normaliseRecoveryCode,
  verifyTotp,
} from '../src/admin/totp';
import { loadKey, open, seal } from '../src/admin/secretbox';

const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    console.log(`  pass  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log('\nRFC 4226 Appendix D — HOTP');
const HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
for (const [counter, expected] of HOTP.entries()) {
  await check(`counter ${counter} -> ${expected}`, async () => assert.equal(await hotp(RFC_SECRET, counter), expected));
}

console.log('\nRFC 6238 Appendix B — TOTP SHA-1, 8 digits');
const TOTP: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [t, expected] of TOTP) {
  await check(`t=${t} -> ${expected}`, async () => assert.equal(await hotp(RFC_SECRET, Math.floor(t / 30), 8), expected));
}

console.log('\nBase32');
await check('encodes the RFC secret correctly', () => assert.equal(base32Encode(RFC_SECRET), RFC_SECRET_B32));
await check('decodes back to the same bytes', () => assert.deepEqual(base32Decode(RFC_SECRET_B32), RFC_SECRET));
await check('decoding ignores spaces and case, as people type it', () =>
  assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), RFC_SECRET));
await check('generated secrets are 160 bits (32 base32 chars)', () => assert.equal(generateSecret().length, 32));
await check('generated secrets differ', () => assert.notEqual(generateSecret(), generateSecret()));

console.log('\nVerification window and replay');
// At t=59s the step is 1; the RFC gives HOTP(1) = 287082.
const t59 = 59_000;
await check('accepts the current code', async () => assert.deepEqual(await verifyTotp(RFC_SECRET_B32, '287082', null, t59), { ok: true, step: 1 }));
await check('accepts a code one step old (clock drift)', async () =>
  assert.equal((await verifyTotp(RFC_SECRET_B32, '755224', null, t59)).ok, true));
await check('accepts a code one step ahead (clock drift)', async () =>
  assert.equal((await verifyTotp(RFC_SECRET_B32, '359152', null, t59)).ok, true));
await check('rejects a code two steps away', async () =>
  assert.deepEqual(await verifyTotp(RFC_SECRET_B32, '969429', null, t59), { ok: false, reason: 'mismatch' }));
await check('rejects a code already used (replay)', async () =>
  assert.deepEqual(await verifyTotp(RFC_SECRET_B32, '287082', 1, t59), { ok: false, reason: 'replay' }));
await check('rejects an older code once a newer one is used', async () =>
  assert.deepEqual(await verifyTotp(RFC_SECRET_B32, '755224', 1, t59), { ok: false, reason: 'replay' }));
await check('rejects anything not six digits', async () =>
  assert.deepEqual(await verifyTotp(RFC_SECRET_B32, '28708', null, t59), { ok: false, reason: 'format' }));
await check('tolerates a space typed in the middle', async () =>
  assert.equal((await verifyTotp(RFC_SECRET_B32, '287 082', null, t59)).ok, true));

console.log('\nRecovery codes');
const codes = generateRecoveryCodes();
await check('ten codes are issued', () => assert.equal(codes.length, 10));
await check('all ten are distinct', () => assert.equal(new Set(codes).size, 10));
await check('format is XXXXX-XXXXX with no 0, O, 1, I or L', () =>
  assert.ok(codes.every((c) => /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(c)), codes.join(' ')));
await check('matching ignores case and the hyphen', async () =>
  assert.equal(await hashRecoveryCode(codes[0]!.toLowerCase().replace('-', ' ')), await hashRecoveryCode(codes[0]!)));
await check('a recovery code is told apart from an app code', () => {
  assert.equal(looksLikeRecoveryCode(codes[0]!), true);
  assert.equal(looksLikeRecoveryCode('287082'), false);
});
await check('normalising strips everything but letters and digits', () => assert.equal(normaliseRecoveryCode('ab-cd e'), 'ABCDE'));

console.log('\nSecrets at rest');
const keyB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const key = await loadKey(keyB64);
const sealed = await seal(RFC_SECRET_B32, key, 'user-a');
await check('a sealed secret does not contain the plaintext', () => assert.ok(!sealed.includes(RFC_SECRET_B32)));
await check('it opens back to the original', async () => assert.equal(await open(sealed, key, 'user-a'), RFC_SECRET_B32));
await check('sealing twice gives different ciphertext (random IV)', async () => assert.notEqual(await seal(RFC_SECRET_B32, key, 'user-a'), sealed));
await check('copied onto another account, it refuses to open', async () => {
  await assert.rejects(open(sealed, key, 'user-b'));
});
await check('tampered ciphertext refuses to open', async () => {
  const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
  await assert.rejects(open(flipped, key, 'user-a'));
});
await check('the wrong key refuses to open', async () => {
  const other = await loadKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  await assert.rejects(open(sealed, other, 'user-a'));
});
await check('a missing key is a clear error, not a crash later', async () => {
  await assert.rejects(loadKey(undefined), /TOTP_ENCRYPTION_KEY is not set/);
});
await check('a key of the wrong length is refused', async () => {
  await assert.rejects(loadKey(Buffer.from('short').toString('base64')), /must be 32 bytes/);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
