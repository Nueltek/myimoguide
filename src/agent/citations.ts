/**
 * Turning a web answer's citations into something WhatsApp can show.
 *
 * OpenAI's web search writes its citations into the answer itself, as
 * Markdown links — "([imshiaonline.com](https://imshiaonline.com/...))".
 * WhatsApp does not render Markdown links, so residents saw the raw
 * syntax. And the sources list was simply the first four the search
 * returned, so the page the answer actually quoted could be missing from
 * it while four others were listed.
 *
 * Here the links are taken out of the text (the sources are listed
 * underneath anyway), and the pages the answer cited are put first in
 * that list. Only URLs the provider reported as sources are listed: a URL
 * that appears only in the model's prose is not shown, because nothing
 * says it was actually read.
 */

export interface Source {
  title: string;
  url: string;
}

const PAREN_LINK = /\s*\(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\)/g;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** The text without Markdown links, and the URLs it cited, in order. */
export function stripInlineLinks(text: string): { text: string; cited: string[] } {
  const cited: string[] = [];
  const out = text
    // "([site](url))" is a citation marker: drop it entirely.
    .replace(PAREN_LINK, (_m, _label, url: string) => {
      cited.push(cleanUrl(url));
      return '';
    })
    // "[words](url)" is a link on real words: keep the words.
    .replace(LINK, (_m, label: string, url: string) => {
      cited.push(cleanUrl(url));
      return label;
    })
    // Tidy what removing a marker leaves behind: " ." and doubled spaces.
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text: out, cited };
}

/** Without tracking parameters (OpenAI adds utm_source=openai), for display and comparison. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
    u.hash = '';
    return u.toString().replace(/\?$/, '');
  } catch {
    return raw;
  }
}

/** Deduplicated, cited pages first, at most `limit`. */
export function orderSources(sources: Source[], cited: string[], limit = 4): Source[] {
  const byUrl = new Map<string, Source>();
  for (const s of sources) {
    const url = cleanUrl(s.url);
    if (!byUrl.has(url)) byUrl.set(url, { title: s.title, url });
  }
  const first = cited.filter((u, i) => cited.indexOf(u) === i && byUrl.has(u)).map((u) => byUrl.get(u)!);
  const rest = [...byUrl.values()].filter((s) => !first.includes(s));
  return [...first, ...rest].slice(0, limit);
}

/** One line per source. The title only when it says more than the address does. */
export function sourceLine(s: Source): string {
  let host = '';
  try {
    host = new URL(s.url).hostname.replace(/^www\./, '');
  } catch {
    // keep host empty
  }
  const title = s.title.trim();
  const informative = title && title.replace(/^www\./, '') !== host;
  return informative ? `• ${title}: ${s.url}` : `• ${s.url}`;
}
