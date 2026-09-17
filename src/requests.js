// requests.js — the staging list behind "website form → auto-routing".
//
// A new-customer submission from the Evergreen website lands here first. It is
// NOT written into the route sheet on arrival: an unauthenticated form posting
// straight into the sheet drivers work from would be an obvious way to get
// junk, or worse, in front of a driver. Requests sit in SQLite until Alyssa
// approves one, and only then does a row get appended to a route tab.
//
// Lives in the same database file as the style settings, which is on Render's
// persistent disk (DATA_DIR), so the queue survives a deploy.

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

db.exec(`CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  address     TEXT NOT NULL,
  city        TEXT,
  service     TEXT,
  notes       TEXT,
  source      TEXT,
  decided_at  TEXT,
  decided_tab TEXT
)`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_status
         ON requests (status, created_at)`);

export const REQUEST_STATUSES = ["pending", "approved", "declined"];

// ── Validation ────────────────────────────────────────────────────────────
// This endpoint is public by necessity — a website form has no access code —
// so nothing is trusted. Every field is capped, and anything not listed is
// dropped rather than stored.

const LIMITS = {
  name: 120, email: 160, phone: 40, address: 200,
  city: 80, service: 60, notes: 1000, source: 40,
};

function clean(value, max) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")   // strip control chars
    .trim()
    .slice(0, max);
}

/** Returns { ok, errors, value } — never throws on bad input. */
export function validateRequest(body) {
  const errors = [];
  const value = {};

  for (const [field, max] of Object.entries(LIMITS)) {
    value[field] = clean(body?.[field], max);
  }

  if (!value.name) errors.push("name is required");
  if (!value.address) errors.push("address is required");
  if (!value.email && !value.phone) {
    errors.push("an email address or a phone number is required");
  }
  if (value.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.email)) {
    errors.push("that email address does not look right");
  }

  return { ok: errors.length === 0, errors, value };
}

// ── Store ─────────────────────────────────────────────────────────────────

export function createRequest(value, source = "website") {
  const id = "REQ-" + randomUUID().slice(0, 8).toUpperCase();
  db.prepare(`INSERT INTO requests
    (id, created_at, status, name, email, phone, address, city, service, notes, source)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, new Date().toISOString(), value.name, value.email, value.phone,
         value.address, value.city, value.service, value.notes, source);
  return getRequest(id);
}

export function getRequest(id) {
  return db.prepare("SELECT * FROM requests WHERE id = ?").get(id) || null;
}

export function listRequests({ status, limit = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  if (status && REQUEST_STATUSES.includes(status)) {
    return db.prepare(
      "SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC LIMIT ?"
    ).all(status, lim);
  }
  return db.prepare(
    "SELECT * FROM requests ORDER BY created_at DESC LIMIT ?"
  ).all(lim);
}

export function countByStatus() {
  const rows = db.prepare(
    "SELECT status, COUNT(*) AS n FROM requests GROUP BY status"
  ).all();
  const out = { pending: 0, approved: 0, declined: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** Mark decided. Returns the updated row, or null if it was already decided. */
export function decideRequest(id, status, tabName = null) {
  if (!REQUEST_STATUSES.includes(status) || status === "pending") return null;
  const row = getRequest(id);
  if (!row || row.status !== "pending") return null;   // no double-approving
  db.prepare(
    "UPDATE requests SET status = ?, decided_at = ?, decided_tab = ? WHERE id = ?"
  ).run(status, new Date().toISOString(), tabName, id);
  return getRequest(id);
}

// ── Spam control ──────────────────────────────────────────────────────────
// Deliberately in-memory: a restart clearing the counters is fine, and it
// avoids a disk write per drive-by request. Not a substitute for a real WAF,
// but enough that a bored script cannot fill the queue in a minute.

const hits = new Map();          // ip → timestamps
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;

export function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();        // crude, bounded
  return recent.length > MAX_PER_WINDOW;
}
