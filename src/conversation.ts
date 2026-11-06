import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

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
  }

  /**
   * True the first time a message id is seen.
   *
   * Meta redelivers on any slow or failed webhook response, and the queue
   * itself is at-least-once. Without this the user gets the same answer
   * twice, which looks broken in a live demo.
   */
  async claimMessage(messageId: string): Promise<boolean> {
    const existing = this.sql
      .exec('SELECT 1 FROM seen WHERE message_id = ?', messageId)
      .toArray();
    if (existing.length > 0) return false;

    this.sql.exec('INSERT INTO seen (message_id, at) VALUES (?, ?)', messageId, Date.now());
    // Keep the table small; ids older than a day cannot still be retried.
    this.sql.exec('DELETE FROM seen WHERE at < ?', Date.now() - 86_400_000);
    return true;
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

  async append(role: Turn['role'], text: string): Promise<void> {
    this.sql.exec('INSERT INTO turns (role, text, at) VALUES (?, ?, ?)', role, text, Date.now());
    // Keep only the last 20 turns — context beyond that is noise and tokens.
    this.sql.exec(
      'DELETE FROM turns WHERE id NOT IN (SELECT id FROM turns ORDER BY id DESC LIMIT 20)',
    );
  }
}
