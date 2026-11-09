# Fix: every message failed after the first voice note

**Reported** 8 Nov 2026. One voice note was answered correctly. Every
message after it from the same number, voice or typed, English or
Pidgin, got *"I could not answer that just now — something failed on my
side"*.

## What happened

The stored log from Cloudflare (Observability, *consumer failed*):

```
AI_NoObjectGeneratedError: No object generated: the model did not return a response.
    at generateObject
    at async routeQuestion
    ...
attempt: 3
```

- Answers come from **OpenAI** (`MODEL_PROVIDER=openai`). The routing step
  that decides "is this a service, an office, a fact, or a web question"
  uses `gpt-6-luna`.
- `gpt-6-luna` is a **reasoning model**, with "medium" reasoning by
  default. OpenAI counts that hidden reasoning against the same output
  limit as the answer.
- Routing was capped at **200 output tokens**. That was right for
  Anthropic's Haiku, which answers directly, and it was enough for
  `gpt-6-luna` on short conversations.
- The bot includes the last few turns when routing. After the first voice
  note, those turns carried a long Certificate of Occupancy answer. With
  that in the prompt, the model reasoned past 200 tokens before writing
  its decision. OpenAI returned an empty response **with a success
  status**, and the AI SDK could not read a decision from it.
- Failed messages are never added to the history, so the history never
  changed. Every later message hit the same wall, three times each, and
  ended in the apology.

The Metrics page agreed. There were exactly 14 OpenAI requests, all
successful: one routing call per failed attempt, and nothing after it.

Voice notes were not the cause. The first voice note was simply the first
long answer to land in the history.

## What changed

1. **Routing and web answers on OpenAI get room to reason.**
   - Reasoning is set to `low`.
   - Routing may use up to 2,000 output tokens and web answers up to
     4,000. Output is billed as used, not as allowed.
   - Anthropic's settings are unchanged.
   - Everything is in `routingSettings` and `synthesisSettings` in
     `src/agent/models.ts`.
2. **If routing still returns nothing, the question is still answered.**
   - It goes to the cited web search, as an unmatched question would.
   - The payment-details and emergency safeguards still apply. In this
     case they are decided by plain keyword checks that err towards
     withholding.
   - An account problem (no credit, bad key) is still reported honestly,
     and a network failure is still retried. Only the empty-response case
     falls back.
3. **Nobody can be stuck again.**
   - When a message fails on its last attempt, that person's saved
     conversation is cleared.
   - A credit or key problem gets an immediate honest reply, and the logs
     get a `PROVIDER UNAVAILABLE` line.
4. **The history sent to the models is trimmed.** It's the last 4 turns,
   each cut to 400 characters, which also saves tokens on every message.

### Tests

- **`npm run test:routing`** (17 checks).
  - A fake OpenAI returns exactly what a reasoning model returns when it
    runs out of tokens, and the real AI SDK parses it.
  - The first check proves the fake reproduces the production error
    message word for word. The rest prove that routing now asks for low
    reasoning with room to finish, that an empty response falls back to
    web search, that account and network errors are not hidden, and that
    the fallback keeps the payment and emergency safeguards.
  - Restoring the old 200-token limit makes the tests fail.
- **`npm run test:consumer`** (23 checks): history clearing, honest
  provider errors, trimmed context.

## Deploy and verify

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
npm test
npx wrangler deploy
```

No migration in this fix.

- [ ] `npm test`: every suite ends in `all passed`, then `e2e passed`
- [ ] Send a typed question from the number that was stuck. It is
      answered. Your old conversation was never cleared, because the
      clearing did not exist yet. It works anyway, because routing now
      has room to finish.
- [ ] Send a voice note asking about the Certificate of Occupancy, then
      the voice note and the two typed questions from the screenshots,
      one after another. Each one is answered.
- [ ] Ask a follow-up such as *"and how much is it?"* after a
      Certificate of Occupancy answer. It still understands what "it"
      refers to.
- [ ] Dashboard → Questions shows each message, with no errors

If anything fails, Cloudflare → myimoguide → Observability, with the
time range covering the failure (not the default *Last 1 hour*). Search
`consumer failed` or `routing:` and send me the entry.

---

## Follow-up: three bugs seen in the 8 Nov test screenshots

1. **"Where can I pay my tax?" could be refused as if it asked for an
   account number.** The routing instructions described a payment-details
   request as asking "where to send money", and the model read "where to
   pay" the same way. Two changes:
   - The instructions now say plainly that asking where, at which office
     or how to pay is a normal question. Only a request for the account or
     the reference itself is withheld.
   - A check that does not depend on the model
     (`effectiveSensitivity` in `src/agent/answer.ts`) answers a question
     that asks for a place or a method and names no account, reference or
     transfer, even if the model flags it. Anything vaguer stays withheld.
2. **Raw link code in web answers**, such as
   `([imshiaonline.com](https://...))`. OpenAI writes citations into its
   answer as web-page links, which WhatsApp cannot display. They are now
   removed from the text; the sources are listed underneath.
3. **The page the answer quoted could be missing from the sources.** The
   list was simply the first four pages the search returned. Now the pages
   the answer actually cited come first, OpenAI's `utm_source` tracking is
   removed from the addresses, and each source is one line.
   - Only addresses the provider reported as sources are listed. A link
     that appears only in the model's own text is not, because nothing
     shows it was read.

`npm run test:routing` now has 38 checks. They include the exact answer
from the screenshot, and the whole answer path run end to end with a fake
OpenAI that routes the question and then answers it from the web.

### Verify on your phone

- [ ] *"Where can I pay my tax in Imo State?"* (typed, then as a voice
      note): you get offices or steps, never "I won't pass on payment
      details…"
- [ ] *"Which account do I pay my tax into?"*: still refused, pointing to
      the official office
- [ ] A question that goes to the web (*"Which hospital dey around
      Okigwe?"*): no `[...](...)` text in the answer, and the sources are
      one clean line each
