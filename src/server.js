// server.js
import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { readRange, readRangeWithColors, writeRange, duplicateSheet } from "./sheets.js";
import { parseRouteTab, classifyNote } from "./routeParser.js";
import { ROUTE_DAY_TABS, ROUTE_COLUMNS, EXCLUDED_TABS, NOTES_TAB } from "./config.js";
import { getStyles, setStyles, DEFAULT_STYLES } from "./db.js";
import { getAuthUrl, exchangeCodeForTokens, findCustomerByEmail, findOpenInvoiceForCustomer, getInvoicePaymentLink } from "./qbo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

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

<<<<<<< HEAD
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
  res.redirect(getAuthUrl());
});

// Step 2: Intuit redirects here after Alyssa approves.
// Tokens are printed to logs — copy them into Render env vars.
app.get("/qbo/callback", async (req, res) => {
  try {
    const tokens = await exchangeCodeForTokens(req.url);
    console.log("=== QBO TOKENS — add these to Render env vars ===");
    console.log("QBO_REFRESH_TOKEN =", tokens.refreshToken);
    console.log("QBO_REALM_ID      =", tokens.realmId);
    console.log("=================================================");
    res.send(`
      <h2>QuickBooks connected!</h2>
      <p>Check Render logs for QBO_REFRESH_TOKEN and QBO_REALM_ID, then add them to your Render environment variables.</p>
      <p>After that, customers can use the self-service payment page.</p>
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

// --- Static file server --------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Serve driver.html for all /driver/* routes (client-side routing)
app.get("/driver/:routeId", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'driver.html'));
});

app.use(express.static(PUBLIC_DIR));

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
