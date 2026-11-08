import { and, count, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema';

/**
 * Sign-in throttling.
 *
 * Failed password attempts are written to the audit log — which makes
 * the login page's "sign-in attempts are logged" true, where before it
 * was not — and the same rows drive the limit. No separate counter to
 * drift out of step with the record.
 *
 * Two limits, because they stop different attacks:
 *
 *   Per account (5 in 15 minutes) stops guessing one official's password.
 *
 *   Per address (20 in 15 minutes) stops one machine trying many
 *   accounts. It is set well above the account limit because a ministry
 *   puts many staff behind one public IP, and a single typo-prone
 *   colleague must not lock out the whole office.
 *
 * The known cost: someone who knows an official's email can lock that
 * account for 15 minutes by failing on purpose. That is the standard
 * trade, and far better than unlimited guessing. The production answer
 * is Cloudflare Access in front of /admin.
 */

const WINDOW_MINUTES = 15;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_ADDRESS = 20;

export async function isThrottled(
  db: Db,
  email: string,
  ip: string | null,
): Promise<{ blocked: false } | { blocked: true; minutes: number }> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  const recent = and(eq(auditLog.action, 'login_failed'), gt(auditLog.createdAt, since));

  const [byAccount] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(recent, eq(auditLog.actorEmail, normalise(email))));

  if ((byAccount?.n ?? 0) >= MAX_PER_ACCOUNT) return { blocked: true, minutes: WINDOW_MINUTES };

  if (ip) {
    const [byAddress] = await db
      .select({ n: count() })
      .from(auditLog)
      .where(and(recent, eq(auditLog.ipAddress, ip)));
    if ((byAddress?.n ?? 0) >= MAX_PER_ADDRESS) return { blocked: true, minutes: WINDOW_MINUTES };
  }
  return { blocked: false };
}

export async function recordFailedLogin(db: Db, email: string, ip: string | null, reason: string): Promise<void> {
  await db.insert(auditLog).values({
    actorId: null,
    // The email as typed, so attempts against non-existent accounts are
    // visible too — that pattern is exactly what an audit should surface.
    actorEmail: normalise(email) || '(blank)',
    action: 'login_failed',
    tableName: 'admin_users',
    rowId: null,
    before: null,
    after: { reason },
    ipAddress: ip,
  });
}

function normalise(email: string): string {
  return email.trim().toLowerCase().slice(0, 160);
}

// Re-exported for the sign-in page's wording.
export const THROTTLE = { WINDOW_MINUTES, MAX_PER_ACCOUNT } as const;
