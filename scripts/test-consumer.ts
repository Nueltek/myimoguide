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
import { respond, type Deps } from '../src/queue/consumer';
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

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
