import type { Context } from 'hono';
import type { Env } from '../types';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema';
import type { SessionUser } from './auth';

export type Ctx = { Bindings: Env; Variables: { db: Db; user: SessionUser } };

/**
 * Append-only audit entry. Never updated, never deleted.
 *
 * A real security control, and the first thing a government buyer asks
 * about: who changed this published fee, and when. Every write in the
 * dashboard goes through here.
 */
export async function audit(
  c: Context<Ctx>,
  action: 'create' | 'update' | 'login',
  table: string,
  rowId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  const user = c.get('user');
  await c.get('db').insert(auditLog).values({
    actorId: user.id,
    actorEmail: user.email,
    action,
    tableName: table,
    rowId,
    before: before ?? null,
    after: after ?? null,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
  });
}

/** Postgres unique-violation, so a duplicate becomes a field error, not a 500. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}
