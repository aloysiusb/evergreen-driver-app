# Claude Session Log

Append a dated entry after each session. Most recent first.

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
