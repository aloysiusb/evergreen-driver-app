# Claude Session Log

Append a dated entry after each session. Most recent first.

---

## 2026-09-17 (session 3) — Sim mode, and a rebase onto the access gate

### Rebased onto two upstream commits

Another session had pushed `55f7b38` (shared access-code gate, `src/gate.js`)
and `b6b83cc` (untrack `data/app.db`) while this work was in progress, so the
four local commits were rebased on top. Conflicts in `.gitignore` (same rules,
different comment — kept upstream's) and `CLAUDE_LOG.md` (kept both entries).

`src/server.js` auto-merged, which is exactly where a silent mistake could
hide, so it was checked rather than trusted: `mountGate(app)` sits at line 26
and all the asset-versioning at 296+, so the gate is still in front of
everything — **including the new HTML stamper route**, which was the one that
could plausibly have bypassed it. Verified with `ACCESS_CODE` set: `/`,
`/driver.html`, `/admin.html`, `/js/map.js` and `/api/styles` all 401
without the code, and 302 with it. Unset, the gate no-ops and local dev works.

### Sim mode — `/driver/<route>?sim=1`

Follow mode shipped unverified because testing it needs real GPS at real
speed. Sim mode closes that gap without a truck.

The design choice that matters: it does **not** mock the driver app. It swaps
the two boundaries the app talks to the world through — `navigator.geolocation`
and `window.fetch` — and lets the real map.js/driver.js run on top. Nothing in
them knows it's simulated, so sim.js cannot quietly diverge from the code it's
supposed to be testing.

- Synthetic GPS interpolates between the route's geocoded stops with real
  bearings, at a believable pace (~13 m/s x a speed slider) rather than a
  fixed fraction per leg, which would crawl on long legs and teleport on short
  ones
- **Signal on/off** switch: off makes writes reject like a dead zone, which is
  how you watch the offline queue fill and drain. Switching back on fires the
  `online` event the driver app already listens for
- **Writes never reach the sheet.** Every non-GET to `/api/routes/*` is
  intercepted and logged on screen. Alyssa's live route data cannot be marked
  done by a test drive
- Loud purple panel pinned to the bottom, so nobody mistakes a test drive for
  the real app in a meeting

**Verified**: without `?sim=1` the file is completely inert — no panel and
`window.fetch` is still native. With it, geolocation and fetch are both
swapped, a write returns a synthetic 200 where the real server (no Sheets
creds locally) would have returned 500 — proving interception — and with
Signal off the same write rejects with `sim: no signal`. Both appear in the
log, colour-coded.

**Not verified**: the drive loop itself. Route data won't load locally without
Google Sheets credentials, so `navStops` stays empty and the simulator sits at
"waiting for the route to load". The plumbing is proven; the actual walking of
a route has only been exercised against an empty route. First real use should
be against the deployed app.

---

## 2026-09-17 (session 2) — Driver reliability: offline queue, follow mode, cache busting

Three rounds of work, each uncovering the next.

### Follow mode on the driver map

The map never recentred on the driver — `centerOnCurrent()` pans to the
*stop*, so once moving the GPS dot slid off the edge while the map sat parked
on the destination. Now:

- Rides with the driver at street zoom (17); 🧭 Follow button, on by default
- Hand-panning drops out of follow so it doesn't fight the driver; tap resumes
- Zoom is asserted only on engage, not per GPS tick, so zooming out to see the
  route isn't undone
- Heading kept only above walking pace so the view doesn't spin at red lights.
  `setHeading` is a **no-op on raster maps** — heading-up needs a vector Map
  ID from the Cloud console. Pan-follow works regardless.

Roadmap stays the default rather than satellite: nav apps use roadmap while
moving because aerial is harder to read at speed. Satellite is still a toggle
for scouting driveways. Arrival alerts (80 m) already existed.

### Asset versioning — deploys weren't reaching drivers

Found while testing the above: the Follow button rendered but did nothing,
because the browser was running a cached `map.js` from before the change.
Pages were `no-cache` but js/css were `max-age=86400` on unversioned
filenames, so **a deploy handed drivers fresh HTML pointing at up-to-24-hour-old
JavaScript** — new markup wired to old code, failing silently.

HTML now goes through a stamper that appends `?v=<ASSET_V>`. External font
URLs are untouched and `express.static` ignores the query, so the long cache
that helps drivers on cell service is preserved.

### The offline write queue (the important one)

`markDone` optimistically checked the stop, then **reverted it** if the write
failed, with a 3-second toast. In a dead zone that converted "not synced yet"
into "never happened": phone in pocket, toast unseen, stop unchecked locally
*and* absent from the sheet, with no trace anywhere. Two related bugs sat
alongside it — `markUndone` and the note save both `await`ed fetch without
checking `res.ok`, so a server 500 counted as success. The two operations
failed in opposite directions on the same network.

All three now route through `sendOrQueue()`. The driver's action stands, the
write parks in `localStorage`, and it goes out on reconnect. See CLAUDE.md for
the design; the load-overlay and the `stop-updated` guard are the subtle parts
— without them a reload or a broadcast would repaint parked work as undone.

Also: screen wake lock while the tab is visible (re-taken on `visibilitychange`
— browsers don't restore it), and a short `navigator.vibrate` on the arrival
alert, since a driver watching the road won't see a toast. Both degrade
silently where unsupported (iOS Safari has no vibrate).

**Verified in-browser**: queue survives reload; a failed flush keeps every
entry; a successful flush drains in order and clears the badge; a mid-queue
failure removes only what succeeded and does **not** skip ahead of the failure.
Follow mode couldn't be verified against a live map — no `GOOGLE_MAPS_API_KEY`
locally.

### Housekeeping

- `GOOGLE_MAPS_API_KEY` documented in `render.yaml` (`sync: false`). It's
  the browser-facing key — restrict by HTTP referrer, never reuse the service
  account key.
- Needs enabling: Maps JavaScript, Geocoding, Directions, Distance Matrix.
- A `report` palette exists in `tokens.css` but **no page opts into it yet**
  — inert, and the colour/font consolidation is still the open next step.

---

## 2026-09-17 — Corner radii unified onto one scale

The site had drifted badly: **~200 `border-radius` declarations across 25
distinct hardcoded values**, with individual pages using seven different radii
at once (streetview had 3/6/7/8/9/10/11px on adjacent elements). Almost none of
it was deliberate — it was accumulated drift from pages being written
independently.

- Added `public/css/tokens.css` — five **role** tokens (`--r-chip`,
  `--r-control`, `--r-card`, `--r-panel`, `--r-sheet`) plus `--r-pill` and
  `--r-circle`, in three presets selected by `data-radius` on `<html>`. Roles
  rather than sizes, so an element declares what it *is* and the scale decides
  the number. Linked ahead of each page's own `<style>`, so a page can still
  override any token in its own `:root`.
- Kept the three visual languages that were actually intentional — the driver
  app / product pages (standard), the crisp print-like analysis pages
  (`tight`), and the rounder marketing pages (`soft`) — instead of flattening
  everything to one number.
- Rewrote 194 declarations across 17 files onto the scale. One literal
  survives (`border-radius: 0` on stacked completed stop cards, deliberate).
- Collapsed the old `--radius` var into `--r-panel` / `--r-card` — it was a
  second knob for the same thing and had its own admin slider. Removed from
  `db.js`, `app.css`, `portal.html` and the admin panel. `--route-card-radius`
  was **left alone** — a genuine one-off for the home page's big route cards.
- `needsPx()` had been copy-pasted into admin.html, index.html and driver.js
  and had already started to drift between the three. Extracted to
  `public/js/style-units.js`, which now also carries `shouldApplyStyleVar()` so
  a pushed style can't clobber a `tight`/`soft` page's preset (an inline style
  on `:root` beats any stylesheet selector).
- Added a **Corners** section to the admin style editor — five sliders, live
  preview, persisted to SQLite like every other style var.
- `.gitignore` did not actually cover `data/app.db`, despite CLAUDE.md saying
  it did — the SQLite db showed up as untracked as soon as the server ran
  locally. Added `data/*.db*`.

**Verified locally** (node 24, `PORT=3777`, no Google creds — route data fails
to load as expected, everything else renders): all three presets resolve
correctly in the browser, the Corners sliders drive the live preview iframe,
and index / driver / admin / briefing / dispatch / pitch / portal / weekly all
render without visual breakage.

**Not done — same drift exists in colors and fonts.** Each page defines its own
`:root` palette with different names for the same thing (`--muted` vs
`--text-muted`, `--accent` vs `--green` vs `--forest`) and five near-identical
page backgrounds (#f2f7f3, #f5faf6, #f7f8f6, #f3f7f2, #f5f7f4). Six typefaces
are in play and each page loads its own Google Fonts request — a real
performance cost on top of the inconsistency. `tokens.css` is the obvious place
to fix both next.

---
## 2026-09-17 — Access gate, so the link can be handed to drivers

**Why:** Virginia wanted a link she could text to the drivers today. Nothing in
the app was authenticated, and `/api/routes/:tabName` returns customer names and
addresses — so the only thing protecting Alyssa's customer list was nobody
guessing the hostname. A URL in a group text travels.

**What was done:**
- Added `src/gate.js` — a shared access code, mounted in `server.js` right
  after `express.json()` so it sits in front of every route and static file.
  Driver taps `?c=CODE` once; it is stored in a year-long cookie and stripped
  from the address bar via a 302. Accepts `?c=`, `?code=`, an `x-access-code`
  header, or the cookie, compared with `timingSafeEqual`. `/health` and
  `/qbo/*` are exempt. No-ops entirely if `ACCESS_CODE` is unset, so local dev
  and the existing deploy keep working until the variable is set.
- Separate `ADMIN_CODE` for `/admin.html` and style writes. `GET /api/styles`
  still only needs the driver code, because every driver page fetches it to
  paint itself — that distinction is the fiddly part of the middleware.
- **Removed the QBO refresh token from the logs.** `/qbo/callback` was doing
  `console.log("QBO_REFRESH_TOKEN =", tokens.refreshToken)`. That is a live
  credential for Alyssa's accounting sitting in Render's persistent logs,
  readable by anyone with dashboard access. It now renders once in the browser
  response and is never logged.
- **Removed `/qbo/auth-debug`**, a debug endpoint live in production.

**Tested locally on port 8123** with `ACCESS_CODE`/`ADMIN_CODE` set: no code
gives 401 on pages and API; wrong code 401; right code 302 then 200; header
auth works; cookie persists across visits; driver code is rejected on
`POST /api/styles` and `/admin.html` but accepted on `GET /api/styles`;
`/health` open throughout. Route grid renders in-browser with no console errors.

**Virginia must do, in Render, before the link works:**
1. Set `ACCESS_CODE` and `ADMIN_CODE` env vars — until then the gate is off.
2. **Rotate the QBO refresh token in Intuit**, since the old one was logged.

**Left to do:** restrict `cors()` to the app's own origin — it is currently
mounted with no options. Per-driver identity (who marked which stop) is a
separate job, not attempted here.

## 2026-07-11 — Persistent disk added for the style DB

Closes the "consider adding a Render persistent disk" note from the
2026-07-09 session-1 entry below. Owner confirmed she's on Render's Pro
tier, so the earlier free-tier cost hesitation no longer applies (see
`render_pro_tier` in Claude's cross-session memory if this comes up again
in other repos — evergreen-driver-app, cymatic-decoder, and
The-Lemmon-Dociere all had free-tier caveats written into their docs at
various points).

- `render.yaml`: added `plan: starter` (required by Render for any
  service to attach a disk), a `disk` block (`evergreen-data`, mounted at
  `/data`, 1GB), and `DATA_DIR=/data` env var.
- No code changes needed — `src/db.js` already read `DATA_DIR` correctly
  (falls back to local `./data` if unset, so local dev is unaffected).
- Not yet verified live: this repo's `render.yaml` needs to actually be
  in sync with how the Render service was originally created. If the
  service was set up via Render's Blueprint (render.yaml-driven) flow,
  pushing this should offer to add the disk automatically on the next
  deploy. If it was created by connecting the repo manually (not via
  Blueprint), Render won't pick up the new `disk:`/`plan:` fields on its
  own — check the Render dashboard's "Blueprint" tab for this service,
  or add the disk manually under Settings → Disks if needed.

---

## 2026-07-09 (session 2)

**What was done:**
- Expanded style system to cover every non-sheet visual property with full color + font size + font weight controls per element
- New CSS vars added: `--route-title-font-size/weight`, `--section-header-font-size/weight`, `--completed-section-bg/text/border`, `--stop-account-font-size/weight`, `--stop-address-font-size/weight`, `--stop-note-font-size/weight`, `--note-edit-bg/font-size/font-weight`, `--urgent-bg/text`, `--hold-bg/text`, `--action-btn-font-size/weight`, `--primary-btn-text/font-size/weight`, `--toast-bg/text/font-size/weight`, `--home-heading-font-size/weight`, `--home-subhead-font-size/weight`, `--progress-bar-fill`
- admin.html reorganized into: Home Page, Global Typography, Text Colors, Stop Cards, Notes & Alerts (new), Driver Page, Route Cards & Colors — with paired sliders for size+weight per element
- `needsPx()` is now pattern-based (`key.endsWith('-font-size')`) instead of a hardcoded list — any future vars pick up unit handling automatically
- All hardcoded hex values and `white` literals replaced with CSS vars in app.css
- `needsPx` updated in driver.js and index.html to match

**State:** All changes pushed to GitHub. Ready to deploy to Render.

---

## 2026-07-09 (session 1)

**Session summary:** Set up deployment infrastructure and built the style system.

**What was done:**
- Installed Node.js 24 LTS via `.pkg` installer (Homebrew build from source failed on macOS 12)
- Installed Homebrew, then `gh` (GitHub CLI) to create and push the GitHub repo
- Created `.gitignore` blocking all `*.json` files except `package.json`/`package-lock.json` (keeps service account key out of git)
- Created `render.yaml` for Render deployment; `GOOGLE_SERVICE_ACCOUNT_KEY` and `ROUTE_SHEET_ID` are marked `sync: false` — set manually in Render dashboard only
- Deployed to Render: https://evergreen-driver-app.onrender.com
- Added `src/db.js` — SQLite (node:sqlite) storing shared CSS custom property values for the style system
- Added `public/admin.html` — style editor with color pickers + opacity, font size/weight/line-height sliders, corner radius slider, live preview iframe, "Save & Push to All Drivers" button, reset to defaults
- Updated `src/server.js` — added `/api/styles` GET/POST/reset endpoints; POST broadcasts `style-updated` via WebSocket so all connected driver pages update instantly
- Bumped `render.yaml` NODE_VERSION to 22 (required for built-in `node:sqlite`)
- Note: the remote already had 31 commits of active frontend development (route grid, driver page, sheet row colors, section headers) — those were preserved; style system was layered on top

**State of the remote:** Style system is live in the repo. Render will auto-deploy on push to `main`. Style settings are ephemeral on Render free tier (no persistent disk yet).

**Left to do / next session:**
- Verify style editor works on live Render deploy (env vars need to be set first)
- Consider adding a Render persistent disk for SQLite so style settings survive redeployments
- The driver UI (`driver.html`) and index page (`index.html`) may benefit from integrating the style variables — currently the existing CSS may not use the custom properties set by the style system

---

## 2026-09-18 — smaller photos, and no more guessing at columns

**Photos.** Capture now encodes WebP at 1280px instead of JPEG at 1600px,
dropping a typical stop photo from 200-400 KB to roughly 60-120 KB. WebP is
requested first and the returned blob's type is *checked*: a browser that
cannot encode WebP does not error, it silently hands back a PNG, which is
larger than the JPEG it replaced. If the blob is not WebP it is re-encoded as
JPEG at 0.72 (~110-180 KB). The upload sends the real Content-Type, the server
accepts both types, and Drive stores the file with the matching extension.

**Columns — the fallback is gone.** `columnsFor()` no longer falls back to the
fixed letters in `config.js` when a tab's header cannot be read. That fallback
is what destroyed three addresses on Tues DV: the live sheet had a column
config did not know about, every letter was off by one, and driver notes were
written into Address. It now throws a 409 with a readable message instead.

Refusing costs the driver nothing — the write parks in the phone's offline
queue and goes through by itself once the header is readable, so no work is
lost. Writing to a guessed cell, by contrast, is silent and destroys data.

Also fixed in the same pass: approving a customer from the portal queue was
still composing its new row from `ROUTE_COLUMNS`, so a sheet with a different
shape would have filed the new customer's address in the wrong column. It now
uses the detected columns like every other write. **No write path in
`server.js` uses fixed column letters any more** — the only remaining
references are the diagnostic display in `/api/sheet-check`.

Added a startup audit that reads every route tab's header once and logs
`done→C notes→E address→D` per tab, so a sheet swapped in overnight shows up
as shifted or unreadable in the Render log *before* a driver taps anything.
It warms the column cache as a side effect.

**Still open:** the three damaged addresses on Tues DV rows 6, 7 and 16 have
not been restored — the originals are in the `Tues DV backup 2026-07-06` tab.
`ACCESS_CODE` and `ADMIN_CODE` are still unset, so the route pages remain
publicly readable by anyone with the URL.

---

## 2026-09-18 (later) — the dispatcher joins the style system

**One copy of the style client.** The fetch-and-apply loop existed twice
(index.html, driver.js) and the dispatcher board had no copy at all, which is
the whole reason it ignored the editor. It now lives in
`public/js/styles.js`; pages call `initStyles()`.

**The dispatcher keeps its own light/dark.** It could not simply adopt the
global colours: the editor writes `--bg` and friends as inline styles on
`:root`, inline beats every selector, so one global value would have won in
both themes and the toggle would have stopped mattering. Its palette is
namespaced `--d-*` and fed from `--dispatch-*` inputs, light and dark held
separately. Eighteen new keys, all editable, previewable from the editor via a
new page picker. The toggle is now remembered between visits, restored inline
in `<head>` so there is no flash, and its first tap no longer sets
dark-on-dark when the system is already dark.

**Found while testing: the dispatcher board had been dead since `8ee83bd`.**
A regex written the day before lost its backslashes —
`/https://drive.google.com/S+/` ends at the second slash — so the page's
entire inline script failed to parse. Six route cards, 1401 stops, all of it
blank behind one console error, while `/api/routes/*` answered 200 the whole
time. Same backslash-eating hazard as the earlier `map.js` incident.

`node --check` cannot see inside HTML, which is how it got through.
`tools/check-html.mjs` (`npm run check`) now parses every inline script in
`public/*.html`. Thirteen scripts, zero broken. Verified live afterwards: the
board loads, WebSocket reads Live, 1401 stops, no console errors in a clean
tab.

---

## 2026-09-18 (later still) — route colours, hex fields, two bugs of mine

**Hex codes can be pasted.** A native colour swatch has nowhere to type, so a
hex from a palette could be read but not entered. Each of the 57 swatches now
has a text field beside it, built in script rather than markup. It carries no
`data-var` — `collectStyles()` gathers every `[data-var]` on the page, and a
second element claiming the same key would race the swatch. The 3-digit short
form expands only on blur, since `2d7d4f` passes through `2d7` on the way.

**Route colours carry to the dispatcher.** The board kept its own copy of the
route list and the two had drifted — Valley Route was muted teal on the picker
and bright sky blue on the board. The copy is gone; it loads `routes.js` and
reads the saved `route-<id>` colour, the same key the picker reads. Each card
sets one `--route-color` and the stylesheet does the rest: top band, a wash
behind the header, stripe, progress bar, done count.

**Two bugs of mine, both from today.** `styles.js` opened its WebSocket at the
host root when the server mounts it at `/ws`, so the route picker's live style
updates never connected and retried every four seconds forever. And a chased
phantom worth recording: `getComputedStyle().backgroundColor` read through the
browser tool returned a stale value for the connection dot, which looked like
a CSS bug for several minutes. The rendered pixel was correct all along —
screenshot before trusting a computed-style read.

---

## 2026-09-18 (evening) — "the dispatcher settings aren't saving"

They were. Verified end to end: `collectStyles()` gathers all 19 `--dispatch-*`
keys, the Save button persists them, a reload reads them back. What was
actually happening is that the board keeps its **own** light/dark setting, so
editing the Light rows changes nothing visible while it is showing dark —
indistinguishable from a failed save.

Fix is in the editor, not the server: the preview now has Light / Dark buttons
when the dispatcher is selected, and the section says in words that the rows
only apply to the theme the board is in.

**"The header colours seem transparent."** `.route-card.off-day` was
`opacity: 0.45`. On a Friday that is six cards out of nine, and at 45% a solid
route colour reads as broken rather than inactive. Opacity on the card cannot
be countered on a child, so the fade moved off the card: the detail below the
header is faded, the header keeps its colour at full strength with a slight
desaturation.

**Navigation.** Driver route pages now carry a dispatcher button beside home,
plus the paint button (previously withheld from the route screen; asked for
explicitly). The dispatcher gained a link back to the routes.

---

## 2026-09-18 (night) — one top bar, and the error log earns its keep again

**Shared chrome.** The style editor had the only version of the top bar. It is
now `public/css/chrome.css`, carried by the route picker, a route, the
dispatcher board, the request queue, the error log, the notes page and the
editor. CSS and markup only — no script — because the error log and notes
pages set their own palettes and pulling the style system in just to draw a
bar would let the editor's inline variables override them. Four editable
colours where the style system is already loaded, fallbacks everywhere else.
The customer portal and payment page are deliberately excluded.

**The map crashed where Google has no traffic data — again.** Three places
summed a route's legs; I guarded exactly one of them in an earlier pass. The
error log caught the other two in production (Thursday Com/Eagle, Wednesday
Residential, three occurrences) with a clean stack. `duration_in_traffic` is
absent wherever Google has no traffic model, and `.value` on the missing
object throws and takes the callback with it — no estimate, no live reorder,
no reroute nudge, nothing visible.

`routeMinutes(legs, preferTraffic)` and `legSeconds(leg, preferTraffic)` now
back all four sites, including the Distance Matrix ETA, which was the last
direct `.value` read. **The lesson is the pattern, not the line:** fixing one
instance of a crash shape and not searching for its siblings is how this came
back. Grep for the shape before calling it fixed.

**Also:** the style button came off the route picker and route screen —
styling is the office's job, not the drivers' — leaving it on the dispatcher
board only.

---

## 2026-09-18 (late) — the driver's stop card

**Buttons.** 40×34 squares with only an emoji on them — under the size a gloved
thumb reliably hits, and no way to tell what they did without hovering for a
tooltip, which a phone does not have. Now `grid-template-columns:
repeat(auto-fit, minmax(96px, 1fr))`: two across on a 375px phone, four on an
iPad, each a full 58px touch target with the word on it. No breakpoints beyond
one guard for very narrow phones.

**The wording is a setting.** `report-<kind>-label` in the styles table drives
both the button text and what `report.js` writes into Driver Notes, so the
button cannot promise one thing and the sheet record another. The icon stays
fixed because `writeNote()` uses it to recognise and replace a previous report
on the same stop. Verified end to end: changed it in the editor, the driver
card showed it, restored it.

**Notes are append-only on that screen.** Tapping a note used to open it in a
textarea pre-filled with the existing text — one careless keystroke from wiping
what the office wrote. The note is read-only now; "✎ Add a note" opens an
*empty* box and appends with the same ` · ` separator the incident buttons
use. Trade-off worth naming: a driver can no longer fix their own typo from the
truck. The office can, in the sheet.

**A note you could not read.** `.note-info` took `--route-color-light` on
`--route-color-dark`. Those come from `routes.js` and on several routes sit a
few shades apart — Valley Route was #1c3a43 text on #2f6473. It has its own
`--note-bg`/`--note-text` pair now, editable beside urgent and hold. **Lesson:
deriving two colours that must contrast from one source colour cannot work.**
