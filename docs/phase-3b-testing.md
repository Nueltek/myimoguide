# Phase 3b — a self-service dashboard: setup and test guide

**What this delivers.** Every record the assistant answers from can now be
created and edited in the dashboard: services, agencies, facilities and
state facts. A record added here is answerable on the **very next**
WhatsApp question, with no deploy, because the assistant reads from the
database on every message.

That closes the loop the Questions page opens: see what residents ask,
add the record, and the next person gets a verified answer instead of a
web search.

**New in the assistant.** It can now answer *who handles something* and
*who heads an office* — "Who is the commissioner for youth?", "Which
ministry handles land?" — from agency records.

---

## What changed

| | Before | Now |
| --- | --- | --- |
| Services | Edit only, six seeded | Create and edit, linked to an agency |
| Agencies | Not in the dashboard | Create and edit, with head and remit |
| Facilities | Read-only placeholder | Create, edit, filter by type and LGA |
| State facts | Read-only placeholder | Create and edit |
| "Who heads X?" | Fell through to web search | Answered from the agency record |
| Dates | Runtime clock (UTC) | West Africa Time |

### Agencies now carry who leads them and what they do

Two new fields: **head** (title and name) and **responsible for**. The
assistant matches "who do I talk to about X" against the remit, so write
it in the words a resident would use.

**Leave the head's name blank until it is confirmed.** The assistant then
answers *"Headed by the Honourable Commissioner. I don't have a confirmed
name on record yet"* — honest, and it tells your team what to fill in. A
wrong name is worse than none.

### Every form validates on the server and keeps what you typed

If something is wrong, the form comes back with a summary of every
problem at the top — each one a link to its field — and the error beside
the field itself. **Nothing is saved, and nothing you typed is lost.**

The checks worth knowing:

- **Coordinates outside Imo State are refused.** If latitude and
  longitude look swapped — the commonest mistake — it says so.
- **A fee accepts how fees are written here:** `15000`, `15,000` or
  `₦15,000` all work.
- **Duplicates are caught as a message,** not an error page: two agencies
  with one name, or two facilities with one name in the same LGA.
- **"Open 24 hours" has three answers:** yes, no and *not known*. The
  assistant only claims 24-hour service on a yes.

### Records are hidden, never deleted

Untick **Visible to users** to withdraw a record from answers. It stays in
the dashboard and its history stays in the audit log. Deleting would
break the trail a government buyer will ask to see.

### Facilities flag what has gone stale

Any facility not checked in the last **30 days** shows its date in amber,
and one with no phone number shows a red badge. These numbers are given to
people in emergencies.

---

## 0. Setup

### 0.1 Pull and install

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
```

- [ ] `git pull` brings in the dashboard commit

### 0.2 Run the tests

```powershell
npm run typecheck
npm test
```

- [ ] Typecheck passes
- [ ] The dedupe tests pass
- [ ] `e2e passed` — 60 checks across auth, every page, every form, validation and the audit log

### 0.3 Migrate

One new migration adds the agency profile fields and gives your existing
agencies a short id (`iirs`, `ministry-of-lands`).

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run db:migrate
npm run db:seed:services
```

The seed re-run fills in what IIRS and the Ministry of Lands are
responsible for. It leaves both heads' **names** blank, because neither is
published by the agency.

- [ ] Migration applies
- [ ] `/health` still reports `"ok": true`

### 0.4 Deploy

```powershell
npx wrangler deploy
```

- [ ] Deploy succeeds

---

## 1. Add an agency end to end

This is your Youth Affairs example, and the best rehearsal for the pitch.

1. **Agencies → New agency.**
2. Full name: *Imo State Ministry of Youth and Sports Development*
3. Short name: *Ministry of Youth*
4. Head — title: *Honourable Commissioner*. **Leave the name blank.**
5. Responsible for: *Youth empowerment schemes, skills acquisition centres, sports development and youth registration.*
6. **Create agency.**

- [ ] The button shows "Creating..." while it saves
- [ ] You land on the list with "Agency created"
- [ ] The row shows an amber **Name not confirmed** badge

**Now ask the assistant on WhatsApp:** *Who is the commissioner for youth in Imo State?*

- [ ] It answers from the record: the ministry, "headed by the Honourable Commissioner", that the name is not yet on record, and what the ministry is responsible for
- [ ] It does **not** invent a name

**Then fill the name in.** Edit the agency, add a head name, set
Confidence to *Confirmed* and Confirmed by to who told you. Save, and ask
again.

- [ ] The answer now names the head and reads "Confirmed with the office on <today>"
- [ ] No deploy was needed

## 2. Add a service under it

1. **Services → New service.**
2. Name: *Youth empowerment scheme registration*
3. Agency: **Ministry of Youth** from the list
4. Summary, a couple of documents and steps — anything plausible for the test
5. Leave the fee blank. **Create service.**

- [ ] Saved, and listed with the agency beside it
- [ ] Asking *"How do I register for the youth empowerment scheme?"* returns the steps and documents
- [ ] Asking about the ministry again now lists this service under *"I can walk you through"*

## 3. Try to break the forms

Each of these should come back with a clear message and **your entries
still filled in**:

| Do this | Expect |
| --- | --- |
| New agency with no name | "Full name is required." in the summary and beside the field |
| Latitude `7.03`, longitude `5.48` | "These look swapped…" |
| Email `health@` | "Email does not look like an email address." |
| Website `www.example.com` (no https) | "must be a full web address starting with https://" |
| Service fee `fifteen` | "Fee must be a number." |
| Two facilities, same name, same LGA | "already exists in this LGA" |

- [ ] Every row behaves as described
- [ ] Clicking an error in the summary jumps to its field
- [ ] Nothing in the table above was saved, and none of it reached the audit log

## 4. Facilities and facts

- [ ] Add a facility; filter the list by its type and LGA and it appears
- [ ] A facility with no phone shows the red **No phone** badge
- [ ] Edit the *current governor* fact; ask "Who is the governor?" and the edited answer comes back

## 5. Audit log

- [ ] Every create and edit from sections 1–4 is listed, with your email, the time in West Africa Time, and your IP
- [ ] None of the failed attempts from section 3 appear

---

## Known gaps after this phase

- **2FA is not enforced yet.** The columns exist; nothing checks them.
  Next on the list — a government buyer will ask.
- **Voice notes** still reply "coming soon".
- **Records cannot be deleted from the dashboard**, by design — hide them.
- **Igbo** is not started.

## Sign-off

- [ ] Tests pass locally and in CI
- [ ] An agency added in the dashboard is answered on WhatsApp with no deploy
- [ ] The assistant says a head's name is not on record rather than inventing one
- [ ] Bad input is refused with your entries kept, and nothing is saved
