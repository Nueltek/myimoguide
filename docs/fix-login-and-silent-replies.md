# Fix: dashboard login 500, and WhatsApp replies that never arrive

Two bugs, both found by reproduction rather than by reading the code.
Both fixes are covered by tests that run in CI on every push.

---

## What was wrong

### 1. Login returned 500

**Cause:** Cloudflare's production runtime refuses PBKDF2 above
**100,000 iterations** — the call fails outright rather than
downgrading. The code used 150,000.

**Why every test passed anyway:** `create-admin` runs in Node, which has
no cap, so it wrote your password hash at 150,000 without complaint. My
local tests also run in Node. And local workerd (`wrangler dev`) does not
enforce the cap either — I checked it directly at 100,000, 100,001 and
150,000, and all three succeed locally. Only production refuses.

So the hash was valid, written correctly, and unverifiable in the one
place it is ever checked.

**Fix:** iterations pinned to 100,000. A stored hash above the cap now
fails closed with a log line telling you to reset the account, instead of
a bare 500. CI asserts the cap, since it is the only place it can be
caught before production.

**Your existing password cannot be fixed in place.** It was hashed at
150,000, and a PBKDF2 hash cannot be re-derived at a different count
without the plain password. You must reset it (step 3 below).

### 2. WhatsApp: typing indicator, then nothing, ever

**Cause:** a deduplication bug in my code. The consumer marked each
message *seen* **before** doing any work:

```
claim      -> marked "seen"           <- before any work
markRead   -> typing indicator shows
answering  -> something fails
catch      -> retry
retry      -> claim says "already seen" -> exits quietly -> acked
```

Every retry looked like a duplicate and was dropped. So **any** failure
after the claim became permanent silence — and the final-attempt apology
added in the previous fix could never fire, because attempt 2 always
returned normally. That safety net was dead code.

`scripts/test-dedupe.ts` reproduces this exactly: old logic, first
attempt fails, user receives nothing.

**Fix:** a claim now marks a message *processing*. Only a **delivered**
reply marks it *done*. A message still processing, seen again on a later
attempt, is our own retry and proceeds; seen again on attempt 1, it is
Meta re-delivering something in flight, and is skipped.

**Plus a backstop outside the failing isolate.** Every earlier safety net
ran inside the same invocation as the work, so an invocation killed
outright — a CPU overrun leaves no `catch` to run — took them all with
it. Messages that exhaust their retries now land in the dead-letter
queue, whose consumer does almost nothing and so cannot fail the same
way: it sends a short apology.

**And one message per invocation** (`max_batch_size: 1`), so a killed
invocation loses one message to the retry, not four.

### What this fix does NOT tell us

Why "How do I pay my taxes in Imo State?" fails on its **first** attempt
is still unknown. Before, that failure was invisible — swallowed by the
dedupe bug. Now it will be retried, and if it keeps failing you get an
apology, and `wrangler tail` shows a `consumer failed` line with the full
stack. That line is what I need to fix the underlying cause.

---

## Test it

### 0. Pull and install

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
```

- [ ] `git pull` brings in the fix commit

If `git pull` complains about a `.lock` file under `.git`, a previous
remote session left one behind. Delete just that file and pull again.

### 1. Run the tests locally

```powershell
npm run typecheck
npm test
```

- [ ] Typecheck passes (it now checks the Worker and the scripts separately)
- [ ] `old logic + first attempt fails -> user receives NOTHING` passes — the bug, reproduced
- [ ] `new logic + first attempt fails -> retry delivers the answer` passes — the fix
- [ ] `hash iterations: 100000 (cap 100000) ok`
- [ ] `e2e passed`

### 2. Deploy

```powershell
npx wrangler deploy
```

The dead-letter queue already exists from Phase 2. If deploy reports it
missing:

```powershell
npx wrangler queues create myimoguide-inbound-dlq
npx wrangler deploy
```

- [ ] Deploy lists **two** consumers: `myimoguide-inbound` and `myimoguide-inbound-dlq`

### 3. Reset your dashboard password — required

Your current hash was written at 150,000 iterations and can never verify
in production. Re-hash it:

```powershell
$env:DATABASE_URL = 'postgresql://...'
npx tsx scripts/create-admin.ts you@example.com
```

Save the printed password.

- [ ] Password reset, new password saved

### 4. Log in

Open `https://myimoguide.imostateguide.workers.dev/admin/login`.

- [ ] Clicking **Sign in** immediately shows a spinner and "Signing in..."
- [ ] You land on the Overview
- [ ] Sign out works, and Back does not take you inside again

If it still fails, the `wrangler tail` output for that request is
conclusive — send it.

### 5. The question that went silent

Start the tail first, in a second terminal:

```powershell
npx wrangler tail --format pretty
```

Then on WhatsApp send: **How do I pay my taxes in Imo State?**

Exactly one of these should happen:

| You see | It means |
| --- | --- |
| An answer | Fixed — the first attempt failed and the retry succeeded, or it simply worked |
| An apology, about a minute later | The underlying fault is still there, but you are no longer left in silence |
| Nothing at all | Something I have not accounted for — send the tail output |

- [ ] One of the first two happened
- [ ] The tail shows `stage:` lines for the message
- [ ] If there was a `consumer failed` line, copy it — it holds the real cause

**Send me the `consumer failed` line if you see one.** It is the only
remaining unknown.

---

## Sign-off

- [ ] Tests pass locally and in CI
- [ ] Dashboard login works after the password reset
- [ ] The tax question gets either an answer or an apology — never silence
