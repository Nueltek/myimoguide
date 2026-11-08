/**
 * Time-based one-time passwords (RFC 6238) and recovery codes.
 *
 * Parameters are the authenticator-app defaults — HMAC-SHA1, 6 digits,
 * 30-second steps — because they are what Google Authenticator, Microsoft
 * Authenticator, Authy and 1Password all accept without configuration. A
 * stronger hash that half of officials' phones reject is not stronger.
 *
 * Verified against the RFC's own published test vectors in
 * scripts/test-totp.ts.
 */

const enc = new TextEncoder();
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept one step either side, for clock drift between server and phone. */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 160 bits, the size RFC 4226 recommends for an HMAC-SHA1 key. */
export function generateSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** RFC 4226 HOTP. `counter` is the time step for TOTP. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits = TOTP_DIGITS,
  hash: 'SHA-1' | 'SHA-256' | 'SHA-512' = 'SHA-1',
): Promise<string> {
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  // 64-bit big-endian counter. Steps fit comfortably in 53 bits.
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));

  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Checks a submitted code. Returns the time step it matched, so the
 * caller can refuse any code at or before the last step used — without
 * that, a code read over someone's shoulder stays valid for its full
 * 90-second window.
 */
export async function verifyTotp(
  secretB32: string,
  code: string,
  lastUsedStep: number | null,
  nowMs = Date.now(),
): Promise<{ ok: true; step: number } | { ok: false; reason: 'format' | 'mismatch' | 'replay' }> {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return { ok: false, reason: 'format' };

  const secret = base32Decode(secretB32);
  const now = currentStep(nowMs);
  let matched: number | null = null;

  // Check every candidate step rather than stopping at the first match,
  // so the time taken does not reveal which step matched.
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const step = now + d;
    if (timingSafeEqual(await hotp(secret, step), digits) && matched === null) matched = step;
  }

  if (matched === null) return { ok: false, reason: 'mismatch' };
  if (lastUsedStep !== null && matched <= lastUsedStep) return { ok: false, reason: 'replay' };
  return { ok: true, step: matched };
}

export function otpauthUri(secretB32: string, account: string, issuer = 'MyImoGuide'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Groups a base32 secret in fours so it can be typed without losing your place. */
export function formatSecret(secretB32: string): string {
  return secretB32.match(/.{1,4}/g)?.join(' ') ?? secretB32;
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

/**
 * The way back in when a phone is lost.
 *
 * Without these, a lost phone locks an official out of a government
 * system until someone with database access intervenes. Ten one-time
 * codes, shown once, stored only as hashes. Readable alphabet: no 0/O
 * or 1/I/L to misread from a printout.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    codes.push(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return codes;
}

/** Codes are compared case- and separator-insensitively. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(normaliseRecoveryCode(code)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Does this look like a recovery code rather than a 6-digit app code? */
export function looksLikeRecoveryCode(input: string): boolean {
  return normaliseRecoveryCode(input).length === 10 && /[A-Z]/.test(input.toUpperCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
