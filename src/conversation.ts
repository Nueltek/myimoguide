import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';
import { type ClaimState, decideClaim } from './dedupe';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/**
 * Per-user conversation state and rate limiting.
 *
 * SQLite-backed Durable Object — these are on the Workers free plan, unlike
 * the KV-backed ones. One instance per WhatsApp number, addressed by
 * `idFromName(phoneNumber)`, so all of a user's messages land on the same
 * instance and serialise naturally.
 */
export class Conversation extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        role    TEXT NOT NULL,
        text    TEXT NOT NULL,
        at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (
        message_id TEXT PRIMARY KEY,
        at         INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hits (
        at INTEGER NOT NULL
      );
    `);

    // Instances created before the two-state fix have a `seen` table with
    // no status column. Add it; existing rows default to 'done', which is
    // correct — they finished, or are too old to be retried anyway.
    try {
      this.sql.exec(`ALTER TABLE seen ADD COLUMN status TEXT NOT NULL DEFAULT 'done'`);
    } catch {
      // Column already exists.
    }
  }

  /**
   * True the first time a message id is seen.
   *
   * Meta redelivers on any slow or failed webhook response, and the queue
   * itself is at-least-once. Without this the user gets the same answer
   * twice, which looks broken in a live demo.
   */
  async claimMessage(messageId: string, attempt: number): Promise<boolean> {
    const row = this.sql
      .exec('SELECT status FROM seen WHERE message_id = ?', messageId)
      .toArray()[0];
    const state = (row?.status as ClaimState) ?? undefined;

    // See src/dedupe.ts for why attempt matters. The short version: the
    // original claimed a message as finished before doing any work, so
    // every retry was mistaken for a duplicate and silently dropped.
    if (decideClaim(state, attempt) === 'skip') return false;

    this.sql.exec(
      `INSERT INTO seen (message_id, at, status) VALUES (?, ?, 'processing')
       ON CONFLICT(message_id) DO UPDATE SET at = excluded.at, status = 'processing'`,
      messageId,
      Date.now(),
    );
    // Keep the table small; ids older than a day cannot still be retried.
    this.sql.exec('DELETE FROM seen WHERE at < ?', Date.now() - 86_400_000);
    return true;
  }

  /** Called only once a reply has actually been delivered. */
  async markDone(messageId: string): Promise<void> {
    this.sql.exec(`UPDATE seen SET status = 'done' WHERE message_id = ?`, messageId);
  }

  async isDone(messageId: string): Promise<boolean> {
    const row = this.sql.exec('SELECT status FROM seen WHERE message_id = ?', messageId).toArray()[0];
    return row?.status === 'done';
  }

  /** Sliding window. Returns false when the user is over the limit. */
  async allow(maxPerWindow = 20, windowMs = 300_000): Promise<boolean> {
    const cutoff = Date.now() - windowMs;
    this.sql.exec('DELETE FROM hits WHERE at < ?', cutoff);

    const row = this.sql.exec('SELECT COUNT(*) AS n FROM hits').one();
    if (Number(row.n) >= maxPerWindow) return false;

    this.sql.exec('INSERT INTO hits (at) VALUES (?)', Date.now());
    return true;
  }

  /** Recent turns, oldest first, for follow-up questions like "and the fee?". */
  async recent(limit = 6): Promise<Turn[]> {
    const rows = this.sql
      .exec('SELECT role, text, at FROM turns ORDER BY id DESC LIMIT ?', limit)
      .toArray();
    return rows
      .map((r) => ({ role: r.role as Turn['role'], text: String(r.text), at: Number(r.at) }))
      .reverse();
  }

  /**
   * Forgets the conversation so far. Used when a message has failed on
   * every attempt: whatever caused it, a user must never be stuck because
   * something in their own history keeps breaking every later message.
   */
  async forget(): Promise<void> {
    this.sql.exec('DELETE FROM turns');
  }

  async append(role: Turn['role'], text: string): Promise<void> {
    this.sql.exec('INSERT INTO turns (role, text, at) VALUES (?, ?, ?)', role, text, Date.now());
    // Keep only the last 20 turns — context beyond that is noise and tokens.
    this.sql.exec(
      'DELETE FROM turns WHERE id NOT IN (SELECT id FROM turns ORDER BY id DESC LIMIT 20)',
    );
  }
}
