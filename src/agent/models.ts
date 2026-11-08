import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel, Tool } from 'ai';
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
