import { Hono } from 'hono';
import type { Env, InboundJob } from './types';
import type { WhatsAppWebhookBody } from './whatsapp/types';
import { isValidSignature, verificationChallenge } from './whatsapp/verify';
import { handleBatch } from './queue/consumer';

export { Conversation } from './conversation';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, service: 'myimoguide' }));

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
    // Logged loudly on purpose. A silent 403 is indistinguishable in
    // `wrangler tail` from Meta not sending at all, which costs hours of
    // debugging the wrong layer. Seeing this line means Meta IS
    // delivering and WHATSAPP_APP_SECRET does not match the app.
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
    // Status callbacks (delivered/read) land here. Worth a line: it
    // confirms the webhook is wired even before a real question arrives.
    console.log('webhook: no messages in payload (status callback or unhandled event)');
  }

  return c.body(null, 200);
});

app.notFound((c) => c.text('Not found', 404));

app.onError((err, c) => {
  console.error('unhandled', err instanceof Error ? err.stack : String(err));
  // Still 200 on the webhook path: an error here is ours, and letting Meta
  // retry into the same bug just multiplies it.
  if (c.req.path === '/webhook/whatsapp') return c.body(null, 200);
  return c.text('Internal error', 500);
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
  queue: handleBatch,
} satisfies ExportedHandler<Env, InboundJob>;
