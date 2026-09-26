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
  kind        TEXT NOT NULL DEFAULT 'new_customer',
  detail      TEXT,
  decided_at  TEXT,
  decided_tab TEXT
)`);

// Added after the first release, so bring existing databases forward rather
// than requiring the disk to be wiped.
for (const [col, decl] of [
  ["kind", "TEXT NOT NULL DEFAULT 'new_customer'"],
  ["detail", "TEXT"],
  /* What QuickBooks did when this was approved. Recorded rather than assumed:
     the approval succeeds whether or not QBO answered, so the office has to be
     able to see which half happened, and why if it did not. */
  ["qbo_customer_id", "TEXT"],
  ["qbo_invoice_id", "TEXT"],
  ["qbo_pay_link", "TEXT"],
  ["qbo_error", "TEXT"],
  ["plan_amount", "TEXT"],
  ["plan_label", "TEXT"],
]) {
  const present = db.prepare("PRAGMA table_info(requests)").all().some(c => c.name === col);
  if (!present) db.exec(`ALTER TABLE requests ADD COLUMN ${col} ${decl}`);
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_status
         ON requests (status, created_at)`);

export const REQUEST_STATUSES = ["pending", "approved", "declined"];

// What the customer portal can raise. Only new_customer ends up appended to a
// route tab; the rest are things the office acts on, so approving them just
// marks them handled.
export const REQUEST_KINDS = ["new_customer", "hold", "missed", "update"];
export const KIND_LABELS = {
  new_customer: "New customer",
  hold: "Service hold",
  missed: "Missed pickup",
  update: "Account update",
};

// ── Validation ────────────────────────────────────────────────────────────
// This endpoint is public by necessity — a website form has no access code —
// so nothing is trusted. Every field is capped, and anything not listed is
// dropped rather than stored.

const LIMITS = {
  name: 120, email: 160, phone: 40, address: 200,
  city: 80, service: 60, notes: 1000, source: 40, detail: 300,
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

  value.kind = REQUEST_KINDS.includes(body?.kind) ? body.kind : "new_customer";
  value.detail = clean(body?.detail, 300);

  if (!value.name) errors.push("name is required");
  // Only a new customer has to give an address — someone asking for a hold on
  // an account we already have does not need to retype where they live.
  if (value.kind === "new_customer" && !value.address) {
    errors.push("address is required");
  }
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
    (id, created_at, status, name, email, phone, address, city, service, notes, source, kind, detail)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, new Date().toISOString(), value.name, value.email, value.phone,
         value.address, value.city, value.service, value.notes, source,
         value.kind || "new_customer", value.detail || "");
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

/**
 * Record what QuickBooks did for an already-decided request.
 *
 * Separate from decideRequest on purpose: the approval is committed the moment
 * the route sheet write lands, and this fills in afterwards. A QBO failure
 * writes qbo_error and nothing else, so the office can see the customer is on
 * a route but not yet invoiced.
 */
export function recordQbo(id, { customerId, invoiceId, payLink, error, amount, label } = {}) {
  const row = getRequest(id);
  if (!row) return null;
  db.prepare(
    `UPDATE requests SET
       qbo_customer_id = ?, qbo_invoice_id = ?, qbo_pay_link = ?, qbo_error = ?,
       plan_amount = ?, plan_label = ?
     WHERE id = ?`
  ).run(
    customerId ?? row.qbo_customer_id ?? null,
    invoiceId  ?? row.qbo_invoice_id  ?? null,
    payLink    ?? row.qbo_pay_link    ?? null,
    error      ?? null,
    amount     ?? row.plan_amount     ?? null,
    label      ?? row.plan_label      ?? null,
    id
  );
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

// ── Settings ──────────────────────────────────────────────────────────────
// Who gets told when a request comes in. Kept in the database rather than an
// env var so it can be changed from the approval screen without a redeploy —
// the same reasoning as the style settings.

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

const SETTING_DEFAULTS = {
  notify_email: "perryaloysius@gmail.com",
  notify_enabled: "1",
  // The evening digest. Goes to notify_email — one address to keep current,
  // not two that drift apart.
  digest_enabled: "1",
  digest_hour: "18",          // local to DIGEST_TZ, 0–23
};

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : (SETTING_DEFAULTS[key] ?? "");
}

export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM settings").all()) {
    if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  }
  return out;
}

export function setSettings(patch) {
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in SETTING_DEFAULTS)) continue;
    if (key === "notify_email") {
      const v = String(value).trim().slice(0, 160);
      // Empty is allowed — it means "stop emailing me".
      if (v && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)) continue;
      stmt.run(key, v);
    } else if (key === "digest_hour") {
      /* An hour, not a flag — the "1"/"0" coercion below would turn 18 into
         "0" and quietly move the digest to midnight. */
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 23) continue;
      stmt.run(key, String(n));
    } else {
      stmt.run(key, String(value) === "1" ? "1" : "0");
    }
  }
  return getSettings();
}
