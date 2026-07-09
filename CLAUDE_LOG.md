# Claude Session Log

Append a dated entry after each session. Most recent first.

---

## 2026-07-09

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
