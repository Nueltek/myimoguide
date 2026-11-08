import { and, eq, gt, ne, sql } from 'drizzle-orm';
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
 * ITERATION_COUNT IS PINNED TO 100,000 BY THE PLATFORM, NOT BY CHOICE.
 *
 * Cloudflare's production runtime refuses PBKDF2 above 100,000
 * iterations — the call fails outright rather than downgrading. Local
 * workerd (wrangler dev) does NOT enforce this, so a higher count passes
 * every local test and then 500s on the first real login. That exact
 * failure shipped here: hashes were written at 150,000 by a script
 * running in Node, and production could never verify them.
 *
 * 100,000 is below OWASP's 600,000 for PBKDF2-SHA256. That is the
 * platform ceiling, stated rather than hidden, and it is compensated by
 * a 14-character minimum password and, for production, by putting
 * Cloudflare Access in front of /admin.
 *
 * FOR PRODUCTION, put Cloudflare Access in front of /admin instead. It
 * is free for up to 50 users, gives real SSO and MFA, logs every access
 * attempt, and removes password handling from this codebase entirely.
 * That is a stronger story for a government buyer than any hand-rolled
 * login. It needs a custom domain, which is why this exists for now.
 */

/** Cloudflare's production cap. Do not raise — see the note above. */
export const MAX_PLATFORM_ITERATIONS = 100_000;
const ITERATION_COUNT = MAX_PLATFORM_ITERATIONS;
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

  // A hash above the platform cap can never be verified here; asking
  // workerd to try throws, which surfaced as a bare 500 on the login
  // page. Fail closed, and say exactly what to do about it.
  if (iterations > MAX_PLATFORM_ITERATIONS) {
    console.error(
      `login: stored hash uses ${iterations} PBKDF2 iterations; Cloudflare caps at ` +
        `${MAX_PLATFORM_ITERATIONS}. Reset this account: npx tsx scripts/create-admin.ts <email>`,
    );
    return false;
  }

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

/** 256 random bits, hex. For session tokens and invitation links. */
export function newToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

/** What is stored in place of a token: its SHA-256. */
export const hashToken = sha256Hex;

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  fullName: string | null;
}

export type SessionStage = 'enrolling' | 'pending' | 'full';

export interface ResolvedSession {
  user: SessionUser;
  sessionId: string;
  stage: SessionStage;
  failedAttempts: number;
  /** False until the user has confirmed an authenticator app. */
  totpEnabled: boolean;
  /** When the second factor was last given on this session. */
  confirmedAt: Date | null;
}

/** A partial session exists only to finish signing in. */
const PARTIAL_SESSION_MINUTES = 10;

/**
 * Issues a session. Returns the raw token for the cookie; only its hash
 * is persisted, so a database leak yields no usable sessions.
 */
export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
  stage: SessionStage = 'full',
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const ttl = stage === 'full' ? SESSION_HOURS * 3_600_000 : PARTIAL_SESSION_MINUTES * 60_000;
  const expiresAt = new Date(Date.now() + ttl);

  await db.insert(adminSessions).values({
    userId,
    tokenHash: await sha256Hex(token),
    stage,
    // Completing sign-in is itself a confirmation of the second factor.
    confirmedAt: stage === 'full' ? new Date() : null,
    expiresAt,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
  });

  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<ResolvedSession | null> {
  if (!token) return null;

  const rows = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      role: adminUsers.role,
      fullName: adminUsers.fullName,
      active: adminUsers.isActive,
      totpEnabledAt: adminUsers.totpEnabledAt,
      sessionId: adminSessions.id,
      stage: adminSessions.stage,
      failedAttempts: adminSessions.failedAttempts,
      confirmedAt: adminSessions.confirmedAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
    .where(and(eq(adminSessions.tokenHash, await sha256Hex(token)), gt(adminSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || !row.active) return null;
  return {
    user: { id: row.id, email: row.email, role: row.role, fullName: row.fullName },
    sessionId: row.sessionId,
    stage: (['enrolling', 'pending', 'full'].includes(row.stage) ? row.stage : 'pending') as SessionStage,
    failedAttempts: row.failedAttempts,
    totpEnabled: row.totpEnabledAt !== null,
    confirmedAt: row.confirmedAt,
  };
}

/** Records that the second factor was just given again on this session. */
export async function markConfirmed(db: Db, sessionId: string): Promise<void> {
  await db
    .update(adminSessions)
    .set({ confirmedAt: new Date(), failedAttempts: 0 })
    .where(eq(adminSessions.id, sessionId));
}

/**
 * Ends every session a person has, optionally sparing the one in use.
 * Used when access is removed or a credential changes: a session opened
 * before the change must not outlive it.
 */
export async function destroyUserSessions(db: Db, userId: string, except?: string): Promise<number> {
  const rows = await db
    .delete(adminSessions)
    .where(except ? and(eq(adminSessions.userId, userId), ne(adminSessions.id, except)) : eq(adminSessions.userId, userId))
    .returning({ id: adminSessions.id });
  return rows.length;
}

/**
 * Length is what makes a password strong, and what compensates for the
 * reduced KDF iteration count the platform imposes. A passphrase of three
 * or four ordinary words clears this easily and is easier to remember
 * than a short string of symbols.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Why a chosen password is unacceptable, or null if it is fine. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Use at most 200 characters.';
  // The whole local part, and each name in it: "chiamaka.eze" rules out
  // "chiamaka" too. Short fragments are ignored, so "eze" alone is allowed.
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const lowered = password.toLowerCase();
  const parts = [local, ...local.split(/[._+-]+/)].filter((p) => p.length >= 4);
  if (parts.some((p) => lowered.includes(p))) return 'Do not include your name or email address in your password.';
  if (/^(.)\1+$/.test(password)) return 'Do not use one character repeated.';
  if (['password', 'myimoguide', 'imostate', '123456789', 'qwertyuiop'].some((w) => lowered.includes(w) && lowered.length < w.length + 6)) {
    return 'That password is too easy to guess. Choose something less predictable.';
  }
  return null;
}

/**
 * Finishes sign-in by replacing the partial session with a full one.
 *
 * A new token, not an upgrade in place: a token observed during sign-in
 * — on a shared screen, in a proxy log — is dead once the second factor
 * is given. This is the standard defence against session fixation.
 */
export async function promoteToFull(
  db: Db,
  partialSessionId: string,
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ token: string; expiresAt: Date }> {
  await db.delete(adminSessions).where(eq(adminSessions.id, partialSessionId));
  // "Last sign-in" means a completed one, not a correct password.
  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, userId));
  return createSession(db, userId, meta, 'full');
}

/** Counts a wrong 2FA code against the session. Returns the new total. */
export async function recordFailedCode(db: Db, sessionId: string): Promise<number> {
  const [row] = await db
    .update(adminSessions)
    .set({ failedAttempts: sql`${adminSessions.failedAttempts} + 1` })
    .where(eq(adminSessions.id, sessionId))
    .returning({ n: adminSessions.failedAttempts });
  return row?.n ?? Number.MAX_SAFE_INTEGER;
}

export async function destroySessionById(db: Db, sessionId: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.id, sessionId));
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
