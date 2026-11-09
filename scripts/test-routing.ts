/**
 * Routing on a reasoning model — the failure seen in production on
 * 8 Nov 2026, reproduced and then fixed.
 *
 * In production, after one long answer sat in a user's history,
 * gpt-6-luna spent its whole 200-token output allowance reasoning,
 * returned no message with a 200 status, and every later message from
 * that user failed with:
 *
 *   AI_NoObjectGeneratedError: No object generated: the model did not
 *   return a response.
 *
 * Here OpenAI's Responses API is faked to answer exactly that way, and
 * the real AI SDK parses it. The first check proves the fake reproduces
 * the production error message, so the checks after it test the real
 * failure, not an imagined one.
 *
 *   npm run test:routing
 */
import assert from 'node:assert/strict';
import { generateObject } from 'ai';
import { z } from 'zod';
import { answerQuestion, decideRoute, effectiveSensitivity, fallbackRoute } from '../src/agent/answer';
import { cleanUrl, orderSources, sourceLine, stripInlineLinks } from '../src/agent/citations';
import { renderSourced } from '../src/agent/render';
import { routingModel, routingSettings, synthesisSettings } from '../src/agent/models';

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

const openai = { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' } as never;
const anthropic = { ANTHROPIC_API_KEY: 'test-key' } as never;

/** What OpenAI returns when a reasoning model spends its allowance before writing anything. */
const ranOutReasoning = () =>
  Response.json({
    id: 'resp_test',
    object: 'response',
    created_at: 1_794_160_285,
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    model: 'gpt-6-luna',
    output: [{ type: 'reasoning', id: 'rs_test', summary: [] }],
    usage: {
      input_tokens: 1_850,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 200 },
      total_tokens: 2_050,
    },
  });

/** A normal, complete routing decision. */
const decided = (decision: object) =>
  Response.json({
    id: 'resp_ok',
    object: 'response',
    created_at: 1_794_160_285,
    status: 'completed',
    model: 'gpt-6-luna',
    output: [
      { type: 'reasoning', id: 'rs_ok', summary: [] },
      {
        type: 'message',
        id: 'msg_ok',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(decision), annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1_850,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 140,
      output_tokens_details: { reasoning_tokens: 90 },
      total_tokens: 1_990,
    },
  });

let requests: Array<Record<string, unknown>> = [];
function openaiAnswers(respond: () => Response | Promise<Response>) {
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.openai.com/v1/responses')) throw new Error(`unexpected fetch ${url}`);
    requests.push(JSON.parse(String(init?.body)));
    return respond();
  }) as typeof fetch;
}

const catalogue = [{ slug: 'certificate-of-occupancy', name: 'Certificate of Occupancy', aliases: ['C of O'], summary: 'Land title' }];
const longAnswer = 'Certificate of Occupancy (C of O). The state document confirming your legal right. '.repeat(30);
const history = [
  { role: 'user' as const, text: 'Where can I get my C of O?' },
  { role: 'assistant' as const, text: longAnswer },
];
const route = (question: string) => decideRoute(openai, question, history, catalogue, [], []);

/* ------------------------------------------------------------------ */

console.log('\nThe production failure, reproduced');
openaiAnswers(ranOutReasoning);
await check('a reasoning model that ran out of tokens gives exactly the production error', async () => {
  await assert.rejects(
    generateObject({ model: routingModel(openai), schema: z.object({ kind: z.string() }), prompt: 'x', maxOutputTokens: 200 }),
    /No object generated: the model did not return a response/,
  );
});

console.log('\nThe fix: settings that leave room to reason');
openaiAnswers(() => decided({ kind: 'service', serviceSlug: 'certificate-of-occupancy', factSlug: null, agencySlug: null, facilityType: null, lga: null, confidence: 'high', sensitivity: 'routine' }));
let r = await route('How much does it cost?');
const sent = requests[0]!;
await check('routing on OpenAI asks for low reasoning', () => assert.equal((sent.reasoning as { effort?: string }).effort, 'low'));
await check('routing on OpenAI allows 2,000 output tokens, not 200', () => assert.equal(sent.max_output_tokens, 2000));
await check('no temperature is sent to a reasoning model', () => assert.equal(sent.temperature, undefined));
await check('a complete decision is used as given', () => assert.equal(r.kind, 'service'));
await check('web answers on OpenAI also get room to reason', () =>
  assert.deepEqual(synthesisSettings(openai), { maxOutputTokens: 4000, providerOptions: { openai: { reasoningEffort: 'low' } } }));
await check('Anthropic keeps its direct-answer settings', () => {
  assert.deepEqual(routingSettings(anthropic), { maxOutputTokens: 300, temperature: 0 });
  assert.deepEqual(synthesisSettings(anthropic), { maxOutputTokens: 700, temperature: 0 });
});

console.log('\nThe fix: if the model still returns nothing, the question is still answered');
openaiAnswers(ranOutReasoning);
r = await route('Where can I pay my tax in Imo State?');
await check('an empty response falls back to the cited web search, instead of failing', () => {
  assert.equal(r.kind, 'none');
  assert.equal(r.sensitivity, 'routine');
});
await check('the same happens for the Pidgin question from the screenshot', async () =>
  assert.equal((await route('Abeg where I fit pay my tax for Imo state')).kind, 'none'));

openaiAnswers(() => new Response('{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}', { status: 401 }));
await check('an account problem is not hidden by the fallback: it is thrown, to be reported honestly', () =>
  assert.rejects(route('Where can I pay my tax?'), /API key/i));

openaiAnswers(() => {
  throw new TypeError('fetch failed');
});
await check('a network failure is not hidden by the fallback: it is thrown, for the queue to retry', () =>
  assert.rejects(route('Where can I pay my tax?')));

console.log('\nThe fallback keeps the safeguards');
await check('a request for an account number is still withheld from the web', () =>
  assert.equal(fallbackRoute('What is the IIRS account number to pay into?').sensitivity, 'payment_details'));
await check('a Remita / RRR question too', () => assert.equal(fallbackRoute('send me the RRR for my land use charge').sensitivity, 'payment_details'));
await check('an emergency is still withheld from the web', () =>
  assert.equal(fallbackRoute('There is a fire in my street, who do I call').sensitivity, 'emergency'));
await check('asking what a fee costs is routine, as the router would decide', () =>
  assert.equal(fallbackRoute('How much is a Certificate of Occupancy?').sensitivity, 'routine'));
await check('a bare greeting still gets the welcome', () => assert.equal(fallbackRoute('Good morning!').kind, 'greeting'));
await check('a greeting with a question is a question', () => assert.equal(fallbackRoute('Hello, where is the IIRS office?').kind, 'none'));

console.log('\n"Where can I pay?" is a location, not an account request');
const asked = (q: string) => effectiveSensitivity('payment_details', q);
await check('"Where can I pay my tax?" is answered, even if the model flags it', () => assert.equal(asked('Where can I pay my tax in Imo State?'), 'routine'));
await check('the Pidgin version too', () => assert.equal(asked('Abeg where I fit pay my tax for Imo state'), 'routine'));
await check('"How do I pay my land use charge?" is answered', () => assert.equal(asked('How do I pay my land use charge?'), 'routine'));
await check('"Which account do I pay into?" is still withheld', () => assert.equal(asked('Which account do I pay into?'), 'payment_details'));
await check('"Where do I send the money?" is still withheld', () => assert.equal(asked('Where do I send the money for my C of O?'), 'payment_details'));
await check('"What is the IIRS account number?" is still withheld', () => assert.equal(asked('What is the IIRS account number?'), 'payment_details'));
await check('"Give me the RRR" is still withheld', () => assert.equal(asked('give me the RRR for land use charge'), 'payment_details'));
await check('a vague follow-up keeps the model\'s caution', () => assert.equal(asked('and that one?'), 'payment_details'));
await check('emergencies are never overridden', () => assert.equal(effectiveSensitivity('emergency', 'where is the hospital'), 'emergency'));

console.log('\nWeb answers on WhatsApp: no raw links, the cited page listed first');
// The answer from the 8 Nov screenshot, as OpenAI wrote it.
const screenshot =
  'Yes, *General Hospital, Okigwe* dey for Okigwe town. Imo State Health Insurance Agency lists am for general care, maternity, surgery and children’s care. ([imshiaonline.com](https://imshiaonline.com/imohcps/?utm_source=openai))\n\nWhich side of Okigwe you dey?';
const stripped = stripInlineLinks(screenshot);
await check('the raw "([site](url))" citation is gone from the text', () => {
  assert.ok(!stripped.text.includes('](') && !stripped.text.includes('(['), stripped.text);
  assert.ok(stripped.text.includes("children’s care.\n"), JSON.stringify(stripped.text.slice(100, 180)));
});
await check('a link on real words keeps the words', () =>
  assert.equal(stripInlineLinks('See the [IIRS website](https://iirs.im.gov.ng/) for forms.').text, 'See the IIRS website for forms.'));
await check('OpenAI\'s tracking parameter is removed from URLs', () =>
  assert.equal(cleanUrl('https://imshiaonline.com/imohcps/?utm_source=openai'), 'https://imshiaonline.com/imohcps/'));
const searchSources = [
  { title: 'myimoapp.com', url: 'https://www.myimoapp.com/hospitals?utm_source=openai' },
  { title: 'library.procurementmonitor.org', url: 'https://library.procurementmonitor.org/list.pdf' },
  { title: 'ashmedintegratedhealthservices.com', url: 'https://ashmedintegratedhealthservices.com/providers/' },
  { title: 'imostate.gov.ng', url: 'https://imostate.gov.ng/' },
  { title: 'imshiaonline.com', url: 'https://imshiaonline.com/imohcps/?utm_source=openai' },
  { title: 'myimoapp.com', url: 'https://www.myimoapp.com/hospitals' },
];
const listed = orderSources(searchSources, stripped.cited);
await check('the page the answer quoted is listed first (it was missing before)', () => assert.equal(listed[0]!.url, 'https://imshiaonline.com/imohcps/'));
await check('duplicates are listed once, at most four', () => {
  assert.equal(listed.length, 4);
  assert.equal(new Set(listed.map((l) => l.url)).size, 4);
});
await check('a URL only in the prose, never reported as a source, is not listed', () =>
  assert.ok(!orderSources(searchSources, ['https://made-up.example/page']).some((l) => l.url.includes('made-up'))));
await check('each source is one line, the address only once', () => {
  assert.equal(sourceLine({ title: 'imshiaonline.com', url: 'https://imshiaonline.com/imohcps/' }), '• https://imshiaonline.com/imohcps/');
  assert.equal(sourceLine({ title: 'IMSHIA providers list', url: 'https://imshiaonline.com/imohcps/' }), '• IMSHIA providers list: https://imshiaonline.com/imohcps/');
});
await check('the full reply reads cleanly', () => {
  const reply = renderSourced(stripped.text, listed);
  assert.ok(!reply.includes(']('), 'raw link syntax in the reply');
  assert.ok(!reply.includes('utm_source'), 'tracking parameter in the reply');
});

console.log('\nThe whole answer path, as it runs');
/**
 * answerQuestion() reads its catalogue with one db.batch call. pglite has
 * no batch, so a stand-in returns an empty catalogue, as a fresh
 * deployment has: every question then goes to routing and the web.
 */
const chain: any = new Proxy(() => chain, { get: (_t, key) => (key === 'then' ? undefined : chain), apply: () => chain });
const emptyDb = { select: () => chain, batch: async () => [[], [], []] } as never;

/** OpenAI routes the question, then answers it from the web with a citation. */
function routeThenSearch(decision: object, answer: string, citations: Array<{ url: string; title: string }>) {
  let call = 0;
  openaiAnswers(() => {
    call++;
    if (call === 1) return decided(decision);
    return Response.json({
      id: 'resp_search',
      object: 'response',
      created_at: 1_794_160_285,
      status: 'completed',
      model: 'gpt-6.1-sol',
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'pay tax Imo State' } },
        {
          type: 'message',
          id: 'msg_search',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: answer,
              annotations: citations.map((c) => ({ type: 'url_citation', url: c.url, title: c.title, start_index: 0, end_index: 10 })),
            },
          ],
        },
      ],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 1200 },
    });
  });
}

const flaggedAsPayment = { kind: 'none', serviceSlug: null, factSlug: null, agencySlug: null, facilityType: null, lga: null, confidence: 'low', sensitivity: 'payment_details' };
routeThenSearch(
  flaggedAsPayment,
  'You can pay at any IIRS office, including 76 Okigwe Road, Owerri. ([iirs.im.gov.ng](https://iirs.im.gov.ng/offices?utm_source=openai))',
  [
    { url: 'https://www.myimoapp.com/tax?utm_source=openai', title: 'myimoapp.com' },
    { url: 'https://iirs.im.gov.ng/offices?utm_source=openai', title: 'IIRS offices' },
  ],
);
let answered = await answerQuestion({ db: emptyDb, env: openai, question: 'Where can I pay my tax in Imo State?', history: [] });
await check('"Where can I pay my tax?" flagged as payment details is answered, not withheld', () => assert.equal(answered.tier, 'sourced'));
await check('the reply has no raw link syntax and no tracking parameter', () => {
  assert.ok(!answered.text.includes(']('), answered.text);
  assert.ok(!answered.text.includes('utm_source'), answered.text);
});
await check('the page the answer cited is the first source listed', () => {
  const sourcesBlock = answered.text.split('*Sources*')[1] ?? '';
  assert.ok(sourcesBlock.trim().startsWith('• IIRS offices: https://iirs.im.gov.ng/offices'), sourcesBlock);
});

routeThenSearch(flaggedAsPayment, 'should never be reached', []);
answered = await answerQuestion({ db: emptyDb, env: openai, question: 'Which account do I pay my tax into?', history: [] });
await check('"Which account do I pay into?" is still withheld, and the web is never searched', () => {
  assert.equal(answered.tier, 'withheld');
  assert.equal(requests.length, 1, `${requests.length} OpenAI calls`);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
