# Phase 4 — voice notes: setup and test guide

**What this delivers.** Residents can ask by voice note instead of
typing. The voice note is transcribed by OpenAI's `gpt-transcribe`, and
the text then takes exactly the same path as a typed question: database
first, then cited web search, with the same refusals for payment details
and emergencies.

Every voice reply opens by repeating what was heard:

> _You said: "Abeg how I go take pay my tax for Owerri?"_
>
> To pay your Imo State taxes…

If the transcription is wrong, the person sees it immediately and can
say it again or type. They never get a confident answer to a question
they did not ask.

---

## How it works

1. WhatsApp tells us a voice note arrived. The webhook queues it, as it
   already did for text.
2. The consumer downloads the recording from Meta.
   - Recordings over about 1 MB are refused without downloading.
   - The length is read from the file itself, and anything over 3 minutes
     is refused before paying to transcribe it.
3. The recording goes to OpenAI with a short vocabulary hint (IIRS,
   Certificate of Occupancy, Mbaise, Oguta, Okigwe…), so local names come
   back spelled correctly. **No language is forced**, so Igbo and Pidgin
   are not pushed into English.
4. The transcript is answered like a typed question, and the reply opens
   with *You said: "…"*.
5. The audio is never stored, anywhere. The transcript is stored as the
   question, like a typed one.

### When it cannot be heard

| Situation | What the person is told | Retried? |
| --- | --- | --- |
| Silence, or noise only | *I could not hear any words… try again somewhere quieter, or type* | No |
| Over 3 minutes | *That voice note is too long… send a shorter one* | No |
| OpenAI cannot read the file | *I could not open that voice note. Please record it again* | No |
| No OpenAI credit, bad key, or no key | *I cannot listen to voice notes at the moment. Please type…* | No |
| OpenAI slower than 10 seconds | *That voice note took too long… try again, or type* | No |
| OpenAI rate limit or outage, Meta's servers failing | Retried automatically; an apology on the last attempt | Yes |

Every one of these is logged. The dashboard shows them under **Voice not
understood**, with the reason.

### Cost

`gpt-transcribe` costs **$0.0045 per minute** of audio, from the same
OpenAI credit the answering models use. A typical 20-second voice note
costs about $0.0015. A thousand of them cost about $1.50, on top of the
normal answering cost.

### What changed in the code

- `src/voice/transcribe.ts`: the transcriber. It's chosen by
  `TRANSCRIBE_PROVIDER` (only `openai` for now), with the model
  overridable by `TRANSCRIBE_MODEL`. It also holds the rules that apply
  whichever provider is used: silence detection, and reading the length
  from the file.
- `src/voice/hear.ts`: download, limits, the replies above, and the *You
  said* line.
- `src/queue/consumer.ts`: voice notes become text here, then follow the
  typed path. The answer's time budget now includes transcription time,
  so replies still arrive while WhatsApp's typing indicator is showing.
- The dashboard: a microphone mark on voice questions, with their length.
  The Questions page has **Voice notes** and **Voice not understood**
  filters, and the overview has a voice card.
- `/health` and `/status` report the transcriber and whether it is ready.
- Migration `0008_voice_notes` adds `audio_seconds` to the questions table.

---

## 0. Setup

### 0.1 Pull and install

```powershell
cd C:\Users\HP\Desktop\myimoguide
git pull
npm ci
```

- [ ] No new packages

### 0.2 Run the tests

```powershell
npm run typecheck
npm test
```

- [ ] Dedupe and TOTP: `all passed`
- [ ] **Voice: `all passed` (38 checks).** The audio is a real Ogg/Opus
      file in WhatsApp's format. Its measured length is compared with
      ffprobe's reading of the same file. The network is faked to answer
      like Meta and OpenAI do, including every failure in the table above.
- [ ] **Consumer: `all passed` (10 checks).** The real pipeline against a
      real database: the transcript is what gets answered, the reply opens
      with *You said*, and failed voice notes are logged.
- [ ] e2e: `e2e passed` (204 checks)

### 0.3 Make sure the OpenAI key is set

Voice notes need the OpenAI key **even though answers come from
Anthropic**.

```powershell
npx wrangler secret list
```

- [ ] `OPENAI_API_KEY` is in the list. If not:
      `npx wrangler secret put OPENAI_API_KEY`
- [ ] If your OpenAI project restricts which models it may use, add
      **gpt-transcribe** to the allowed models in that project's settings.
      Otherwise every voice note gets *I cannot listen to voice notes at
      the moment*, and the log shows a 403.

### 0.4 Optional: check your key and the format before deploying

WhatsApp voice notes are Ogg/Opus. OpenAI's documentation does not list
Ogg, but accepts it in practice when the file is named `.ogg`. This
one-minute check confirms that for your key, on your machine. The key
stays in your terminal.

If you can get a WhatsApp voice note onto your computer, name it
`test.ogg` and run the command below. If that is awkward, skip this step:
the first live voice note in section 1 tests the same thing, and the log
shows the exact error if there is one.



```powershell
$env:OPENAI_API_KEY = 'sk-...'
curl.exe https://api.openai.com/v1/audio/transcriptions `
  -H "Authorization: Bearer $env:OPENAI_API_KEY" `
  -F file=@test.ogg -F model=gpt-transcribe
```

- [ ] It prints `{"text": "..."}` with what you said. If it prints an
      error, send it to me before deploying.

### 0.5 Migrate and deploy

```powershell
$env:DATABASE_URL = 'postgresql://...'
npm run db:migrate
npx wrangler deploy
curl.exe https://<your-worker>.workers.dev/health
```

- [ ] Migration `0008_voice_notes` applies
- [ ] `/health` shows
      `"voice": { "provider": "openai", "model": "gpt-transcribe", "ready": true }`
- [ ] Send `/status` on WhatsApp from your admin number. It ends with
      `Voice notes: openai gpt-transcribe`.

---

## 1. English

Send a voice note: *"How do I get a Certificate of Occupancy in Owerri?"*

- [ ] The typing indicator appears, and the reply opens with *You said:*
      followed by your question
- [ ] The answer is what you would get by typing the same question
- [ ] Dashboard → Questions: the question has a microphone mark and its
      length

## 2. Pidgin

Send: *"Abeg, how I go take pay my tax for Imo?"*

- [ ] Note whether *You said* keeps your Pidgin as spoken or rewrites it
      into standard English. Either way, check that the answer fits the
      question.

## 3. Igbo

Send two or three short questions in Igbo. For example, ask where the
IIRS office is, or how much a Certificate of Occupancy costs.

- [ ] Write down exactly what you said, and copy what *You said* shows
- [ ] Note whether the answer made sense

**This is the test that tells us whether Igbo is usable.** OpenAI
publishes no Igbo results, so your voice notes are the evidence.

## 4. The edge cases

- [ ] A voice note of near-silence, a few seconds of a quiet room: *I
      could not hear any words…*
- [ ] A voice note in a noisy place (market, traffic): is *You said*
      still right?
- [ ] A voice note over 3 minutes: *That voice note is too long…*
- [ ] Typed questions still work exactly as before, with no *You said*
      line
- [ ] Dashboard → **Voice not understood** lists the silent and the
      too-long notes, with their reasons
- [ ] The overview's **Voice notes** card counts them

## 5. Send me the results

For each voice note in sections 1–4, send me a line like this:

| Language | What you said | What "You said" showed | Answer made sense? |
| --- | --- | --- | --- |
| English | How do I get a C of O in Owerri? | | |
| Pidgin | | | |
| Igbo | | | |
| Noisy | | | |

The live log has a line for each voice note with its length and outcome,
in case anything needs a closer look:

```powershell
npx wrangler tail --format pretty
```

Look for lines beginning `voice:`.

From those results we decide what to do about Igbo. It could be fine as
it is, it could need a tuned prompt, or it could need a specialist
Nigerian speech provider added behind `TRANSCRIBE_PROVIDER`.

---

## Known limits, stated plainly

- **Igbo and Pidgin accuracy are unknown until your test.** Nothing
  filters by language, so an Igbo voice note is transcribed and answered.
  The *You said* line is what protects the person if it is transcribed
  badly.
- **No language detection.** OpenAI's response contains only the text,
  so the dashboard cannot yet show which language a voice note was in.
- **A voice note whose answer fails and is retried is transcribed
  again.** That costs a fraction of a cent. Not worth the extra moving
  parts to avoid.
- **Comparing models is a one-line change.** Set
  `TRANSCRIBE_MODEL=gpt-4o-transcribe` in `wrangler.jsonc` vars and
  redeploy to compare against OpenAI's previous model. Clear it to go
  back.

## Sign-off

- [ ] Tests pass locally and in CI
- [ ] `/health` shows voice `ready: true`
- [ ] An English voice note is answered, opening with *You said*
- [ ] Silence and a 3-minute-plus note get plain replies, not guesses
- [ ] Igbo and Pidgin results sent back for the next decision
