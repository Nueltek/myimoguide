import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { adminSessions, adminUsers } from '../db/schema';

/**
 * Dashboard authentication.
 *
 * WHY PBKDF2 AND NOT ARGON2ID
 *
 * Argon2id is the better password hash and the usual recommendation. It
 * is not available in the Workers runtime without shipping a WASM build,
 * which costs bundle size, and — the deciding factor — a memory-hard KDF
 * is exactly the wrong shape for a platform that bills CPU per
 * invocation. PBKDF2-HMAC-SHA256 is native to WebCrypto, runs inside the
 * runtime rather than in JS, and is an accepted choice when argon2 and
 * scrypt are unavailable.
 *
 * ITERATION_COUNT is below OWASP's 600,000 for PBKDF2-SHA256, and that
 * is a deliberate, stated trade-off against the Workers CPU ceiling
 * rather than an oversight. It is compensated by a strict minimum
 * password length, mandatory TOTP, and login rate limiting.
 *
 * FOR PRODUCTION, put Cloudflare Access in front of /admin instead. It
 * is free for up to 50 users, gives real SSO and MFA, logs every access
 * attempt, and removes password handling from this codebase entirely.
 * That is a stronger story for a government buyer than any hand-rolled
 * login. It needs a custom domain, which is why this exists for now.
 */

const ITERATION_COUNT = 150_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const SESSION_HOURS = 8;
export const SESSION_COOKIE = 'myimoguide_session';

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return toHex(bits);
}

/** Stored as `pbkdf2$<iterations>$<saltHex>$<hashHex>` so it can be upgraded later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATION_COUNT);
  return `pbkdf2$${ITERATION_COUNT}$${toHex(salt.buffer)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, expected] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltHex || !expected) return false;

  const iterations = Number.parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  const actual = await derive(password, fromHex(saltHex), iterations);

  // Constant time. A length check first is safe: both are fixed-width hex.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

/**
 * Issues a session. Returns the raw token for the cookie; only its hash
 * is persisted, so a database leak yields no usable sessions.
 */
export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ token: string; expiresAt: Date }> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);

  await db.insert(adminSessions).values({
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });

  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const rows = await db
    .select({ id: adminUsers.id, email: adminUsers.email, role: adminUsers.role, active: adminUsers.isActive })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
    .where(and(eq(adminSessions.tokenHash, await sha256Hex(token)), gt(adminSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || !row.active) return null;
  return { id: row.id, email: row.email, role: row.role };
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, await sha256Hex(token)));
}

/**
 * Cookie attributes, all of them load-bearing.
 *
 * HttpOnly keeps the token away from any script on the page, so an XSS
 * bug cannot read it. Secure keeps it off plaintext connections.
 * SameSite=Strict blocks it from cross-site requests, which is CSRF
 * protection for every state-changing form in the dashboard.
 */
export function sessionCookie(token: string, expiresAt: Date): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/admin',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ].join('; ');
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
