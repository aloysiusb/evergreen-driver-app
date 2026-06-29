# Evergreen Driver App — Backend

Backend server for the compost route driver app. Reads/writes the route
Google Sheet, excludes financial/billing tabs and columns by design, and
broadcasts real-time updates to all connected drivers over WebSocket.

## Setup on Render

1. Push this folder to a GitHub repo (same pattern as wall-settings-server).
2. Create a new Web Service on Render, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. In Render's Environment tab, add these two variables:
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the *entire* contents of your
     service account JSON key file (the new one you generated after
     rotating the old one).
   - `ROUTE_SHEET_ID` — the ID from your route sheet's URL, the long
     string between `/d/` and `/edit` in
     `https://docs.google.com/spreadsheets/d/THIS_PART/edit`

Never commit the JSON key file itself to the repo. It only ever lives in
Render's environment variables.

## API

- `GET /api/tabs` — list of route-day tab names
- `GET /api/routes/:tabName` — parsed stops + sections for a tab
- `PATCH /api/routes/:tabName/stops/:rowNumber` — body `{ done: true }`
- `PATCH /api/routes/:tabName/stops/:rowNumber/notes` — body `{ notes: "..." }`
- `POST /api/notes-log` — body `{ driverName, tabName, accountName, text }`
- `POST /api/routes/:tabName/backup` — duplicates the tab as a dated backup
- `GET /health` — health check
- `WS /ws` — real-time broadcast of stop/note updates to all connected clients

## Security design

`src/config.js` is a whitelist, not a blacklist. Only the fields listed
in `ALLOWED_STOP_FIELDS` ever leave the server in an API response. Tabs
listed in `EXCLUDED_TABS` (New Customers, Container Circus, Customer
Movment, Schedule, Weeklies) are never readable through this API at all,
because they contain billing/financial fields.
