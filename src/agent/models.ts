import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel, Tool } from 'ai';
import type { Env } from '../types';

/**
 * The one place a model or provider is named.
 *
 * Nothing else in the codebase imports a provider package. Switching the
 * whole system between Anthropic and OpenAI is a single secret:
 *
 *   npx wrangler secret put MODEL_PROVIDER     # "anthropic" | "openai"
 *
 * This is what "model agnostic" has to mean in practice. The Vercel AI
 * SDK already normalises generateText, generateObject, tool calling and
 * structured output across providers — but that buys nothing if
 * createAnthropic is sprinkled through the call sites.
 *
 * Two jobs, two models, because they want opposite things:
 *
 *   routing    — a tiny classification into a schema, run on every single
 *                message. Wants the cheapest adequate model.
 *   synthesis  — reading web pages and writing the answer a commissioner
 *                may read aloud. Wants quality.
 *
 * Prices per million tokens, checked 7 Nov 2026:
 *
 *   routing     Haiku 5.5     $0.10 / $0.50      Luna      $0.10 / $0.50
 *   synthesis   Sonnet 5.5    $2.00 / $10.00     6.1 Sol   $2.00 / $10.00
 *
 * They are at parity at both tiers, so provider choice is an answer
 * quality question, not a cost one. OpenAI does have one rung Anthropic
 * lacks — gpt-6.1-terra at $1/$5 — if synthesis cost ever bites.
 *
 * Web search is $10 per 1,000 searches on both.
 */

export type ModelProvider = 'anthropic' | 'openai';

export function providerOf(env: Env): ModelProvider {
  return env.MODEL_PROVIDER === 'openai' ? 'openai' : 'anthropic';
}

/** Cheap, deterministic classification. Runs on every message. */
export function routingModel(env: Env): LanguageModel {
  if (providerOf(env) === 'openai') {
    return createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-6-luna');
  }
  return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-haiku-5-5');
}

/** Reads sources and writes the answer. Quality matters here. */
export function synthesisModel(env: Env): LanguageModel {
  if (providerOf(env) === 'openai') {
    return createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-6.1-sol');
  }
  return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-sonnet-5-5');
}

/**
 * The provider's own web search tool, which runs server-side.
 *
 * This is the one place the two providers genuinely differ in shape, so
 * it is normalised here rather than at the call site. Both bill $10 per
 * 1,000 searches; `maxUses` is the per-question cost ceiling.
 */
export function webSearchTool(env: Env): Record<string, Tool> {
  if (providerOf(env) === 'openai') {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    return {
      web_search: openai.tools.webSearch({
        searchContextSize: 'medium',
        userLocation: {
          type: 'approximate',
          country: 'NG',
          region: 'Imo',
          city: 'Owerri',
        },
      }),
    };
  }

  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    web_search: anthropic.tools.webSearch_20260318({
      maxUses: 3,
      userLocation: {
        type: 'approximate',
        country: 'NG',
        region: 'Imo',
        city: 'Owerri',
        timezone: 'Africa/Lagos',
      },
    }),
  };
}

/**
 * Fails loudly at the start of a request rather than deep inside a
 * provider call, where the error surfaces as a generic failure.
 */
export function assertConfigured(env: Env): void {
  const provider = providerOf(env);
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('MODEL_PROVIDER is "openai" but OPENAI_API_KEY is not set');
  }
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('MODEL_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set');
  }
}
