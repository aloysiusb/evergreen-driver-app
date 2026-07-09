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
