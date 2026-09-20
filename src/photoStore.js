// photoStore.js — where a driver's photo goes when Drive will not take it.
//
// Google refuses the obvious arrangement: a service account has no storage of
// its own, so it cannot own a file inside a person's Drive folder. The ways
// round that are a Shared Drive or domain-wide delegation, both of which need
// Google Workspace and an administrator. Neither is something a driver can
// wait for.
//
// So photos land on the app's own persistent disk and are served back by the
// app. That works today, with nothing to configure, and the link in the sheet
// opens the picture like any other link. If a Shared Drive is set up later,
// drive.js takes over and this stays as the fallback.
//
// The disk is 1 GB and a shrunk photo is 60-120 KB, so roughly ten thousand
// fit. Oldest are pruned past the cap rather than letting a full disk take the
// whole app down with it.

import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.env.DATA_DIR || "/data", "photos");
const MAX_BYTES = 700 * 1024 * 1024;   // leaves room for the database and logs

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

export function photoDir() {
  return DIR;
}

/** Only ever serve names this module generates. */
export function isSafeName(name) {
  return /^[0-9]{13}-[a-z0-9]{6}\.(jpg|webp)$/.test(String(name || ""));
}

export function pathFor(name) {
  return isSafeName(name) ? path.join(DIR, name) : null;
}

function listOldestFirst() {
  let names;
  try { names = fs.readdirSync(DIR); } catch { return []; }
  return names
    .filter(isSafeName)
    .map(name => {
      try {
        const st = fs.statSync(path.join(DIR, name));
        return { name, bytes: st.size, at: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

export function usage() {
  const files = listOldestFirst();
  return { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/* A full disk is worse than a missing old photo: if the database cannot be
   written the whole app stops. Prune from the oldest until back under. */
function pruneIfNeeded() {
  const files = listOldestFirst();
  let total = files.reduce((n, f) => n + f.bytes, 0);
  let removed = 0;
  for (const f of files) {
    if (total <= MAX_BYTES) break;
    try {
      fs.unlinkSync(path.join(DIR, f.name));
      total -= f.bytes;
      removed++;
    } catch { /* already gone */ }
  }
  if (removed) console.log(`[photos] pruned ${removed} old photo(s) to stay under the cap`);
}

/**
 * Save one image and return how to reach it.
 * Throws with a readable message — the caller must never report success for a
 * photo that did not land.
 */
export function savePhoto(buffer, mimeType) {
  if (!buffer || !buffer.length) throw new Error("No image received.");
  ensureDir();
  pruneIfNeeded();

  const ext = mimeType === "image/webp" ? "webp" : "jpg";
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(DIR, name), buffer);

  return { id: name, name, link: "/photos/" + name, store: "disk" };
}
