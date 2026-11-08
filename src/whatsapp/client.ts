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

/** The media is larger than we are willing to download. */
export class MediaTooLargeError extends Error {
  constructor(readonly bytes: number | null) {
    super(`media exceeds the size limit${bytes ? ` (${bytes} bytes)` : ''}`);
  }
}

/**
 * Download inbound media (voice notes). Two hops: resolve the media id to a
 * short-lived URL, then fetch it with the same bearer token.
 *
 * Each call costs a subrequest, and the free plan allows 50 per
 * invocation. A voice note therefore spends 2 before any model call.
 *
 * Capped: the size Meta reports is checked before downloading, and the
 * download itself stops at the cap, so a long recording cannot exhaust
 * memory or CPU. A response that is not audio — Meta returns an HTML
 * error page in some failure modes — is rejected rather than sent to the
 * transcriber as if it were sound.
 */
export async function fetchMedia(env: Env, mediaId: string, maxBytes: number): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const metaRes = await fetch(graphUrl(env, mediaId), {
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`media lookup failed ${metaRes.status}`);

  const meta = (await metaRes.json()) as { url?: string; file_size?: number; mime_type?: string };
  if (!meta.url) throw new Error('media lookup returned no url');
  if (typeof meta.file_size === 'number' && meta.file_size > maxBytes) throw new MediaTooLargeError(meta.file_size);

  const binRes = await fetch(meta.url, {
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'user-agent': 'MyImoGuide/1.0' },
  });
  if (!binRes.ok) throw new Error(`media download failed ${binRes.status}`);

  const type = binRes.headers.get('content-type') ?? meta.mime_type ?? '';
  if (!/^(audio\/|application\/octet-stream)/i.test(type)) throw new Error(`media download returned ${type || 'no content type'}, not audio`);

  const declared = Number(binRes.headers.get('content-length') ?? '');
  if (declared > maxBytes) throw new MediaTooLargeError(declared);

  return { bytes: await readCapped(binRes, maxBytes), mimeType: meta.mime_type ?? type };
}

/** Reads a body, stopping with an error past the cap instead of buffering it all. */
export async function readCapped(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MediaTooLargeError(null);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
