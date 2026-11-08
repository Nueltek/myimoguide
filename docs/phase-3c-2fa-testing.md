# Phase 3c — two-step sign-in: setup and test guide

**What this delivers.** Every dashboard account now needs two things to
sign in: the password, and a 6-digit code from an authenticator app on
the person's phone. A leaked or guessed password no longer opens the
dashboard by itself.

It is mandatory. There is no "skip" and no "remind me later". The first
time anyone signs in after this deploy, including you, they are taken
through setup before they can see anything.

This is usually the first security question a government IT reviewer
asks, and the answer is now "yes, enforced on every account".

---

## What changed

| | Before | Now |
| --- | --- | --- |
| Sign-in | Password only | Password, then a 6-digit code from the phone |
| Lost phone | — | 10 single-use recovery codes, issued at setup |
| Wrong passwords | Unlimited | 5 per account per 15 minutes, then locked for 15 minutes |
| Wrong codes | — | 5 per sign-in, then back to the password |
| Failed sign-ins | Not recorded | Every one in the audit log, with the reason and IP address |
| Audit log labels | Raw action names | Plain words: *Signed in*, *Sign-in failed*, *Locked out* |
| Existing sessions | — | Sent to set up 2FA. Nobody is waved through. |
| Back button after sign-out | Could show a cached page | Dashboard pages are never cached |

### How sign-in works now

1. **Password.** If it is right, you get a session that lasts **10 minutes**
   and can do one thing only: finish signing in. It cannot open any page or
   save anything.
2. **Code.** The 6-digit code from the app, or one of your recovery codes.
   If it is right, the 10-minute session is **thrown away** and replaced
   with a new 8-hour one. A token seen during sign-in, on a shared screen
   or in a log, is useless afterwards.

### The protections, and why each exists

- **The app's secret is encrypted in the database** with a key held
  outside it, as a Cloudflare secret. A copy of the database alone does
  not let anyone generate codes. Each encrypted secret is also bound to
  its own account, so copying one account's secret onto another account
  does not work.
- **A code works once.** A code someone watched you type cannot be reused,
  even inside its 30-second window and even if they submit it at the same
  instant you do. The tests cover that race explicitly.
- **Five wrong codes end the sign-in.** A 6-digit code has a million
  possible values. Without a limit it can be guessed, and with a limit of
  five it cannot.
- **Recovery codes are stored only as fingerprints (hashes).** They are
  shown once, at setup, and cannot be shown again, by anyone, from
  anywhere. Each code works once.
- **Password failures are counted per account and per network address.**
  The per-address limit (20) is deliberately higher than the per-account
  limit (5), because a ministry puts many staff behind one internet
  connection. One colleague's typos must not lock out the whole office.
- **The sign-in error never says which part was wrong.** "Email or
  password is incorrect" is the same for a wrong password and an account
  that does not exist. The real reason goes to the audit log, where only
  staff can see it.

---

## 0. Setup

### 0.1 Pull and install

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
```

- [ ] `git pull` brings in the two-step sign-in commit
- [ ] `npm ci` completes. One new package: `uqr` draws the QR code. It has
      no dependencies and runs inside the Worker, so the secret never goes to
      an outside QR service.

### 0.2 Run the tests

```powershell
npm run typecheck
npm test
```

- [ ] Typecheck passes
- [ ] The dedupe tests pass
- [ ] The TOTP tests end with `all passed`. These are 43 checks against
      the published test vectors in RFC 4226 and RFC 6238, the standards the
      authenticator apps implement, plus the encryption checks.
- [ ] `e2e passed`: 113 checks, of which 53 are new for this phase.
      They cover setup, codes, replay, the simultaneous-code race,
      lockout, recovery codes, password throttling, old sessions and the
      missing-key case.

### 0.3 Create the encryption key

**Do this before deploying.** Without the key, nobody can sign in. The
dashboard will say so plainly rather than fail with a generic error.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the output, then:

```powershell
npx wrangler secret put TOTP_ENCRYPTION_KEY
```

Paste it when asked.

**Also save it in your password manager.** If this key is lost, every
account's 2FA has to be reset with the command in section 6. Nothing
is lost apart from the setup, but it is a chore. Do not put the key in
`.dev.vars` in the repository, in chat or in email.

For local `wrangler dev`, generate a **separate** key and put it in your
local `.dev.vars` as `TOTP_ENCRYPTION_KEY=...`. That file is already
git-ignored.

- [ ] Key generated and stored with `wrangler secret put`
- [ ] Key saved in your password manager

### 0.4 Migrate

One migration adds the 2FA columns, the session stage and two indexes
that keep the throttle check fast.

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run db:migrate
```

- [ ] Migration `0006_two_factor` applies

### 0.5 Deploy

```powershell
npx wrangler deploy
curl.exe https://<your-worker>.workers.dev/health
```

- [ ] Deploy succeeds
- [ ] `/health` shows `"dashboard": { "twoFactorKey": "ok" }`.
      `"missing"` means step 0.3 did not take; `"invalid"` means what was
      pasted was not the 44-character value the command printed.

---

## 1. Set up your own account

Install **Google Authenticator** or **Microsoft Authenticator** on your
phone first. Both are free.

1. Open `/admin/login` and sign in with your password.
2. You land on **Set up two-step sign-in**, not the overview. That is
   expected.
3. Scan the QR code with the app. A *MyImoGuide* entry appears.
4. Enter the 6-digit code it shows, then **Verify and finish**.
5. Your **recovery codes** appear. **Download** or **Print** them now.
   This page cannot be shown again.
6. **I have saved them — continue** takes you to the overview.

- [ ] A correct password goes to setup, not to the overview
- [ ] The QR code scans and the app shows a 6-digit code for MyImoGuide
- [ ] Reloading the setup page shows the **same** QR code, so a code you
      already scanned keeps working
- [ ] Entering `000000` is refused with *4 attempts left*
- [ ] The right code shows 10 recovery codes
- [ ] The downloaded file contains all 10 codes and your email address
- [ ] **Press Back** from the overview. The recovery codes do **not**
      reappear.

## 2. Sign in normally

1. Sign out (bottom of the sidebar).
2. Sign in with your password. You land on **Enter your code**.
3. Enter the current code from the app.

- [ ] After the password, the code page is shown, not the overview
- [ ] While on the code page, typing `/admin/services` into the address
      bar sends you back to the code page
- [ ] The right code opens the overview
- [ ] Sign out, sign in again and enter **the same code** within 30
      seconds. It is refused with *already been used*. Wait for the next
      code and it works.

## 3. Lose your phone (recovery code)

1. Sign out, then sign in with your password.
2. On the code page, enter one of your recovery codes. The hyphen and
   capitals are optional.

- [ ] It signs you in
- [ ] The overview shows a notice: *You signed in with a recovery code… 9
      remain*
- [ ] Sign out and try **the same recovery code** again. It is refused.
- [ ] **Cross that code off your printed list.**

## 4. Guessing is stopped

### Wrong codes

1. Sign in with your password.
2. Enter a wrong code five times.

- [ ] Each attempt shows how many are left
- [ ] The fifth sends you back to the sign-in page: *Too many incorrect
      codes. For your security, sign in again with your password.*
- [ ] You can sign in again straight away with password and correct code.
      A code lockout ends that one sign-in; it does not lock the account.

### Wrong passwords

Use a **second, test account** for this, not your own. Create one with:

```powershell
npx tsx scripts/create-admin.ts test@yourdomain.com
```

Then, in a private browser window, enter a wrong password for it six
times.

- [ ] The sixth attempt says *Too many failed sign-in attempts. Wait 15
      minutes and try again.*
- [ ] Even the **right** password is refused with that message during
      the 15 minutes. The page gives no hint whether it was right.
- [ ] Your own account still signs in normally from your usual browser

## 5. The audit log

Open **Audit log**.

- [ ] *Sign-in failed* rows for the wrong passwords, with *wrong
      password* in the record column and an IP address
- [ ] A wrong password typed against an email that has no account shows
      up too, with *no such account*. That pattern is worth noticing if
      it ever appears in real use.
- [ ] *2FA set up*, *Signed in*, *Wrong code*, *Locked out*, *Recovery
      code* and *Signed out* rows for what you did above

## 6. If someone loses both phone and recovery codes

There is deliberately no way around 2FA from inside the dashboard. An
administrator resets it from the command line:

```powershell
$env:DATABASE_URL = 'postgresql://...'
npx tsx scripts/create-admin.ts official@imostate.gov.ng --reset-2fa
```

This removes their authenticator, ends all their sessions and writes a
*2FA reset* row to the audit log. At their next sign-in they set up a new
phone and receive new recovery codes.

**Confirm who is asking before running it, in person or by a call to a
number you already have.** This command is the one way around the
second factor, so it is what an attacker will try to talk someone into
running.

Resetting a **password** with the same script now also ends all of that
person's sessions. If the reset is because the password leaked, anyone
signed in with the old one is signed out.

- [ ] On your test account, run `--reset-2fa`, sign in, and confirm it
      goes to setup again

---

## Known limits, stated plainly

- **Self-enrolment.** A brand-new account sets up 2FA at its first
  sign-in, so whoever first signs in with that password owns the account.
  Hand new passwords over in person or by phone, and have the official
  sign in **the same day**. The production answer is **Cloudflare Access**
  in front of `/admin`, which only lets staff email addresses reach the
  page at all. It is free for up to 50 users, and we should switch it on
  before handover.
- **Lockout can be triggered on purpose.** Someone who knows an
  official's email can lock their sign-in for 15 minutes by entering wrong
  passwords. That is the standard trade-off and far better than unlimited
  guessing. Cloudflare Access removes it too.
- **No self-service regeneration of recovery codes yet.** Someone running
  low on codes needs the reset in section 6. An account page that issues
  new codes is on the list.
- **Authenticator apps only.** No SMS codes. SMS can be redirected by
  SIM-swap, which is common enough in Nigeria to rule it out for a
  government system.

## Sign-off

- [ ] Tests pass locally and in CI
- [ ] `/health` reports the 2FA key as `ok`
- [ ] Your account is set up and your recovery codes are stored offline
- [ ] A password alone cannot open any dashboard page
- [ ] A used code, a used recovery code and a sixth guess are all refused
- [ ] Every failed attempt appears in the audit log
