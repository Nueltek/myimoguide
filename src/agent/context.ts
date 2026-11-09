/**
 * The recent conversation, as the models see it.
 *
 * Every turn is cut to a few hundred characters. The router and the
 * search only need the gist of what was said — "and the fee?" needs to
 * know the last answer was about a Certificate of Occupancy, not every
 * line of it. Keeping it short holds the token cost of every message
 * down, and means no single long or odd answer in the history can crowd
 * out or derail the question actually being asked.
 */
export const CONTEXT_TURNS = 4;
export const CONTEXT_CHARS_PER_TURN = 400;

export function conversationContext(history: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  return history
    .slice(-CONTEXT_TURNS)
    .map((t) => {
      const text = t.text.replace(/\s+/g, ' ').trim();
      const cut = text.length > CONTEXT_CHARS_PER_TURN ? `${text.slice(0, CONTEXT_CHARS_PER_TURN - 3).trimEnd()}...` : text;
      return `${t.role === 'user' ? 'User' : 'Assistant'}: ${cut}`;
    })
    .join('\n');
}
