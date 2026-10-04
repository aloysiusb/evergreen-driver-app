# Carryover — where the app stands, and what a new session needs to know

This file is the standing handoff. Unlike `CLAUDE_LOG.md`, which is a history
and only ever grows, **this file describes the present and should be edited in
place** when the present changes. If something here is no longer true, correct
it rather than appending a contradiction.

Last reviewed: 2026-10-04.

---

## What the app is for

A compost-hauling route app for Evergreen, in the Colorado valley. Drivers work
from phones; the office works from a dispatcher board. Node/Express with
`node:sqlite`, deployed on Render, persistent disk at `/data`. The route data
lives in a Google Sheet and syncs through a service account.

The client is Alyssa. Briefs written for her live at `/brief`, `/brief2`,
`/pitch` and `/updates`, and a copy of brief two is hosted on a separate
portfolio site (see **Two repos** below).

---

## Open work

### 1 · Link Evergreen's public website to `/start` — the last real gap

The customer-automation path is **finished and tested**: `/start` →
`POST /api/requests` → approvals queue → approve → a row written onto the route
sheet, with an email to the owner when a request lands. Verified by posting
`public/start.html`'s exact payload to a running server — returns
`{"ok":true,"id":"REQ-…"}`, and the queue then holds one pending `new_customer`
with every field intact. The only step not exercised is the final sheet append,
which needs the live Sheets credential.

**Nothing points at the front door.** That link belongs on Evergreen's own
website, which is outside both of these repos — so this is a note to the owner,
not a code change. **Do not build a second form.** `public/start.html` exists
and works; a brief claimed otherwise for five days and had to be corrected
twice (see `CLAUDE_LOG.md`, 2026-10-04).

### 2 · Cleanup once the Google Maps key is un-suspended

The key was suspended over an unpaid September balance — the owner's side, not
a code problem. When service resumes:

- **The first map load will fire ~200 geocodes.** That is the cache filling.
  It is not a regression. Do not "fix" it.
- Confirm the cache is actually being hit: `GET /api/geocodes` should return
  rows after the first load, and a second load should geocode nothing at all.
- A dev key exists (`GOOGLE_MAPS_API_KEY_DEV`, used when `?sim=1`). **Google
  Cloud quotas are per-API per-project, not per-key** — if that key lives in the
  same project as the production one it shares the same quota, which defeats
  most of the point. Worth checking before relying on it.

---

## Rules this codebase runs on

### Paid APIs

`CLAUDE.md` has a **"Paid APIs: answer this before shipping anything that calls
one"** section: four questions that must be answered in the body of any pull
request touching a billed call. It is not optional, and it exists because
September cost $207 on an app with a couple of hundred addresses.

**No timer may reach a paid API.** Every billed call must be triggered by a
person tapping something or a truck physically moving. An auto-reroute watcher
running on a three-minute interval was deleted outright for this reason; there
is a comment block in `public/js/map.js` explaining why. Do not reinstate it,
and do not add a new interval that reaches Google.

**These three are removed deliberately and must stay removed:**
`drivingOptions`/`trafficModel`, `optimizeWaypoints`, and `libraries=places`.
Each pushes requests out of the standard tier.

### Geocoding

Goes through `src/geocache.js`, keyed on the normalised address, with a
**30-day expiry and a daily sweep**. The expiry is a Google Maps Platform
*terms* requirement, not a performance choice — a lat/lng may be cached
temporarily, a Place ID indefinitely. The first version of that file kept rows
forever, which was a quiet breach. **Do not make it permanent again.**

### Style defaults

`DEFAULT_STYLES` in `src/db.js` is the real source of the palettes. The CSS
custom-property fallbacks only apply when nothing is stored, so **editing the
CSS alone will look like it did nothing.** Change `db.js`.

### `ACCESS_CODE` is off, and that is a decision

The owner switched it off while the app is being demonstrated and tested, and
has confirmed it more than once. **Do not turn it on to tidy a stale-looking
note.** When it does go back on, the link handed out needs to carry the code
(`?c=…`) — last time it was on, the code only ever travelled in a text message
and the owner could not open his own app once that message scrolled away.

### The client-facing documents

`public/brief.html` (20 September) is a **record**: it carries a dated
correction note above text that has since gone out of date, rather than being
rewritten. A brief records what was known on a day, and quietly editing one is
how a record stops being worth having.

`brief2.html`, `pitch.html` and `updates.html` describe the **present** and are
corrected outright.

**When you correct a claim, grep for it across all of them** — including the
portfolio copy. A correction has twice reached one file and not its siblings:
once leaving the stale start-form claim in three places, once leaving a
retracted email limitation in two.

### Email

`notifyNewRequest` returns **silently** when notifications are switched off or
the address is blank — no log line at all. Only the missing-API-key branch
logs. That is the quietest of the three ways it can fail to send.

Request mail goes through **Resend's shared sandbox sender** unless
`REQUESTS_FROM_EMAIL` names a verified domain, and that sender generally only
delivers to the address the account was registered with. So changing
`notify_email` on the Approvals page to a shared office inbox would stop the
emails arriving, **with nothing on screen to say so.** Do not propose that
change without the verified domain first. Customer-facing confirmation emails
need the same domain and are not sent yet.

---

## Two repos

| | |
|---|---|
| `aloysiusb/evergreen-driver-app` | The app. **Changes go through pull requests.** |
| `aloysiusb/vpayson` | A portfolio site that hosts a self-contained copy of brief two at `work/evergreen/brief2.html`. The owner asked for **commits straight to `main`** here. |

**The portfolio copy must contain no reference to Claude.** Note also that the
server appends an attribution footer to pull request bodies automatically; on
that repo it has had to be stripped after the fact.

The two copies of brief two drift. When one changes, check the other.

---

## Testing — the failure mode that keeps recurring

**Browser tests here have passed while testing nothing.** A stubbed Google Maps
object missing `TrafficLayer`, `addListener` or `DirectionsRenderer` reports
zero billed calls because nothing ran at all — which looks identical to a
successful optimisation.

**Always include a control case that must fail.** The map-fallback test contains
a "map loads successfully" case, proving the fallback does not fire when it
shouldn't. The page-render checks look for a sentinel string that must *not* be
found, proving the matcher is capable of failing. A green run with no control
proves nothing.

Practical notes for this environment:

- Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Pass it
  as `executablePath`. `npx playwright install` is unnecessary and will not work.
- Google Fonts fetches are denied by the sandbox proxy, so filter
  `net::ERR_CERT_AUTHORITY_INVALID` out of console-error assertions or every
  page check fails for the wrong reason.
- Use tracked PIDs to stop test servers, not `pkill` — a broad pattern has
  twice killed the session's own shell.
