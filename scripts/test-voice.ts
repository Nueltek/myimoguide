/**
 * Voice notes, from WhatsApp media id to transcript or reply.
 *
 * The network is replaced with a fake that answers like Meta's Graph API
 * and OpenAI's transcription endpoint do, so every path — success,
 * silence, too long, out of credit, a bad file, a slow provider, Meta
 * returning an error page — runs without a real call. The audio is a real
 * Ogg/Opus file in WhatsApp's format, and its length is checked against
 * ffprobe's reading of the same file, not against a value this code
 * produced.
 *
 *   npm run test:voice
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { echoLine, hearVoiceNote, UNHEARD_REPLIES } from '../src/voice/hear';
import { MAX_AUDIO_SECONDS, VOCABULARY_PROMPT, oggOpusSeconds, silenceReason, transcriberFor } from '../src/voice/transcribe';
import { readCapped } from '../src/whatsapp/client';

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

const fixture = new Uint8Array(readFileSync('scripts/fixtures/voice-note-7.5s.ogg'));
/** ffprobe -show_entries format=duration on the fixture: 7.5065 s. */
const FFPROBE_SECONDS = 7.5065;

/** The same file with its final granule position rewritten, to fake a longer recording. */
function withSeconds(seconds: number): Uint8Array {
  const copy = fixture.slice();
  for (let i = copy.length - 27; i >= 0; i--) {
    if (copy[i] === 0x4f && copy[i + 1] === 0x67 && copy[i + 2] === 0x67 && copy[i + 3] === 0x53) {
      let g = Math.round(seconds * 48_000) + 312;
      for (let b = 0; b < 8; b++) {
        copy[i + 6 + b] = g % 256;
        g = Math.floor(g / 256);
      }
      return copy;
    }
  }
  throw new Error('no Ogg page found');
}

/* ------------------------------------------------------------------ */
/* A fake network                                                       */
/* ------------------------------------------------------------------ */

type Call = { url: string; init?: RequestInit | undefined };
interface Scenario {
  fileSize?: number;
  audio?: Uint8Array;
  downloadType?: string;
  openai?: () => Response | Promise<Response>;
}

const calls: Call[] = [];
function network(s: Scenario) {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.startsWith('https://graph.facebook.com/')) {
      return Response.json({
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123',
        mime_type: 'audio/ogg; codecs=opus',
        file_size: s.fileSize ?? (s.audio ?? fixture).byteLength,
      });
    }
    if (url.startsWith('https://lookaside.fbsbx.com/')) {
      return new Response(s.audio ?? fixture, { headers: { 'content-type': s.downloadType ?? 'audio/ogg' } });
    }
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      return s.openai ? s.openai() : Response.json({ text: 'How much is a Certificate of Occupancy in Owerri?' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const env = {
  WHATSAPP_API_VERSION: 'v25.0',
  WHATSAPP_TOKEN: 'test-whatsapp-token',
  OPENAI_API_KEY: 'test-openai-key',
} as never;

/* ------------------------------------------------------------------ */

console.log('\nRecording length, read from the file');
await check(`a real WhatsApp-format Ogg/Opus file measures ${FFPROBE_SECONDS}s, as ffprobe does`, () =>
  assert.equal(oggOpusSeconds(fixture), Math.round(FFPROBE_SECONDS * 10) / 10));
await check('a longer recording is measured from its last page', () => assert.equal(oggOpusSeconds(withSeconds(200)), 200));
await check('a file that is not Ogg gives no length rather than a wrong one', () =>
  assert.equal(oggOpusSeconds(new TextEncoder().encode('<html>error page from Meta</html>'.padEnd(80, ' '))), null));

console.log('\nWhat counts as silence');
await check('an empty transcript', () => assert.ok(silenceReason('   ')));
await check('punctuation only', () => assert.ok(silenceReason(' ... ')));
await check('"Thank you." alone is the classic silence hallucination', () => assert.ok(silenceReason('Thank you.')));
await check('"Thanks for watching!" too', () => assert.ok(silenceReason('Thanks for watching!')));
await check('the vocabulary prompt echoed back', () => assert.ok(silenceReason(VOCABULARY_PROMPT)));
await check('a real question containing "thank you" is kept', () =>
  assert.equal(silenceReason('Thank you, please where is the IIRS office in Owerri?'), null));
await check('a short real question that appears in the prompt is kept', () => assert.equal(silenceReason('Certificate of Occupancy?'), null));
await check('Pidgin is kept as spoken', () => assert.equal(silenceReason('Abeg how I go take pay my tax for Owerri?'), null));
await check('Igbo text is kept (the letters with dots count as letters)', () => assert.equal(silenceReason('Ọ bụ ole ka m ga-akwụ?'), null));

console.log('\nThe line that repeats what was heard');
await check('it quotes the transcript in italics', () =>
  assert.equal(echoLine('Where is the IIRS office?'), '_You said: "Where is the IIRS office?"_'));
await check('WhatsApp formatting characters cannot break it', () =>
  assert.equal(echoLine('pay *now* _please_ ~x~'), '_You said: "pay now please x"_'));
await check('a long transcript is shortened', () => {
  const line = echoLine('word '.repeat(200));
  assert.ok(line.length < 300 && line.endsWith('..."_'), line.slice(-20));
});

console.log('\nThe request to OpenAI');
network({});
let heard = await hearVoiceNote(env, 'media-123');
const openaiCall = calls.find((c) => c.url.includes('api.openai.com'))!;
const sent = openaiCall.init?.body as FormData;
await check('a voice note is heard and transcribed', () => assert.equal(heard.ok && heard.text, 'How much is a Certificate of Occupancy in Owerri?'));
await check('it uses gpt-transcribe by default', () => assert.equal(sent.get('model'), 'gpt-transcribe'));
await check('the file is named .ogg — OpenAI rejects WhatsApp\'s .oga for the same bytes', () =>
  assert.equal((sent.get('file') as File).name, 'voice-note.ogg'));
await check('the whole recording is sent, unchanged', async () =>
  assert.deepEqual(new Uint8Array(await (sent.get('file') as File).arrayBuffer()), fixture));
await check('the Imo vocabulary goes as the prompt', () => assert.equal(sent.get('prompt'), VOCABULARY_PROMPT));
await check('no language is forced, so Igbo and Pidgin are not pushed into English', () => {
  assert.equal(sent.get('language'), null);
  assert.equal(sent.get('languages'), null);
});
await check('the OpenAI key is the bearer token', () =>
  assert.equal(new Headers(openaiCall.init?.headers).get('authorization'), 'Bearer test-openai-key'));
await check('the WhatsApp token never goes to OpenAI', () =>
  assert.ok(!JSON.stringify(openaiCall.init?.headers).includes('test-whatsapp-token')));
await check('the length is recorded from the file', () => assert.equal(heard.ok && heard.seconds, 7.5));
await check('TRANSCRIBE_MODEL overrides the model', () =>
  assert.equal(transcriberFor({ ...(env as object), TRANSCRIBE_MODEL: 'gpt-4o-transcribe' } as never).model, 'gpt-4o-transcribe'));

console.log('\nWhen it cannot be heard');
network({ openai: () => Response.json({ text: 'Thank you.' }) });
heard = await hearVoiceNote(env, 'm');
await check('silence gets the "could not hear any words" reply', () => assert.equal(!heard.ok && heard.reply, UNHEARD_REPLIES.no_speech));

network({ audio: withSeconds(MAX_AUDIO_SECONDS + 20) });
heard = await hearVoiceNote(env, 'm');
await check(`over ${MAX_AUDIO_SECONDS / 60} minutes is refused before paying to transcribe it`, () => {
  assert.equal(!heard.ok && heard.reason, 'too_long');
  assert.ok(!calls.some((c) => c.url.includes('api.openai.com')), 'OpenAI was called');
});

network({ fileSize: 5_000_000 });
heard = await hearVoiceNote(env, 'm');
await check('a file Meta reports as too big is not even downloaded', () => {
  assert.equal(!heard.ok && heard.reason, 'too_long');
  assert.ok(!calls.some((c) => c.url.includes('lookaside')), 'it was downloaded');
});

network({ openai: () => new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 }) });
heard = await hearVoiceNote(env, 'm');
await check('out of OpenAI credit: told to type, straight away', () => assert.equal(!heard.ok && heard.reason, 'unavailable'));

network({ openai: () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }) });
heard = await hearVoiceNote(env, 'm');
await check('a bad key: told to type, straight away', () => assert.equal(!heard.ok && heard.reason, 'unavailable'));

network({});
heard = await hearVoiceNote({ ...(env as object), OPENAI_API_KEY: '' } as never, 'm');
await check('no OpenAI key: told to type, and nothing is downloaded or sent', () => {
  assert.equal(!heard.ok && heard.reason, 'unavailable');
  assert.equal(calls.length, 0, calls.map((c) => c.url).join(', '));
});

network({ openai: () => new Response('{"error":{"message":"Audio file might be corrupted or unsupported"}}', { status: 400 }) });
heard = await hearVoiceNote(env, 'm');
await check('a file OpenAI cannot read: asked to record it again', () => assert.equal(!heard.ok && heard.reason, 'unreadable'));

network({ openai: () => new Response('rate limited', { status: 429 }) });
await check('a rate limit is thrown, so the queue retries it', () => assert.rejects(hearVoiceNote(env, 'm'), /429/));

network({ openai: () => new Response('upstream error', { status: 503 }) });
await check('an OpenAI outage is thrown, so the queue retries it', () => assert.rejects(hearVoiceNote(env, 'm'), /503/));

network({ downloadType: 'text/html' });
await check('an HTML error page from Meta is not sent to OpenAI as if it were audio', async () => {
  await assert.rejects(hearVoiceNote(env, 'm'), /not audio/);
  assert.ok(!calls.some((c) => c.url.includes('api.openai.com')));
});

network({ openai: () => new Promise<Response>((r) => setTimeout(() => r(Response.json({ text: 'late' })), 300)) });
heard = await hearVoiceNote(env, 'm', 50);
await check('a provider slower than the budget gets an honest reply, not silence', () => assert.equal(!heard.ok && heard.reason, 'slow'));

console.log('\nDownload limits');
await check('a body over the cap is stopped, not buffered whole', () =>
  assert.rejects(readCapped(new Response(new Uint8Array(2_000)), 1_000), /size limit/));
await check('a body under the cap is read exactly', async () =>
  assert.equal((await readCapped(new Response(new Uint8Array(999)), 1_000)).byteLength, 999));

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
