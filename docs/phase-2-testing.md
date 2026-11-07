# Phase 2 — platform spikes: setup and test guide

**Goal.** Find the Cloudflare free tier's walls before real build time goes
into Phase 3. Everything here is throwaway or verification code.

**Gate to Phase 3.** Every checkbox below is ticked, or the failure has a
written workaround in the "If it fails" box under it.

The free-plan limits as of November 2026. Confirm them in your own
dashboard rather than trusting this file.

| Limit | Free | Paid |
| --- | --- | --- |
| Requests | 100k/day | no daily cap |
| CPU per invocation | 10 ms | 30 s, up to 5 min |
| Subrequests per invocation | 50 | 10,000 |
| Worker size (gzipped) | 3 MB | 10 MB |
| Queue operations | 10k/day | 1M/month |
| Queue retention | 24 h | up to 14 days |
| Cron triggers | 5 | 250 |

---

## 0. Setup

### 0.1 Local

Node 22 or later is required — the AI SDK v7 is ESM-only and drops Node 20.

```bash
git clone git@github.com:nueltek/myimoguide.git
cd myimoguide
node --version        # must be >= 22
npm ci
npm run typecheck     # must pass before anything else
```

- [ ] `npm ci` completes
- [ ] `node --version` is 22 or higher
- [ ] `npm run typecheck` exits clean

### 0.2 Accounts

- [ ] Cloudflare account on the **Free** plan, no card attached
- [ ] Neon project created
- [ ] Meta developer app with the Cloud API test number claimed
- [ ] Your own WhatsApp number allowlisted as a test recipient (OTP verified)

### 0.3 Secrets needed for this phase

All six. Set as Wrangler secrets for the deployed Worker, and in a local
`.dev.vars` (gitignored) for `wrangler dev`.

| Secret | Where it comes from | Watch for |
| --- | --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | a random string you invent | must match exactly what you paste into Meta's webhook config |
| `WHATSAPP_APP_SECRET` | Meta app dashboard → App settings → Basic | this signs the webhook; a wrong value makes every POST 403 |
| `WHATSAPP_TOKEN` | Meta → System User token | **not** the 60-minute temporary token — that expires mid-test |
| `WHATSAPP_PHONE_ID` | Meta → WhatsApp → API Setup | the phone number **ID**, not the phone number |
| `ANTHROPIC_API_KEY` | console.anthropic.com | load a few dollars of credit |
| `DATABASE_URL` | Neon → Connection string | use the **pooled** string |

Authenticate Wrangler first, once:

```
npx wrangler login
```

**PowerShell (Windows).** One at a time — each command prompts for its value.

```powershell
Copy-Item .dev.vars.example .dev.vars   # fill it in; it is gitignored

npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_ID
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put DATABASE_URL
```

**bash / WSL / macOS.**

```bash
cp .dev.vars.example .dev.vars

for s in WHATSAPP_VERIFY_TOKEN WHATSAPP_APP_SECRET WHATSAPP_TOKEN \
         WHATSAPP_PHONE_ID ANTHROPIC_API_KEY DATABASE_URL; do
  npx wrangler secret put "$s"
done
```

If Wrangler reports that the Worker does not exist yet, run `npx wrangler
deploy` once to create it, then set the secrets.

- [ ] All six set via `wrangler secret put`
- [ ] `.dev.vars` filled in and **not** tracked (`git status` shows nothing)

### 0.4 Cloudflare resources

```bash
npx wrangler queues create myimoguide-inbound
npx wrangler queues create myimoguide-inbound-dlq
npx wrangler r2 bucket create myimoguide-sources
```

- [ ] Both queues exist
- [ ] R2 bucket exists

### 0.5 Database

```sql
-- once, in the Neon SQL editor:
CREATE EXTENSION IF NOT EXISTS vector;
```

Dependencies must be installed first — `drizzle-kit` lives in
`node_modules`, and without it these commands fail with "not recognized as
an internal or external command". If you skipped step 0.1, run `npm ci` now.

The initial migration (`drizzle/0000_init.sql`) is already committed, so
there is nothing to generate. Apply it:

**PowerShell (Windows).**

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run db:migrate
```

**bash / WSL / macOS.**

```bash
export DATABASE_URL='postgresql://...'
npm run db:migrate
```

Only run `npm run db:generate` after you change `src/db/schema.ts` — it
writes a new migration file, which must then be committed (CI fails if the
schema and the migrations disagree).

- [ ] `vector` extension installed
- [ ] Migration applied; tables visible in Neon
- [ ] The generated migration in `drizzle/` is **committed** (CI checks this)

---

## Spike 1 — queue consumer under real load

**This is the blocker.** Run it first.

**Question.** The Queues docs list consumer CPU as configurable up to five
minutes, but the Workers Free plan caps CPU at 10 ms per invocation. How do
those interact for a queue consumer?

**Why it matters.** If the consumer is held to 10 ms, the whole
retrieve-then-generate loop cannot run in one invocation, and Phase 3 needs
a different shape — the loop split across several queue messages. Finding
that out during the pilot would be expensive.

**Steps.**

```bash
npx wrangler deploy
```

In the Meta dashboard set the callback URL to
`https://myimoguide.<subdomain>.workers.dev/webhook/whatsapp`, paste the
verify token, and subscribe to the `messages` field.

```bash
npx wrangler tail --format pretty
```

Send 20 messages from your allowlisted number, varied: short questions,
long ones, two in quick succession.

**Pass criteria.**

- [ ] Meta's webhook verification (the GET handshake) succeeded
- [ ] 20 of 20 messages received a reply
- [ ] No `Error 1102` and no "exceeded CPU" lines in `wrangler tail`
- [ ] Two identical messages sent quickly produce **one** reply (the Durable Object dedupe)
- [ ] Nothing landed in `myimoguide-inbound-dlq`

```bash
npx wrangler queues info myimoguide-inbound-dlq   # should be empty
```

**If it fails.** Split the loop: message 1 routes and enqueues, message 2
renders and sends. Write the workaround here before moving on.

> Workaround (fill in if needed):

---

## Spike 2 — bundle size — **ALREADY PASSING**

Verified during the scaffold build: **382 KiB gzipped**, about 12% of the
3 MB ceiling. This is why the stack uses the Vercel AI SDK rather than
LangChain or Mastra.

CI now enforces it on every push, failing above 2 MB so there is room to
react before the real ceiling.

```bash
node scripts/check-bundle-size.mjs
```

- [x] Under 3 MB gzipped
- [ ] CI green on the first push (confirms the gate runs)

---

## Spike 3 — Neon over HTTP from a deployed Worker

Local success proves nothing here — the Workers runtime is not Node, and
the failure mode is a TCP driver that works on your laptop and dies at the
edge.

**Steps.** Temporarily add to `src/index.ts`:

```ts
app.get('/debug/db', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const rows = await db.select().from(services).limit(1);
  return c.json({ ok: true, count: rows.length });
});
```

Deploy, hit it, then **delete the route before the pilot.**

**Pass criteria.**

- [ ] The route returns `{ ok: true }` from the deployed Worker, not just locally
- [ ] A pgvector distance query returns (once `intents` has a row)
- [ ] Debug route removed afterwards

**Watch for.** The HTTP driver has no interactive transactions. Anything
multi-statement must use `db.batch([...])`.

---

## Spike 4 — subrequest count on a realistic turn

Every `fetch` counts: each Neon statement, each Anthropic call, each
WhatsApp API call. The free plan allows 50 per invocation.

**Steps.** Count the fetches in `wrangler tail` for one full turn. The
designed path is 4 to 5: services query, routing call, optional facility
query, read receipt, send.

**Pass criteria.**

- [ ] A simple question uses 5 or fewer subrequests
- [ ] A worst case — facility lookup plus follow-up — stays under 25

**Watch for.** `Promise.all` over a list. That is the quickest way to blow
the cap, which is why `src/queue/consumer.ts` loops sequentially. Do not
"optimise" that into parallel.

---

## Spike 5 — end-to-end hello world

The moment the project becomes real.

**Pass criteria.**

- [ ] Message the test number, get a model-generated reply
- [ ] Round trip under 5 seconds
- [ ] An unanswerable question returns the honest fallback, not a guess
- [ ] The reply carries a verification date

---

## Troubleshooting: messages arrive but `wrangler tail` shows nothing

The single most common Phase 2 failure. Work down this list in order; each
step rules out a layer.

**Read the ticks first.** The consumer calls `markRead`, so a working
pipeline turns WhatsApp's ticks blue within a second or two.

| What you see | What it means |
| --- | --- |
| Grey double ticks, nothing in `tail` | No request reached the Worker. Meta is not sending. |
| Blue ticks, nothing in `tail` | `tail` is attached to the wrong Worker or expired. Restart it. |
| Blue ticks, errors in `tail` | The Worker ran. A real bug — read the stack trace. |

**1. Is the Worker alive?**

```powershell
curl https://myimoguide.<your-subdomain>.workers.dev/health
```

Expect `{"ok":true,"service":"myimoguide"}`. If this fails, the deploy is
the problem, not Meta.

**2. Is the `messages` field subscribed?**

The usual culprit. Saving and verifying the callback URL is a *separate
step* from subscribing to events, and the dashboard lets you complete the
first without the second — verification passes, and no POST is ever sent.

Meta dashboard → WhatsApp → Configuration → Webhook fields → Manage →
tick **`messages`**.

**3. Does Meta think it delivered anything?**

Meta dashboard → Webhooks → recent deliveries. Failed attempts and their
response codes are listed there. An empty list confirms step 2 is the
cause. A list of 403s means the signature check is rejecting them — the
`WHATSAPP_APP_SECRET` secret does not match the app.

**4. Did Cloudflare see a request at all?**

Cloudflare dashboard → Workers → myimoguide → Metrics. Requests at zero
while Meta reports deliveries means the callback URL points somewhere
else — check for a typo, a missing `/webhook/whatsapp` path, or an old
subdomain.

**5. Is `tail` attached to the right Worker?**

`npx wrangler tail` prints `Connected to <name>`. It must say
`myimoguide`. Tails expire after a few hours — restart it if the session
has been open a long time.

---

## Phase 2 sign-off

- [ ] All five spikes pass, or each failure has a workaround written above
- [ ] CI green on `main`
- [ ] No secrets in tracked files (CI checks this)
- [ ] Debug routes removed

Report back with: which boxes are ticked, the `wrangler tail` output for any
failure, and the subrequest count from Spike 4. That decides the shape of
Phase 3.
