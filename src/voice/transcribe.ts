import type { Env } from '../types';

/**
 * Speech to text for WhatsApp voice notes.
 *
 * Provider-agnostic in the same way as the answering models: a
 * Transcriber is chosen by TRANSCRIBE_PROVIDER, and everything around it —
 * download, limits, what to do with an empty result, logging — is shared.
 * Today there is one provider, OpenAI, on the account that already funds
 * the answering models.
 *
 * Default model: gpt-transcribe, OpenAI's current model for recorded audio
 * (3.3% word error rate on Artificial Analysis's benchmark, $0.0045 a
 * minute). Override with TRANSCRIBE_MODEL.
 *
 * What is not yet known, and is tested with real voice notes rather than
 * assumed: how it does on Nigerian Pidgin and on Igbo. OpenAI publishes
 * no results for either. Nothing here filters by language, so an Igbo
 * voice note is transcribed and answered like any other — the reply
 * opens by repeating what was heard, which makes a poor transcription
 * obvious to the person instead of silently answered.
 */

export type ProviderName = 'openai';

export interface Transcript {
  text: string;
  /** Only when the provider reports one. OpenAI's json response does not. */
  language: string | null;
}

export interface Transcriber {
  provider: ProviderName;
  model: string;
  /** Why it cannot run at all — a missing key — or null. Checked before downloading anything. */
  problem: string | null;
  /** Throws TranscriberUnavailableError when retrying cannot help (no key, no credit). */
  transcribe(audio: ArrayBuffer, mimeType: string): Promise<Transcript>;
}

/** The provider cannot be used right now, and retrying will not change that. */
export class TranscriberUnavailableError extends Error {}

/** The provider could not read this particular recording. */
export class UnreadableAudioError extends Error {}

/** WhatsApp's ceiling is 16 MB; ours is far lower, as a cost and latency guard. ~4+ minutes of Opus. */
export const MAX_AUDIO_BYTES = 1_000_000;

/** Longer than this and we ask for a shorter note, before paying to transcribe it. */
export const MAX_AUDIO_SECONDS = 180;

/**
 * Proper nouns the model would otherwise misspell. Passed as the prompt,
 * which every OpenAI transcription model accepts. Phrased as a sentence,
 * because the model treats it as preceding speech.
 */
export const VOCABULARY_PROMPT =
  'A question about Imo State government services, in Owerri, Orlu or Okigwe: ' +
  'IIRS tax, Certificate of Occupancy, Mbaise, Oguta, Mbaitoli, Ikeduru, Ohaji/Egbema, LGA, commissioner.';

export function transcriberFor(env: Env): Transcriber {
  const provider: ProviderName = env.TRANSCRIBE_PROVIDER ?? 'openai';
  switch (provider) {
    case 'openai':
    default:
      return openAI(env, env.TRANSCRIBE_MODEL?.trim() || 'gpt-transcribe');
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */

function openAI(env: Env, model: string): Transcriber {
  const problem = env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY is not set. Voice notes need it even when answers use Anthropic.';
  return {
    provider: 'openai',
    model,
    problem,
    async transcribe(audio, mimeType) {
      if (problem) throw new TranscriberUnavailableError(problem);

      const form = new FormData();
      // The file name matters. OpenAI decides the format from the
      // extension, and rejects WhatsApp's ".oga" while accepting the same
      // Ogg/Opus bytes named ".ogg".
      form.append('file', new Blob([audio], { type: 'audio/ogg' }), fileNameFor(mimeType));
      form.append('model', model);
      form.append('prompt', VOCABULARY_PROMPT);
      form.append('response_format', 'json');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const detail = `OpenAI transcription ${res.status}: ${body.slice(0, 300)}`;
        // Out of credit, bad key, or model not enabled for the project:
        // none of these improves on retry, and the person should hear
        // "please type" now rather than wait.
        if (res.status === 401 || res.status === 403 || /insufficient_quota/.test(body)) {
          throw new TranscriberUnavailableError(detail);
        }
        // This recording, not the service: a corrupted or unsupported file.
        if (res.status === 400) throw new UnreadableAudioError(detail);
        // Rate limits and server errors are transient: let the queue retry.
        throw new Error(detail);
      }

      const json = (await res.json()) as { text?: string; language?: string };
      return { text: json.text ?? '', language: json.language ?? null };
    },
  };
}

function fileNameFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'voice-note.mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'voice-note.m4a';
  if (m.includes('wav')) return 'voice-note.wav';
  if (m.includes('webm')) return 'voice-note.webm';
  // WhatsApp voice notes: audio/ogg; codecs=opus.
  return 'voice-note.ogg';
}

/* ------------------------------------------------------------------ */
/* Shared rules, whichever provider                                    */
/* ------------------------------------------------------------------ */

/**
 * Phrases transcription models are known to produce from silence or
 * background noise, learned from subtitle-heavy training data. Matched
 * against the whole transcript only, so a real question that happens to
 * contain "thank you" is never discarded.
 */
const SILENCE_PHRASES = new Set([
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'thank you for watching.',
  'please subscribe',
  'subtitles by the amara.org community',
  'you',
  'bye',
  'bye.',
]);

/**
 * Can this transcript be acted on? Null if so; the reason if not.
 * Pure, so every case is tested without calling a provider.
 */
export function silenceReason(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return 'empty transcript';
  if (SILENCE_PHRASES.has(lower)) return `silence phrase "${text}"`;
  // An echo of the prompt reproduces a long stretch of it. A real
  // question may be a short piece of it — "Certificate of Occupancy?" —
  // so only a large share counts.
  const bare = lower.replace(/[.!?]$/, '');
  if (bare.length >= VOCABULARY_PROMPT.length * 0.4 && VOCABULARY_PROMPT.toLowerCase().includes(bare)) {
    return 'transcript is the vocabulary prompt echoed back';
  }
  return null;
}

/**
 * Length of an Ogg/Opus recording, read from the file itself.
 *
 * The last Ogg page's granule position counts 48 kHz samples from the
 * start; Opus's header records a pre-skip to subtract. No decoding, and
 * the provider does not need to report it. Null if the file is not
 * Ogg/Opus or the header cannot be found, in which case the size cap
 * still applies.
 */
export function oggOpusSeconds(bytes: Uint8Array): number | null {
  const isOggS = (i: number) => bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53;
  if (bytes.length < 47 || !isOggS(0)) return null;

  // OpusHead is in the first page; pre-skip is a little-endian uint16 at offset 10 of it.
  let preSkip = 0;
  const head = findAscii(bytes, 'OpusHead', 0, Math.min(bytes.length, 512));
  if (head < 0) return null;
  preSkip = bytes[head + 10]! | (bytes[head + 11]! << 8);

  // Search backwards for the last page header.
  for (let i = bytes.length - 27; i >= 0; i--) {
    if (!isOggS(i)) continue;
    // Granule position: little-endian int64 at offset 6. Voice notes are
    // far below 2^53 samples, so a Number is exact.
    let granule = 0;
    for (let b = 7; b >= 0; b--) granule = granule * 256 + bytes[i + 6 + b]!;
    if (granule === 0 || granule >= 2 ** 53) return null;
    return Math.max(0, Math.round(((granule - preSkip) / 48_000) * 10) / 10);
  }
  return null;
}

function findAscii(bytes: Uint8Array, needle: string, from: number, to: number): number {
  outer: for (let i = from; i <= to - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
