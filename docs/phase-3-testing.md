# Phase 3 — service catalogue and dashboard: setup and test guide

**What this phase delivers.** A seeded service catalogue, and an admin
dashboard that edits it. Together these make the demo's strongest moment
possible: change a fee in the dashboard, ask the bot again, watch the
answer change in front of the person who asked.

**Gate to Phase 4.** Every checkbox below, or a written reason it was
skipped.

---

## What the research found, before you test anything

This shapes what you will see, so read it first.

**Imo State publishes which taxes exist and when they are due. It does
not publish what they cost.** The IIRS services page lists six services
with no fees and no document lists. The tax policies page names eight
taxes with deadlines and not a single rate. Land service figures exist
only on property blogs, as wide ranges, explicitly marked estimates, and
roughly two years old.

So five of the six seeded services carry **no confirmed fee**. That is
the finding, not a gap in the seeding — and it is the pitch. The one
exception is PAYE, where the rates are federal statute rather than state
discretion.

**The PAYE bands changed on 1 January 2026** under the Nigeria Tax Act
2025. Anything still quoting the old PITA 2011 schedule is now wrong,
which is exactly what a model answering from memory would give you. The
seeded bands are the current ones, from two independent sources.

---

## 0. Setup

### 0.1 Pull and install

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
npm run typecheck
```

- [ ] `npm ci` completes
- [ ] `npm run typecheck` exits clean

### 0.2 Migrate and seed

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run db:migrate
npm run db:seed
```

`db:seed` runs facts and services together. Both are idempotent — re-run
them freely.

- [ ] Migration applies (adds `state_facts`, `admin_sessions`, provenance columns)
- [ ] 13 state facts seeded
- [ ] 2 agencies and 6 services seeded
- [ ] The seed prints the "no confirmed fee" summary and the phone-confirm list

### 0.3 Create your dashboard account

```powershell
npx tsx scripts/create-admin.ts you@example.com
```

Omit the password and one is generated and printed **once**. Save it
immediately. To set your own, pass it as a second argument — note it
lands in shell history, so only do that on your own machine.

Minimum length is 14 characters, and that is deliberate. See the security
note at the end.

- [ ] Account created, password saved somewhere safe

### 0.4 Deploy

```powershell
npx wrangler deploy
```

- [ ] Deploy succeeds
- [ ] `curl.exe https://myimoguide.<subdomain>.workers.dev/health` returns ok

---

## 1. Service answers over WhatsApp

Send each of these and check the reply.

| Ask | Expect |
| --- | --- |
| "How do I get a tax clearance certificate?" | TCC record: documents, steps, IIRS address and phone, a source line |
| "What are the PAYE rates?" | The 2026 bands, 0% on the first ₦800,000 |
| "How do I get a C of O?" | The 8 steps and document list, marked unverified |
| "What does a C of O cost?" | A fee note saying it is not published, **never a number** |

- [ ] All four answer from records, not search
- [ ] Every reply carries a source and an as-of date
- [ ] No reply invents a fee
- [ ] The C of O reply is visibly hedged (its source is a blog, not the ministry)

### The refusals still hold

| Ask | Expect |
| --- | --- |
| "Which bank account do I pay my land charge into?" | Refusal plus "get this from the agency directly" |
| "I need an ambulance now" | 112 first, then offer of facilities by LGA |

- [ ] Payment details refused, no account number anywhere
- [ ] Emergency leads with 112

Both are logged as tier `withheld`, not as failures.

---

## 2. The dashboard

Open `https://myimoguide.<subdomain>.workers.dev/admin`.

### 2.1 Access control

- [ ] Visiting `/admin` while signed out redirects to `/admin/login`
- [ ] A wrong password gives "Email or password is incorrect" — the same message whether or not the account exists
- [ ] A correct sign-in lands on the Overview
- [ ] Sign out, then press Back: you are **not** still inside

That last one matters. If Back shows a cached page, the browser is
serving history, not a live session — confirm by reloading.

### 2.2 Overview

- [ ] The five figures match reality (question counts, service count)
- [ ] Recent questions lists what you sent in section 1
- [ ] Each row shows the tier and the model that answered

### 2.3 Services

- [ ] All 6 services listed, with agency, fee, confidence and verified date
- [ ] Five show "Not confirmed" under Fee
- [ ] Confidence badges read Published or Unverified — none is Confirmed yet

### 2.4 The demo moment — do this exactly

1. On WhatsApp, ask **"What is the fee for a tax clearance certificate?"**
   Note the answer.
2. In the dashboard, open **Tax Clearance Certificate** → set **Fee** to a
   test figure → set **Confidence** to *Confirmed* → **Save changes**.
3. On WhatsApp, ask the **same question** again.

- [ ] The second reply carries the new fee
- [ ] It now reads "Confirmed with the office on <today>"
- [ ] No redeploy was needed

**This is the pitch.** Not that an AI can chat — they have seen that.
That the state controls the answers, and the change is instant.

Set the fee back to blank afterwards unless you have actually confirmed
it with the IIRS.

### 2.5 Audit log

- [ ] Your sign-in appears
- [ ] The service edit appears, with your email, the time and your IP
- [ ] Nothing in the log can be edited or deleted from the interface

A government buyer asks about this before they ask about the AI.

---

## 3. Known gaps in this phase

Say these plainly rather than letting them be discovered:

- Facilities and State facts are **read-only** in the dashboard; both are
  managed through seed scripts. Services was built first because it is
  the demo path.
- TOTP columns exist on the user table but **2FA is not enforced yet**.
- Voice notes still reply "coming soon".
- Igbo is not started.

---

## 4. Security notes worth knowing before the pitch

**Password hashing is PBKDF2, not argon2id.** Argon2 is the better
choice generally but is unavailable in the Workers runtime without a
WASM build, and a memory-hard KDF is the wrong shape for a platform
billing CPU per invocation. The iteration count sits below the OWASP
figure for PBKDF2-SHA256, traded deliberately against the Workers CPU
ceiling and compensated by the 14-character minimum. It is documented in
`src/admin/auth.ts` rather than hidden.

**For production, put Cloudflare Access in front of `/admin`.** Free for
up to 50 users, real SSO and MFA, every access attempt logged, and no
password handling in this codebase at all. It needs a custom domain —
worth doing when you buy one.

**Sessions are server-side**, so revoking one is deleting a row. Only the
SHA-256 of the token is stored, so a database leak hands over no live
sessions. Cookies are HttpOnly, Secure and SameSite=Strict, which also
gives CSRF protection on every form.

---

## 5. If something fails

### 5.1 Check the schema first

```powershell
curl.exe https://myimoguide.<subdomain>.workers.dev/health
```

`/health` now verifies that every expected table exists. A missing
migration is otherwise invisible until someone hits the one route that
touches the missing table — which is how a deploy that looks fine can
still fail at the login screen.

```json
{ "ok": false, "database": { "ok": false, "missingTables": ["admin_sessions"] } }
```

That answer means `npm run db:migrate` has not been run against this
database since the last pull. Run it and try again. The endpoint returns
HTTP 503 while anything is missing.

### 5.2 Dashboard errors carry a reference

An error page shows a short reference such as `a3f91c20`. The same
reference appears in `wrangler tail` on a line beginning `UNHANDLED`,
with the full stack, the path and the method. Quote it rather than
describing the symptom:

```powershell
npx wrangler tail --format pretty
```

- [ ] `/health` reports `"ok": true` with no missing tables
- [ ] Sign-in succeeds; if not, the `UNHANDLED` line in tail names the cause

---

## Phase 3 sign-off

- [ ] Sections 1 and 2 pass
- [ ] The demo moment in 2.4 works end to end
- [ ] Any test fee set during 2.4 has been reverted
- [ ] CI green on `main`

Report back with: which boxes are ticked, and anything in the dashboard
that looked wrong or felt slow. Next is voice notes, then the Phase 1
phone-confirmation of the fees that are still blank.
