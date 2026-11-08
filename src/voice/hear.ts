import type { Env } from '../types';
import { MediaTooLargeError, fetchMedia } from '../whatsapp/client';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  TranscriberUnavailableError,
  UnreadableAudioError,
  oggOpusSeconds,
  silenceReason,
  transcriberFor,
} from './transcribe';

/**
 * From a WhatsApp media id to either a transcript we can act on, or a
 * reply that tells the person plainly what to do instead.
 *
 * Transient failures — Meta's media servers, a rate limit, a provider
 * outage — are thrown, so the queue retries them and, on the last attempt,
 * the consumer apologises. Outcomes a retry cannot change (silence, a note
 * too long, no credit left) are returned as replies straight away.
 *
 * The audio is held in memory for this invocation only. It is never
 * written anywhere.
 */

export type Hearing =
  | { ok: true; text: string; language: string | null; seconds: number | null; provider: string; model: string }
  | {
      ok: false;
      reason: Unheard;
      reply: string;
      language: string | null;
      seconds: number | null;
      provider: string;
      model: string;
      /** For the log: why, in specifics. */
      detail: string;
    };

export type Unheard = 'no_speech' | 'too_long' | 'unreadable' | 'unavailable' | 'slow';

/** How long transcription may take before we stop waiting. Leaves most of the answer budget intact. */
export const TRANSCRIBE_BUDGET_MS = 10_000;

export const UNHEARD_REPLIES: Record<Unheard, string> = {
  no_speech:
    'I could not hear any words in that voice note. Please try again somewhere quieter, or type your question.',
  too_long: `That voice note is too long for me. Please send a shorter one, under ${MAX_AUDIO_SECONDS / 60} minutes, or type your question.`,
  unreadable: 'I could not open that voice note. Please record it again, or type your question.',
  unavailable: 'I cannot listen to voice notes at the moment. Please type your question and I will answer it straight away.',
  slow: 'That voice note took too long to process. Please try again, or type your question.',
};

/** How the dashboard describes each. */
export const UNHEARD_LABELS: Record<Unheard, string> = {
  no_speech: 'no speech heard',
  too_long: 'voice note too long',
  unreadable: 'recording could not be read',
  unavailable: 'voice transcription unavailable',
  slow: 'transcription too slow',
};

export async function hearVoiceNote(env: Env, mediaId: string, budgetMs = TRANSCRIBE_BUDGET_MS): Promise<Hearing> {
  const transcriber = transcriberFor(env);
  const who = { provider: transcriber.provider, model: transcriber.model };
  let seconds: number | null = null;

  const refuse = (reason: Unheard, detail: string, language: string | null = null): Hearing => {
    console.log(`voice: ${reason} seconds=${seconds ?? '?'} provider=${who.provider} model=${who.model} detail="${detail}"`);
    return { ok: false, reason, reply: UNHEARD_REPLIES[reason], language, seconds, detail, ...who };
  };

  if (transcriber.problem) {
    console.error(`voice: transcription unavailable — ${transcriber.problem}`);
    return refuse('unavailable', transcriber.problem);
  }

  let bytes: ArrayBuffer;
  let mimeType: string;
  try {
    ({ bytes, mimeType } = await fetchMedia(env, mediaId, MAX_AUDIO_BYTES));
  } catch (err) {
    if (err instanceof MediaTooLargeError) return refuse('too_long', err.message);
    throw err;
  }

  // Measured from the file before paying to transcribe it.
  seconds = oggOpusSeconds(new Uint8Array(bytes));
  if (seconds !== null && seconds > MAX_AUDIO_SECONDS) return refuse('too_long', `${seconds}s over the ${MAX_AUDIO_SECONDS}s limit`);
  if (seconds !== null && seconds < 0.5) return refuse('no_speech', `${seconds}s recording`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), budgetMs);
  });

  try {
    const result = await Promise.race([transcriber.transcribe(bytes, mimeType), deadline]);
    if (result === 'slow') return refuse('slow', `no transcript within ${budgetMs} ms`);

    const silent = silenceReason(result.text);
    if (silent) return refuse('no_speech', silent, result.language);

    const text = result.text.replace(/\s+/g, ' ').trim();
    console.log(
      `voice: heard bytes=${bytes.byteLength} seconds=${seconds ?? '?'} chars=${text.length} ` +
        `language=${result.language ?? '?'} provider=${who.provider} model=${who.model}`,
    );
    return { ok: true, text, language: result.language, seconds, ...who };
  } catch (err) {
    if (err instanceof TranscriberUnavailableError) {
      console.error(`voice: transcription unavailable — ${err.message}`);
      return refuse('unavailable', err.message);
    }
    if (err instanceof UnreadableAudioError) return refuse('unreadable', err.message);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The line that opens every reply to a voice note. Shows the person what
 * we heard, so a mishearing is obvious and they can correct it, rather
 * than receiving a confident answer to a question they never asked.
 */
export function echoLine(transcript: string): string {
  // WhatsApp formatting characters inside the transcript would break the
  // italics or embolden random words.
  const clean = transcript.replace(/[_*~`]/g, '').replace(/\s+/g, ' ').trim();
  const shown = clean.length > 280 ? `${clean.slice(0, 277).trimEnd()}...` : clean;
  return `_You said: "${shown}"_`;
}
