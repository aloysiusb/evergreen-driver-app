// geocache.js — remember where an address is, so Google is asked once ever.
//
// The map geocoded every stop on the round every single time it opened. A
// fifty-stop route is fifty billed lookups, and the same fifty again on the
// next open, and again for the next driver, and again on every test drive.
// September's usage report showed 11,542 Geocoding calls on a round of a
// couple of hundred addresses that had not moved since.
//
// Addresses do not move. So the answer is kept here, keyed by the exact
// string the app asked about, and the browser only troubles Google for the
// ones nobody has looked up before.
//
// On the app's own disk beside everything else, so it survives deploys. There
// is nothing private in it: a street address and the coordinates of that
// street address, both of which are already in the route sheet.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

db.exec(`CREATE TABLE IF NOT EXISTS geocache (
  address TEXT PRIMARY KEY,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  at      TEXT NOT NULL
)`);

/* The key is the address as asked, with the edges tidied and the case
   flattened — "118 Cascade Ave, Carbondale, CO" and "118 CASCADE AVE,
   Carbondale, CO " are one address and must not be two rows, or the cache
   misses and Google is paid twice for the same answer. */
function key(address) {
  return String(address || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Everything known, as { "<address key>": { lat, lng } }. */
export function allKnown() {
  const rows = db.prepare("SELECT address, lat, lng FROM geocache").all();
  const out = {};
  for (const r of rows) out[r.address] = { lat: r.lat, lng: r.lng };
  return out;
}

/**
 * Remember a batch the browser has just looked up.
 *
 * Silently skips anything that is not a real pair of coordinates rather than
 * throwing: a bad row from one stop should not lose the other forty-nine, and
 * a wrong number cached forever is worse than one not cached at all.
 */
export function remember(entries) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO geocache (address, lat, lng, at) VALUES (?, ?, ?, ?)");
  const now = new Date().toISOString();
  let saved = 0;
  for (const e of entries || []) {
    const k = key(e && e.address);
    const lat = Number(e && e.lat), lng = Number(e && e.lng);
    if (!k) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    stmt.run(k, lat, lng, now);
    saved++;
  }
  return saved;
}

/** For the forget-this-address case: an address the sheet has corrected. */
export function forget(address) {
  const k = key(address);
  if (!k) return false;
  return db.prepare("DELETE FROM geocache WHERE address = ?").run(k).changes > 0;
}

export function count() {
  return db.prepare("SELECT COUNT(*) AS n FROM geocache").get().n;
}

export { key as cacheKey };
