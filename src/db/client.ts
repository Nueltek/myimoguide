import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

/**
 * Neon over HTTP, not TCP.
 *
 * Workers cannot hold a pooled TCP connection across requests, and the
 * isolate may be torn down between invocations. The `neon-http` driver
 * sends each statement as a single HTTPS request, which suits a Worker and
 * needs no Hyperdrive on the free plan.
 *
 * The trade-off: no interactive transactions. Multi-statement work uses
 * `db.batch([...])`, which Neon runs as one atomic request.
 *
 * Each statement costs one subrequest against the free plan's 50 per
 * invocation, so the consumer should query once and reuse the row.
 */
export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema, casing: 'snake_case' });
}

export type Db = ReturnType<typeof createDb>;
