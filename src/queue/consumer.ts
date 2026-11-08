import type { Env, InboundJob } from '../types';
import { createDb } from '../db/client';
import { markRead, sendText } from '../whatsapp/client';
import { answerQuestion } from '../agent/answer';
import { activeConfig } from '../agent/models';
import { transcriberFor } from '../voice/transcribe';
import { UNHEARD_LABELS, UNHEARD_REPLIES, echoLine, hearVoiceNote, type Hearing } from '../voice/hear';

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
/**
 * Apologise and stop on this attempt.
 *
 * Deliberately one less than the queue's total deliveries: max_retries 3
 * in wrangler.jsonc allows four. A thrown error is caught here and
 * answered on the third. The fourth delivery exists only for the case
 * this catch cannot see — an invocation killed outright on the third —
 * and if that fails too, the message reaches the dead-letter handler,
 * which apologises from outside the failing isolate.
 */
const MAX_ATTEMPTS = 3;

/**
 * How long the whole pipeline may take before we give up and say so.
 *
 * WhatsApp's typing indicator lasts about 25 seconds. Past that the user
 * sees nothing at all and concludes the service is dead, so the work has
 * to finish — or fail honestly — inside that window.
 */
const ANSWER_BUDGET_MS = 22_000;

export async function handleBatch(
  batch: MessageBatch<InboundJob>,
  env: Env,
): Promise<void> {
  const db = createDb(env.DATABASE_URL);

  // Sequential, not Promise.all. Parallel fan-out multiplies subrequests
  // within one invocation and is the quickest way to hit the 50 cap.
  for (const message of batch.messages) {
    try {
      await handleOne(message.body, env, db, message.attempts);
      message.ack();
    } catch (err) {
      console.error('consumer failed', {
        messageId: message.body.messageId,
        attempt: message.attempts,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });

      // Silence is the worst outcome. A user who sees a typing indicator
      // and then nothing assumes the service is broken and re-sends,
      // which multiplies the load that caused the failure. On the last
      // attempt, say so and stop.
      if (message.attempts >= MAX_ATTEMPTS) {
        await sendText(
          env,
          message.body.from,
          "I could not answer that just now — something failed on my side, not with your question.\n\nPlease send it again in a moment.",
        ).catch(() => undefined);
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}

type ConvoStub = Pick<ReturnType<Env['CONVERSATION']['get']>, 'allow' | 'recent' | 'append'>;

/**
 * What respond() calls out to. Defaults are the real ones; the test
 * harness passes its own so the whole pipeline — voice note in, reply
 * and database row out — runs without a model or a phone.
 */
export interface Deps {
  answer: typeof answerQuestion;
  hear: typeof hearVoiceNote;
}
const REAL: Deps = { answer: answerQuestion, hear: hearVoiceNote };

async function handleOne(
  job: InboundJob,
  env: Env,
  db: ReturnType<typeof createDb>,
  attempt: number,
): Promise<void> {
  const convo = env.CONVERSATION.get(env.CONVERSATION.idFromName(job.from));

  // Duplicates are normal: Meta re-delivers slow webhooks, and the queue
  // retries failures. The claim tells those two apart — see src/dedupe.ts
  // for the bug that conflating them caused.
  if (!(await convo.claimMessage(job.messageId, attempt))) return;

  // respond() throws on failure, leaving the message 'processing' so the
  // queue's retry is allowed through. It returns only once a reply has
  // actually been sent — and only then is the message finished.
  await respond(job, env, db, convo);
  await convo.markDone(job.messageId);
}

export async function respond(
  incoming: InboundJob,
  env: Env,
  db: ReturnType<typeof createDb>,
  convo: ConvoStub,
  deps: Deps = REAL,
): Promise<void> {
  let job = incoming;
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

  // Diagnostic command. The person testing this is holding a phone, not
  // sitting at a terminal, and "which provider answered that?" is not a
  // question they should have to infer from latency or wording.
  //
  // Restricted to ADMIN_NUMBERS. Which model powers the assistant is not
  // the public's business: in a government setting it invites "so it is
  // just ChatGPT with extra steps", a conversation about plumbing rather
  // than about verified data. A non-admin sending /status falls through
  // to normal handling, so the command does not announce its existence.
  if (job.text.trim().toLowerCase() === '/status' && isAdmin(env, job.from)) {
    const cfg = activeConfig(env);
    await sendText(
      env,
      job.from,
      [
        '*MyImoGuide status*',
        '',
        `Provider: *${cfg.provider}*`,
        `Routing model: ${cfg.routingModel}`,
        `Synthesis model: ${cfg.synthesisModel}`,
        `API key present: ${cfg.keyPresent ? 'yes' : 'NO — calls will fail'}`,
        `Voice notes: ${voiceStatus(env)}`,
      ].join('\n'),
    );
    return;
  }

  const started = Date.now();

  /**
   * Stage markers.
   *
   * A message that vanishes tells you nothing about where it died. If the
   * isolate is killed — a CPU overrun leaves no catch to run — the last
   * stage printed is the one that was running. That is the difference
   * between knowing and guessing.
   */
  const stage = (name: string) =>
    console.log(`stage: ${name} (${Date.now() - started}ms) ${job.messageId}`);

  // Voice notes become text here, and from then on take exactly the same
  // path as a typed question. Nothing about the audio is kept: not the
  // file, and not the media id once this invocation ends.
  let voice: Extract<Hearing, { ok: true }> | null = null;
  if (job.kind === 'audio') {
    stage('transcribing');
    const heard = job.mediaId
      ? await deps.hear(env, job.mediaId)
      : ({
          ok: false,
          reason: 'unreadable',
          reply: UNHEARD_REPLIES.unreadable,
          language: null,
          seconds: null,
          detail: 'no media id',
          provider: transcriberFor(env).provider,
          model: transcriberFor(env).model,
        } as const);
    stage(heard.ok ? 'heard' : `unheard:${heard.reason}`);
    if (!heard.ok) {
      await sendText(env, job.from, heard.reply);
      await logUnheard(db, env, job, heard, Date.now() - started);
      return;
    }
    voice = heard;
    job = { ...job, text: heard.text };
  }

  stage('history');
  const history = await convo.recent();

  // No "let me check that for you" message.
  //
  // markRead above already sends WhatsApp's native typing indicator, which
  // is the right signal: it appears instantly, needs no message, and
  // vanishes on its own. A holding message followed by a long wait is
  // worse than the wait alone — it promises an answer, and when none
  // arrives the user re-sends, multiplying the load.
  //
  // The budget keeps us inside the indicator's lifetime, so a slow search
  // produces an honest reply rather than silence.
  stage('answering');
  // One budget for the whole pipeline: time spent transcribing comes out
  // of the time left to answer, so the reply still lands while the typing
  // indicator is showing.
  const result = await withBudget(
    deps.answer({ db, env, question: job.text, history }),
    Math.max(5_000, ANSWER_BUDGET_MS - (Date.now() - started)),
  );
  stage(result ? `answered:${result.tier}` : 'budget-exceeded');

  if (!result) {
    console.warn('answer exceeded budget', { messageId: job.messageId });
    await sendText(
      env,
      job.from,
      "That one is taking longer than it should and I would rather not leave you waiting.\n\nPlease send it again — if it keeps happening, the problem is mine to fix.",
    );
    return;
  }

  // One line per answered question, so `wrangler tail` shows the tier and
  // the model that produced it without digging.
  console.log(
    `answered: tier=${result.tier} provider=${result.provider} model=${result.model}`,
  );

  await sendText(env, job.from, voice ? `${echoLine(voice.text)}\n\n${result.text}` : result.text);
  stage('sent');

  await convo.append('user', job.text);
  await convo.append('assistant', result.text);

  // Logging every question — matched or not — is how the pilot produces the
  // gap list that becomes the pitch.
  await logQuery(db, env, job, result, Date.now() - started, voice);
  stage('logged');
}

function voiceStatus(env: Env): string {
  const t = transcriberFor(env);
  return `${t.provider} ${t.model}${t.problem ? ` — NOT READY: ${t.problem}` : ''}`;
}

/** Is this sender allowed to run diagnostic commands? */
function isAdmin(env: Env, from: string): boolean {
  const list = env.ADMIN_NUMBERS?.split(',').map((n) => n.trim().replace(/^\+/, '')) ?? [];
  return list.length > 0 && list.includes(from.replace(/^\+/, ''));
}

/** Resolves to the value, or null if the deadline passes first. */
async function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function logQuery(
  db: ReturnType<typeof createDb>,
  env: Env,
  job: InboundJob,
  result: Awaited<ReturnType<typeof answerQuestion>>,
  latencyMs: number,
  voice: Extract<Hearing, { ok: true }> | null,
): Promise<void> {
  const { queries } = await import('../db/schema');
  await db
    .insert(queries)
    .values({
      userHash: await hashUser(job.from, env.WHATSAPP_APP_SECRET),
      messageId: job.messageId,
      question: job.text,
      wasVoice: job.kind === 'audio',
      language: voice?.language ?? null,
      audioSeconds: voice?.seconds ?? null,
      matchedServiceId: result.serviceId ?? null,
      matchedFacilityId: result.facilityId ?? null,
      wasResolved: result.resolved,
      answerTier: result.tier,
      provider: result.provider,
      model: result.model,
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

/**
 * Consumer for the dead-letter queue: the backstop that lives OUTSIDE the
 * isolate that failed.
 *
 * Every other safety net in this file runs inside the same invocation as
 * the work. If that invocation is killed outright — a CPU overrun leaves
 * no catch to run and no timer to fire — none of them execute, and after
 * the last retry the message lands here. This handler does almost
 * nothing, so it cannot fail the same way: one Durable Object read, one
 * WhatsApp send. No database, no model.
 */
export async function handleDeadLetter(
  batch: MessageBatch<InboundJob>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      const convo = env.CONVERSATION.get(env.CONVERSATION.idFromName(job.from));
      // Answered after all, just before the isolate died. Say nothing.
      if (await convo.isDone(job.messageId)) {
        message.ack();
        continue;
      }
      console.error('dead-letter: no reply was delivered', { messageId: job.messageId });
      await sendText(
        env,
        job.from,
        "I'm sorry — I wasn't able to answer your last message. The fault is on my side, not with your question.\n\nPlease send it again in a few minutes.",
      );
      await convo.markDone(job.messageId);
      message.ack();
    } catch (err) {
      console.error('dead-letter handler failed', {
        messageId: job.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      message.retry();
    }
  }
}

/**
 * A voice note we could not act on is still a question someone asked.
 * Logged with its reason, so the dashboard shows how often voice fails
 * and why — silence, length, or the transcription service itself.
 */
async function logUnheard(
  db: ReturnType<typeof createDb>,
  env: Env,
  job: InboundJob,
  heard: Extract<Hearing, { ok: false }>,
  latencyMs: number,
): Promise<void> {
  const { queries } = await import('../db/schema');
  await db
    .insert(queries)
    .values({
      userHash: await hashUser(job.from, env.WHATSAPP_APP_SECRET),
      messageId: job.messageId,
      question: `(Voice note: ${UNHEARD_LABELS[heard.reason]})`,
      wasVoice: true,
      language: heard.language,
      audioSeconds: heard.seconds,
      wasResolved: false,
      answerTier: 'unheard',
      provider: heard.provider,
      model: heard.model.slice(0, 64),
      answer: heard.reply,
      latencyMs,
    })
    .onConflictDoNothing();
}
