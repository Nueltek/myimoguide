import { Hono } from 'hono';
import type { Env, InboundJob } from './types';
import type { WhatsAppWebhookBody } from './whatsapp/types';
import { isValidSignature, verificationChallenge } from './whatsapp/verify';
import { handleBatch, handleDeadLetter } from './queue/consumer';
import { activeConfig } from './agent/models';
import { admin } from './admin/routes';
import { createDb } from './db/client';
import { sql } from 'drizzle-orm';

export { Conversation } from './conversation';

const app = new Hono<{ Bindings: Env }>();

/**
 * Reports which provider and models are live, so a provider switch can be
 * confirmed from outside rather than assumed. Never exposes a key — only
 * whether one is present.
 */
app.get('/health', async (c) => {
  const base = { service: 'myimoguide', ...activeConfig(c.env) };

  // Check the schema, not just that the process is up. A missing
  // migration is otherwise invisible until someone hits the one route
  // that touches the missing table — which is how a working deploy can
  // still fail at the login screen.
  let database: { ok: boolean; missingTables?: string[]; error?: string };
  try {
    const db = createDb(c.env.DATABASE_URL);
    const expected = [
      'agencies', 'services', 'facilities', 'state_facts',
      'queries', 'admin_users', 'admin_sessions', 'audit_log',
    ];
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    // The neon-http driver has returned both a bare array and a {rows}
    // envelope across versions. Accept either rather than depending on it.
    const rows: Array<{ table_name: string }> = Array.isArray(result)
      ? result
      : ((result as { rows?: Array<{ table_name: string }> }).rows ?? []);
    const present = new Set(rows.map((r) => r.table_name));
    const missing = expected.filter((t) => !present.has(t));
    database = missing.length
      ? { ok: false, missingTables: missing }
      : { ok: true };
  } catch (err) {
    database = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return c.json({ ok: database.ok, ...base, database }, database.ok ? 200 : 503);
});

/** Meta's one-time handshake when the webhook URL is saved. */
app.get('/webhook/whatsapp', (c) => {
  const challenge = verificationChallenge(new URL(c.req.url), c.env.WHATSAPP_VERIFY_TOKEN);
  if (!challenge) return c.text('Forbidden', 403);
  return c.text(challenge, 200);
});

/**
 * Inbound messages.
 *
 * This handler does exactly three things: verify the signature, enqueue,
 * return 200. No database, no model, no media fetch. Meta retries
 * aggressively on a slow or failed response, and a duplicated retry in
 * front of a commissioner is the failure mode to design out.
 */
app.post('/webhook/whatsapp', async (c) => {
  // Raw bytes — the signature is over what Meta sent, not over a
  // re-serialised object.
  const raw = await c.req.arrayBuffer();

  const valid = await isValidSignature(
    raw,
    c.req.header('x-hub-signature-256') ?? null,
    c.env.WHATSAPP_APP_SECRET,
  );
  if (!valid) {
    console.warn(
      'webhook: signature rejected — check WHATSAPP_APP_SECRET matches the Meta app',
      { hasHeader: c.req.header('x-hub-signature-256') !== undefined },
    );
    return c.text('Forbidden', 403);
  }

  let body: WhatsAppWebhookBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as WhatsAppWebhookBody;
  } catch {
    // Malformed but signed: ack so Meta stops retrying, and log it.
    console.error('webhook: unparseable body');
    return c.body(null, 200);
  }

  const jobs = extractJobs(body);

  if (jobs.length > 0) {
    // sendBatch is one subrequest for the whole batch, rather than one per
    // message. Failure here means Meta retries, which is the correct
    // outcome — better a duplicate than a dropped question.
    await c.env.INBOUND.sendBatch(jobs.map((body) => ({ body })));
    console.log(`webhook: enqueued ${jobs.length} message(s)`);
  } else {
    console.log('webhook: no messages in payload (status callback or unhandled event)');
  }

  return c.body(null, 200);
});

// The dashboard. Auth is enforced by middleware inside, so a page added
// later is protected by default rather than by remembering to protect it.
app.route('/admin', admin);

app.notFound((c) => c.text('Not found', 404));

app.onError((err, c) => {
  // A bare "Internal error" is the same mistake as a swallowed search
  // failure: it tells the person nothing and hides the cause from the
  // logs they would check. The full stack goes to the log, and the
  // response carries a short reference so a screenshot can be matched to
  // a log line without guessing.
  const ref = crypto.randomUUID().slice(0, 8);
  console.error('UNHANDLED', {
    ref,
    path: c.req.path,
    method: c.req.method,
    error: err instanceof Error ? err.stack ?? err.message : String(err),
  });

  // Still 200 on the webhook path: an error here is ours, and letting Meta
  // retry into the same bug just multiplies it.
  if (c.req.path === '/webhook/whatsapp') return c.body(null, 200);

  if (c.req.path.startsWith('/admin')) {
    // Name the cause when we can recognise it. A missing relation means a
    // migration has not been applied, and saying so on the page beats
    // sending someone to read logs for a one-line fix.
    const raw = err instanceof Error ? err.message : String(err);
    const missing = /relation "([a-z_]+)" does not exist|column "?([a-z_.]+)"? does not exist/i.exec(raw);
    const diagnosis = missing
      ? `<p style="background:#FFF8E6;border:1px solid #F2E3BC;border-radius:6px;padding:10px 12px;color:#9A6700">
           <strong>The database is behind the code.</strong><br>
           Missing: <code>${(missing[1] ?? missing[2] ?? '').replace(/[<>&]/g, '')}</code><br>
           Run <code>npm run db:migrate</code> against this database.
         </p>`
      : '';

    return c.html(
      `<!doctype html><meta charset="utf-8">
       <title>Error</title>
       <style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;
         min-height:100vh;display:grid;place-items:center;background:#F7F9F8;color:#121614}
         .b{max-width:420px;padding:28px;background:#fff;border:1px solid #E2E6E3;border-radius:8px}
         code{background:#F1F3F2;padding:2px 6px;border-radius:4px;font-size:13px}
         p{color:#67706A;font-size:13.5px}</style>
       <div class="b">
         <h1 style="font-size:17px;margin:0 0 8px">Something went wrong</h1>
         <p>The dashboard could not complete that request. This is a fault on our side.</p>
         ${diagnosis}
         <p>Reference <code>${ref}</code> — quote it when reporting this. The full cause is in the server log.</p>
         <p style="margin-bottom:0"><a href="/admin/login" style="color:#005A36">Back to sign in</a></p>
       </div>`,
      500,
    );
  }

  return c.text(`Internal error (ref ${ref})`, 500);
});

/**
 * Pull the messages out of Meta's envelope.
 *
 * Status callbacks (delivered/read) arrive on the same hook and are skipped
 * — they are not questions, and enqueuing them would burn queue operations
 * against the free plan's daily allowance.
 */
function extractJobs(body: WhatsAppWebhookBody): InboundJob[] {
  const jobs: InboundJob[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const msg of value.messages) {
        if (!msg.id || !msg.from) continue;

        const timestamp = Number(msg.timestamp ?? 0) || Math.floor(Date.now() / 1000);

        if (msg.type === 'text' && msg.text?.body) {
          jobs.push({
            messageId: msg.id,
            from: msg.from,
            phoneNumberId,
            text: msg.text.body,
            kind: 'text',
            timestamp,
          });
        } else if (msg.type === 'audio' && msg.audio?.id) {
          jobs.push({
            messageId: msg.id,
            from: msg.from,
            phoneNumberId,
            text: '',
            kind: 'audio',
            mediaId: msg.audio.id,
            timestamp,
          });
        } else if (msg.type === 'interactive') {
          const title = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title;
          if (title) {
            jobs.push({
              messageId: msg.id,
              from: msg.from,
              phoneNumberId,
              text: title,
              kind: 'text',
              timestamp,
            });
          }
        } else {
          // Images, documents, location, stickers. Acknowledged so the user
          // gets a reply explaining what the agent can take.
          jobs.push({
            messageId: msg.id,
            from: msg.from,
            phoneNumberId,
            text: '',
            kind: 'unsupported',
            timestamp,
          });
        }
      }
    }
  }

  return jobs;
}

export default {
  fetch: app.fetch,
  // One Worker consumes both queues; route on which one delivered the batch.
  queue: (batch, env) =>
    batch.queue === 'myimoguide-inbound-dlq' ? handleDeadLetter(batch, env) : handleBatch(batch, env),
} satisfies ExportedHandler<Env, InboundJob>;
