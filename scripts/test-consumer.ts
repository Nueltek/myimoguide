/**
 * The consumer, end to end: a WhatsApp message in; a reply sent and a row
 * in the questions table out.
 *
 * Runs the real respond() against a real Postgres (pglite, with every
 * committed migration applied). Only the edges are replaced: the model
 * that answers, the transcriber that hears, and the WhatsApp API that the
 * reply is sent to.
 *
 *   npm run test:consumer
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { queries } from '../src/db/schema';
import { PROVIDER_DOWN_REPLY, handleBatch, respond, type Deps } from '../src/queue/consumer';
import { providerAccountProblem } from '../src/agent/models';
import { conversationContext } from '../src/agent/context';
import { UNHEARD_REPLIES, type Hearing } from '../src/voice/hear';
import type { InboundJob } from '../src/types';

let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    console.log(`  pass  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

const pg = await PGlite.create();
for (const f of readdirSync('drizzle').filter((n) => n.endsWith('.sql')).sort()) {
  for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
    try {
      await pg.exec(stmt);
    } catch (e) {
      if (!/vector|intents/.test((e as Error).message)) throw e;
    }
  }
}
const db = drizzle(pg as never) as never;
const q = db as any;

/** Messages sent to WhatsApp, in order. */
const sent: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/messages')) {
    const body = JSON.parse(String(init?.body));
    if (body.text?.body) sent.push(body.text.body);
    return Response.json({ messages: [{ id: 'wamid.out' }] });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const history: Array<[string, string]> = [];
const convo = {
  allow: async () => true,
  recent: async () => [],
  append: async (role: string, text: string) => {
    history.push([role, text]);
  },
} as never;

const env = {
  WHATSAPP_API_VERSION: 'v25.0',
  WHATSAPP_TOKEN: 't',
  WHATSAPP_PHONE_ID: '123',
  WHATSAPP_APP_SECRET: 'salt',
  OPENAI_API_KEY: 'k',
} as never;

const asked: string[] = [];
const answer: Deps['answer'] = async ({ question }) => {
  asked.push(question);
  return { text: 'Pay at any IIRS office.', resolved: true, tier: 'verified', provider: 'anthropic', model: 'claude-haiku-5-5' };
};
const hearing = (h: Hearing): Deps['hear'] => async () => h;

const job = (over: Partial<InboundJob>): InboundJob => ({
  messageId: `wamid.${Math.random().toString(36).slice(2)}`,
  from: '2348000000000',
  phoneNumberId: '123',
  text: '',
  kind: 'text',
  timestamp: 0,
  ...over,
});

/* ------------------------------------------------------------------ */

console.log('\nA typed question');
let j = job({ text: 'Where do I pay my tax?' });
await respond(j, env, db, convo, { answer, hear: hearing({} as never) });
let [row] = await q.select().from(queries).where(eq(queries.messageId, j.messageId));
await check('is answered without a "You said" line', () => assert.equal(sent.at(-1), 'Pay at any IIRS office.'));
await check('is logged as typed', () => assert.equal(row.wasVoice, false));

console.log('\nA voice note that was heard');
j = job({ kind: 'audio', mediaId: 'media-1' });
const transcript = 'Abeg how I go take pay my tax for Owerri?';
await respond(j, env, db, convo, {
  answer,
  hear: hearing({ ok: true, text: transcript, language: null, seconds: 6.2, provider: 'openai', model: 'gpt-transcribe' }),
});
[row] = await q.select().from(queries).where(eq(queries.messageId, j.messageId));
await check('the transcript is what gets answered', () => assert.equal(asked.at(-1), transcript));
await check('the reply opens by repeating what was heard', () =>
  assert.equal(sent.at(-1), `_You said: "${transcript}"_\n\nPay at any IIRS office.`));
await check('the transcript is stored as the question, marked as voice, with its length', () => {
  assert.equal(row.question, transcript);
  assert.equal(row.wasVoice, true);
  assert.equal(row.audioSeconds, 6.2);
});
await check('the conversation remembers the transcript, not a placeholder', () =>
  assert.deepEqual(history.slice(-2), [['user', transcript], ['assistant', 'Pay at any IIRS office.']]));

console.log('\nA voice note that was not heard');
j = job({ kind: 'audio', mediaId: 'media-2' });
const before = asked.length;
await respond(j, env, db, convo, {
  answer,
  hear: hearing({
    ok: false,
    reason: 'no_speech',
    reply: UNHEARD_REPLIES.no_speech,
    language: null,
    seconds: 3.1,
    provider: 'openai',
    model: 'gpt-transcribe',
    detail: 'silence phrase "Thank you."',
  }),
});
[row] = await q.select().from(queries).where(eq(queries.messageId, j.messageId));
await check('nothing is answered — there was no question to answer', () => assert.equal(asked.length, before));
await check('the person is told plainly what to do', () => assert.equal(sent.at(-1), UNHEARD_REPLIES.no_speech));
await check('it is still logged, as "unheard", with the reason and the transcriber', () => {
  assert.equal(row.answerTier, 'unheard');
  assert.equal(row.question, '(Voice note: no speech heard)');
  assert.equal(row.provider, 'openai');
  assert.equal(row.model, 'gpt-transcribe');
  assert.equal(row.wasResolved, false);
});

console.log('\nA voice note with no media id');
j = job({ kind: 'audio' });
await respond(j, env, db, convo, { answer, hear: async () => assert.fail('should not try to hear') });
await check('is told it could not be opened, without calling the transcriber', () => assert.equal(sent.at(-1), UNHEARD_REPLIES.unreadable));

console.log('\nWhen the answering provider refuses the account');
// What Anthropic returns when credit runs out, wrapped the way the AI SDK wraps it.
const anthropicNoCredit = Object.assign(new Error('Failed after 1 attempts. Last error: Your credit balance is too low'), {
  lastError: Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), {
    statusCode: 400,
    responseBody: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
  }),
});
const openaiNoQuota = Object.assign(new Error('You exceeded your current quota'), { statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' });
const badKey = Object.assign(new Error('invalid x-api-key'), { statusCode: 401, responseBody: '{"error":{"type":"authentication_error"}}' });
await check('Anthropic out of credit is recognised, through the SDK wrapper', () => assert.match(providerAccountProblem(anthropicNoCredit) ?? '', /no credit/));
await check('OpenAI out of quota is recognised', () => assert.match(providerAccountProblem(openaiNoQuota) ?? '', /no credit or quota/));
await check('a rejected key is recognised', () => assert.match(providerAccountProblem(badKey) ?? '', /rejected the API key/));
await check('...even when the only clue is the status code, inside the SDK\'s wrapper', () =>
  assert.match(
    providerAccountProblem(Object.assign(new Error('Failed after 3 attempts.'), { lastError: Object.assign(new Error('Unauthorized'), { statusCode: 401 }) })) ?? '',
    /rejected the API key/,
  ));
await check('an ordinary failure is not mistaken for an account problem', () => {
  assert.equal(providerAccountProblem(new Error('fetch failed')), null);
  assert.equal(providerAccountProblem(Object.assign(new Error('Overloaded'), { statusCode: 529 })), null);
});

j = job({ text: 'Where do I pay my tax?' });
await respond(j, env, db, convo, { answer: async () => { throw anthropicNoCredit; }, hear: hearing({} as never) });
[row] = await q.select().from(queries).where(eq(queries.messageId, j.messageId));
await check('the person is told honestly at once — no three silent retries', () => assert.equal(sent.at(-1), PROVIDER_DOWN_REPLY));
await check('it is logged as an error, with the cause for staff to see', () => {
  assert.equal(row.answerTier, 'error');
  assert.match(row.answer, /no credit or quota left/);
});
await check('an ordinary failure is still thrown, so the queue retries it', () =>
  assert.rejects(respond(job({ text: 'x' }), env, db, convo, { answer: async () => { throw new Error('fetch failed'); }, hear: hearing({} as never) }), /fetch failed/));

console.log('\nHistory cannot derail later messages');
const longAnswer = 'Certificate of Occupancy (C of O). ' + 'Fees are not published by the ministry. '.repeat(80);
const ctx = conversationContext([
  { role: 'user', text: 'old question 1' },
  { role: 'assistant', text: 'old answer 1' },
  { role: 'user', text: 'Where can I get my C of O?' },
  { role: 'assistant', text: longAnswer },
  { role: 'user', text: 'and the fee?' },
]);
await check('only the last four turns are sent', () => assert.ok(!ctx.includes('old question 1') && ctx.includes('and the fee?')));
await check('a long answer is cut to its gist', () => {
  const line = ctx.split('\n').find((l) => l.startsWith('Assistant: Certificate'))!;
  assert.ok(line.length <= 'Assistant: '.length + 400 && line.endsWith('...'), `${line.length} chars`);
});

console.log('\nA message that fails on every attempt');
let forgotten = 0;
let acked = 0;
const failingEnv = {
  ...(env as object),
  DATABASE_URL: 'postgresql://u:p@db.invalid/neondb',
  CONVERSATION: {
    idFromName: (n: string) => n,
    get: () => ({
      claimMessage: async () => true,
      allow: async () => true,
      recent: async () => [],
      append: async () => undefined,
      markDone: async () => undefined,
      forget: async () => {
        forgotten++;
      },
    }),
  },
} as never;
const batch = (attempts: number) =>
  ({
    queue: 'myimoguide-inbound',
    messages: [{ body: job({ text: 'Where do I pay my tax?' }), attempts, ack: () => acked++, retry: () => undefined }],
  }) as never;
const sentBefore = sent.length;
await handleBatch(batch(1), failingEnv);
await check('an early failed attempt is retried, with history left alone', () => {
  assert.equal(forgotten, 0);
  assert.equal(sent.length, sentBefore);
});
await handleBatch(batch(3), failingEnv);
await check('on the last attempt the user\'s history is cleared, so they cannot be stuck', () => assert.equal(forgotten, 1));
await check('...and they get the apology', () => assert.match(sent.at(-1) ?? '', /something failed on my side/));

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
