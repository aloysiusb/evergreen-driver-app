# Evergreen Driver App — Claude context

**Before doing anything else, read `CARRYOVER.md` and `CLAUDE_LOG.md`.**

- **`CARRYOVER.md`** is the standing handoff: what the app is for, what work is open, and the rules this codebase runs on — paid APIs, the geocode cache's expiry, where style defaults actually live, why `ACCESS_CODE` is off, how the client-facing briefs are maintained, and the testing failure mode that keeps recurring. It describes the *present*, so **edit it in place** when the present changes rather than appending a contradiction.
- **`CLAUDE_LOG.md`** is the history, and only grows. Check it for prior context, then **add a dated entry after making changes.** It went unwritten for nine days once, and a stale claim reached the client as a direct result.
- **`docs/`** holds standalone reference documents — see the rule below.

## Anything of lasting value goes in a committed file

**A standing instruction from the owner:** work that will be useful later must
end up in a **standalone file in this repository**, not in a chat reply and not
in a session scratchpad. Those vanish with the container. If you produce
something reusable — a reference table, a post-mortem, a letter that worked, a
decision and its reasoning, a trap that cost someone an evening — **write it to
a file and commit it.** Do not wait to be asked, and do not assume the next
session will have the conversation you had.

Two kinds of file, and the difference matters:

- **Living references** describe the present and are **edited in place**:
  `CARRYOVER.md`, `docs/credentials.md`. Correct them when they go stale rather
  than appending a contradiction.
- **Dated records** are closed and **must not be rewritten**:
  `CLAUDE_LOG.md` entries, `docs/google-maps-billing-2026-09.md`, and the
  client-facing briefs in `public/`. If something changes, add a dated note —
  quietly editing a record is how a record stops being worth having.

Current contents of `docs/`:

| File | Kind | What it is |
|---|---|---|
| `docs/credentials.md` | Living | Every environment variable, which are secrets, where each is managed, what is outstanding to rotate. **No values, ever.** |
| `docs/google-maps-billing-2026-09.md` | Dated record | The $207.21 Maps bill: cause, the four fixes, the terms problem with the cache, the appeal letter verbatim, and what to expect during a monitoring window. |

## What this app is

Node.js/Express backend + frontend for Evergreen compost route drivers. Syncs with a Google Sheets spreadsheet via a service account. Drivers see their route stops, can mark stops done, and add notes. All updates sync in real time across devices via WebSocket.

Deployed on Render: https://evergreen-driver-app.onrender.com

## Repo structure

```
src/
  server.js       — Express + WebSocket server, REST API
  sheets.js       — Google Sheets API wrapper (reads credentials from env var only)
  routeParser.js  — Parses raw sheet rows into stop objects, detects section headers
  config.js       — Whitelist of allowed tabs/columns (security: nothing flows through by default)
  db.js           — SQLite (node:sqlite, requires Node 22+) for persisted style settings
  gate.js         — Shared access code, mounted in front of every route (see below)
  requests.js     — Staging queue for website form submissions (site automation)
  errors.js       — Client error log, deduped by fingerprint (see /errors.html)
public/
  index.html      — Route grid (tap a route to open it)
  driver.html     — Driver view: stop list, done toggles, notes
  admin.html      — Style editor: color pickers, sliders, Push button to broadcast styles live
  walkthrough.html — Scripted movie of the driver screen. Self-contained; no key, sheet or network.
  css/tokens.css  — Corner radius scale + palettes. Linked FIRST by every page.
  css/app.css     — Shared styles
  js/routes.js    — Route definitions
  js/driver.js    — Driver page logic + the offline write queue
  js/map.js       — Driver map: GPS, follow mode, arrival prompts, reroute nudges
  js/style-units.js — needsPx()/shouldApplyStyleVar(), shared by index/driver/admin
  js/sim.js       — Test-drive mode for driver.html (?sim=1). Inert otherwise.
data/
  .gitkeep        — Keeps data/ in git; app.db lives here (gitignored, created at runtime)
```

## Architecture notes

- **Google credentials** — service account key is ONLY in Render's environment variables as `GOOGLE_SERVICE_ACCOUNT_KEY` (full JSON). Never committed to git. `sheets.js` reads it from `process.env`.
- **Column whitelist** — `config.js` is a strict allowlist. Billing/financial columns are never exposed to the driver API even if new columns are added to the sheet.
- **WebSocket broadcast** — all connected clients get real-time updates for stop toggles, note edits, and style changes.
- **Offline write queue** — drivers work in dead zones, so a failed write is
  *never* rolled back on screen. `driver.js` parks it in `localStorage`
  (`pending_writes_<routeId>`) and retries on WebSocket reconnect, the
  `online` event, tab re-focus, and a 30 s timer. Entries are keyed
  (`done:<row>`, `notes:<row>`) so repeated edits collapse to the driver's
  final intent, and every queued write is an **idempotent PATCH of absolute
  state** — never a delta — which is what makes blind retries safe. A flush
  stops at the first failure to preserve order. Server data is authoritative
  except where a parked write exists: `applyPendingToStops()` re-applies them
  after every load, and a `stop-updated` broadcast is ignored for any row with
  a parked write, so an echo of older state can't undo the driver on screen.
- **Turn-by-turn** — `map.js` keeps the next manoeuvre on our own screen
  (`#turn-banner`) instead of handing the driver off to Google Maps or Waze and
  losing the stop notes, access codes and Done button with them. Directions are
  fetched from the driver's live position to the current stop, throttled
  (`TURN_MIN_REFETCH_MS`) because it is a billed API call; steps advance only
  forwards so GPS jitter cannot send the driver back a turn. Distances use the
  existing `haversineM()`, not `google.maps.geometry` — map.js loads only the
  `places` library. Design was ported from `demo.html`, where it already existed.
- **Sim mode** — `/driver/<route>?sim=1` test-drives the real driver page from
  a desk. It does **not** reimplement anything: it swaps `navigator.geolocation`
  for synthetic positions walking the route's geocoded stops, and wraps
  `window.fetch` as a fake network with an on/off switch. So map.js and
  driver.js run untouched and sim.js can't drift out of sync with them.
  **Writes never reach the Google Sheet** — every non-GET to `/api/routes/*`
  is intercepted and shown in an on-screen log. Switching "Signal" off makes
  writes reject exactly like a dead zone, which is how you exercise the
  offline queue. Not to be confused with `demo.html`, which is a narrated
  sales demo with its own separate simulation.
- **Client error reporting** — `public/js/report-errors.js` loads first on the
  driver pages and posts what breaks to `POST /api/client-errors`, which is
  open to anyone holding the driver code. Reading the log (`/errors.html`,
  `GET /api/client-errors`) needs ADMIN_CODE. Failures are **deduped by
  fingerprint** — one bug firing per GPS tick is one row with a count, not
  thousands of rows — and the table is pruned past 500 fingerprints so it
  cannot fill the disk. The reporter wraps `fetch` to catch failed API
  responses, which is the class of failure that hid the waypoint bug: no
  exception, no rejection, just a status nobody checked. `window.reportIssue()`
  is there for failures the app handles deliberately but still wants counted.
- **Asset versioning** — `ASSET_V` in `server.js` (Render's commit SHA, or
  process start time locally) is stamped onto local js/css URLs as `?v=`.
  Pages are `no-cache`, assets cache for a day. Without this, a deploy served
  fresh HTML against day-old JavaScript. **Don't remove it** and don't add
  hashed filenames on top — this is the cache-busting mechanism.
- **Style system** — `src/db.js` stores CSS custom property values in SQLite. `/api/styles` GET/POST/reset. Admin page at `/admin.html` pushes changes to all drivers via WebSocket `style-updated` message.
- **Palettes** — the analysis/report pages (briefing, hub, routing, streetview,
  weekly, aspenone) share one palette from `tokens.css`, selected with
  `data-palette="report"` on `<html>`. **Not `data-theme`** — that is already
  taken for the light/dark override. Each page used to carry the same palette
  three times over (light, `@media (prefers-color-scheme: dark)`, and
  `:root[data-theme="dark"]`), 18 copies in all; five were byte-identical and
  aspenone had drifted a few shades off. Adding a page to the family means
  setting the attribute and deleting its `:root` blocks, not copying colours.
- **Corners** — every `border-radius` in the app resolves to one of five role
  tokens defined in `public/css/tokens.css`: `--r-chip`, `--r-control`,
  `--r-card`, `--r-panel`, `--r-sheet` (plus `--r-pill` / `--r-circle`).
  **Don't write a px radius literal** — pick the role that matches what the
  element *is*. Three presets, set with `data-radius` on `<html>`:
  standard (default, driver app + product pages), `tight` (analysis/report
  pages — aspenone, briefing, routing, hub, dispatch, weekly), `soft`
  (marketing/deck pages — pitch, portal, round2, pay, notes). The scale is
  editable in the admin panel's **Corners** section and persists to SQLite.
  `public/iphone.html` is deliberately exempt: its 44/50px radii are physical
  device-frame dimensions, not design tokens.
- **Section headers** — detected in `routeParser.js` by absence of street number + no city; they use the actual row highlight color from the sheet.
- **Row colors** — `sheets.js` has `readRangeWithColors()` which fetches both values and cell background colors in one API call to avoid row index misalignment.

## Environment variables (set in Render dashboard, never in code)

| Key | Description |
|-----|-------------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full contents of the service account `.json` key file |
| `ROUTE_SHEET_ID` | Spreadsheet ID from the Google Sheet URL (between `/d/` and `/edit`) |
| `DATA_DIR` | Path for the SQLite db. `render.yaml` sets this to `/data`, a mounted persistent disk (added 2026-07-11, owner is on Render's Pro tier) — defaults to `./data` if unset, e.g. for local dev. |
| `ACCESS_CODE` | Shared code drivers need. Sent in the link as `?c=CODE`, then stored in a cookie. **If unset, the gate is off and the app is open to anyone with the URL.** |
| `ADMIN_CODE` | Separate code for `/admin.html` and style writes, so a driver cannot restyle everybody else's screen. If unset, the driver code works for admin too. |
| `GOOGLE_MAPS_API_KEY` | The map. Billed per call — read the paid-API section below before changing anything that uses it. |
| `GOOGLE_MAPS_API_KEY_DEV` | Optional second key, served only to a test drive (`?sim=1`). Give it a small daily quota in the Cloud console so a runaway in testing fails loudly instead of billing. Unset, the simulator uses the real key. |
| `GOOGLE_MAPS_MAP_ID` | Optional. A vector Map ID lets the map tilt and turn heading-up. **A Map ID that does not exist, or belongs to another project, fails the whole map rather than falling back** — remove the variable to rule it out. |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | QuickBooks Online app credentials, for the customer payment-link feature. |
| `QBO_REFRESH_TOKEN` / `QBO_REALM_ID` | Obtained once by visiting `/qbo/auth`. **Shown in the browser only — deliberately never logged.** |

## Access gate (`src/gate.js`, added 2026-09-17)

There is no per-driver login and no audit trail of who marked a stop done. The
gate exists for one reason: the route sheet contains customer names and
addresses, and before this the only thing protecting them was nobody guessing
the hostname.

- Mounted in `server.js` immediately after `express.json()`, **before every
  route and static file**, so nothing is reachable without a code.
- A driver taps `https://…/?c=CODE` once. The code is stored in a year-long
  cookie and then stripped from the address bar by a 302 to the bare path, so
  it is not left in screenshots or shared tabs.
- Accepts the code from `?c=`, `?code=`, an `x-access-code` header, or the
  cookie. Compared with `timingSafeEqual`.
- `/health` and `/qbo/*` are exempt — Render pings the former, Intuit redirects
  to the latter.
- `GET /api/styles` needs only the driver code, because every driver page
  fetches it to paint itself. Writing styles needs `ADMIN_CODE`.

**Still open:** `cors()` is mounted with no options, so any origin can call the
API from a browser. The gate makes that far less interesting, but it should be
restricted to the app's own origin. Per-driver identity is a separate job if
Alyssa ever wants to know who did what.

## Styling: how a saved setting reaches a page

`public/js/styles.js` is the only copy of the fetch-and-apply loop. A page
includes `style-units.js`, `fonts.js`, `styles.js` and calls `initStyles()`.
Pages with a WebSocket of their own pass style messages to
`window.onStyleMessage(msg)`; pages without one pass `{ socket: true }`.

**The rule that matters:** the editor writes its values as INLINE styles on
`:root`, and inline beats every selector. So a page that wants light and dark
variants of a colour must not name that colour the same as a global key —
the single global value would win in both. The dispatcher board shows the
pattern: its palette is `--d-*`, fed from `--dispatch-*` inputs the editor
sets, with light and dark read from separate keys. Copy that shape for any
other page that needs its own themes.

The app's WebSocket is mounted at **`/ws`**, not the host root. Every client
must include the path or the handshake is refused and the reconnect loop retries
forever, silently.

`<html data-style-button>` opts a page into the paint button injected by
`styles.js`. **It is on the dispatcher board only.** Styling is the office's
job, not the drivers' — Virginia was explicit about this on 2026-09-18 — so it
is off the route picker and off the route screen, where it would also have sat
under a driver's thumb while they work a stop. It must never go on the
customer portal.

## Paid APIs: answer this before shipping anything that calls one

Google Maps bills per call. In September this app spent **$207** on a round of
two or three drivers, and the whole of it came from the same mistake made three
times: **a billed call placed inside something that repeats, with nothing
remembering the answer.**

- **Geocoding: 11,542 requests** against about 200 addresses. `geocodeAndPlot`
  asked Google where every stop was *every time the map opened* — again on the
  next open, again for the next driver, again on every test drive.
- **Distance Matrix,** with a traffic model, on **every GPS fix**. In a moving
  truck `watchPosition` fires about once a second.
- **The reroute watcher** — waypoint optimisation *and* traffic across 23 stops
  — every three minutes for as long as the page was open, including all night
  on a phone left in a cab.

None of it showed up as an error. The app ran perfectly while spending money,
and the first signal was a bill thirty days later. The second was the map
dying, because Google suspends the APIs when payment fails.

**So, before merging anything that touches `google.maps`, answer all four in
the PR body — not from memory, from the code:**

1. **What does it call that Google bills for?** Geocoder, DirectionsService,
   DistanceMatrixService, Places, Street View, and each map load.
2. **What makes it fire?** A click is fine. A GPS fix, a `setInterval`, or a
   loop over every stop is not, until it has a guard.
3. **What is the worst case per driver per day?** Multiply it out. "Once a
   second for eight hours" is 28,800. If the number is over a few hundred,
   it is wrong.
4. **Can the answer be reused?** Anything derived from the sheet rather than
   from the moment — an address above all — is cached in `geocache.js` and
   asked once ever.

Two guards already exist to copy rather than reinvent: `fetchTurnSteps` and
`fetchNextEta` each take a minimum interval *and* a minimum distance moved, and
`checkForBetterRoute` additionally skips while `document.hidden`. A billed call
with no guard at all does not ship.

A test drive asks `/api/maps-key?sim=1` and gets `GOOGLE_MAPS_API_KEY_DEV` when
one is set — a key with a small daily quota, so a runaway during testing fails
loudly on the tester's screen instead of quietly on the card thirty days later.
Keep it that way: demonstrations are not free.

## Checks before pushing

- `node --check <file>` for every `.js` touched.
- `npm run check` — parses every inline `<script>` in `public/*.html`.
  `node --check` does not look inside HTML, which is how `8ee83bd` shipped a
  regex with its backslashes eaten (`/https://drive.google.com/S+/`). That one
  malformed literal stopped the dispatcher board's entire script from parsing,
  and the board showed "Loading routes…" for a day while the API answered
  correctly the whole time.
- Writing files through bash heredocs is what ate those backslashes. Use a
  node script with the Write tool instead, and scan the result for stray
  control characters.

## Open items — carry these forward (last reviewed 2026-09-18)

Not for the stakeholder write-up at `public/updates.html` unless Virginia says
so. This is the working list.

### 1. Three damaged addresses on `Tues DV` — NOT yet repaired

**What happened.** Writes used to use the fixed column letters in
`src/config.js`. The live `Tues DV` tab carried a legacy "Ney" column that
config did not know about, so every letter was off by one and a saved driver
note was written one column to the left — on top of the **Address**. Three rows
(observed at **6, 7 and 16**) lost their real address and hold note text in its
place. The symptom to look for is `address` and `notes` being identical.

**Cause is fixed** (`9899f90`, hardened in `0138368`): writes now resolve
columns from the sheet's own header row, and refuse outright rather than
falling back to guessed letters.

**The repair is manual and has to be done in the sheet** — the app must not
attempt it, because it cannot tell a damaged address from a legitimately odd
one. Originals should be in the `Tues DV backup 2026-07-06` tab (also
`backup 2026-06-29`). Match by row position and account name, not row number
alone, in case rows were added since.

**Verify current state before acting** — this has not been re-checked since the
column fix, and the rows may already have been corrected by hand:

```
GET /api/routes/Tues%20DV   →  items[] where address.trim() === notes.trim()
```

Note the payload key is `items`, not `stops`.

### 2. `ACCESS_CODE` and `ADMIN_CODE` are still unset

Until they are, customer names, addresses and gate codes are readable by anyone
with the URL. Two entries in the Render dashboard. This is the highest-priority
open item — higher than the addresses.

### 3. Never re-checked against real GPS

Follow mode, turn-by-turn and the side-of-road call have only ever run in
simulation. One real route before Dave depends on them.

### 4. Deferred by Virginia, not forgotten

- Light/dark theme toggle (dark is done; the toggle was deferred twice).
- Making the incident buttons editable **by drivers** — they know the nuances,
  so they should own the wording. Recommended shape: a sheet tab the app reads,
  not a code change.
- `REQUESTS_FROM_EMAIL` needs a verified sending domain before customers
  receive confirmations. The office notification already works.

### 5. Deferred on purpose — notes into the New Customers tab

Alyssa traditionally writes route notes (contamination and so on) in the
**New Customers** tab, column C, "Driver Notes and Special Instructions".
Virginia asked about writing the app's notes there too, alongside hers.

**Decided against for now (2026-09-20):** the app already writes every incident
to the Driver Notes column of the route tab, on the right row, with no matching
needed. Writing into New Customers means matching a route stop to one of ~176
rows in a separately maintained list, by address. Getting that wrong puts a
contamination note against the wrong customer, on a tab that also holds
billing.

**What was already established, so it need not be redone:**

- Header row is row 1. B Address · C Driver Notes · E Customer Name · F City ·
  G Email · H Phone · I Autopay · J Rate/Accounting Notes.
- **Column D has no heading but holds data in 11 rows — it is NOT free.**
  "No heading" is not "empty"; that distinction is the July bug.
- **Column K is genuinely free** and is where such a column should go.
- `GET /api/sheet-headings?tab=X` (admin code) reports headings and a count of
  non-empty cells per column, for any tab including excluded ones. Counts, never
  contents.

**If it is picked up again, measure first:** how many route stops find exactly
one address match in New Customers. High, and it is safe with unmatched ones
flagged. Low, and it needs a different key — do not build it on a guess.

Virginia's own preference if revisited: *append* rather than write in place.

### 5. Raised but undecided

Driver identity on notes (who did what), persistence of the dispatcher feed
across days (the `Driver Notes Log` tab exists but nothing writes to it), an
end-of-day summary, and live truck positions — the last needs a conversation
about driver privacy before anything is built.

## Known deviations from portfolio standard

- **Node.js, not Python** — predates the Python backend standard. Working production app; don't rewrite without asking Virginia.

## Node version

Requires Node 22+ (for `node:sqlite` built-in). `render.yaml` sets `NODE_VERSION: 22`.
