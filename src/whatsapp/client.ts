import type { Env } from '../types';

/**
 * Outbound calls to the WhatsApp Cloud API.
 *
 * Only free-form replies are used. Every conversation here is user-initiated,
 * so we are always inside the 24-hour customer service window and no message
 * templates are needed — nothing to submit to Meta for review.
 */

function graphUrl(env: Env, path: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${path}`;
}

export async function sendText(env: Env, to: string, body: string): Promise<void> {
  // WhatsApp hard-limits text bodies at 4096 characters.
  const text = body.length > 4096 ? `${body.slice(0, 4093)}...` : body;

  const res = await fetch(graphUrl(env, `${env.WHATSAPP_PHONE_ID}/messages`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });

  if (!res.ok) {
    // Read the error body: Meta puts the actual cause in `error.message`,
    // and the status alone is rarely enough to debug a rejected send.
    const detail = await res.text().catch(() => '<unreadable>');
    throw new Error(`WhatsApp send failed ${res.status}: ${detail}`);
  }
}

/** Mark the user's message as read so they see the blue ticks while we work. */
export async function markRead(env: Env, messageId: string): Promise<void> {
  const res = await fetch(graphUrl(env, `${env.WHATSAPP_PHONE_ID}/messages`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  });

  // Non-fatal: a failed read receipt must never cost the user their answer.
  if (!res.ok) {
    console.warn('markRead failed', res.status, await res.text().catch(() => ''));
  }
}

/**
 * Download inbound media (voice notes). Two hops: resolve the media id to a
 * short-lived URL, then fetch it with the same bearer token.
 *
 * Note each call costs a subrequest, and the free plan allows 50 per
 * invocation. A voice note therefore spends 2 before any model call.
 */
export async function fetchMedia(env: Env, mediaId: string): Promise<ArrayBuffer> {
  const metaRes = await fetch(graphUrl(env, mediaId), {
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`media lookup failed ${metaRes.status}`);

  const { url } = (await metaRes.json()) as { url?: string };
  if (!url) throw new Error('media lookup returned no url');

  const binRes = await fetch(url, {
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  });
  if (!binRes.ok) throw new Error(`media download failed ${binRes.status}`);

  return binRes.arrayBuffer();
}
