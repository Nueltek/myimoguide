import { generateText } from 'ai';
import { conversationContext } from './context';
import type { Env } from '../types';
import { synthesisModel, webSearchTool } from './models';

/**
 * Tier 2: answer from the live web, with every claim attributed.
 *
 * This runs ONLY when the database has no record. The database always
 * wins, because a curated row carries something the web cannot: somebody
 * we can name checked it, on a date we can state.
 *
 * The rule that makes this safe is not "never use the web" — it is
 * "never present an unverified claim as a verified one". A sourced answer
 * that says where it came from and admits it is unconfirmed is honest and
 * useful. A confident answer from the model's own memory is neither.
 *
 * Anthropic runs the search server-side and returns citations, so this
 * costs ONE subrequest regardless of how many pages are read — which is
 * what makes it viable against the free plan's 50-per-invocation cap.
 *
 * Billing note: web search is charged per search, separately from tokens.
 * `maxUses` is the cost ceiling per question.
 */

export interface SearchResult {
  text: string;
  sources: Array<{ title: string; url: string }>;
  /** True when we have an attributed answer to show. */
  found: boolean;
  /**
   * Set when the search itself broke rather than simply finding nothing.
   *
   * These are different events and must not look the same to the user.
   * "I have no confirmed answer" is a statement about the world; a failed
   * API call is a statement about us. Reporting the second as the first
   * is a lie, and it hides the outage — which is exactly what happened
   * the first time this shipped.
   */
  error?: string;
}

/**
 * Optional allowlist. Empty = search the open web.
 *
 * Narrowing this to official and established sources raises answer
 * quality and is a strong line in a pitch ("we only read from these"),
 * but it also returns nothing for long-tail questions. Start open, watch
 * what the pilot's citations look like, then tighten.
 */
const ALLOWED_DOMAINS: string[] = [];

export async function searchWeb(
  env: Env,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
): Promise<SearchResult> {
  const context = conversationContext(history);

  try {
    const result = await generateText({
      model: synthesisModel(env),
      tools: webSearchTool(env),
      instructions: [
        'You answer questions about Imo State, Nigeria for residents and visitors, on WhatsApp.',
        '',
        'You MUST search before answering. Never answer from your own memory.',
        'If the search returns nothing relevant, say so plainly. Do not fill the gap.',
        '',
        'Hard rules:',
        '- Never state a bank account number, payment reference or account name from a web page. These are forged by scammers and indexed by search engines. If a page gives one, say the official office must confirm it.',
        '- Never give an emergency phone number from a web page as if it were checked. Point to 112 instead.',
        '- Prefer official sources (gov.ng domains, the state government, agency sites) over blogs and aggregators.',
        '- If sources disagree, say they disagree and give both.',
        '- Attribute dates: say when something was published or last updated if the page states it.',
        '',
        'Style: short, plain, WhatsApp-friendly. Use *bold* sparingly for key values.',
        'No markdown headings, no bullet characters other than a simple dash.',
        'Three short paragraphs at most. Do not list the source URLs yourself — they are added separately.',
      ].join('\n'),
      prompt: context ? `${context}\n\nUser: ${question}` : question,
      maxOutputTokens: 700,
      temperature: 0,
      // Must finish inside the consumer's ANSWER_BUDGET_MS, which in turn
      // sits inside WhatsApp's ~25s typing indicator. A search allowed to
      // outlast the indicator leaves the user staring at nothing.
      abortSignal: AbortSignal.timeout(18_000),
    });

    const sources = (result.sources ?? [])
      .filter((s): s is typeof s & { url: string } => 'url' in s && typeof s.url === 'string')
      .map((s) => ({
        title: 'title' in s && typeof s.title === 'string' && s.title ? s.title : hostOf(s.url),
        url: s.url,
      }));

    // Dedupe by URL — the same page is often cited several times.
    const seen = new Set<string>();
    const unique = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));

    const text = result.text.trim();

    return {
      text,
      sources: unique.slice(0, 4),
      // No citations means nothing was actually read, whatever the model
      // wrote. Treat that as a miss rather than passing off unsourced prose.
      found: text.length > 0 && unique.length > 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud, and carried back to the caller. A swallowed search failure
    // that renders as "no confirmed answer" is indistinguishable from
    // working correctly, which is how a dead integration stays dead.
    console.error('web search FAILED', {
      message,
      hint:
        'Common causes: web search not enabled in the provider console; ' +
        'bad or missing API key; model id not available to this account.',
    });
    return { text: '', sources: [], found: false, error: message };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
