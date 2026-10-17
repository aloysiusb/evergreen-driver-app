// server.js
import express from "express";
import cors from "cors";
import compression from "compression";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { readRange, readRangeWithColors, writeRange, appendRows, duplicateSheet, getSheetsClient } from "./sheets.js";
import { parseRouteTab, classifyNote, detectColumns } from "./routeParser.js";
import { ROUTE_DAY_TABS, ROUTE_COLUMNS, EXCLUDED_TABS, NOTES_TAB } from "./config.js";
import { getStyles, setStyles, DEFAULT_STYLES } from "./db.js";
import { getAuthUrl, exchangeCodeForTokens, findCustomerByEmail, findOpenInvoiceForCustomer, getInvoicePaymentLink, ensureCustomer, createInvoice, isConfigured as qboConfigured } from "./qbo.js";
import { uploadPhoto, photosFolderId } from "./drive.js";
import { addHazard, liveHazards, clearHazard, sweepHazards, isHazardKind, HAZARD_KINDS } from "./hazards.js";
import { savePhoto, pathFor, labelFor, usage as photoUsage } from "./photoStore.js";
import { recordActivity, todaysActivity, pruneActivity } from "./activity.js";
import { buildDigest, digestText, digestSubject, localClock, DIGEST_TZ } from "./digest.js";
import { mountGate } from "./gate.js";
import { recordError, listErrors, errorSummary, clearErrors } from "./errors.js";
import { allKnown as knownGeocodes, remember as rememberGeocodes,
         count as geocodeCount, sweepExpired as sweepGeocodes } from "./geocache.js";
import {
  validateRequest, createRequest, listRequests, getRequest,
  decideRequest, countByStatus, rateLimited, recordQbo,
  getSettings, setSettings,
} from "./requests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(compression());
app.use(cors());
/* Render terminates TLS in front of us, so without this req.protocol reports
   "http" on every request. That matters: a photo link built from it would be
   an http:// URL embedded in an https:// page, which browsers block as mixed
   content — the picture would simply never appear on the dispatcher board. */
app.set("trust proxy", 1);

app.use(express.json());

/* Keep the whole app out of search results.
 *
 * Eight pages carried no robots meta tag — among them approval.html, which
 * lists a customer's name, address, email and phone. A tag per page is a rule
 * that has to be remembered on every new file, and it was not. A header is
 * applied whether or not anyone remembered, and it also covers what a meta
 * tag cannot: the JSON from /api/routes, and the photos under /photos.
 *
 * This is not a security control. It is a request, and only well-behaved
 * crawlers honour it — Google and Bing do, a scraper does not. What keeps
 * route data private is ACCESS_CODE. This stops the app turning up in a
 * search for a customer's address, which is a different problem and worth
 * fixing on its own.
 */
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  next();
});

// Let /portal stand in for /portal.html, and so on for every page.
//
// Deliberately BEFORE the gate. The gate decides what is public by exact path
// — "/portal.html" is on that list — so a request for "/portal" arriving
// unrewritten would be treated as a private page and refused once ACCESS_CODE
// is set. Normalising the URL first means the gate, the routes and the static
// server all see the same path and cannot disagree about it.
//
// Only rewrites when the .html file actually exists, so a genuine typo still
// 404s rather than being quietly redirected somewhere unrelated.
const PAGES_DIR = path.join(__dirname, "..", "public");

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const p = req.path;
  if (p === "/" || p.startsWith("/api/") || p.startsWith("/qbo/")) return next();
  if (path.extname(p)) return next();               // already has an extension

  const rel = decodeURIComponent(p).replace(/^\/+/, "");
  if (rel.includes("..")) return next();            // path traversal guard
  const candidate = path.join(PAGES_DIR, rel + ".html");
  if (!candidate.startsWith(PAGES_DIR)) return next();

  if (fs.existsSync(candidate)) {
    req.url = "/" + rel + ".html" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  }
  next();
});

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

    const cols = await columnsFor(tabName);
    const cell = `'${tabName}'!${cols.doneCol}${rowNumber}`;
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

    const cols = await columnsFor(tabName);
    const cell = `'${tabName}'!${cols.notesCol}${rowNumber}`;
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

// /health proved the process was alive and nothing else, which is the least
// useful thing it could tell us. The question that actually matters is whether
// the database is on the persistent disk: if Render is ignoring the disk block
// in render.yaml — which it does when the service was created by connecting
// the repo rather than through a Blueprint — then every deploy silently wipes
// the request queue, the error log and the style settings. That was flagged as
// unverified in July and never checked.
app.get("/health", (req, res) => {
  // Resolve the SAME path db.js uses, rather than a label — an earlier
  // version of this check reported a description string as if it were a
  // directory and declared it unwritable, which was a bug in the diagnostic
  // and not a finding about the disk.
  const dir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const onPersistentDisk = Boolean(process.env.DATA_DIR);

  let writable = false;
  let dbBytes = null;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    writable = true;
    dbBytes = fs.statSync(path.join(dir, "app.db")).size;
  } catch { /* reported as false/null below */ }

  res.json({
    status: "ok",
    commit: (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null,
    data: {
      dir,
      onPersistentDisk,
      writable,
      dbBytes,
      // The one that answers the question. If this is false on Render, the
      // disk is not attached and data does not survive a deploy.
      survivesDeploy: onPersistentDisk && writable,
    },
    photos: {
      store: photosFolderId() ? "drive, disk as fallback" : "disk",
      ...photoUsage(),
    },
    /* Enough to tell whether the spreadsheet is configured and being read,
       and nothing more. No id, no title, no tab names, no customer data —
       this endpoint is deliberately outside the access gate, so it reports
       only that the wiring works.

       Counts come from the column cache the startup audit already filled, so
       asking costs no extra call to Google. */
    sheet: {
      configured: Boolean(SPREADSHEET_ID),
      tabsExpected: ROUTE_DAY_TABS.length,
      tabsReadable: columnCache.size,
      // Route names and a reason. No customer data, and it is the difference
      // between knowing something is wrong and knowing what to do about it.
      problems: Object.fromEntries(columnProblems),
    },
    /* Which integrations are WIRED, as yes/no and nothing else.
     *
     * Why this exists: Render lets a person or a Claude session SET an
     * environment variable but gives a Claude session no way to READ one. So
     * "is QuickBooks connected?" had no answer anyone could get at without
     * asking the owner, and the repo's notes went stale the moment something
     * was connected outside a session. This is the source of truth instead of
     * somebody's memory of it.
     *
     * Booleans only — never a value, an id, an address or a recipient. This
     * endpoint is outside the access gate, so it must say no more than that
     * the wiring is present. Whether the gate itself is on is deliberately not
     * reported here: any gated page answering 401 already says so.
     *
     * "Configured" means the settings are present. It does NOT mean the
     * integration works — a revoked QuickBooks token still reports true. For
     * that, exercise it. */
    integrations: {
      googleServiceAccount: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      mapsKey: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      mapId: Boolean(process.env.GOOGLE_MAPS_MAP_ID),
      quickbooks: qboConfigured(),
      email: {
        providerKey: Boolean(process.env.RESEND_API_KEY),
        verifiedSender: Boolean(process.env.REQUESTS_FROM_EMAIL),
      },
      digest: {
        enabled: getSettings().digest_enabled === "1",
        hour: Number(getSettings().digest_hour),
        // In memory, so it resets on restart. Absent means "not since the
        // last restart", not "never".
        lastSentOn: digestSentOn || null,
      },
    },
  });
});

/* A driver saying "here I am".
 *
 * Deliberately a broadcast and nothing else: it never opens the spreadsheet,
 * writes no row, and keeps no history. The dispatcher board already watches
 * the socket every other live event arrives on, so this reaches it the moment
 * it is sent.
 *
 * Not a tracking feed. It fires when a driver taps the GPS button, which is
 * the difference between answering "where are you?" and being followed all
 * day. */
/* Where the trucks are.
 *
 * Held in memory and nowhere else, deliberately. A position is only worth
 * anything while it is current, and a table of everywhere a driver has been
 * is a different thing from a board showing where they are now — one is a
 * dispatcher's tool, the other is a record of somebody's movements that
 * nobody asked for. A restart forgets the lot, and the next ping refills it.
 *
 * Keyed by route tab: one truck runs one round. */
const driverPositions = new Map();

/* Long enough that a tunnel or a black spot does not drop a truck off the
 * board, short enough that nobody reads a half-hour-old position as current. */
const POSITION_STALE_MS = 5 * 60 * 1000;

function livePositions() {
  const now = Date.now();
  const out = [];
  for (const [tabName, p] of driverPositions) {
    if (now - p.ms > POSITION_STALE_MS) { driverPositions.delete(tabName); continue; }
    out.push({ ...p, ms: undefined, tabName });
  }
  return out;
}

app.post("/api/driver-location", (req, res) => {
  const { lat, lng, accuracy, heading, tabName, stop, mode } = req.body || {};
  const nLat = Number(lat), nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng) ||
      nLat < -90 || nLat > 90 || nLng < -180 || nLng > 180) {
    return res.status(400).json({ error: "A valid lat and lng are required." });
  }

  /* 'once' is a single send; 'start' and 'ping' mean the driver has sharing
     switched on; 'stop' means they have just switched it off. Anything else
     is treated as a single send, which is what older clients do. */
  const kind = ["start", "ping", "stop", "once"].includes(mode) ? mode : "once";
  const tab = String(tabName || "").slice(0, 80);

  const msg = {
    type: "driver-location",
    lat: nLat,
    lng: nLng,
    accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
    heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
    tabName: tab,
    stop: String(stop || "").slice(0, 120),
    mode: kind,
    live: kind === "start" || kind === "ping",
    at: new Date().toISOString(),
  };

  if (kind === "stop") {
    driverPositions.delete(tab);
  } else if (msg.live) {
    driverPositions.set(tab, { ...msg, ms: Date.now() });
  }

  broadcast(msg);
  res.json({ ok: true });
});

/* For a dispatcher who opens the board halfway through the round: the socket
 * only carries what happens next, and a truck that pinged a minute ago would
 * otherwise be invisible until it moved again. */
app.get("/api/driver-locations", (req, res) => {
  res.json({ drivers: livePositions(), staleAfterMs: POSITION_STALE_MS });
});

/* ── Road hazards ─────────────────────────────────────────────────────────
 * What drivers tell each other about the road: rockslides, closures, ice,
 * police. See hazards.js for why this is our own drivers' reports rather than
 * Waze's — there is no public feed to borrow.
 *
 * Reading the list is open to anyone already past the gate, because a driver
 * opening the app mid-round needs the ones filed before they arrived; the
 * socket only carries what happens next.
 */
app.get("/api/hazards", (req, res) => {
  res.json({ kinds: HAZARD_KINDS, hazards: liveHazards() });
});

// --- Where the addresses are -----------------------------------------------
//
// The map used to ask Google for the coordinates of every stop every time it
// opened — fifty billed lookups a round, again on the next open and again for
// the next driver. September's usage showed 11,542 Geocoding calls against a
// couple of hundred addresses that had not moved.
//
// So the browser asks here first and only troubles Google for addresses
// nobody has looked up before, then posts those back. Steady state is zero
// calls: the round settles after one driver has opened it once.

/* Coordinates age out at thirty days to stay inside Google's caching terms.
   Swept at boot and daily, so an expired row is deleted rather than merely
   ignored — the same shape as the hazard sweep below. */
sweepGeocodes();
setInterval(sweepGeocodes, 24 * 60 * 60 * 1000).unref?.();

app.get("/api/geocodes", (req, res) => {
  res.json({ known: knownGeocodes() });
});

app.post("/api/geocodes", (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  // A sane ceiling: a round is tens of stops, not thousands, and this endpoint
  // takes no code to reach.
  if (entries.length > 500) {
    return res.status(400).json({ error: "Too many at once." });
  }
  const saved = rememberGeocodes(entries);
  res.json({ ok: true, saved, total: geocodeCount() });
});

app.post("/api/hazards", (req, res) => {
  const { kind, lat, lng, note, tabName } = req.body || {};
  const nLat = Number(lat), nLng = Number(lng);
  if (!isHazardKind(kind)) {
    return res.status(400).json({ error: "Unknown hazard kind." });
  }
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng) ||
      nLat < -90 || nLat > 90 || nLng < -180 || nLng > 180) {
    return res.status(400).json({ error: "A valid lat and lng are required." });
  }
  const hazard = addHazard({ kind, lat: nLat, lng: nLng, note, tabName });
  broadcast({ type: "hazard-added", hazard });
  res.json({ ok: true, hazard });
});

/* Clearing one. Any driver can, deliberately: the person who can see that the
 * road is open again is whoever is standing on it, not whoever filed it. */
app.post("/api/hazards/:id/clear", (req, res) => {
  const ok = clearHazard(req.params.id);
  if (!ok) return res.status(404).json({ error: "Already cleared or unknown." });
  broadcast({ type: "hazard-cleared", id: req.params.id });
  res.json({ ok: true });
});

// Expired rows are dead weight; swept daily, and once at boot so a server that
// is restarted more often than daily still tidies up.
sweepHazards();
setInterval(sweepHazards, 24 * 60 * 60 * 1000).unref?.();

// --- Maps config ---------------------------------------------------------

app.get("/api/maps-key", (req, res) => {
  /* A test drive spends a different key.
   *
   * September's bill was built partly out of demonstrations: sim.js is careful
   * that a test drive cannot write to the route sheet, the dispatch board or
   * the hazard layer, and nobody thought about it writing to the card. Every
   * demo was real Google money, indistinguishable on the bill from a driver
   * doing the round.
   *
   * So the simulator asks for its own key. Give GOOGLE_MAPS_API_KEY_DEV a tiny
   * daily quota in the Cloud console and a runaway during testing stops at a
   * few pennies, loudly, on the screen of whoever caused it — instead of
   * quietly, on the bill, thirty days later.
   *
   * Unset, it falls back to the real key, so nothing breaks by not configuring
   * it and the test drive keeps working either way. */
  const wantsDev = req.query.sim === "1";
  const key = (wantsDev && process.env.GOOGLE_MAPS_API_KEY_DEV)
    || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(404).json({ error: "Maps key not configured" });
  // A Map ID is optional, and it is the thing that decides whether the driver
  // map can tilt and turn heading-up. Google only renders a VECTOR map when
  // the map is created with a Map ID made with vector rendering in the Cloud
  // console — on a raster map setTilt and setHeading do nothing at all. So the
  // app has always asked for them and always been ignored. Set
  // GOOGLE_MAPS_MAP_ID and the same code starts working; leave it unset and
  // the map stays flat and north-up, exactly as it behaves today.
  res.json({ key, mapId: process.env.GOOGLE_MAPS_MAP_ID || null });
});

// --- Style API -----------------------------------------------------------

app.get("/api/styles", (req, res) => {
  res.json(getStyles());
});

app.post("/api/styles", (req, res) => {
  const styles = setStyles(req.body);
  chromeTagCache = null;
  broadcast({ type: "style-updated", styles });
  res.json(styles);
});

app.post("/api/styles/reset", (req, res) => {
  const styles = setStyles(DEFAULT_STYLES);
  chromeTagCache = null;
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

/* Photos kept on the disk are served from here, so the link written into the
   sheet opens the picture like any other link. The name is checked against the
   shape this app generates rather than trusted, so no path can be talked into
   pointing somewhere else. */
app.get("/photos/:name", (req, res) => {
  const file = pathFor(req.params.name);
  if (!file) return res.sendStatus(400);

  /* The file on disk is named by timestamp and random characters so the URL
     cannot be talked into pointing elsewhere. That name is no use to a person,
     so it is opened INLINE but offered under a readable one — save it and you
     get "2026-09-19 1432 · Carbondale Community School · Tues DV row 6.jpg"
     rather than "1789864200427-yiwr3v.jpg".

     Quotes and newlines are stripped: the value sits inside a quoted header,
     and either would break out of it. */
  const label = String(labelFor(req.params.name)).replace(/["\r\n]/g, "");
  res.setHeader("Content-Disposition", `inline; filename="${label}"`);

  res.sendFile(file, { maxAge: "7d", immutable: true }, (err) => {
    if (err) res.sendStatus(404);
  });
});

/* What has happened today, so a reloaded board is not a blank one.
   Returns the raw broadcasts; the board replays them through the same code
   path that handles live ones. */
app.get("/api/activity", (req, res) => {
  /* ?date=YYYY-MM-DD, interpreted in the server's own timezone so it lines up
     with the day a driver actually worked. Anything unparseable falls back to
     today rather than erroring — a bad date should show the usual screen, not
     a broken one. */
  const raw = String(req.query.date || "").trim();
  let day = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    const candidate = new Date(y, m - 1, d);
    if (!Number.isNaN(candidate.getTime())) day = candidate;
  }
  res.json({ date: raw || null, events: todaysActivity(300, day) });
});

// --- Simulated activity (demo only) ---------------------------------------
//
// A test drive intercepts its own writes so the route sheet cannot be touched,
// which also means the dispatcher board saw nothing at all — the one screen
// you most want to show someone while demonstrating.
//
// This broadcasts an event and NOTHING ELSE. It never opens the spreadsheet.
// Every message is stamped sim:true, and the board puts those in the feed
// without letting them move the real stop counts, so a demo running next to a
// real shift cannot make the numbers lie.

app.post("/api/sim-event", (req, res) => {
  const { type, tabName, rowNumber, done, notes, accountName } = req.body || {};

  if (type !== "stop-updated" && type !== "note-updated") {
    return res.status(400).json({ error: "Not an event this accepts." });
  }
  try {
    assertAllowedTab(tabName);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  broadcast({
    type,
    tabName,
    rowNumber: Number(rowNumber),
    done: Boolean(done),
    notes: typeof notes === "string" ? notes.slice(0, 500) : undefined,
    noteUrgency: typeof notes === "string" ? classifyNote(notes) : undefined,
    accountName: typeof accountName === "string" ? accountName.slice(0, 80) : undefined,
    sim: true,
  });

  res.json({ ok: true });
});

/* The "Photos per Notes" column.
 *
 * Not assumed to exist. The first time a photo is taken on a tab, the heading
 * is written one past the last header that has text, and the cached column map
 * for that tab is dropped so the new column is picked up immediately.
 *
 * It is never written over an existing heading: if every column is occupied up
 * to the edge of what we read, we stop rather than overwrite someone's data.
 */
const PHOTOS_HEADING = "Photos per Notes";

const colIndex = (letter) => (letter ? letter.charCodeAt(0) - 65 : -1);

async function photosColumnFor(tabName) {
  const cols = await columnsFor(tabName);
  const headerRow = cols.headerRowNumber || 1;

  /* The data ends at the rightmost column we know about. A photos column has
     to be to the RIGHT of that — anything found to the left is not one. */
  const dataEnd = Math.max(
    colIndex(cols.notesCol),
    colIndex(cols.cityCol),
    colIndex(cols.accountNameCol),
    colIndex(cols.directionsCol)
  );
  const found = colIndex(cols.photosCol);

  if (found > dataEnd) return cols.photosCol;

  if (found >= 0) {
    /* An earlier version of this counted the used columns from a second read
       of the header and got an empty answer, so it treated column A — the
       blank leading cell this sheet keeps — as "the first free column" and
       wrote the heading there. Clear it and place one properly rather than
       leaving a stray word above the data. */
    console.warn(`[photos] clearing a stray "${PHOTOS_HEADING}" at ${cols.photosCol}${headerRow} on '${tabName}'`);
    await writeRange(SPREADSHEET_ID, `'${tabName}'!${cols.photosCol}${headerRow}`, [[""]]);
    columnCache.delete(tabName);
  }

  /* Where to put it, taken from the header row the rest of the app already
     trusts rather than read again. headerWidth is the number of cells up to
     the last one with text, so it IS the next free column — and it is never
     allowed to land on or before the data. */
  const target = Math.max(Number(cols.headerWidth) || 0, dataEnd + 1);
  if (target > 25) {                      // past Z
    console.warn(`[photos] no free column on '${tabName}' to add the heading`);
    return null;
  }

  const letter = String.fromCharCode(65 + target);
  await writeRange(SPREADSHEET_ID, `'${tabName}'!${letter}${headerRow}`, [[PHOTOS_HEADING]]);
  columnCache.delete(tabName);            // so the next read sees the new column
  console.log(`[photos] added "${PHOTOS_HEADING}" to '${tabName}' at column ${letter}`);
  return letter;
}

/* Put the link in that column for this stop, alongside any already there.
   Several photos of one stop is normal — a bin, then the label, then the
   street — so they accumulate rather than replacing each other. */
async function recordPhotoLink(tabName, rowNumber, link) {
  const col = await photosColumnFor(tabName);
  if (!col) return null;

  const cell = `'${tabName}'!${col}${rowNumber}`;
  let existing = "";
  try {
    const rows = await readRange(SPREADSHEET_ID, cell);
    existing = String((rows && rows[0] && (rows[0].values ? rows[0].values[0] : rows[0][0])) || "").trim();
  } catch { /* an empty cell reads as nothing; carry on */ }

  const combined = existing ? existing + "\n" + link : link;
  await writeRange(SPREADSHEET_ID, cell, [[combined]]);
  return col;
}

/* Tidy up photo links this app wrote into the wrong column.
 *
 * The first version of the column placement put the heading — and then a link —
 * into column A, the blank leading cell these sheets keep. This clears that up
 * precisely: a cell is only emptied when its ENTIRE contents are links to this
 * app own /photos/ path, and never in the real photos column. It cannot touch
 * an address, a note, or anything a person typed.
 */
app.post("/api/photos/tidy", async (req, res) => {
  const tabName = String(req.body?.tabName || "").trim();
  try {
    assertAllowedTab(tabName);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    const cols = await columnsFor(tabName);
    const keep = cols.photosCol;
    const rows = await readRange(SPREADSHEET_ID, `'${tabName}'!A1:N400`);

    const cleared = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        const letter = String.fromCharCode(65 + c);
        if (letter === keep) continue;              // the real column, leave alone
        if (!isOurPhotoCell(row[c])) continue;
        await writeRange(SPREADSHEET_ID, `'${tabName}'!${letter}${r + 1}`, [[""]]);
        cleared.push(letter + (r + 1));
      }
    }

    console.log(`[photos] tidied ${cleared.length} stray link cell(s) on '${tabName}'`);
    res.json({ ok: true, tab: tabName, photosColumn: keep, cleared });
  } catch (err) {
    console.error("[photos] tidy failed:", err.message);
    res.status(502).json({ error: err.message });
  }
});

/* True only when a cell holds nothing but links this app generated. A note
   that MENTIONS a photo link is not such a cell, so it is left alone. */
function isOurPhotoCell(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every(
    (u) => /^https?:\/\/\S+\/photos\/[0-9]{13}-[a-z0-9]{6}\.(jpg|webp)$/.test(u)
  );
}

/* Name a column that has no heading.
 *
 * These sheets are kept by people, and a column whose heading was never typed
 * is common — Friday's address column was blank, which made the whole tab
 * unreadable and unwritable while the addresses themselves sat there in plain
 * sight. The app finds columns BY NAME on purpose, so an unnamed one cannot be
 * used no matter how obvious it looks.
 *
 * The one thing this will not do is overwrite. If the heading cell already has
 * text it refuses and says what is there — so a wrong guess costs nothing, and
 * no existing heading can be clobbered by a typo in a request.
 */
app.post("/api/sheet-heading", async (req, res) => {
  const tabName = String(req.body?.tabName || "").trim();
  const column = String(req.body?.column || "").trim().toUpperCase();
  const heading = String(req.body?.heading || "").trim().slice(0, 60);

  try {
    assertAllowedTab(tabName);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (!/^[A-N]$/.test(column)) {
    return res.status(400).json({ error: "Column must be a single letter A-N." });
  }
  if (!heading) {
    return res.status(400).json({ error: "No heading given." });
  }

  try {
    /* Which row the headings are on. Read from the sheet rather than assumed:
       some of these tabs carry blank rows above the header. */
    const top = await readRange(SPREADSHEET_ID, `'${tabName}'!A1:N12`);
    const headerIdx = (top || []).findIndex(
      r => (r || []).filter(v => String(v || "").trim()).length > 2
    );
    if (headerIdx < 0) {
      return res.status(409).json({ error: "Could not find a header row in the first 12 rows." });
    }
    const rowNumber = headerIdx + 1;

    const existing = String((top[headerIdx] || [])[column.charCodeAt(0) - 65] || "").trim();
    if (existing) {
      return res.status(409).json({
        error: `${column}${rowNumber} already reads "${existing}". Nothing was changed.`,
      });
    }

    await writeRange(SPREADSHEET_ID, `'${tabName}'!${column}${rowNumber}`, [[heading]]);
    columnCache.delete(tabName);
    await auditColumns();

    console.log(`[sheet] named ${column}${rowNumber} on '${tabName}' as "${heading}"`);
    res.json({
      ok: true,
      tab: tabName,
      cell: column + rowNumber,
      heading,
      tabsReadable: columnCache.size,
      problems: Object.fromEntries(columnProblems),
    });
  } catch (err) {
    console.error("[sheet] could not name the column:", err.message);
    res.status(502).json({ error: err.message });
  }
});

/* The column HEADINGS of any tab, including the ones the driver app is not
 * allowed to read.
 *
 * Those tabs are excluded because they carry rates and accounting notes — but
 * being unable to see even their headings means any change involving them
 * starts with a guess about which column is which, and guessing at column
 * positions is what destroyed three addresses in July.
 *
 * Headings only. Never the rows beneath them, which is where the money and the
 * customers are. Behind the admin code, not the driver one.
 */
app.get("/api/sheet-headings", async (req, res) => {
  const tabName = String(req.query.tab || "").trim();
  if (!tabName) return res.status(400).json({ error: "Which tab?" });

  try {
    // Read further down so each column can be reported as empty or not.
    // A heading can be missing while the column below it is full, and writing
    // into that would destroy data — the count is what makes it safe to say
    // "this column is free".
    const rows = await readRange(SPREADSHEET_ID, `'${tabName}'!A1:T300`);

    /* The header row is the first with more than two non-empty cells. These
       sheets keep blank rows and date banners above it. */
    const idx = (rows || []).findIndex(
      r => (r || []).filter(v => String(v || "").trim()).length > 2
    );
    if (idx < 0) {
      return res.json({ tab: tabName, headerRow: null, headings: [] });
    }

    const width = Math.max(...(rows || []).map(r => (r || []).length), 0);
    const headings = [];
    for (let i = 0; i < width; i++) {
      let filled = 0;
      for (let r = idx + 1; r < rows.length; r++) {
        if (String((rows[r] || [])[i] || "").trim()) filled++;
      }
      headings.push({
        column: String.fromCharCode(65 + i),
        heading: String((rows[idx] || [])[i] || "").trim(),
        cellsWithSomethingIn: filled,     // a count, never the contents
      });
    }

    res.json({
      tab: tabName,
      headerRow: idx + 1,
      headings,
      firstFreeColumn: String.fromCharCode(65 + headings.length),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Photos ---------------------------------------------------------------
//
// The phone shrinks the image before sending — a raw phone photo is 3-5 MB and
// a driver on rural cell service would be standing at the bin waiting for it.
// Arrives as the JPEG itself rather than base64 in JSON, which avoids a third
// more bytes over the slowest part of the journey.

app.post(
  "/api/photo",
  express.raw({ type: ["image/jpeg", "image/webp"], limit: "6mb" }),
  async (req, res) => {
    const tabName = String(req.query.tab || "").trim();
    const rowNumber = Number(req.query.row);
    const account = String(req.query.account || "").slice(0, 80);

    if (!tabName || !Number.isFinite(rowNumber)) {
      return res.status(400).json({ error: "Which stop is this photo of?" });
    }
    try {
      assertAllowedTab(tabName);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "No image received." });
    }

    const mimeType = req.is("image/webp") ? "image/webp" : "image/jpeg";
    const kb = Math.round(req.body.length / 1024);

    /* Drive first, where it is set up. Google will not let a service account
       own a file inside a personal Drive folder — "Service Accounts do not
       have storage quota" — so unless the folder is a Shared Drive this fails
       every time, and a driver standing at a bin cannot wait for an
       administrator. The disk underneath always works. */
    if (photosFolderId()) {
      try {
        const saved = await uploadPhoto(req.body, { tabName, rowNumber, account, mimeType });
        console.log(`[photo] drive: ${saved.name} (${kb} KB)`);
        return res.json({ ok: true, store: "drive", ...saved });
      } catch (err) {
        console.warn("[photo] drive refused it, keeping it on disk instead:", err.message);
      }
    }

    try {
      const saved = savePhoto(req.body, mimeType, { tabName, rowNumber, account });
      console.log(`[photo] disk: ${saved.name} (${kb} KB)`);
      /* A relative path is no use once it is sitting in a spreadsheet cell —
         it has to be a link someone can click from anywhere. */
      const origin = `${req.protocol}://${req.get("host")}`;
      const link = origin + saved.link;

      /* Into its own column, now rather than later. The answer does not wait
         on it: the photo is already saved, and a driver should not be held up
         by a spreadsheet write. A failure here is logged, not thrown.

         ?debug=1 waits for it and reports what happened, because a failure
         that only ever reaches the server log is a failure you cannot see
         from outside. */
      /* The board is told the moment the photo exists, not once the
         spreadsheet has caught up. The picture is real either way, and a
         failed column write should not also cost the office the photo. */
      broadcast({ type: "photo-added", tabName, rowNumber, link, account });

      const record = recordPhotoLink(tabName, rowNumber, link)
        .then((col) => ({ column: col }))
        .catch((err) => {
          console.warn("[photos] could not record the link:", err.message);
          return { error: err.message };
        });

      if (req.query.debug) {
        const sheet = await record;
        return res.json({ ok: true, ...saved, link, sheet });
      }

      res.json({ ok: true, ...saved, link });
    } catch (err) {
      console.error("[photo] could not be saved at all:", err.message);
      // Never answer ok for a photo that did not land — a driver would walk
      // away believing it saved.
      res.status(502).json({ error: "Could not save the photo. " + err.message });
    }
  }
);

// --- Which column is which, per tab ---------------------------------------
//
// Read from the sheet's own header rather than assumed from config, because
// tabs differ: some carry the legacy "Ney" column and some don't, which shifts
// everything after it. Cached per tab — the header does not move during a
// shift, and re-reading it on every tick of a 200-stop day would be absurd.

/* The accepted headings, from settings, with the built-in list as the floor.
   Read fresh each time rather than cached: changing one is exactly the moment
   somebody needs the next read to use it. */
function columnNames() {
  const s = getStyles();
  const split = (key) =>
    String(s[key] || "")
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);
  return {
    address: split("sheet-col-address"),
    account: split("sheet-col-account"),
    done:    split("sheet-col-done"),
    notes:   split("sheet-col-notes"),
  };
}

const columnCache = new Map();
const COLUMN_TTL_MS = 10 * 60 * 1000;

function columnFault(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function columnsFor(tabName) {
  const hit = columnCache.get(tabName);
  if (hit && Date.now() - hit.at < COLUMN_TTL_MS) return hit.cols;

  let rows;
  try {
    rows = await readRange(SPREADSHEET_ID, `'${tabName}'!A1:J6`);
  } catch (err) {
    console.warn(`[sheet] could not read header of '${tabName}':`, err.message);
    throw columnFault("Could not read the sheet's header row, so there is no safe place to write. Nothing was changed.");
  }

  const cols = detectColumns(rows, columnNames());

  // This used to fall back to the fixed letters in config.js when the header
  // could not be read. That fallback is exactly what destroyed three addresses
  // on Tues DV: the sheet had a column config did not know about, every letter
  // was off by one, and notes landed in Address. A guess that is usually right
  // is worse than a refusal, because a refusal is visible and reversible.
  //
  // Refusing is cheap for the driver: the write parks in the phone's queue and
  // goes through by itself once the header is readable again. Nothing is lost.
  if (!cols) {
    console.error(`[sheet] '${tabName}' has no recognisable header row — refusing to write`);
    throw columnFault(`The header row on '${tabName}' does not look right, so writes are paused for that tab. Your work is saved on the phone and will go through once it is fixed.`);
  }

  // Belt and braces for the one mistake that actually happened.
  if (cols.addressCol && (cols.notesCol === cols.addressCol || cols.doneCol === cols.addressCol)) {
    console.error(`[sheet] '${tabName}' resolved a write column onto Address — refusing`, cols);
    throw columnFault("The sheet's columns resolved onto the Address column, which would overwrite an address. Nothing was changed.");
  }

  console.log(`[sheet] '${tabName}' columns: done→${cols.doneCol} notes→${cols.notesCol} address→${cols.addressCol}`);
  columnCache.set(tabName, { cols, at: Date.now() });
  return cols;
}

/* Read every route tab's header once at startup and say what was found.
 *
 * So that a sheet swapped in overnight shows up in the log as a shifted or
 * unreadable header before a driver taps anything, rather than after. Purely
 * informational — it changes nothing and cannot stop the app booting. */
/* Which tabs could not be read, and why.
 *
 * "7 of 9 readable" tells you something is wrong and nothing about what. These
 * are route names — the same labels already printed on the public walkthrough
 * — not customer data, so naming them costs nothing and saves opening the
 * spreadsheet to guess. */
const columnProblems = new Map();

async function auditColumns() {
  if (!SPREADSHEET_ID) return;
  columnProblems.clear();
  for (const tab of ROUTE_DAY_TABS) {
    try {
      await columnsFor(tab);
      columnProblems.delete(tab);
    } catch (err) {
      /* Distinguish "the tab is not in this spreadsheet" from "it is there but
         its header row is not recognised". They need completely different
         fixes: one is a name, the other is a heading. */
      const missing = /unable to parse range|not found/i.test(err.message);
      let detail = missing ? "No tab with this name in the spreadsheet" : "";

      /* Say which heading is absent, not that "the header row is not
         recognised". One of those can be fixed in ten seconds; the other
         means opening the sheet and comparing it against another tab.

         Headings only — never the rows beneath them, which are customer data. */
      if (!missing) {
        try {
          const rows = await readRange(SPREADSHEET_ID, `'${tab}'!A1:N12`);
          const headings = (rows || [])
            .map(r => (r || []).map(v => String(v || "").trim()))
            .find(r => r.filter(Boolean).length > 2);

          if (!headings) {
            detail = "No header row found in the first 12 rows";
          } else {
            const words = headings.map(h => h.toLowerCase());
            const seen = (list) => words.some(w => w && list.some(k => w.includes(k)));

            const absent = [];
            if (!seen(["address"])) absent.push("Address");
            if (!seen(["account", "customer", "business", "name"])) absent.push("Account Name");
            if (!seen(["yay", "done", "complete", "collected", "picked"])) absent.push("Yay");
            if (!seen(["notes", "instruction", "request"])) absent.push("Driver Notes");

            detail = absent.length
              ? "Missing heading" + (absent.length > 1 ? "s" : "") + ": " + absent.join(", ")
              : "Headings present but could not be matched";
            detail += " · found: " + headings.filter(Boolean).join(" | ");
          }
        } catch (readErr) {
          detail = "Could not read this tab: " + readErr.message;
        }
      }

      columnProblems.set(tab, detail);
      console.warn(`[sheet] startup check — '${tab}': ${err.message}`);
    }
  }
}

/* Re-run the audit on demand. The startup one is a snapshot; after someone
   fixes a heading they should not have to wait for a deploy to find out. */
app.post("/api/sheet-recheck", async (req, res) => {
  columnCache.clear();
  await auditColumns();
  res.json({
    tabsExpected: ROUTE_DAY_TABS.length,
    tabsReadable: columnCache.size,
    problems: Object.fromEntries(columnProblems),
  });
});

// --- Sheet check ----------------------------------------------------------
//
// Pointing the app at a different spreadsheet fails in four different ways and
// three of them look identical from the outside ("routes won't load"). This
// answers all four at once:
//
//   1. is the service account allowed to open it        — the step people miss
//   2. which tabs exist, and do they match the whitelist
//   3. do the columns sit where the parser expects them
//   4. which tabs would actually serve a route today
//
// Admin-gated: it names the tabs and the first row of the sheet.

app.get("/api/sheet-check", async (req, res) => {
  const sheetId = String(req.query.id || SPREADSHEET_ID || "").trim();

  // The address to share the sheet with. Not a secret — it is an identifier,
  // and Google's own instructions are to paste it into the Share dialog.
  let serviceAccount = null;
  try {
    serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "{}").client_email || null;
  } catch { /* malformed key reported below as unreadable */ }

  const out = {
    spreadsheetId: sheetId || null,
    shareWith: serviceAccount,
    expected: { tabs: ROUTE_DAY_TABS, columns: ROUTE_COLUMNS },
  };

  if (!sheetId) {
    out.ok = false;
    out.problem = "No spreadsheet id. Set ROUTE_SHEET_ID, or pass ?id=… to test one.";
    return res.json(out);
  }
  if (!serviceAccount) {
    out.ok = false;
    out.problem = "GOOGLE_SERVICE_ACCOUNT_KEY is missing or not valid JSON.";
    return res.json(out);
  }

  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });

    out.title = meta.data.properties?.title || null;
    const present = (meta.data.sheets || []).map(sh => sh.properties.title);
    out.tabsInSheet = present;

    out.tabsMatched = ROUTE_DAY_TABS.filter(t => present.includes(t));
    out.tabsMissing = ROUTE_DAY_TABS.filter(t => !present.includes(t));
    out.tabsUnused  = present.filter(t => !ROUTE_DAY_TABS.includes(t) && !EXCLUDED_TABS.includes(t));

    // Read the top of each matched tab so the columns can be eyeballed against
    // what routeParser expects.
    out.columnCheck = [];
    /* Every matched tab, not the first three. A checker that samples three of
       nine cannot show you the one that is broken — which is exactly what
       happened with Friday. Pass ?tab=Name to look at one. */
    const only = String(req.query.tab || "").trim();
    const toCheck = only ? out.tabsMatched.filter(t => t === only) : out.tabsMatched;
    for (const tab of toCheck) {
      try {
        const span = String(req.query.rows || "1:3");
        const safe = /^[0-9]+:[0-9]+$/.test(span) ? span : "1:3";
        const [a,b]=safe.split(":");
        // Out to N, not H. Stopping at H meant a column this app ADDS —
        // "Photos per Notes", which lands at I on these sheets — was invisible
        // to the one tool meant for checking the columns.
        const rows = await readRange(sheetId, `'${tab}'!A${a}:N${b}`);
        out.columnCheck.push({ tab, firstRows: rows, detected: detectColumns(rows, columnNames()) });
      } catch (err) {
        out.columnCheck.push({ tab, error: err.message });
      }
    }

    out.ok = out.tabsMatched.length > 0;
    out.problem = out.ok
      ? null
      : "The service account can open the sheet, but none of its tabs match the " +
        "names in config.js. Rename the tabs, or update ROUTE_DAY_TABS.";
  } catch (err) {
    out.ok = false;
    const m = err.message || String(err);
    out.problem = /permission|403|forbidden/i.test(m)
      ? `The service account cannot open this sheet. Share it with ${serviceAccount} (Viewer is enough to read; Editor is needed to mark stops done).`
      : /not found|404/i.test(m)
        ? "No spreadsheet with that id. Check the id in the sheet's URL."
        : m;
  }

  res.json(out);
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

  /* Enough for the office to know what arrived and decide whether to go and
     look. Deliberately NOT the email address or phone number: this goes to
     every screen with the board open, and the queue itself is one click away
     for anyone who needs to contact them. */
  broadcast({
    type: "request-created",
    id: saved.id,
    kind: saved.kind,
    name: saved.name,
    address: [saved.address, saved.city].filter(Boolean).join(", "),
  });
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
    const cols = await columnsFor(tabName);
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

  /* QuickBooks comes after the approval is committed, never before it.
     Alyssa's click has already done the thing that matters — the customer is
     on a route — and an Intuit outage, an expired token or a missing service
     item must not undo that or leave her clicking again. Whatever happens is
     written onto the request so the approval screen can show it. */
  const amount = String(req.body?.amount ?? "").trim();
  const label  = String(req.body?.planLabel ?? row.service ?? "").trim();

  if (amount) {
    createQboRecords(row, amount, label).catch(err =>
      console.warn("[qbo] unexpected failure for", row.id, err.message));
  }

  res.json(updated);
});

/**
 * Create the customer and first invoice in QuickBooks for an approved request.
 * Swallows every failure into qbo_error — the caller has already responded.
 */
async function createQboRecords(row, amount, label) {
  if (!qboConfigured()) {
    recordQbo(row.id, {
      amount, label,
      error: "QuickBooks is not connected — set the QBO_* variables in Render.",
    });
    broadcast({ type: "request-decided", id: row.id, status: "approved" });
    return;
  }

  try {
    const { customer, created } = await ensureCustomer({
      name: row.name, email: row.email, phone: row.phone,
      address: row.address, city: row.city,
    });

    const invoice = await createInvoice({
      customerId: customer.Id,
      amount,
      description: label || "Compost service",
      email: row.email || undefined,
    });

    /* A pay link only exists once QuickBooks Payments is switched on for the
       account. Its absence is not a failure of the invoice, so it is not
       recorded as one. */
    let payLink = null;
    try {
      payLink = await getInvoicePaymentLink(invoice.Id);
    } catch (err) {
      console.warn("[qbo] no pay link for invoice", invoice.Id, err.message);
    }

    recordQbo(row.id, {
      customerId: customer.Id, invoiceId: invoice.Id, payLink, amount, label,
    });
    console.log(
      `[qbo] ${row.id}: ${created ? "created" : "matched"} customer ${customer.Id}, ` +
      `invoice ${invoice.Id}${payLink ? ", pay link ready" : ", no pay link"}`
    );
  } catch (err) {
    recordQbo(row.id, { amount, label, error: err.message });
    console.warn("[qbo]", row.id, "->", err.message);
  }

  broadcast({ type: "request-decided", id: row.id, status: "approved" });
}

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

  await sendMail({
    from, to,
    subject: `New Evergreen request — ${request.name}`,
    text: [
      `${request.name}`,
      `${request.address}${request.city ? ", " + request.city : ""}`,
      request.email ? `Email: ${request.email}` : "",
      request.phone ? `Phone: ${request.phone}` : "",
      request.notes ? `Notes: ${request.notes}` : "",
      "",
      `Approve or decline: ${publicBaseUrl()}/approval.html`,
    ].filter(Boolean).join("\n"),
  });
  console.log(`[requests] ${request.id} notified ${to}`);
}

// Confirmation email. No provider is wired up yet: set RESEND_API_KEY and
// REQUESTS_FROM_EMAIL in Render and this starts sending, with no new npm
// dependency. Until then it logs and returns, so the queue works regardless.
// The confirmation read "we have your request for ." on anything but a new
// signup, because only a new customer gives an address — a hold or a missed
// pickup is against an account we already have. It also promised to confirm a
// "collection day" to someone asking us to PAUSE their collections.
//
// One template cannot cover four different things, so it no longer tries.

function confirmationSubject(request) {
  switch (request.kind) {
    case "hold":   return "We got your hold request";
    case "missed": return "We got your missed pickup report";
    case "update": return "We got your account change";
    default:       return "We got your Evergreen compost request";
  }
}

function confirmationBody(request) {
  const hi = `Hi ${request.name},\n\n`;
  const sign = "\n\nEverGreen ZeroWaste";
  // Only mention the detail line when there is one to mention.
  const detail = request.detail ? `\n\nWhat we have: ${request.detail}` : "";

  switch (request.kind) {
    case "hold":
      return hi
        + "Thanks — we've got your request to pause collections."
        + detail
        + "\n\nAlyssa's team will confirm the dates with you. Your service "
        + "resumes automatically at the end of the hold."
        + sign;

    case "missed":
      return hi
        + "Thanks for letting us know — we've logged the missed pickup and "
        + "someone will look into what happened."
        + detail
        + "\n\nWe'll be in touch within one business day."
        + sign;

    case "update":
      return hi
        + "Thanks — we've got your account change request."
        + detail
        + "\n\nAlyssa's team will make the change and follow up with you."
        + sign;

    default: {
      const where = request.address
        ? ` for ${request.address}${request.city ? ", " + request.city : ""}`
        : "";
      return hi
        + `Thanks — we've got your request${where}.`
        + "\n\nSomeone will be in touch to confirm your collection day."
        + sign;
    }
  }
}

async function sendConfirmation(request) {
  const key = process.env.RESEND_API_KEY;
  const verifiedFrom = process.env.REQUESTS_FROM_EMAIL;

  // Two ways this is allowed to send, and no third.
  //
  //   A verified sending domain — the real setup. Goes to anyone.
  //
  //   Practice: the "customer" is us. Resend's sandbox sender only delivers to
  //   the address the account was registered with, so submitting a request
  //   with our own address puts BOTH emails — the notification and the
  //   customer confirmation — in our own inbox. That is how you rehearse the
  //   whole loop without owning a sending domain.
  //
  // What is still refused is the dangerous middle: sandbox sender, real
  // customer address. That would log "sent" for mail nobody receives, which
  // is the failure this codebase keeps having to dig out.
  const notifyTo = (getSettings().notify_email || "").trim().toLowerCase();
  const isPractice = Boolean(request.email) &&
    request.email.trim().toLowerCase() === notifyTo;

  const from = verifiedFrom || (isPractice ? SANDBOX_FROM : "");

  if (key && !from && request.email) {
    console.log(
      `[requests] ${request.id} confirmation NOT sent to ${request.email} — ` +
      `no verified sending domain. Set REQUESTS_FROM_EMAIL, or submit with ` +
      `${notifyTo || "the notify address"} to rehearse it.`
    );
  }

  if (!key || !from || !request.email) {
    console.log(`[requests] ${request.id} stored; confirmation email not sent (not configured)`);
    return;
  }
  await sendMail({
    from,
    to: request.email,
    subject: confirmationSubject(request),
    text: confirmationBody(request),
  });
  console.log(`[requests] ${request.id} confirmation email sent`);
}

// --- Evening digest ------------------------------------------------------
//
// "What was skipped, what needs follow-up, what complaints came in" — built
// from what the day already recorded, so it cannot disagree with the board.
//
// Sent on a timer inside the web process rather than as a Render cron job:
// the digest reads the SQLite file on the persistent disk, and a cron job is
// a separate container that would not have it mounted.

/* One place that talks to Resend. notifyNewRequest and sendConfirmation each
   grew their own copy of this fetch; a third would have been the point where
   they start to differ. */
async function sendMail({ to, subject, text, from }) {
  const key = process.env.RESEND_API_KEY;
  from = from || process.env.REQUESTS_FROM_EMAIL || SANDBOX_FROM;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!r.ok) throw new Error("Resend responded " + r.status);
}

/**
 * @param force  a hand-triggered send goes out even on a quiet day — someone
 *               who pressed the button is owed an answer, unlike the timer.
 */
async function sendDigest({ force = false } = {}) {
  const { notify_email: to, digest_enabled: enabled } = getSettings();
  const digest = buildDigest();

  if (!force && enabled !== "1") return { sent: false, reason: "digest disabled", digest };
  if (!to) return { sent: false, reason: "no recipient set", digest };
  if (!force && digest.empty) return { sent: false, reason: "nothing happened today", digest };
  if (!process.env.RESEND_API_KEY) {
    console.log(`[digest] would send to ${to}:\n${digestText(digest, publicBaseUrl())}`);
    return { sent: false, reason: "email not configured", digest };
  }

  await sendMail({ to, subject: digestSubject(digest), text: digestText(digest, publicBaseUrl()) });
  console.log(`[digest] sent to ${to}`);
  return { sent: true, digest };
}

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || "https://evergreen-driver-app.onrender.com";
}

/* Checked every minute against the valley's clock rather than scheduled with
   a 24-hour setTimeout: Render restarts the process on every deploy, and a
   long timer would be thrown away each time — on a busy week the digest would
   simply never fire. A restart at 6:05pm still sends today's.
   
   sentOn is the local date string, so the digest goes once a day however many
   times the minute is checked or the process restarts. */
let digestSentOn = "";

function digestTick() {
  try {
    const { digest_enabled: enabled, digest_hour: hourStr } = getSettings();
    if (enabled !== "1") return;
    const hour = Number(hourStr);
    if (!Number.isInteger(hour)) return;

    const now = new Date();
    const { hour: localHour } = localClock(now);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: DIGEST_TZ }).format(now);
    if (digestSentOn === today) return;
    if (localHour < hour) return;

    digestSentOn = today;                       // set BEFORE awaiting, so a
                                                // slow send cannot double-fire
    sendDigest().then(r => {
      if (!r.sent && r.reason !== "nothing happened today") {
        console.log(`[digest] not sent — ${r.reason}`);
      }
    }).catch(err => console.warn("[digest] failed:", err.message));
  } catch (err) {
    console.warn("[digest] tick failed:", err.message);
  }
}

/* Preview. Behind the gate like every other office screen, and read-only —
   this is what tonight's email WOULD say. */
app.get("/api/digest", (req, res) => {
  const digest = buildDigest();
  res.json({
    settings: getSettings(),
    tz: DIGEST_TZ,
    subject: digestSubject(digest),
    text: digestText(digest, publicBaseUrl()),
    digest,
  });
});

app.post("/api/digest/send", async (req, res) => {
  try {
    const result = await sendDigest({ force: true });
    res.json({ ok: result.sent, reason: result.reason || null, subject: digestSubject(result.digest) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
/* The top bar's settings, written into every page as a tiny <style>.
 *
 * The bar is on pages that deliberately do NOT load the style system — the
 * error log and the notes page set their own palettes, and the editor pushes
 * its values as inline styles on :root, which would override them. Serving
 * just the four bar colours plus the name from here keeps the bar editable
 * everywhere without letting the rest of the editor near those pages.
 *
 * Cached, and thrown away whenever styles are saved.
 */
let chromeTagCache = null;

/* Values come from the editor, so they are arbitrary text typed by a person.
 * Anything that could close the style element or start a declaration of its
 * own is removed rather than escaped — none of it belongs in a colour or a
 * company name. */
function cssSafe(value) {
  return String(value == null ? "" : value).replace(/[<>{};\\"']/g, "").trim().slice(0, 60);
}

function chromeTag() {
  if (chromeTagCache) return chromeTagCache;
  const s = getStyles();
  const pick = (key, fallback) => cssSafe(s[key]) || fallback;
  chromeTagCache =
    '<style id="chrome-vars">:root{' +
    '--appbar-bg:' + pick("--appbar-bg", "#111611") + ';' +
    '--appbar-border:' + pick("--appbar-border", "#2a332d") + ';' +
    '--appbar-text:' + pick("--appbar-text", "#ffffff") + ';' +
    '--appbar-link:' + pick("--appbar-link", "#9fb8a8") + ';' +
    '--appbar-name:"' + pick("appbar-name", "EverGreen") + '";' +
    '--appbar-mark:"' + pick("appbar-mark", "🌿") + '"' +
    '}</style>';
  return chromeTagCache;
}

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
    // Last thing in the head, so it beats chrome.css's fallbacks.
    const withChrome = html.includes('</head>')
      ? html.replace('</head>', chromeTag() + '\n</head>')
      : html;
    res.type('html').send(stampAssets(withChrome));
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

/* No page carries a <link rel="icon">, so browsers fall back to asking for
   /favicon.ico. Serving the leaf here answers that one request everywhere at
   once, instead of adding a tag to twenty-odd pages. It is an SVG under an
   .ico path on purpose: browsers read the Content-Type, not the extension. */
app.get("/favicon.ico", (req, res) => {
  res.type("image/svg+xml")
     .setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(PUBLIC_DIR, "favicon.svg"));
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

/* Everything the board shows is recorded on its way out.
 *
 * Doing it here rather than at each call site means a broadcast added later
 * cannot be forgotten — the live feed and the day's record are fed by the
 * same line, so they cannot drift apart. activity.js decides what is worth
 * keeping, and ignores simulated events. */
function broadcast(message) {
  recordActivity(message);
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
  /* Say where the database went, every boot, in the log.
   *
   * /health has answered this since July, but only for somebody who can reach
   * the site — and the one thing it settles is whether a deploy quietly wipes
   * the settings, the offline queue and the hazards. That belongs in the
   * deploy log, where it is the first thing anybody looking at a restart
   * sees. DATA_DIR unset means the disk is not mounted where the code
   * writes, and the fix is one environment variable in the Render dashboard,
   * not a change here. */
  const dbDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  console.log(
    process.env.DATA_DIR
      ? `Database on the persistent disk at ${dbDir} — survives deploys.`
      : `WARNING: DATA_DIR is not set, so the database is at ${dbDir}, inside ` +
        `the container. Styles, activity, the offline queue and hazard ` +
        `reports are LOST on every deploy. Set DATA_DIR=/data in the Render ` +
        `dashboard.`
  );
  auditColumns();
  pruneActivity();
  digestTick();                                  // catch a restart after the hour
  setInterval(digestTick, 60 * 1000).unref();
});
