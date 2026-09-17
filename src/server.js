// server.js
import express from "express";
import cors from "cors";
import compression from "compression";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { readRange, readRangeWithColors, writeRange, appendRows, duplicateSheet } from "./sheets.js";
import { parseRouteTab, classifyNote } from "./routeParser.js";
import { ROUTE_DAY_TABS, ROUTE_COLUMNS, EXCLUDED_TABS, NOTES_TAB } from "./config.js";
import { getStyles, setStyles, DEFAULT_STYLES } from "./db.js";
import { getAuthUrl, exchangeCodeForTokens, findCustomerByEmail, findOpenInvoiceForCustomer, getInvoicePaymentLink } from "./qbo.js";
import { mountGate } from "./gate.js";
import { recordError, listErrors, errorSummary, clearErrors } from "./errors.js";
import {
  validateRequest, createRequest, listRequests, getRequest,
  decideRequest, countByStatus, rateLimited,
  getSettings, setSettings,
} from "./requests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());

// Shared access code. Must be mounted before any route or static file, so
// nothing is reachable without it. No-ops if ACCESS_CODE is unset.
mountGate(app);

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.ROUTE_SHEET_ID;

if (!SPREADSHEET_ID) {
  console.warn(
    "WARNING: ROUTE_SHEET_ID env var is not set. Set it in Render to the " +
    "spreadsheet ID from your route sheet's URL."
  );
}

function assertAllowedTab(tabName) {
  if (EXCLUDED_TABS.includes(tabName)) {
    throw Object.assign(
      new Error(`Tab "${tabName}" is not exposed to the driver app.`),
      { status: 403 }
    );
  }
  if (!ROUTE_DAY_TABS.includes(tabName)) {
    throw Object.assign(new Error(`Unknown tab "${tabName}".`), { status: 404 });
  }
}

// --- REST routes ---------------------------------------------------------

app.get("/api/tabs", (req, res) => {
  res.json({ tabs: ROUTE_DAY_TABS });
});

app.get("/api/routes/:tabName", async (req, res) => {
  try {
    const { tabName } = req.params;
    assertAllowedTab(tabName);

    const range = `'${tabName}'!A1:H1000`;
    const rawRows = await readRangeWithColors(SPREADSHEET_ID, range);
    const { items, routeDate } = parseRouteTab(rawRows);

    const withUrgency = items.map((item) =>
      item.isSectionHeader
        ? item
        : { ...item, noteUrgency: classifyNote(item.notes) }
    );

    res.json({ tabName, routeDate, items: withUrgency });
  } catch (err) {
    console.error(`[routes/${req.params.tabName}] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Toggle a single stop's done status. Body: { done: true|false }
app.patch("/api/routes/:tabName/stops/:rowNumber", async (req, res) => {
  try {
    const { tabName, rowNumber } = req.params;
    const { done } = req.body;
    assertAllowedTab(tabName);

    if (typeof done !== "boolean") {
      return res.status(400).json({ error: "Body must include boolean 'done'." });
    }

    const cell = `'${tabName}'!${ROUTE_COLUMNS.doneCol}${rowNumber}`;
    await writeRange(SPREADSHEET_ID, cell, [[done ? "TRUE" : "FALSE"]]);

    broadcast({
      type: "stop-updated",
      tabName,
      rowNumber: Number(rowNumber),
      done,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update a stop's driver note text. Body: { notes: "..." }
app.patch("/api/routes/:tabName/stops/:rowNumber/notes", async (req, res) => {
  try {
    const { tabName, rowNumber } = req.params;
    const { notes } = req.body;
    assertAllowedTab(tabName);

    if (typeof notes !== "string") {
      return res.status(400).json({ error: "Body must include string 'notes'." });
    }

    const cell = `'${tabName}'!${ROUTE_COLUMNS.notesCol}${rowNumber}`;
    await writeRange(SPREADSHEET_ID, cell, [[notes]]);

    broadcast({
      type: "note-updated",
      tabName,
      rowNumber: Number(rowNumber),
      notes,
      noteUrgency: classifyNote(notes),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Append a free-form note to the dedicated notes log tab.
// Body: { driverName, tabName, accountName, text }
app.post("/api/notes-log", async (req, res) => {
  try {
    const { driverName, tabName, accountName, text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Note text is required." });
    }

    const timestamp = new Date().toISOString();
    const row = [[timestamp, driverName || "", tabName || "", accountName || "", text]];
    await appendRows(SPREADSHEET_ID, `'${NOTES_TAB}'!A1`, row);

    broadcast({ type: "notes-log-entry", driverName, tabName, accountName, text, timestamp });

    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Create today's backup snapshot of a route tab before drivers start.
app.post("/api/routes/:tabName/backup", async (req, res) => {
  try {
    const { tabName } = req.params;
    assertAllowedTab(tabName);

    const dateStr = new Date().toISOString().slice(0, 10);
    const newTitle = `${tabName} backup ${dateStr}`;
    const result = await duplicateSheet(SPREADSHEET_ID, tabName, newTitle);

    res.json({ ok: true, newTitle, result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// --- Maps config ---------------------------------------------------------

app.get("/api/maps-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(404).json({ error: "Maps key not configured" });
  res.json({ key });
});

// --- Style API -----------------------------------------------------------

app.get("/api/styles", (req, res) => {
  res.json(getStyles());
});

app.post("/api/styles", (req, res) => {
  const styles = setStyles(req.body);
  broadcast({ type: "style-updated", styles });
  res.json(styles);
});

app.post("/api/styles/reset", (req, res) => {
  const styles = setStyles(DEFAULT_STYLES);
  broadcast({ type: "style-updated", styles });
  res.json(styles);
});

// --- QuickBooks OAuth setup routes (one-time, run by Alyssa) ---------------

// Step 1: Visit this URL in the browser to start the OAuth flow.
app.get("/qbo/auth", (req, res) => {
  if (!process.env.QBO_CLIENT_ID) {
    return res.status(500).send("QBO_CLIENT_ID not set in Render environment.");
  }
  const url = getAuthUrl();
  console.log("[qbo/auth] Redirecting to:", url);
  res.redirect(url);
});


// Step 2: Intuit redirects here after Alyssa approves.
// Tokens are printed to logs — copy them into Render env vars.
app.get("/qbo/callback", async (req, res) => {
  try {
    const tokens = await exchangeCodeForTokens(req.url);
    // The refresh token is a live credential for Alyssa's accounting, so it is
    // shown once here in the browser and never written to the Render logs —
    // logs persist and are readable by anyone with dashboard access.
    console.log("[qbo/callback] OAuth complete. Token shown in browser only.");
    res.send(`
      <h2>QuickBooks connected</h2>
      <p>Copy these into Render's environment variables now. They are not
         written to the logs, so this page is the only place they appear.</p>
      <pre style="background:#f4f6f4;padding:1rem;border-radius:6px;word-break:break-all;white-space:pre-wrap">QBO_REFRESH_TOKEN = ${tokens.refreshToken}
QBO_REALM_ID      = ${tokens.realmId}</pre>
      <p><strong>Then close this tab.</strong> Reloading will not show them again.</p>
    `);
  } catch (err) {
    console.error("[qbo/callback]", err.message);
    res.status(500).send("OAuth error: " + err.message);
  }
});

// --- Customer self-service: request a payment link by email ----------------
// POST /api/payment-link  { email: "customer@example.com" }
// Returns { paymentLink } or { error, noInvoice: true }
app.post("/api/payment-link", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }

    const customer = await findCustomerByEmail(email.trim().toLowerCase());
    if (!customer) {
      return res.status(404).json({
        error: "No account found with that email. Please contact Evergreen.",
        notFound: true,
      });
    }

    const invoice = await findOpenInvoiceForCustomer(customer.Id);
    if (!invoice) {
      return res.json({
        message: "No outstanding balance found on your account — you're all set!",
        noInvoice: true,
      });
    }

    const paymentLink = await getInvoicePaymentLink(invoice.Id);
    if (!paymentLink) {
      return res.status(500).json({
        error: "Could not generate a payment link. Please contact Evergreen directly.",
      });
    }

    res.json({ paymentLink, balance: invoice.Balance, dueDate: invoice.DueDate });
  } catch (err) {
    console.error("[payment-link]", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again or contact Evergreen." });
  }
});

// Read-only access to backup tabs (named like "Tues DV backup 2026-06-29")
app.get("/api/backup/:tabName", async (req, res) => {
  try {
    const { tabName } = req.params;
    if (!tabName.includes('backup')) {
      return res.status(403).json({ error: 'Not a backup tab.' });
    }
    const range = `'${tabName}'!A1:H1000`;
    const rawRows = await readRange(SPREADSHEET_ID, range);
    const { items, routeDate } = parseRouteTab(rawRows);
    res.json({ tabName, routeDate, items });
  } catch (err) {
    console.error(`[backup/${req.params.tabName}] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Client error reporting ----------------------------------------------
//
// The driver app posts its own failures here. Identical failures are deduped
// into one row with a count, so a bug firing on every GPS tick is one line
// that says 4,812 rather than 4,812 lines.

app.post("/api/client-errors", (req, res) => {
  const list = Array.isArray(req.body?.errors) ? req.body.errors.slice(0, 20) : [];
  let stored = 0;
  for (const e of list) if (recordError(e)) stored++;
  res.json({ ok: true, stored });
});

app.get("/api/client-errors", (req, res) => {
  res.json({ summary: errorSummary(), items: listErrors(req.query.limit) });
});

app.post("/api/client-errors/clear", (req, res) => {
  res.json(clearErrors());
});

// --- New-customer requests (website form -> staging -> approval) ---------
//
// Flow: the website form POSTs here, the request lands in SQLite as "pending",
// and nothing touches the route sheet. Alyssa reviews the queue on
// /approval.html and approving appends the customer to a route tab.
//
// The POST is deliberately the only part reachable without an access code
// (see gate.js) because a public form cannot carry one.

app.post("/api/requests", (req, res) => {
  const ip = (req.get("x-forwarded-for") || "").split(",")[0].trim()
           || req.socket.remoteAddress || "unknown";

  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  // Honeypot: a field no human sees and every naive bot fills in. Answer 200
  // so the bot believes it succeeded and does not retry with another shape.
  if (req.body && String(req.body.company || "").trim() !== "") {
    return res.json({ ok: true, id: null });
  }

  const { ok, errors, value } = validateRequest(req.body);
  if (!ok) return res.status(400).json({ error: errors.join("; "), errors });

  const saved = createRequest(value, "website");

  // Two different emails, two different problems:
  //   notify      → to us. Any address works, including gmail.
  //   confirmation → to the customer. Needs a verified sending domain.
  notifyNewRequest(saved).catch(err =>
    console.warn("[requests] notification failed:", err.message));
  sendConfirmation(saved).catch(err =>
    console.warn("[requests] confirmation email failed:", err.message));

  broadcast({ type: "request-created", id: saved.id });
  res.status(201).json({ ok: true, id: saved.id });
});

app.get("/api/requests", (req, res) => {
  const status = req.query.status;
  res.json({ counts: countByStatus(), items: listRequests({ status }) });
});

app.get("/api/requests/:id", (req, res) => {
  const row = getRequest(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

app.post("/api/requests/:id/approve", async (req, res) => {
  const row = getRequest(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.status !== "pending") {
    return res.status(409).json({ error: `Already ${row.status}.` });
  }

  // A hold, a missed pickup or a contact change is something the office acts
  // on — approving it means "handled", not "add them to a route". Only a new
  // customer gets appended to the sheet.
  if (row.kind && row.kind !== "new_customer") {
    const handled = decideRequest(req.params.id, "approved", null);
    broadcast({ type: "request-decided", id: req.params.id, status: "approved" });
    return res.json(handled);
  }

  const tabName = String(req.body?.tabName || "").trim();
  if (!ROUTE_DAY_TABS.includes(tabName)) {
    return res.status(400).json({ error: "Pick which route they go on.", allowed: ROUTE_DAY_TABS });
  }

  // Append FIRST, and only mark approved if the sheet write actually landed —
  // otherwise a failed write would leave a customer marked approved and
  // silently missing from the route, which is the same class of bug as the
  // driver's vanishing checkmark.
  try {
    const cols = ROUTE_COLUMNS;
    const rowValues = [];
    const put = (col, val) => { rowValues[col.charCodeAt(0) - 65] = val; };
    put(cols.addressCol, row.address);
    put(cols.notesCol, row.notes || "");
    put(cols.accountNameCol, row.name);
    put(cols.cityCol, row.city || "");
    for (let i = 0; i < rowValues.length; i++) if (rowValues[i] == null) rowValues[i] = "";

    await appendRows(SPREADSHEET_ID, `'${tabName}'!A:Z`, [rowValues]);
  } catch (err) {
    console.error("[requests] approve -> sheet append failed:", err.message);
    return res.status(502).json({ error: "Could not add them to the route sheet. Nothing was changed." });
  }

  const updated = decideRequest(req.params.id, "approved", tabName);
  broadcast({ type: "request-decided", id: req.params.id, status: "approved" });
  res.json(updated);
});

app.post("/api/requests/:id/decline", (req, res) => {
  const updated = decideRequest(req.params.id, "declined");
  if (!updated) return res.status(409).json({ error: "Not found, or already decided." });
  broadcast({ type: "request-decided", id: req.params.id, status: "declined" });
  res.json(updated);
});

// Resend's shared sandbox sender. Works with an API key alone — no domain, no
// DNS records, nothing to verify. The trade-off is that it will generally only
// deliver to the address the Resend account was registered with, which is fine
// for notifying us and NOT fine for emailing customers. Set
// REQUESTS_FROM_EMAIL to an address on a verified domain when customer
// confirmations are wanted.
const SANDBOX_FROM = "onboarding@resend.dev";

// Who gets notified, and whether. Behind the gate like everything else.
app.get("/api/requests-settings", (req, res) => res.json(getSettings()));

app.post("/api/requests-settings", (req, res) => {
  res.json(setSettings(req.body));
});

// Tell us a request came in. The recipient is a setting, not an env var, so
// it can be changed from the approval screen without a redeploy.
async function notifyNewRequest(request) {
  const { notify_email: to, notify_enabled: enabled } = getSettings();
  const key = process.env.RESEND_API_KEY;
  const from = process.env.REQUESTS_FROM_EMAIL || SANDBOX_FROM;

  if (enabled !== "1" || !to) return;
  if (!key) {
    console.log(`[requests] ${request.id} from ${request.name} — would notify ${to} (email not configured)`);
    return;
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: `New Evergreen request — ${request.name}`,
      text: [
        `${request.name}`,
        `${request.address}${request.city ? ", " + request.city : ""}`,
        request.email ? `Email: ${request.email}` : "",
        request.phone ? `Phone: ${request.phone}` : "",
        request.notes ? `Notes: ${request.notes}` : "",
        "",
        `Approve or decline: https://evergreen-driver-app.onrender.com/approval.html`,
      ].filter(Boolean).join("\n"),
    }),
  });
  if (!r.ok) throw new Error("Resend responded " + r.status);
  console.log(`[requests] ${request.id} notified ${to}`);
}

// Confirmation email. No provider is wired up yet: set RESEND_API_KEY and
// REQUESTS_FROM_EMAIL in Render and this starts sending, with no new npm
// dependency. Until then it logs and returns, so the queue works regardless.
async function sendConfirmation(request) {
  const key = process.env.RESEND_API_KEY;
  // Deliberately NOT falling back to the sandbox sender: this one goes to a
  // member of the public, and the sandbox will not deliver to them. Silently
  // "sending" mail customers never receive is worse than not sending.
  const from = process.env.REQUESTS_FROM_EMAIL;
  if (!key || !from || !request.email) {
    console.log(`[requests] ${request.id} stored; confirmation email not sent (not configured)`);
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: request.email,
      subject: "We got your Evergreen compost request",
      text: `Hi ${request.name},\n\nThanks — we have your request for ${request.address}. `
          + `Someone will confirm your collection day shortly.\n\nEverGreen ZeroWaste`,
    }),
  });
  if (!r.ok) throw new Error("Resend responded " + r.status);
  console.log(`[requests] ${request.id} confirmation email sent`);
}

// --- Static file server --------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Serve driver.html for all /driver/* routes (client-side routing)
app.get("/driver/:routeId", (req, res) => {
  sendStampedHtml(res, path.join(PUBLIC_DIR, 'driver.html'));
});

// Pages revalidate so edits go live immediately; css/js/icons cache for a day
// since drivers often reopen the app repeatedly on cell service.
// Asset version — changes on every deploy. Render exposes the commit SHA;
// locally we fall back to process start time, so a restart is enough.
//
// Why this exists: pages are no-cache but js/css cache for a day, which meant a
// deploy handed drivers FRESH HTML pointing at STALE JavaScript for up to 24
// hours — new markup wired to old code, failing silently. Stamping the version
// onto asset URLs means new HTML requests a URL the browser has never seen, so
// it fetches immediately, while old URLs stay cached and harmless.
const ASSET_V = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);

// Add ?v=<ASSET_V> to local js/css URLs. Only paths starting with a single "/"
// are touched, so Google Fonts and other external URLs are left alone.
function stampAssets(html) {
  return html.replace(
    /(<(?:script|link)\b[^>]*?\s(?:src|href)=")(\/[^"?#>]+\.(?:js|css))(")/g,
    (_m, pre, url, post) => pre + url + '?v=' + ASSET_V + post
  );
}

function sendStampedHtml(res, file, next) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return next ? next() : res.sendStatus(404);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(stampAssets(html));
  });
}

// HTML goes through the stamper, and stays no-cache, so every page load picks
// up the current asset version the moment a deploy lands.
app.get(/\.html$|^\/$/, (req, res, next) => {
  const rel = req.path === '/' ? 'index.html' : decodeURIComponent(req.path).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return res.sendStatus(403);  // path traversal guard
  sendStampedHtml(res, file, next);
});

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  setHeaders(res, filePath) {
    res.setHeader(
      "Cache-Control",
      filePath.endsWith(".html") ? "no-cache" : "public, max-age=86400"
    );
  },
}));

// --- WebSocket layer for real-time sync across drivers -------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "connected" }));
});

server.listen(PORT, () => {
  console.log(`Evergreen driver app backend listening on port ${PORT}`);
});
