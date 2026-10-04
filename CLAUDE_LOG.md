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

---

## 2026-09-18 (last) — the bar everywhere, and buttons you can shape

**The top bar is editable on every page.** Its colours only reached pages that
load the style system; the error log and notes page deliberately do not, since
the editor's inline `:root` values would override their own palettes. The
server now writes just the bar's own settings into every page's `<head>` from
`stampAssets`' sibling — four colours plus the name and mark, the latter drawn
through `content: var(--appbar-name)` so they are editable on a page running
no script at all. Values are typed by a person, so `cssSafe()` strips anything
that could close the element or open a declaration. Cached; dropped on save.

**approval.html has no `</head>`** — never did. The first version of that
injection silently skipped the page because it looked for a closing tag that
was not there. Head closed, body opened.

**Incident buttons are fully style-driven**: fill, text, edge, corners,
height, icon size, text size, weight, style, gap, and `--report-btn-min-width`.
That last one is the interesting one — `repeat(auto-fit, minmax(var(...), 1fr))`
means the number across is a *consequence* of the width, not a breakpoint.
Verified 2 across at 375×812, and 4 at 812×375, 768×1024 and 1024×768.

**`needsPx()` nearly broke line spacing everywhere.** Adding
`endsWith('-height')` for `--report-btn-height` also captures `--line-height`,
a bare ratio that would have become `1.5px`. There is now a check that every
key `needsPx` claims holds a bare number — run it after touching that
function. **Suffix rules over a shared namespace catch more than you meant.**

---

## 2026-09-19 — the stop card, settled

**One note field.** The separate "Add a note" button is gone; the note itself
is the control. Tapping it opens an *empty* textarea and what is typed is
appended. The existing words are never loaded into that box — that is the whole
mechanism that keeps them uneditable, and it survives merging the two controls
into one. Bigger by default (13 → 15) with a "✎ Tap to add" hint.

**No per-stop Map button.** The Map tab lives in the sticky route header, which
is always on screen, so a second button on every card was noise. The capability
was kept rather than dropped: the address line is the link now.

**Round, muted, larger buttons.** Each of the four has its own fill
(`--report-bg-<kind>`) so they read by colour before the word. Height 88, gap
16, radius 36, icon 28, label 13.

**--report-btn-min-width was deliberately NOT raised.** It is what decides how
many sit across, and widening it drops an iPad from four to three, stranding
the fourth on its own row. "Bigger" here means taller and further apart. Counts
verified: 2 across at 375×812, 4 at 768×1024.

**Defaults in code do not move what is already stored.** All six size keys were
in the styles table at their old values, so the new defaults changed nothing on
screen until they were pushed. Any future default change needs the same
follow-up, or it is invisible.

---

## 2026-09-19 (cont.) — circles, and a link that did nothing

**The address link was dead.** Removing the 📍 Map button, I made the address
line the link with `target="_blank"`. A new tab is silently refused inside an
in-app browser and in the installed-app mode this app supports — which is
exactly how a driver opens it. No error, no tab, nothing. Reproduced it in the
browser before touching anything.

Two fixes: no `target`, so it navigates in place (on a phone the Maps app takes
over and leaves the page behind it), and the documented
`google.com/maps/search/?api=1&query=` URL instead of the legacy
`maps.google.com/?q=`, which is the form that actually hands off to the app.

**Buttons are solid circles now**, white type, no icons. `aspect-ratio: 1` with
a 50% radius ties height to whatever width the column works out to, so they
stay round at any size with nothing written down. Four muted solids, each
*measured* against white rather than picked by eye — 5.18, 4.97, 5.34, 6.06 to
1, all past AA.

`overflow-wrap: anywhere` split "Contamination" into "Contaminatio" + "n",
which reads as a bug. `hyphens: auto` with `break-word` as the fallback, plus
4px more room. **A circle is a hostile container for a long word — check the
longest label, not the shortest.**

The editor dropped corners, height, icon size and edge colour: a circle cannot
use them, and leaving dead controls in a panel is worse than having fewer.

---

## 2026-09-19 (cont.) — a demo the dispatcher can see

**The typing box was inheriting `--text`**, which on a pale card is a muted
grey — fine for a label, too faint to read what you are typing in a moving
truck. It has `--note-edit-text` of its own now, plus `--note-edit-height`, and
bigger defaults: 13 → 16, weight 400 → 500, box 64 → 96. Verified live:
`rgb(20,36,27)`, 16px, 500, 96px.

**A test drive now shows on the dispatcher board.** It never did, and the
reason was the safety feature: sim intercepts its own writes so the sheet
cannot be touched, so the server never broadcast anything. The screen you most
want to show someone during a demo was the one screen that stayed blank.

`/api/sim-event` broadcasts and does nothing else — it never opens the
spreadsheet. Messages are stamped `sim:true`; the board files them in the feed
tagged "Test drive" and **deliberately does not let them touch `routeState`**,
so the stop counts keep reporting what the sheet says. Verified end to end:
two simulated events appeared labelled, and the fleet count stayed 5 / 1401.

**The principle worth keeping:** when a safety measure hides something someone
needs to see, add a path that shows it without removing the safety — do not
weaken the original guard.

**Also fixed:** `/driver/tues-dv/?sim=1` (trailing slash) reported "Route not
found" because `split('/').pop()` returned the empty segment. `filter(Boolean)`.

---

## 2026-09-19 (cont.) — the drill-down

The stepped panel already existed and already asked exactly what was wanted —
contamination → what kind → 1 / 2 / 3+ bags. It was reachable only from the
"Add detail" button on the confirmation toast, which is easy to miss.

Added the one thing it had no room for: an optional typed box on the last step,
for the day the lists do not fit. Held in a variable, not read off the element
at submit — `renderStep()` rebuilds the panel's innerHTML and would throw the
text away on any re-render.

Restyled to match the circles that open it: options are pills (not circles —
"Recyclables mixed in" has to stay readable), the chosen one fills with the
colour of the report being filed, and the panel's own accents were still the
bright red/amber/blue defaults belonging to nothing else in the app.

Four fills taken darker: contrast with white went from ~5:1 to 7–8:1.

Verified end to end in sim:
`Testing · 🚫 Contamination: black trash bags ×2 · left of gate, third time this month`
— original note kept, the earlier one-tap marker replaced rather than stacked.

**Uncommitted-on-purpose note:** this entry is held back to ride along with the
next code commit rather than triggering a redeploy of its own.

---

## 2026-09-19 (cont.) — levels, and why photos fail

**Photo uploads are refused by Google, not by the app.** Tested the endpoint
directly with a 160-byte JPEG:

```
502 {"error":"Could not save the photo. Google Drive API has not been used in
project 404757106796 before or it is disabled."}
```

The Drive API is simply not enabled on the Cloud project. Code path is fine and
the failure surfaces correctly rather than claiming success. **If enabling it
reveals a second error about service-account storage quota, the fix is a Shared
Drive** — a file created by a service account inside a personal My Drive folder
is owned by that account, which has no quota of its own.

**Second and third levels are settings now.** `report-<kind>-l2` and `-l3`,
comma separated. A saved BLANK is honoured as "no level" — only an *absent*
setting falls back to the built-in list, otherwise clearing a level would
silently restore it. Verified live: set a third level for Overflow, walked
Severe → Left behind → `📦 Overflow: Severe · Left behind`, then cleared it.

**Per-report camera switch** (`report-<kind>-photo`): opens the camera once
that report is filed. Left OFF everywhere until Drive works — a camera that
cannot save is worse than no camera.

**The dispatcher shows the photo, not a link.** `webViewLink` opens a viewer
page, useless in a feed; `drive.google.com/thumbnail?id=…` serves the image and
honours the same folder permissions, so it loads for anyone who can see the
folder and quietly fails for anyone who cannot. Link kept underneath.

---

## 2026-09-19 — photos actually work now

Enabling the Drive API revealed the real wall: **"Service Accounts do not have
storage quota."** A service account cannot own a file inside a person's Drive
folder. The documented ways round it — a Shared Drive, or domain-wide
delegation — both need Workspace and an administrator.

So photos go to the app's own 1 GB persistent disk (`/data/photos`) and are
served back by `GET /photos/:name`. Nothing to configure. Drive is still tried
first where `PHOTOS_FOLDER_ID` is set, and `drive.js` gained
**`supportsAllDrives: true`** — without which a Shared Drive would have been
refused too, even after someone went to the trouble of creating one.

Guards: served names must match the exact shape this app generates
(`<13 digits>-<6 chars>.jpg|webp`), so no path can be talked into pointing
elsewhere; oldest photos are pruned past 700 MB rather than letting a full disk
take the database down with it.

**Three failures found by testing, in order — each one hid the next:**

1. The link came back `http://`. Render terminates TLS, so `req.protocol` lies
   without `app.set("trust proxy", 1)`. An http image in an https page is mixed
   content and would have been blocked outright.
2. The sim branch on the dispatcher built its feed entry by hand and never
   extracted the photo link, so demonstrating the camera showed text and
   nothing to look at.
3. `loading="lazy"` never triggered inside the feed's own scrolling area — the
   image laid out as a 2px sliver and was never fetched.

**Worth keeping:** before blaming the renderer I fetched the URL by hand and
decoded it — 200, `image/jpeg`, 480×320. That ruled out storage, serving and
the file itself in one step, and left only the `<img>`. My first test fixture
was a hand-made "JPEG" that was structurally complete but would not decode;
generating one through `canvas.toBlob` — the same path the camera uses — was
both a valid fixture and a truer test.

---

## 2026-09-20 — the "Photos per Notes" column, and a write that went wrong

**What it does.** The column is added to a tab the first time a photo is taken
on it, and the link is written into it as the photo lands. Links accumulate in
the cell — several photos of one stop is normal.

**I wrote into the wrong column, on the live sheet.** The first version worked
out where to put the heading by re-reading the header row and counting used
cells. That read came back empty, so column A — the blank leading cell these
sheets keep — looked like "the first free column". It wrote the heading into
**A1**, then links into **A6** and **A9** on Tues DV.

Three things came out of it:

1. **Placement no longer does its own read.** It uses `headerWidth` from the
   header the rest of the app already trusts, floored at one past the rightmost
   known data column, so it cannot land on or before the data whatever a read
   returns.
2. **It heals.** A heading found to the LEFT of the data is not a photos
   column: it is cleared and a proper one placed.
3. **`POST /api/photos/tidy`** clears stray links precisely — only cells whose
   ENTIRE contents are links of the exact shape this app generates, never the
   real photos column. Ran it: `cleared: ["A6","A9"]`.

**The diagnostic was blind.** `/api/sheet-check` read **A to H**. The column
this app adds lands at **I**, so the one tool meant for checking columns could
not show it — and I spent a cycle hunting a failed write that had succeeded.
It reads to N now. **A checking tool whose range is narrower than the thing it
checks is worse than no tool: it reports absence as fact.**

**Also added** `?debug=1` on `/api/photo`, which waits for the sheet write and
returns its outcome. The write is fire-and-forget so a slow spreadsheet never
leaves a driver waiting — the cost is that failures only reach the server log,
where I cannot see them.

---

## 2026-09-20 — notes rewritten for the demo, and a finding

**The note no longer carries the URL.** It reads "📷 Photo"; the link lives in
the "Photos per Notes" column. The board stopped digging links out of note text
— the server announces `photo-added` the moment the photo is saved, *before*
the spreadsheet write, because the picture is real either way and a failed
column write should not also cost the office the photo.

Verified the whole path: driver page in sim → note "📷 Photo", toast "Photo
saved", write intercepted (sheet untouched) while the photo still landed in
column **I** and appeared on the board at 400×300 with customer and address.

**The write-up gained two sections.** "Trying it yourself" — the `?sim=1`
address, driving, filing an incident, cutting the signal, watching the board
alongside. And "What's next — customers through the website".

**The finding worth carrying forward:** `REQUEST_KINDS` includes
`new_customer`, the approval screen filters for it, and approving one appends
the customer to the route sheet — all built, all working. But `portal.html`
only ever sends `hold`, `missed` and `update`. **There is no "start service"
form, so nothing of the new-customer path is ever exercised.** One form is the
whole remaining gap between the website and a driver's screen.

Also corrected in the notes: they claimed photos go to EverGreen's Drive
folder. Google refused that arrangement; they are on the app's disk.

---

## 2026-09-20 — access code on, and the demo material caught up

**The gate is live** and behaves correctly: `/`, `/dispatch`, `/admin` and the
route API all 401; `/walkthrough`, `/portal`, `/pay`, `/updates` and now
`/pitch` stay open. Drivers enter a code once per device.

**The denied page had no input.** It explained that the link should end in
`?c=…`, which is useless to anyone holding the code but not the link. It has a
box now; it just puts the code in the URL where the gate already knows how to
read it. Nothing is validated there — that page is served *because* the code
was wrong, so it cannot tell a good one from a bad one.

**`/photos/` is public, deliberately.** A link written into the route sheet
answered 401, which made the column decorative. Reading a photo needs no code;
uploading still does. There is no listing endpoint and names are a millisecond
timestamp plus six random characters, so a link must be deliberately passed on
before it reaches anyone.

**The board showed every draft of a note** — "Contamination", then
"Contamination: 3+ bags", then the same plus a photo — five entries for one
bin. Entries now merge on stop + kind within fifteen minutes. Marking a stop
done stays separate on purpose: it is not an edit of the incident report.

**`/health` reports `sheet: {configured, tabsExpected, tabsReadable}`** —
counts only, no id or names — because with the gate on there was otherwise no
way to check the wiring without unlocking the whole app. It read 7 of 9 after
the sheet was switched: **two tabs still unresolved, worth chasing.**

**The presentation was years behind the app** and listed built features as
future opportunities. Corrected, and made public — a presentation that needs an
access code is not one you can show anybody.

---

## 2026-09-20 — all nine routes read

Two tabs were unreadable after the sheet switch, which meant writes to them
were refused — silently from the office's side.

**Thursday COM/EAGLE** — the sheet spells it with a slash; config did not.
Fixed in config rather than by renaming the tab: renaming risks whatever
formulas the office already points at it, and the app is the thing that should
bend.

**Friday** — its address column had **no heading**. The addresses were sitting
there in plain sight, and the app refused the whole tab because it finds
columns by name on purpose. Guessing by position is what destroyed three
addresses in July.

So `/api/sheet-heading` names an unlabelled column and **refuses to overwrite**
one that already has text. Named Friday's C1 "Address"; the tab went from
unreadable to 80 stops immediately.

**Now 9 of 9, 1,476 stops, every one with an address.**

Two diagnostics earned their place on the way:

- The sheet checker was sampling **three tabs of nine**, so the one tool meant
  for diagnosing this could not see either broken tab. It covers all of them
  now and takes `?tab=`.
- `/health` names the failing tabs and which heading is missing, rather than
  reporting "7 of 9". **A count tells you something is wrong and nothing about
  what.**

The dispatcher board now shows a banner naming any route it cannot write to,
rechecked every ten minutes — the failure was otherwise invisible until a
driver said their work had vanished.

**ACCESS_CODE is currently OFF** for testing and must go back on.

---

## 2026-09-20 (late) — the board remembers the day

The feed lived only in the browser: reloading at three in the afternoon meant
the morning had never happened, on the one screen the office is asked to leave
open all day.

`src/activity.js` records every broadcast worth keeping — **inside
`broadcast()` rather than at each call site**, so a message added later cannot
be forgotten; the live feed and the record are fed by the same line and cannot
drift. Replay goes through the **same handler** as a live message, because two
paths would drift and the replayed one is what nobody would notice breaking.

Entries keep the time they happened, so the morning does not read as "just
now". Simulated events are deliberately not recorded — a demonstration should
vanish on reload rather than become part of the day's record. Kept seven days,
pruned at startup.

A day picker shows any of the last seven. While a past day is on screen it is
labelled, and live events are kept out of the list; the route cards go on
updating, since those show the sheet as it is.

**Found on the way:** `parseIncidents` read only the FIRST character of a note
to decide whether it was an incident. Notes are a line of history — "Gate code
1234 · 🚫 Contamination: 2 bags" — so on any stop the office had already
written on, the card said "No incidents" while the sheet plainly had some.

Verified: a done-tick on a stop with no note records and replays; a real note
survives a full reload with customer, address and original time; a sim event
shows live and leaves nothing behind.

---

## 2026-09-26 — the portal asks which house

Three of the four portal forms — hold, missed pickup, account update — asked
for a name and an email and nothing else. The request reached the queue, so
from the customer's side it worked; from the office's side it was a name with
no stop attached. Every one of them started with a reply asking where they
live.

`validateRequest` already accepted `address` and `phone`, and already required
the address only for a new customer. The gap was entirely in the form. All
three now ask for the **service address** (required client-side, with a
message that says why) and a phone number (optional).

Two date inputs — the missed-pickup date and the update's effective date — had
**no `id` and were read by nothing**. A customer could type the day they were
missed and it went nowhere. Both are wired into the request's detail line now.

**On the approval screen**, `detailText()` showed the address *instead of* the
detail, which was right when only a new customer had one. Now that a hold
carries both, the address gets its own line, suppressed when it would just
repeat the detail — so a new customer's card does not print it twice.

Also: `portal.html` ended with `</body></html>` twice.

---

## 2026-09-26 — the evening digest

The pitch has promised this for a while: notes are stored in real time, "this
can be extended to a daily summary that emails Alyssa each evening — what was
skipped, what needs follow-up, what complaints came in". The storing half was
built. This is the other half.

`src/digest.js` builds it from **what the day already recorded** — `activity`
and the requests table — rather than re-reading the sheet, so the email cannot
disagree with what the board showed. It writes nothing, so a failed digest
cannot damage a day's work.

Three things it deliberately does not do:

- **A tick then an un-tick is not two collections.** The last state of each
  stop wins, so a driver fixing a mis-tap does not inflate the count.
- **An edited note is one situation, not two.** Only the last note on a stop
  is reported, and clearing a note removes it.
- **Urgency is not re-derived.** It reports the `noteUrgency` the note was
  already classified with, so the digest and the board cannot drift.

**Timezone.** `todaysActivity()` decides the day with `setHours()`, which is
the *server's* midnight — on Render that is UTC, so "today" ends at 6pm in the
valley and an evening digest would report a day that had not finished.
`activityBetween()` takes an explicit window and `localDayStart()` works out
the valley's own midnight through `Intl`, so it survives daylight saving
rather than assuming −7.

**The timer checks every minute against the valley's clock** rather than
sleeping 24 hours. Render restarts the process on every deploy, and a long
`setTimeout` would be discarded each time — on a busy week the digest would
simply never fire. A restart at 6:05pm still sends today's, and the local date
is recorded before the send so it cannot go twice.

Sent from the web process, not a Render cron job: the digest reads the SQLite
file on the persistent disk, and a cron job is a separate container without it
mounted.

**`sendMail()`** — `notifyNewRequest` and `sendConfirmation` had each grown
their own copy of the Resend fetch. A third would have been the point where
they start to differ. One call site now.

**`/api/requests-settings` existed from the first release and no screen ever
called it**, so the notify address could only be changed with curl. The digest
would have inherited exactly that, so `approval.html` now has a strip: on/off,
the hour, who it goes to, Preview, and Send now. "Send now" reports `ok:false`
as *not sent, and why* — reporting "sent" for mail nobody receives is the
failure this codebase keeps having to dig out.

`digest_hour` needed its own branch in `setSettings`: the existing `"1"`/`"0"`
coercion would have turned 18 into `"0"` and quietly moved the digest to
midnight.

**Not built, because it already was:** `start.html` is a complete new-customer
signup posting `kind: 'new_customer'`, and `portal.html` already links to it.

**Still outstanding:** `ACCESS_CODE` is off, and QuickBooks is waiting on
Alyssa authorizing the OAuth connection — neither is a code change.

---

## 2026-09-26 — handoff: where the automation work stands

Read this with the two entries above it. Everything below is merged to `main`
(PRs #5 and #6); nothing is in flight.

### Working, and needing nothing

- **Customer portal** (`portal.html`) — hold, missed pickup, account update.
  All three collect the service address now, so a request can be matched to a
  stop without emailing the customer back.
- **New-customer signup** (`start.html`) — complete, posts
  `kind: 'new_customer'`, linked from the portal. It is easy to mistake this
  for unbuilt because the portal's four tabs are all for existing customers;
  it is a separate page and it works.
- **Request queue** (`approval.html`) — approve a new customer onto a route
  tab; a hold/missed/update approves as "handled" without touching the sheet.
- **Evening digest** (`src/digest.js`) — built, merged, and **not sending**,
  for the reason below.

### Blocked on configuration, not code

None of these three are worth writing code for. A session that "fixes" them in
code is solving the wrong problem.

1. **The digest sends nothing until Render has `RESEND_API_KEY`.** Without it
   the digest logs what it *would* send and reports `"email not configured"`.
   With the key but no `REQUESTS_FROM_EMAIL`, the only address that can
   receive is the notify address itself (Resend's sandbox sender) — that is
   the deliberate "practice" path in `sendConfirmation`, not a bug. A verified
   sending domain in `REQUESTS_FROM_EMAIL` is what makes it reach customers.
   Preview and Send now on `approval.html` both work before any of that, and
   a refused send says why rather than claiming success.

2. **`ACCESS_CODE` is OFF deliberately, not by oversight.** Earlier entries say
   it "must go back on", which is still true — but the owner's decision on
   2026-09-26 was to wait: **the drivers do not have the code yet.** Turning
   the gate on before they do takes every driver's route away mid-day. Do not
   flip it to tidy up a stale-looking note; it is a rollout step, and the
   owner owns the timing.

3. **QuickBooks is waiting on a human.** `src/qbo.js` and the pay flow are
   built. Alyssa has to click through the OAuth approval at `/qbo/auth`. There
   is nothing to implement until she has.

### Two things worth knowing before touching this code

- **`todaysActivity()` decides the day with the SERVER's midnight**, which on
  Render is UTC. `digest.js` does not use it for that reason — it uses
  `activityBetween()` with a window from `localDayStart()`. Anything else that
  needs "today" in the valley's terms should do the same, not call
  `todaysActivity()`.
- **`setSettings()` coerces every value to `"1"`/`"0"`** except the keys with
  their own branch (`notify_email`, `digest_hour`). A new non-boolean setting
  needs its own branch or it will silently store `"0"`.

---

## 2026-09-26 — the other session: error messages, the signup form, and phones

Written from the session that pushed PRs #1–#4, to sit beside the handoff
entry above. Everything here is merged to `main`; nothing is in flight.

### One correction to the handoff above

**`RESEND_API_KEY` is set, and the digest is sending.** The entry above says
the digest "sends nothing until Render has `RESEND_API_KEY`". That was true
when it was written and is not true now. The 04:26 boot on 2026-09-26 logged:

    [digest] sent to perryaloysius@gmail.com

`server.js` only reaches that line *after* `sendMail()` resolves, and only
when the key is present — without it the branch above logs `would send to`
and returns `"email not configured"`. So the mail went out. `REQUESTS_FROM_EMAIL`
is still the thing standing between this and customers receiving anything;
that half of the note holds.

### What PRs #1–#4 changed

- **The driver was shown `HTTP 500`** while the server had already explained
  the cause. `driver.js` threw the status code away. It reads the server's
  message now, the way `camera.js` already did on upload. The other two
  `HTTP ' + res.status` throws in that file are deliberately left: their catch
  discards the error and retries offline, so nobody ever reads the text.
- **`demo.html`, `streetview.html` and `weekly.html` asked Google for
  `?key=undefined`.** They guarded the maps key with a bare try/catch, and
  `fetch` does not reject on a 404 — the error body parsed as JSON, `.key`
  came back undefined, and the catch never ran. They check `res.ok` and a
  present key now, as `map.js` and `walkthrough.html` already did.
- **`start.html`** — the new-customer signup form, and `/start.html` added to
  `PUBLIC_PAGES`. (The handoff above is right that this is easy to miss.)
- **The dispatch board carries an Approvals count**, re-read from
  `/api/requests` rather than counted locally, because a request can be
  decided from another laptop or while the screen slept.
- **A favicon**, because `/favicon.ico` was answering 401 and putting a red
  error in every page's console.

### QuickBooks: what is built, and what has never run

`ensureCustomer()` and `createInvoice()` exist in `src/qbo.js`, and approving
a new customer **with a price** creates the customer, raises the first invoice,
fetches the pay link and stores all three on the request.

**The contract, which matters if you touch the approve handler:**
QuickBooks runs *after* `decideRequest` has committed and the response has
been sent — never before. The click has already done the thing that counts,
and an Intuit outage must not undo it or make Alyssa click twice. Every
failure is caught into `qbo_error`, which the approval card renders as
"Not invoiced" with the reason. Six columns were added to `requests` for
this: `qbo_customer_id`, `qbo_invoice_id`, `qbo_pay_link`, `qbo_error`,
`plan_amount`, `plan_label`.

**It has never been called against Intuit.** There are no `QBO_*` credentials
in any environment this session could reach, so no request has ever been made.
22 unit tests cover `isConfigured`, amount validation, the nameless-customer
guard and the `recordQbo` round trip — including that a QBO failure leaves
`status` approved and `decided_tab` intact. None of that exercises the v3 API.
The request and response shapes follow the docs and are unverified. Worth a
sandbox run (`QBO_SANDBOX=true`) before it touches a real customer.

### Phones: an invariant, and the trap that broke it

All 23 pages were measured at 320px and 390px. **No page scrolls sideways.**
Three did: `portal.html` 341px, `streetview.html` 331px, `updates.html` 325px.

**The trap worth knowing about**, because it will happen again:
`walkthrough.html` had a correct `@media (max-width: 760px)` block that did
**nothing**. It sat at line 41, above `.phone`, `.screen`, `.wt-stage` and
`.wt-rail` — same specificity, earlier in the file, so the desktop rules won.
The page looked responsive in the source and was 797px wide on a 390px phone.
The block now lives at the end of that stylesheet and must stay there. **Any
rule added below it silently re-breaks the page.**

The same shape caused two of the three overflows: a grid or flex item will not
shrink below its own min-content unless told to, so one `nowrap` chip or one
`flex-shrink: 0` rail widens the track, the grid, and then the page.
`minmax(0, 1fr)` and `min-width: 0` are the fix, not a new breakpoint.

Tap targets are 44px on the pages someone holds a phone to use — `demo`,
`walkthrough`, `portal`, the dispatch Approvals link. Deliberately not
`admin.html` (208 dense inputs, a desktop tool) or links inside sentences.
Anything inside `.screen` on the walkthrough is exempt: that is the simulated
app, drawn at the app's own metrics and already `pointer-events: none`.

### On `ACCESS_CODE`

The handoff above has this right and it is worth repeating: **off is a
decision, not an oversight.** The owner is demonstrating the app as part of a
proposal and cannot be locked out of it mid-pitch. Do not turn it on to tidy
a stale-looking note. When it does go back on, the link needs to carry the
code — `?c=…` — because the last time it was on, the code only ever travelled
inside a text message and the owner could not open his own app once the
message scrolled away.

---

## 2026-09-30 → 2026-10-04 — four reported faults, a $207 bill, and three corrections to one paragraph

Nothing was logged here between 26 September and this entry, so this covers
everything in between. **The log going unwritten for nine days is itself the
finding**: the geocoding work below would have been caught sooner by a session
that read its own history, and the stale brief claim in the last section would
not have survived to reach the client. Append after each session.

A standing handoff now lives in **`CARRYOVER.md`** at the repo root. It
describes the present and is meant to be edited in place; this file stays a
history and only grows. Read both.

### Four things reported in one message, fixed as PR #39

**The directions and conditions floated over the compass.** The map's bottom
padding was adding three strips together — geo chip, hazard strip, dock — so
with all three on screen it reserved far more room than any one of them needed,
and with the geo chip unmeasured it reserved too little. It is now a `max()` of
the three, and `public/js/map-dock.js` measures the geo chip live through a
`ResizeObserver` plus resize, orientationchange and `fonts.ready`. The
clearance follows the tallest thing actually drawn instead of a guess.

**The dispatch incident cards said only a name.** "Grace Oliphant", with no
indication that the alert was *contamination* — the dispatcher could see who
but not what. The chip now reads icon, then what happened, then `· who`, and is
set `flex: 0 0 auto` so a long name cannot squeeze the kind out.

**The day's feed is ruled like a spreadsheet**, which is how it was asked for:
alternating subtle stripes on `:nth-child(even)` through a `--d-stripe` token,
each row clamped to two lines with `-webkit-line-clamp` and expanding on click
or keyboard. Handlers are delegated, so rows arriving over the socket work
without rebinding.

**The dark board was near-black and has been lifted** through `#18231b` /
`#26352a` / `#3a4d3f` with `#e8f1ea` text. Worth knowing: this was changed in
`DEFAULT_STYLES` in `src/db.js`, because the stored defaults are the real
source and the CSS fallbacks only apply when nothing is saved. **Editing the
CSS alone looks like it did nothing** — a wasted pass before working that out.

### "The routes are not loading" — PR #40

Diagnosed from a screenshot taken for an unrelated purpose. The driver page
opens on the Map tab. When the Google Maps script failed to load, the page sat
on "Loading map…" indefinitely and **the stop list was behind a tab nobody
thought to press.** So a billing problem on one API presented as the whole app
being dead, to a driver standing at a truck.

`mapUnavailable(why)` now falls back to the stop list once, says why, and offers
a retry; `initMap()` wraps the script load in try/catch and throws early when
there is no key at all. The driver always has their round.

**The test for this is the reason to trust it**: it includes a control case
where the map loads successfully, proving the fallback does not fire when it
shouldn't. Three earlier versions of that test passed while exercising nothing,
because the stubbed `google.maps` object was missing `TrafficLayer`,
`addListener` and `DirectionsRenderer` — which looks exactly like success.

### The $207 September bill — PRs #41 through #44

The owner was charged $207.21 for September. One mistake, made three times: **a
billed call inside something that repeats, with nothing remembering the
answer.**

**I diagnosed it wrong first.** I blamed Distance Matrix and began optimising
it. The actual usage report said **Geocoding, 11,542 calls** — on a round of a
couple of hundred addresses that had not moved. Worth recording because the
wrong answer was confident and plausible, and reading the report took a minute.

- **#41 — ETA.** `fetchNextEta` was firing on effectively every GPS fix. Now
  gated by `ETA_MIN_REFETCH_MS` (3 minutes) and `ETA_MIN_MOVE_M` (200 m).
- **#42 — Geocoding.** Every stop was geocoded on every map open: fifty stops
  is fifty billed lookups, again on the next open, again for the next driver,
  again on every test drive. Added `src/geocache.js`; `geocodeAndPlot()` now
  asks `GET /api/geocodes` what is already known and only geocodes the misses,
  posting new ones back.
- **#43 — Policy.** `CLAUDE.md` gained a *"Paid APIs: answer this before
  shipping anything that calls one"* section — four questions mandatory in the
  PR body. Test drives (`?sim=1`) now route to `GOOGLE_MAPS_API_KEY_DEV` when
  it is set, so simulating a route stops spending the fleet's quota.
- **#44 — Standard tier, and an expiry.** Removed every `drivingOptions` /
  `trafficModel` (five sites) and `optimizeWaypoints`, and dropped
  `libraries=places` from the script URL. All three push requests out of the
  standard tier.

**The auto-reroute watcher was deleted outright** — 3,419 characters of it. A
three-minute timer calling a premium-tier route API, running all night with
nobody driving. That one could not be optimised into acceptability. There is a
comment block in `public/js/map.js` saying so, because the obvious instinct is
to add it back.

Then the claim was checked rather than asserted: every timer in the codebase
was read, and **no timer anywhere can now reach Google.** Every billed call is
triggered by a person or a moving truck.

**Two things about the cache worth passing on.** First, it had **no expiry**
when first written — rows kept forever, which is very likely a breach of the
Maps Platform terms, and it was caught only because Google's support engineer
asked what was being stored. In the middle of asking Google for a goodwill
credit. It now ages out at 30 days with a daily sweep, and the comment in
`geocache.js` says the limit is a terms decision and not a performance one, so
nobody removes it as an optimisation. Second, **Cloud quotas are per-API
per-project, not per-key** — a dev key in the same project shares the
production quota, so the #43 split only half works until that is checked.

### Brief two, and three corrections to one paragraph

Brief two was written on 30 September — a thorough account of the app as it
stands, plus the automation pages and how to review them — and a self-contained
copy is hosted on the `vpayson` portfolio site with four explanatory figures.
That copy carries **no reference to Claude**, by request; note that the server
appends an attribution footer to PR bodies on its own, and it had to be
stripped.

Then the same paragraph was wrong three times, each time from writing about the
state of something without checking it.

**One.** Brief one, on 20 September, named the missing start-service form as
"the whole remaining gap between someone finding you online and their bin
appearing on a driver's screen." True that day. **The form was built four days
later** — `675fb95`, "a start service form, so the website can reach a route" —
and the sentence was carried into brief two on the 30th unchecked. So a
document written to be sent to the client told her a thing was missing **that
she had already paid to have built**, and pointed her at the wrong next step.
Verified before changing anything by posting `start.html`'s exact payload to a
running server: `{"ok":true,"id":"REQ-9EF7C405"}`, and the queue then held one
pending `new_customer` with every field intact.

**Two.** The correction replaced that with a different wrong claim — a known
limit saying the office might not be told when a request arrives, written
because the mail configuration was not visible from here. It is configured. The
notification sends, and had all along. Retracted.

**Three.** The retraction reached both copies of brief two **and nowhere else.**
`pitch.html` and `updates.html` went on saying a request could wait "silently
in the queue" until the mail service was configured. Found by reading the diff
of the still-open pull request rather than by anyone hitting it. **When
correcting a client-facing claim, grep for it across all four pages and the
portfolio copy.**

Brief one is **not** rewritten. It carries a dated note saying the form has
since been built, above its original text, because a brief records what was
known on a day.

**What the briefs say now:** the path runs form → queue → approval → route
sheet, the office is emailed when a request lands, and one real gap remains —
**Evergreen's public website does not link to `/start`.** The machinery has no
front door.

**And one trap that was written down nowhere.** Request emails go through
Resend's shared sandbox sender unless `REQUESTS_FROM_EMAIL` names a verified
domain, and that sender generally only delivers to the address the account was
registered with. Changing `notify_email` on the Approvals page to a shared
office inbox would stop the emails arriving, with nothing on screen to say so.
Related: **`notifyNewRequest` returns silently** when notifications are off or
the address is blank — no log line at all; only the missing-API-key branch
logs. The quietest of the three ways it can fail to send.

### On `ACCESS_CODE`

Still off, still deliberate, still confirmed by the owner in this session in
plain terms. The previous two entries have this right. Do not turn it on
unasked.

### Credentials

The owner pasted a Maps API key, a sheet ID and a full service-account private
key into the conversation while debugging, and offered Google account access.
The account access was declined — reading a usage report and fixing a billing
pattern needs none of it, and holding it would have widened the blast radius of
any mistake for no gain. **None of the pasted secrets were written to either
repo.** The service-account key should be rotated; the owner has agreed to.
