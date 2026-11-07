# Switching provider and models

Everything here is configuration. No code change, no redeploy of altered
source — just secrets and one `wrangler deploy`.

All provider and model choice lives in `src/agent/models.ts`. Nothing else
in the codebase imports a provider package.

## The four settings

| Setting | Values | Default |
| --- | --- | --- |
| `MODEL_PROVIDER` | `anthropic` \| `openai` | `anthropic` |
| `ROUTING_MODEL` | any model id for that provider | per provider, below |
| `SYNTHESIS_MODEL` | any model id for that provider | per provider, below |
| `OPENAI_API_KEY` | your key | required only for `openai` |

Defaults:

| | Anthropic | OpenAI |
| --- | --- | --- |
| routing | `claude-haiku-5-5` | `gpt-6-luna` |
| synthesis | `claude-sonnet-5-5` | `gpt-6.1-sol` |

## Why two models

They are different jobs with opposite priorities.

**Routing** classifies a question into a fixed schema and runs on *every
message*. It wants the cheapest model that is accurate enough.

**Synthesis** reads web pages and writes prose a commissioner may read
aloud. It wants quality, and only runs when the database has no record.

Tuning them separately is the main cost lever. Routing at a premium model
is money burnt; synthesis at a budget model is visible in the pitch.

## Switch to OpenAI

```powershell
npx wrangler secret put MODEL_PROVIDER    # type: openai
npx wrangler secret put OPENAI_API_KEY    # paste your key
npx wrangler deploy
```

## Switch back to Anthropic

```powershell
npx wrangler secret put MODEL_PROVIDER    # type: anthropic
npx wrangler deploy
```

The other provider's key can stay set — it is simply unused, which is what
makes switching back mid-pitch-prep a ten-second operation.

## Change only the model, keeping the provider

```powershell
npx wrangler secret put SYNTHESIS_MODEL   # e.g. gpt-6.1-terra
npx wrangler deploy
```

To return to the default, set it to an empty value.

## Confirm the switch took effect

Never assume. Ask the Worker:

```powershell
curl.exe https://myimoguide.<your-subdomain>.workers.dev/health
```

```json
{
  "ok": true,
  "service": "myimoguide",
  "provider": "openai",
  "routingModel": "gpt-6-luna",
  "synthesisModel": "gpt-6.1-sol",
  "keyPresent": true
}
```

`keyPresent: false` means the active provider has no key set — every model
call will fail. The endpoint never returns the key itself.

## Costs, checked 7 November 2026

Per million tokens, input / output:

| Tier | Anthropic | OpenAI |
| --- | --- | --- |
| routing | `claude-haiku-5-5` $0.10 / $0.50 | `gpt-6-luna` $0.10 / $0.50 |
| synthesis | `claude-sonnet-5-5` $2 / $10 | `gpt-6.1-sol` $2 / $10 |
| cheaper synthesis | — | `gpt-6.1-terra` $1 / $5 |

Parity at both tiers we use, so provider choice is about answer quality,
not price. OpenAI has one cheaper synthesis rung if that cost bites.

Web search is billed separately at **$10 per 1,000 searches on both**, on
top of tokens. `maxUses: 3` in `models.ts` caps it per question. Searches
only happen when the database misses, so seeding records lowers the bill
as well as raising answer quality.

## Provider-specific gotchas

**Anthropic web search must be enabled in the Console** — Settings →
Capabilities → Allow web search. It is off by default for an organisation.

**Do not set `userLocation` on Anthropic's web search tool with
`country: 'NG'`.** It rejects the entire request with "Country code NG is
not supported", and because the tool call fails rather than returning
empty, it looks exactly like a search that found nothing. This cost real
debugging time. The parameter is omitted deliberately in `models.ts`;
every question here names Imo State anyway, which steers results better
than a country hint.

## Running an A/B before the pitch

Both providers can hold credit at once. To compare answer quality on the
questions that matter:

1. Note the current provider from `/health`.
2. Ask your ten hardest demo questions. Screenshot the replies.
3. Switch provider, deploy, ask the same ten.
4. Compare side by side.

`answer_tier` is logged per query, so you can also compare how often each
provider resolved a question rather than falling back.
