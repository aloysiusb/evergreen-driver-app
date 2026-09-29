// hazards.js — what drivers tell each other about the road.
//
// Alyssa asked whether the app could do what Waze does: rockslides, closures,
// police, ice. It cannot use Waze's data — there is no public incidents API,
// and the only feed they publish is a partnership for government road
// authorities. What it CAN do is carry its own drivers' reports, which for a
// handful of trucks on the same valley roads every week is arguably the more
// useful half: a rockslide in a canyon is exactly the thing one driver knows
// and the others are about to need.
//
// Kept in the same database as everything else rather than in memory. A
// warning that vanishes because the server restarted is a warning that was not
// given, and the restart a driver cannot see is the one that will happen while
// the rock is still on the road.
//
// Everything expires. A hazard nobody has cleared is not permanent truth — it
// is one driver's account of one moment, and an hour-old "police here" is
// worse than nothing because it is believed.

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { randomUUID } from "node:crypto";

// Same database and same fallback as activity.js, errors.js and requests.js —
// one file on the persistent disk, not several that end up in different places.
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

db.exec(`CREATE TABLE IF NOT EXISTS hazards (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  tab_name   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cleared_at TEXT
)`);

/* How long each kind is worth believing.
 *
 * Not one number, because these are not one kind of thing. A rockslide or a
 * closure is still there in four hours unless somebody moved it; a patrol car
 * has usually gone in forty minutes, and a stale one teaches drivers to ignore
 * the whole layer. Ice is a morning thing and melts.
 *
 * A driver can clear any of them early, which is what actually keeps the map
 * honest — these are the backstop for when nobody does. */
export const HAZARD_KINDS = {
  rockslide: { label: "Rockslide",   icon: "🪨", minutes: 8 * 60 },
  closure:   { label: "Road closed", icon: "🚧", minutes: 8 * 60 },
  ice:       { label: "Ice",         icon: "🧊", minutes: 4 * 60 },
  police:    { label: "Police",      icon: "🚔", minutes: 45 },
  hazard:    { label: "Hazard",      icon: "⚠️", minutes: 4 * 60 },
};

export function isHazardKind(kind) {
  return Object.prototype.hasOwnProperty.call(HAZARD_KINDS, kind);
}

function rowToHazard(r) {
  const meta = HAZARD_KINDS[r.kind] || HAZARD_KINDS.hazard;
  return {
    id: r.id,
    kind: r.kind,
    label: meta.label,
    icon: meta.icon,
    lat: r.lat,
    lng: r.lng,
    note: r.note || "",
    tabName: r.tab_name || "",
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** File one. Returns the stored hazard, ready to broadcast. */
export function addHazard({ kind, lat, lng, note, tabName }) {
  const meta = HAZARD_KINDS[kind] || HAZARD_KINDS.hazard;
  const now = new Date();
  const expires = new Date(now.getTime() + meta.minutes * 60 * 1000);
  const hazard = {
    id: randomUUID(),
    kind: isHazardKind(kind) ? kind : "hazard",
    lat: Number(lat),
    lng: Number(lng),
    note: String(note || "").slice(0, 200),
    tabName: String(tabName || "").slice(0, 80),
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };

  db.prepare(
    `INSERT INTO hazards (id, kind, lat, lng, note, tab_name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(hazard.id, hazard.kind, hazard.lat, hazard.lng, hazard.note,
        hazard.tabName, hazard.createdAt, hazard.expiresAt);

  return { ...hazard, label: meta.label, icon: meta.icon };
}

/** Everything still worth showing: not expired, not cleared. */
export function liveHazards() {
  const rows = db.prepare(
    `SELECT * FROM hazards
      WHERE cleared_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`
  ).all(new Date().toISOString());
  return rows.map(rowToHazard);
}

/** A driver saying it is gone. Returns false if it was already gone. */
export function clearHazard(id) {
  const info = db.prepare(
    `UPDATE hazards SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL`
  ).run(new Date().toISOString(), String(id));
  return info.changes > 0;
}

/* Old rows are not needed once they have expired — nothing reads them and the
 * board has its own record of the day in activity. Swept on a timer rather
 * than at read time so a quiet week does not leave a table that only ever
 * grows. A fortnight is well past any possible use and still leaves a trail if
 * somebody asks what was reported last Tuesday. */
export function sweepHazards() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM hazards WHERE expires_at < ?`).run(cutoff);
}
