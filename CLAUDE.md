# Evergreen Driver App — Claude context

**Before doing anything else, read `CLAUDE_LOG.md`.** It's a running log every Claude session appends to — check it first for prior context, then add a dated entry after making changes.

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
public/
  index.html      — Route grid (tap a route to open it)
  driver.html     — Driver view: stop list, done toggles, notes
  admin.html      — Style editor: color pickers, sliders, Push button to broadcast styles live
  css/app.css     — Shared styles
  js/routes.js    — Route definitions
  js/driver.js    — Driver page logic
data/
  .gitkeep        — Keeps data/ in git; app.db lives here (gitignored, created at runtime)
```

## Architecture notes

- **Google credentials** — service account key is ONLY in Render's environment variables as `GOOGLE_SERVICE_ACCOUNT_KEY` (full JSON). Never committed to git. `sheets.js` reads it from `process.env`.
- **Column whitelist** — `config.js` is a strict allowlist. Billing/financial columns are never exposed to the driver API even if new columns are added to the sheet.
- **WebSocket broadcast** — all connected clients get real-time updates for stop toggles, note edits, and style changes.
- **Style system** — `src/db.js` stores CSS custom property values in SQLite. `/api/styles` GET/POST/reset. Admin page at `/admin.html` pushes changes to all drivers via WebSocket `style-updated` message.
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

## Known deviations from portfolio standard

- **Node.js, not Python** — predates the Python backend standard. Working production app; don't rewrite without asking Virginia.

## Node version

Requires Node 22+ (for `node:sqlite` built-in). `render.yaml` sets `NODE_VERSION: 22`.
