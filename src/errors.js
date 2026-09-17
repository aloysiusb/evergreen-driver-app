// errors.js — where client-side failures go, so they stop being invisible.
//
// The waypoint bug ran on every driver's phone for months and was found by
// accident, in a console, while looking at something else. This is the fix for
// that class of problem: the app reports its own failures and they pile up
// somewhere you can look.
//
// Two decisions that matter:
//
//   Deduped by fingerprint. One broken line fires thousands of times — once
//   per GPS tick, in this app's case. Storing each occurrence would fill the
//   disk and bury the signal, so identical failures increment a count instead.
//   "208 waypoints, 4,812 times, first seen Tuesday" is the useful shape.
//
//   Bounded. Errors are the one table that grows without anyone choosing to
//   add to it, so the oldest fingerprints are pruned past a cap. A full disk
//   on the route sheet's server is a worse outcome than losing old errors.

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

db.exec(`CREATE TABLE IF NOT EXISTS client_errors (
  fingerprint TEXT PRIMARY KEY,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  kind        TEXT,
  message     TEXT NOT NULL,
  source      TEXT,
  line        INTEGER,
  page        TEXT,
  stack       TEXT,
  agent       TEXT
)`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_client_errors_seen
         ON client_errors (last_seen DESC)`);

const MAX_ROWS = 500;
const LIMITS = { kind: 24, message: 400, source: 200, page: 200, stack: 2000, agent: 200 };

function clean(v, max) {
  if (v == null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/** Same bug, same row — line number included so two bugs in one file stay apart. */
function fingerprintOf(e) {
  return createHash("sha1")
    .update([e.kind, e.message, e.source, e.line].join("|"))
    .digest("hex")
    .slice(0, 16);
}

export function recordError(raw) {
  const e = {
    kind: clean(raw?.kind, LIMITS.kind) || "error",
    message: clean(raw?.message, LIMITS.message),
    source: clean(raw?.source, LIMITS.source),
    line: Number.isFinite(Number(raw?.line)) ? Number(raw.line) : null,
    page: clean(raw?.page, LIMITS.page),
    stack: clean(raw?.stack, LIMITS.stack),
    agent: clean(raw?.agent, LIMITS.agent),
  };
  if (!e.message) return null;

  const fp = fingerprintOf(e);
  const now = new Date().toISOString();

  const existing = db.prepare("SELECT count FROM client_errors WHERE fingerprint = ?").get(fp);
  if (existing) {
    db.prepare("UPDATE client_errors SET count = count + 1, last_seen = ? WHERE fingerprint = ?")
      .run(now, fp);
  } else {
    db.prepare(`INSERT INTO client_errors
      (fingerprint, first_seen, last_seen, count, kind, message, source, line, page, stack, agent)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fp, now, now, e.kind, e.message, e.source, e.line, e.page, e.stack, e.agent);
    prune();
  }
  return fp;
}

function prune() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM client_errors").get().n;
  if (n <= MAX_ROWS) return;
  db.prepare(`DELETE FROM client_errors WHERE fingerprint IN (
    SELECT fingerprint FROM client_errors ORDER BY last_seen ASC LIMIT ?
  )`).run(n - MAX_ROWS);
}

export function listErrors(limit = 200) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), MAX_ROWS);
  return db.prepare(
    "SELECT * FROM client_errors ORDER BY last_seen DESC LIMIT ?"
  ).all(lim);
}

export function errorSummary() {
  const row = db.prepare(
    "SELECT COUNT(*) AS kinds, COALESCE(SUM(count), 0) AS total FROM client_errors"
  ).get();
  const since = db.prepare(
    "SELECT COALESCE(SUM(count), 0) AS n FROM client_errors WHERE last_seen > ?"
  ).get(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  return { distinct: row.kinds, total: row.total, last24h: since.n };
}

export function clearErrors() {
  db.exec("DELETE FROM client_errors");
  return errorSummary();
}
