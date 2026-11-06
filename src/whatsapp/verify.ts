/**
 * Meta signs every webhook POST with HMAC-SHA256 over the RAW body, sent as
 * `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Two things matter here:
 *  - verify against the raw bytes, never a re-serialised JSON object;
 *  - compare in constant time, so the check cannot be probed byte by byte.
 *
 * Web Crypto's `subtle.verify` does the comparison inside the runtime, which
 * is both constant-time and cheaper in CPU than hashing and comparing
 * ourselves — this runs on every request against a 10 ms free-plan budget.
 */

const encoder = new TextEncoder();

/** Cache the imported key per secret; importKey is the expensive part. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keyCache.set(secret, key);
  }
  return key;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length !== 64 || /[^0-9a-f]/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * @param rawBody the exact bytes Meta sent
 * @param header  the `X-Hub-Signature-256` header value, or null
 */
export async function isValidSignature(
  rawBody: ArrayBuffer,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;

  const signature = hexToBytes(header.slice(7).toLowerCase());
  if (!signature) return false;

  return crypto.subtle.verify('HMAC', await hmacKey(appSecret), signature, rawBody);
}

/**
 * The one-time GET handshake Meta performs when you save the webhook URL.
 * Returns the challenge to echo back, or null to reject.
 */
export function verificationChallenge(url: URL, verifyToken: string): string | null {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || !challenge) return null;
  if (!token || !timingSafeEqualString(token, verifyToken)) return null;

  return challenge;
}

/** Constant-time string compare for the verify token. */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  // Length is not secret here, but keep the loop fixed-width anyway.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
