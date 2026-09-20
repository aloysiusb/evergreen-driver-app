// activity.js — the day's events, kept so the board can be reloaded.
//
// The dispatcher's feed lived entirely in the browser. Reload the page at
// three in the afternoon and the morning had never happened — which is a poor
// property for the one screen the office is asked to leave open all day.
//
// What is stored is the broadcast itself, not a rendered line. The board
// resolves customer names and addresses from the route data it has already
// loaded, so replaying the raw message through the same code path produces
// exactly what would have appeared live. One code path, not two that can
// drift.
//
// Simulated events are deliberately NOT recorded. A test drive is a
// demonstration; it should vanish when the page is reloaded rather than
// silently becoming part of the day's record.

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

// Same database and same fallback as errors.js and requests.js — one file on
// the persistent disk, not three that can end up in different places.
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

db.exec(`CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS activity_at ON activity (at)");

/* Which broadcasts belong in the day's record. Styles and connection notices
   are machinery, not activity. */
const KEPT = new Set([
  "stop-updated",
  "note-updated",
  "photo-added",
  "notes-log-entry",
  "request-created",
  "request-decided",
]);

export function recordActivity(msg) {
  if (!msg || !KEPT.has(msg.type)) return;
  if (msg.sim) return;                 // a demonstration is not the day's work
  try {
    db.prepare("INSERT INTO activity (at, type, payload) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), msg.type, JSON.stringify(msg));
  } catch (err) {
    // Never let recording the day break the thing being recorded.
    console.warn("[activity] could not record:", err.message);
  }
}

/** Today's events, oldest first so the board can replay them in order. */
export function todaysActivity(limit = 300) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  try {
    const rows = db.prepare(
      "SELECT at, payload FROM activity WHERE at >= ? ORDER BY id ASC LIMIT ?"
    ).all(start.toISOString(), limit);
    return rows.map(r => {
      try {
        return { ...JSON.parse(r.payload), at: r.at };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.warn("[activity] could not read:", err.message);
    return [];
  }
}

/* A week is enough to answer "what happened on Tuesday" without the table
   growing without limit. Runs on startup rather than on every write. */
export function pruneActivity(days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const before = db.prepare("SELECT COUNT(*) AS n FROM activity").get().n;
    db.prepare("DELETE FROM activity WHERE at < ?").run(cutoff);
    const after = db.prepare("SELECT COUNT(*) AS n FROM activity").get().n;
    if (before !== after) console.log(`[activity] pruned ${before - after} old entries`);
  } catch (err) {
    console.warn("[activity] could not prune:", err.message);
  }
}
