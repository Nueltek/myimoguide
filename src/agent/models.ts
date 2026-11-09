import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel, Tool, generateText } from 'ai';
import type { Env } from '../types';

/**
 * The only file in this codebase that names a provider or a model.
 *
 * Nothing else imports @ai-sdk/anthropic or @ai-sdk/openai. Swapping the
 * whole system is configuration, never a code change — which matters
 * because running one provider's credit down must never stall the work.
 *
 * Switching is four optional settings:
 *
 *   MODEL_PROVIDER    "anthropic" (default) | "openai"
 *   ROUTING_MODEL     override the per-provider default below
 *   SYNTHESIS_MODEL   override the per-provider default below
 *   OPENAI_API_KEY    required when MODEL_PROVIDER is "openai", and for voice notes
 *
 * GET /health reports which provider and models are live, so a switch can
 * be confirmed rather than assumed.
 *
 * TWO MODELS, because the jobs want opposite things:
 *
 *   routing    a tiny classification into a fixed schema, on every single
 *              message. Wants the cheapest model that is accurate enough.
 *   synthesis  reads web pages and writes prose a commissioner may read
 *              aloud. Wants quality; runs only when records miss.
 *
 * Prices per million tokens, checked 7 November 2026. The two providers
 * are at parity at both tiers, so this is an answer-quality decision, not
 * a cost one:
 *
 *   routing     claude-haiku-5-5   $0.10 / $0.50
 *               gpt-6-luna         $0.10 / $0.50
 *   synthesis   claude-sonnet-5-5  $2.00 / $10.00
 *               gpt-6.1-sol        $2.00 / $10.00
 *
 * OpenAI has one rung Anthropic lacks, gpt-6.1-terra at $1 / $5, if
 * synthesis cost ever bites. Set SYNTHESIS_MODEL to use it.
 *
 * Web search is billed separately at $10 per 1,000 searches on both.
 */

export type ModelProvider = 'anthropic' | 'openai';

const DEFAULTS = {
  anthropic: { routing: 'claude-haiku-5-5', synthesis: 'claude-sonnet-5-5' },
  openai: { routing: 'gpt-6-luna', synthesis: 'gpt-6.1-sol' },
} as const;

export function providerOf(env: Env): ModelProvider {
  return env.MODEL_PROVIDER === 'openai' ? 'openai' : 'anthropic';
}

export function routingModelId(env: Env): string {
  return env.ROUTING_MODEL?.trim() || DEFAULTS[providerOf(env)].routing;
}

export function synthesisModelId(env: Env): string {
  return env.SYNTHESIS_MODEL?.trim() || DEFAULTS[providerOf(env)].synthesis;
}

function client(env: Env) {
  return providerOf(env) === 'openai'
    ? createOpenAI({ apiKey: env.OPENAI_API_KEY })
    : createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Per-call settings, by provider.
 *
 * Learned the hard way. Anthropic's models here answer directly, so the
 * output limit only has to fit the answer. OpenAI's gpt-6 models are
 * reasoning models — "medium" reasoning by default — and OpenAI counts
 * that hidden reasoning against the same output limit. Routing was capped
 * at 200 tokens: fine for Haiku, and fine for gpt-6-luna on a short
 * conversation. Once a long answer sat in the history, the model reasoned
 * past 200 tokens before writing its decision, returned nothing with a
 * success status, and every later message from that user failed with
 * "No object generated: the model did not return a response".
 *
 * So for OpenAI: reasoning turned down to "low" (routing is a simple
 * classification; web answers summarise what was read), and limits large
 * enough to hold reasoning plus answer. Output is billed as used, not as
 * allowed, so a higher ceiling costs nothing on its own. Temperature is
 * left out for reasoning models, which do not accept it.
 */
type CallSettings = Pick<Parameters<typeof generateText>[0], 'maxOutputTokens' | 'temperature' | 'providerOptions'>;

export function routingSettings(env: Env): CallSettings {
  return providerOf(env) === 'openai'
    ? { maxOutputTokens: 2_000, providerOptions: { openai: { reasoningEffort: 'low' } } }
    : { maxOutputTokens: 300, temperature: 0 };
}

export function synthesisSettings(env: Env): CallSettings {
  return providerOf(env) === 'openai'
    ? { maxOutputTokens: 4_000, providerOptions: { openai: { reasoningEffort: 'low' } } }
    : { maxOutputTokens: 700, temperature: 0 };
}

/** Cheap, deterministic classification. Runs on every message. */
export function routingModel(env: Env): LanguageModel {
  return client(env)(routingModelId(env));
}

/** Reads sources and writes the answer. Quality matters here. */
export function synthesisModel(env: Env): LanguageModel {
  return client(env)(synthesisModelId(env));
}

/**
 * The provider's own server-side web search.
 *
 * NO userLocation. Anthropic rejects the whole request with
 * "Country code NG is not supported", which silently killed every search
 * until the error was surfaced. The tool takes only a short list of
 * countries, and Nigeria is not on it.
 *
 * Nothing is lost: every question here is explicitly about Imo State and
 * the instructions say so, which steers results better than a coarse
 * country hint would. Do not reintroduce userLocation without testing a
 * live search against the provider first.
 */
export function webSearchTool(env: Env): Record<string, Tool> {
  if (providerOf(env) === 'openai') {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    return { web_search: openai.tools.webSearch({ searchContextSize: 'medium' }) };
  }

  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    web_search: anthropic.tools.webSearch_20260318({
      // Cost ceiling per question, and a latency ceiling with it.
      maxUses: 3,
    }),
  };
}

/** What /health reports, so a switch can be verified rather than assumed. */
export function activeConfig(env: Env) {
  const provider = providerOf(env);
  return {
    provider,
    routingModel: routingModelId(env),
    synthesisModel: synthesisModelId(env),
    // Presence only — never the key itself.
    keyPresent: provider === 'openai' ? Boolean(env.OPENAI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY),
  };
}

/**
 * Is this error the provider refusing our account — no credit left, a
 * revoked key — rather than a one-off failure?
 *
 * The difference decides what happens next. A one-off failure is worth
 * the queue's retries. An account problem fails identically every time,
 * so retrying only triples the wait and ends in a vague apology, while
 * the real cause sits unseen in the logs. Instead it is answered at once,
 * honestly, and logged in a line nobody can miss.
 *
 * Looks through the wrappers the AI SDK puts around provider errors
 * (RetryError.lastError, cause), and matches on what Anthropic and OpenAI
 * actually return.
 */
export function providerAccountProblem(err: unknown): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const x = e as { statusCode?: number; responseBody?: string; message?: string; lastError?: unknown; cause?: unknown; errors?: unknown[] };
    const text = `${x.responseBody ?? ''} ${x.message ?? ''}`;
    if (/credit balance is too low|insufficient_quota|exceeded your current quota|billing/i.test(text)) {
      return `the model provider reports no credit or quota left (${x.statusCode ?? 'no status'}): ${text.trim().slice(0, 200)}`;
    }
    if (x.statusCode === 401 || x.statusCode === 403 || /invalid x-api-key|incorrect api key|invalid_api_key|authentication_error|permission_error/i.test(text)) {
      return `the model provider rejected the API key (${x.statusCode ?? 'no status'}): ${text.trim().slice(0, 200)}`;
    }
    queue.push(x.lastError, x.cause, ...(Array.isArray(x.errors) ? x.errors : []));
  }
  return null;
}
