# Phase 3d — users, roles and invitations: setup and test guide

**What this delivers.** The ministry can run its own dashboard team
without calling us. An administrator invites a colleague by email, chooses
what they may do, and can later change their role, sign them out, reset
their two-step sign-in or remove their access. All of it is in the
dashboard and recorded in the audit log.

The command-line script is still there, for creating the first
administrators at handover and as a break-glass tool if every
administrator is ever locked out. Day to day, nobody needs it.

---

## What changed

| | Before | Now |
| --- | --- | --- |
| Adding a person | We ran a script and handed over a password | An administrator sends an invitation link; the person chooses their own password |
| What people can do | Everyone could do everything | Three roles: Administrator, Editor, Viewer |
| Lost phone | We ran `--reset-2fa` | Another administrator resets it from the person's page |
| Someone leaves | Not possible | Deactivate: access removed at once, history kept |
| Your own password | Script only | Account page: change password, new recovery codes, see where you are signed in |
| Managing accounts | — | Asks for a fresh 2FA code if the last one was over 15 minutes ago |
| Audit log | | Also records invitations, joins, role changes, deactivations and resets, e.g. *Viewer → Editor* |

### The three roles

| | Administrator | Editor | Viewer |
| --- | :---: | :---: | :---: |
| See services, agencies, facilities, facts | Yes | Yes | Yes |
| See questions and the audit log | Yes | Yes | Yes |
| Add and edit records | Yes | Yes | No |
| Invite people, change roles, remove access | Yes | No | No |
| Manage their own password and recovery codes | Yes | Yes | Yes |

**Viewer** suits a commissioner who wants to see what residents ask, an
internal auditor, or a reviewer from another ministry. Their pages show
**View** instead of **Edit**, and records open read-only.

A ministry should always have **at least two administrators**. Then if
one loses their phone, the other can restore their access. The Users page
warns when there is only one.

### How an invitation works

1. An administrator opens **Users → Invite someone**, enters the email and
   picks a role.
2. The dashboard shows a link **once**. The administrator sends it
   themselves, by official email or a direct message.
3. The person opens it, enters their name, and **chooses their own
   password**.
4. They go straight to setting up their authenticator app, and they are
   in.

Why it works this way:

- **Nobody ever knows anyone else's password**, including the
  administrator who invited them.
- **The link works once and expires after 72 hours.** Only a fingerprint
  (hash) of it is stored, so it cannot be recovered from the database or
  shown again.
- **This closes the gap noted in Phase 3c.** There is no temporary
  password that someone else could use first.
- **We do not send the email ourselves.** That would mean a paid email
  service or one more account to manage. An administrator sending a link
  through a channel they already trust is normal for a ministry, and
  arguably safer.

### The rules the dashboard enforces

- **Nobody changes their own role, access or 2FA** on the Users page. One
  mis-click cannot lock someone out of their own account, and every
  change to an account is made by a second person, on the record.
- **Accounts are deactivated, never deleted.** The audit log keeps
  showing who made every past change. A deactivated person is signed out
  immediately, cannot sign in, and can be reactivated later.
- **Role changes apply on the person's next click.** Nobody needs to sign
  out.
- **Managing accounts asks for a fresh code.** If the last 2FA code was
  given more than 15 minutes ago, the Users pages ask for one before
  opening. A laptop left signed in at a desk cannot be used to invite
  someone or remove a colleague. Wrong codes count towards the same limit
  of five as at sign-in.
- **The rules are checked on the server for every request**, not just
  hidden in the menus. An editor who types a Users address, or a viewer
  who submits a form directly, gets *Your role does not allow this*, and
  nothing is saved. The tests check exactly that.

---

## 0. Setup

### 0.1 Pull and install

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
```

- [ ] `git pull` brings in the user-management commit
- [ ] No new packages

### 0.2 Run the tests

```powershell
npm run typecheck
npm test
```

- [ ] Typecheck passes
- [ ] Dedupe and TOTP tests end with `all passed`
- [ ] The e2e run prints `pre-roles 'admin' account migrated to 'administrator' ok`.
      This replays your own upgrade: it creates an account the old way,
      applies the new migration, and checks the account came out as an
      administrator.
- [ ] `e2e passed`: 199 checks, of which 86 are new for this phase

### 0.3 Migrate

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run db:migrate
```

The migration adds roles, invitations and the confirmation timestamp.
**Your existing account becomes an Administrator.** It had role `admin`,
from before roles existed, and the migration converts that. Any role it
does not recognise becomes Viewer, which can change nothing, rather than
failing.

- [ ] Migration `0007_user_management` applies

### 0.4 Deploy

```powershell
npx wrangler deploy
```

- [ ] Deploy succeeds
- [ ] You can still sign in, and your name in the top-right shows
      **Administrator**

---

## 1. Your account page

Click your email or name in the top-right corner.

- [ ] It shows your role, when 2FA was turned on, and how many recovery
      codes you have left
- [ ] Enter your name and **Save name**. It now appears top-right instead
      of your email.
- [ ] *Where you are signed in* lists this browser as **This session**

## 2. Invite an editor

You need a second email address you can open: a Gmail account works, or
use the private window of another browser.

1. **Users**. If you signed in more than 15 minutes ago, you are asked for
   a code from your app first. Signing in counts as a confirmation, so
   straight after signing in you go straight through.
2. **Invite someone**. Enter the second email and choose **Editor**.
3. Copy the link.

- [ ] Users asks for a code when your last one is over 15 minutes old
      (wait, or test it later in the session)
- [ ] Inviting your **own** email is refused: *already has an account*
- [ ] The link page says *shown only now*. Click **Done**. The Users page
      lists the invitation but never the link itself.
- [ ] The invitation appears under **Open invitations**, with an expiry
      three days from now in WAT

## 3. Accept it, as the new person

In a **private window** (so you are not signed in as yourself), paste the
link.

- [ ] It says who invited you and that you are invited as **an Editor**
- [ ] A password shorter than 12 characters is refused, and your name is
      kept
- [ ] A password containing your email name is refused
- [ ] With a good password you go straight to **Set up two-step
      sign-in**. Set it up with your phone. A second account in
      Google Authenticator is fine.
- [ ] Paste the link again. It says *already been used*.

## 4. See what an editor can and cannot do

Still in the private window, as the editor:

- [ ] Services, Agencies, Facilities and State facts work, with **New**
      buttons
- [ ] There is **no Users** item in the menu
- [ ] Type `/admin/users` into the address bar. You see *Your role does
      not allow this*.

## 5. Change their role, from your own window

Back as yourself: **Users → Manage** on the new person.

1. Change their role to **Viewer**, then **Change role**.
2. In the private window, click **Services**.

- [ ] The **New service** button has gone and **Edit** now says **View**,
      without them signing out
- [ ] Opening a record shows the fields greyed out and no **Save** button
- [ ] **Audit log** in your window shows *Role changed · Editor →
      Viewer*

## 6. Remove and restore access

On their page, **Deactivate… → Deactivate**.

- [ ] Their next click in the private window goes to the sign-in page
- [ ] Signing in as them says *Email or password is incorrect*
- [ ] The audit log shows *Sign-in failed · account disabled*
- [ ] **Reactivate** restores them, and they sign in with the same
      password and phone

## 7. Lost phone, without the command line

On their page, **Reset two-step sign-in → Reset two-step sign-in**.

- [ ] They are signed out, and their next sign-in goes to setup with a new
      QR code
- [ ] On **your own** page, the Manage access section is replaced by
      *This is your account*. You cannot reset, demote or deactivate
      yourself.

## 8. Withdraw an invitation

Invite a made-up address, then **Withdraw** it from Open invitations.

- [ ] Opening that link says *This invitation was withdrawn*

## 9. Change your password

On **your account page**, change your password.

- [ ] A wrong current password is refused. It also counts towards the
      five-per-15-minutes sign-in limit, so an open session cannot be
      used to guess your password.
- [ ] After changing it, any other browser you were signed in on is
      signed out, and this one is not
- [ ] **Issue new codes** asks for a code from your app first if it has
      been over 15 minutes, then shows 10 new codes once. Your old printed
      codes no longer work: **replace your printed copy.**

---

## At handover

1. Create the ministry's first administrator:

   ```powershell
   npx tsx scripts/create-admin.ts official@imostate.gov.ng --name "Full Name" --role administrator
   ```

   The script prints a generated password once. Hand it over in person,
   and have them sign in that same day. They change it on their account
   page.
2. **They invite a second administrator from the dashboard.** From then
   on the ministry is self-sufficient.
3. Our own account: either deactivate it, or keep it as a named support
   account that appears in the audit log like everyone else. Some
   government IT reviewers ask that the vendor have no standing access.
   Deactivating it, and asking for reactivation when support is needed,
   meets that.

The script stays available as break-glass recovery, if every
administrator loses access at once. That belongs in the maintenance
contract.

## Known limits, stated plainly

- **Inviting the same person again replaces the earlier link.** Only the
  newest link works, so a link sent by mistake can be cancelled by
  re-inviting. The same happens if the invitation page is refreshed and
  the browser resubmits the form. If you refresh it, send the new link,
  not the one copied before.
- **Links are sent by the administrator, not the system.** That is a
  deliberate choice for now. Sending email automatically can be added
  with an email service if the ministry prefers it.
- **Cloudflare Access**, when we turn it on, keeps its own list of who may
  reach the dashboard. If staff use `@imostate.gov.ng` addresses, one rule
  covers everyone and adding a person stays one step. If they use Gmail,
  each new person also has to be added to Access. Worth finding out early.
- **The 15-minute confirmation also applies to opening the Users pages**,
  not just to saving changes. That way a form is never lost to an
  expired confirmation, at the cost of an occasional extra code.
- **Roles are fixed at three.** Per-ministry permissions, such as an
  editor who may only touch Lands records, are possible later if a buyer
  asks. They are not needed for a single-ministry pilot.

## Sign-off

- [ ] Tests pass locally and in CI
- [ ] Your account migrated to Administrator
- [ ] An invited person created their own password and set up 2FA
- [ ] An editor cannot reach Users, and a viewer cannot change a record,
      even by typing addresses directly
- [ ] Deactivation and 2FA reset take effect on the person's next click
- [ ] Every one of these changes appears in the audit log, with who made it
