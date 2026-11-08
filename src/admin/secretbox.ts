/**
 * Encryption at rest for 2FA secrets.
 *
 * A TOTP secret is a standing credential: whoever holds it can generate
 * valid codes forever. Stored in plain text, a database leak would hand
 * an attacker the second factor for every account, defeating the point
 * of having one. So it is sealed with AES-256-GCM under a key held as a
 * Wrangler secret, outside the database. A leak of either alone yields
 * nothing usable.
 *
 * The user's id is bound in as additional authenticated data, so a
 * ciphertext copied onto another account's row fails to decrypt rather
 * than quietly granting that account the first one's codes.
 *
 * Generate the key once:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   npx wrangler secret put TOTP_ENCRYPTION_KEY
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = 'v1';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class MissingKeyError extends Error {
  constructor(detail: string) {
    super(`TOTP_ENCRYPTION_KEY ${detail}. Generate one and run: npx wrangler secret put TOTP_ENCRYPTION_KEY`);
    this.name = 'MissingKeyError';
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

export function loadKey(raw: string | undefined): Promise<CryptoKey> {
  if (!raw) return Promise.reject(new MissingKeyError('is not set'));
  let key = keyCache.get(raw);
  if (!key) {
    let bytes: Uint8Array;
    try {
      bytes = fromB64(raw.trim());
    } catch {
      return Promise.reject(new MissingKeyError('is not valid base64'));
    }
    if (bytes.length !== 32) return Promise.reject(new MissingKeyError(`must be 32 bytes, got ${bytes.length}`));
    key = crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, key);
  }
  return key;
}

export async function seal(plaintext: string, key: CryptoKey, boundTo: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(boundTo) },
      key,
      enc.encode(plaintext),
    ),
  );
  return `${VERSION}.${b64url(iv)}.${b64url(ct)}`;
}

export async function open(sealed: string, key: CryptoKey, boundTo: string): Promise<string> {
  const [version, iv, ct] = sealed.split('.');
  if (version !== VERSION || !iv || !ct) throw new Error('unrecognised sealed value');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv) as BufferSource, additionalData: enc.encode(boundTo) },
    key,
    fromB64(ct) as BufferSource,
  );
  return dec.decode(pt);
}
