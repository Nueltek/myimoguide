# myimoguide

WhatsApp AI assistant for Imo State government services. Built by
[Nueltek Global Resources](https://nueltekglobalresources.com).

## The rule this codebase is built around

**The model routes. It does not write facts.**

Its only job is to map a question to a database row. Every fee, address,
phone number and document list is rendered in `src/agent/render.ts` from a
typed column, carrying the date it was last verified. There is no code path
where a model can invent a number.

That constraint is the product. It is what separates this from a chatbot
guessing, and it is what makes it safe to hand to a commissioner who
already knows the right answers.

## Stack

Everything runs on free tiers. The only recurring cost is LLM credits.

| Layer | Choice | Why |
| --- | --- | --- |
| Edge | Hono on Cloudflare Workers | 100k req/day free |
| Async | Cloudflare Queues | free since Feb 2026, 10k ops/day |
| Database | Neon Postgres + pgvector | free tier, no expiry |
| Driver | `@neondatabase/serverless` over HTTP | Workers cannot hold TCP pools |
| State | SQLite-backed Durable Objects | on the free plan; KV-backed ones are not |
| Storage | R2 | source documents behind each record |
| Models | Vercel AI SDK v7 | 3 MB gzipped Worker ceiling rules out LangChain |

## Provider and model switching

Anthropic and OpenAI are both wired. Switching is configuration, not code:

```powershell
npx wrangler secret put MODEL_PROVIDER    # anthropic | openai
npx wrangler secret put OPENAI_API_KEY    # only for openai
npx wrangler deploy
```

`GET /health` reports the live provider and model ids so a switch can be
verified. Routing and synthesis models are set independently, and both
can be overridden with `ROUTING_MODEL` / `SYNTHESIS_MODEL`.

Full detail, costs and gotchas: [docs/switching-providers.md](docs/switching-providers.md).

## Layout

```
src/
  index.ts            Hono app. Verify signature, enqueue, return 200. Nothing else.
  conversation.ts     Durable Object: dedupe, rate limit, recent turns.
  types.ts            Worker bindings and the queue job shape.
  whatsapp/
    verify.ts         HMAC-SHA256 over the raw body, constant-time.
    client.ts         Send, mark read, fetch media.
    types.ts          The slice of Meta's envelope we read.
  queue/
    consumer.ts       The slow path: dedupe, answer, send, log.
  db/
    schema.ts         Typed columns, verified_at on everything.
    client.ts         Drizzle over Neon HTTP.
  agent/
    answer.ts         Routing only. Never writes a fact.
    render.ts         Pure functions over rows. Writes every fact.
spikes/
  README.md           Phase 2. Run these before building Phase 3.
```

## Setup

Requires Node 22 or later — the AI SDK v7 is ESM-only and drops Node 20.

```bash
npm install
```

**1. Neon.** Create a project, then once against the database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**2. Migrate.**

```bash
export DATABASE_URL='postgresql://...'
npm run db:generate && npm run db:migrate
```

**3. Cloudflare queues.**

```bash
npx wrangler queues create myimoguide-inbound
npx wrangler queues create myimoguide-inbound-dlq
npx wrangler r2 bucket create myimoguide-sources
```

**4. Secrets.** Never in `wrangler.jsonc`.

```bash
npx wrangler secret put WHATSAPP_VERIFY_TOKEN   # random string you invent
npx wrangler secret put WHATSAPP_APP_SECRET     # Meta app secret
npx wrangler secret put WHATSAPP_TOKEN          # System User token, not the 60-min one
npx wrangler secret put WHATSAPP_PHONE_ID       # phone number ID, not the number
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put DATABASE_URL
```

**5. Deploy, then point Meta at it.**

```bash
npx wrangler deploy
```

In the Meta app dashboard, set the callback URL to
`https://<worker>.workers.dev/webhook/whatsapp` and the verify token to the
value above. Subscribe to the `messages` field.

No message templates are needed. Every conversation is user-initiated, so
replies stay inside the 24-hour customer service window.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill it in; it is gitignored
npm run dev
```

Expose the local port with a Cloudflare Tunnel rather than ngrok — you get
a persistent hostname, so the webhook URL does not have to be re-registered
in Meta on every restart.

## Checks

```bash
npm run typecheck
npm run size        # must stay under 3 MB gzipped on the free plan
```
