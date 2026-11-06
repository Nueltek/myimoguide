import type { Env, InboundJob } from '../types';
import { createDb } from '../db/client';
import { markRead, sendText } from '../whatsapp/client';
import { answerQuestion } from '../agent/answer';

/**
 * Where the slow work happens, off the webhook's critical path.
 *
 * Free-plan budget to respect per invocation:
 *   - 10 ms CPU (wall time awaiting fetch does not count)
 *   - 50 subrequests
 *
 * So: no JSON parsing of large payloads, no vector maths in-Worker, and one
 * database round trip reused rather than several. Phase 2 spike 1 measures
 * whether this holds for a consumer; see spikes/README.md.
 */
export async function handleBatch(
  batch: MessageBatch<InboundJob>,
  env: Env,
): Promise<void> {
  const db = createDb(env.DATABASE_URL);

  // Sequential, not Promise.all. Parallel fan-out multiplies subrequests
  // within one invocation and is the quickest way to hit the 50 cap.
  for (const message of batch.messages) {
    try {
      await handleOne(message.body, env, db);
      message.ack();
    } catch (err) {
      console.error('consumer failed', message.body.messageId, err);
      // retry() re-delivers with backoff; after max_retries it lands in the
      // DLQ rather than disappearing.
      message.retry();
    }
  }
}

async function handleOne(
  job: InboundJob,
  env: Env,
  db: ReturnType<typeof createDb>,
): Promise<void> {
  const convo = env.CONVERSATION.get(env.CONVERSATION.idFromName(job.from));

  // At-least-once delivery plus Meta's own retries means duplicates are
  // normal, not exceptional.
  const isNew = await convo.claimMessage(job.messageId);
  if (!isNew) return;

  if (!(await convo.allow())) {
    await sendText(env, job.from, 'You have sent a lot of messages just now. Please try again in a few minutes.');
    return;
  }

  if (job.kind === 'unsupported') {
    await sendText(
      env,
      job.from,
      'I can read text messages and voice notes. Please send your question as one of those.',
    );
    return;
  }

  await markRead(env, job.messageId);

  // Voice notes are table stakes on WhatsApp in Nigeria. Transcription is
  // wired in Phase 3, step 7 — until then, say so rather than fail silently.
  if (job.kind === 'audio') {
    await sendText(env, job.from, 'Voice notes are coming soon. Please type your question for now.');
    return;
  }

  const started = Date.now();
  const history = await convo.recent();

  const result = await answerQuestion({
    db,
    env,
    question: job.text,
    history,
  });

  await sendText(env, job.from, result.text);

  await convo.append('user', job.text);
  await convo.append('assistant', result.text);

  // Logging every question — matched or not — is how the pilot produces the
  // gap list that becomes the pitch.
  await logQuery(db, env, job, result, Date.now() - started);
}

async function logQuery(
  db: ReturnType<typeof createDb>,
  env: Env,
  job: InboundJob,
  result: Awaited<ReturnType<typeof answerQuestion>>,
  latencyMs: number,
): Promise<void> {
  const { queries } = await import('../db/schema');
  await db
    .insert(queries)
    .values({
      userHash: await hashUser(job.from, env.WHATSAPP_APP_SECRET),
      messageId: job.messageId,
      question: job.text,
      wasVoice: job.kind === 'audio',
      matchedServiceId: result.serviceId ?? null,
      matchedFacilityId: result.facilityId ?? null,
      wasResolved: result.resolved,
      answer: result.text,
      latencyMs,
    })
    .onConflictDoNothing();
}

/**
 * Phone numbers are not stored in the clear. A salted SHA-256 is enough to
 * count unique users and spot repeat askers without holding the number.
 */
async function hashUser(phone: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${phone}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
