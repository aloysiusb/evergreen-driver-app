import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "app.db"));

db.exec(`CREATE TABLE IF NOT EXISTS styles (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

export const DEFAULT_STYLES = {
  // ── Global ──────────────────────────────────────────────
  "--bg":               "#f4f4f5",
  "--surface":          "#ffffff",
  "--border":           "#e4e4e7",
  "--text":             "#18181b",
  "--text-muted":       "#71717a",
  // ── Corner radius scale (see public/css/tokens.css) ─────
  // Roles, not sizes. Every border-radius in the app resolves
  // to one of these, so corners stay consistent site-wide.
  "--r-chip":           "4",   // badges, swatches, tiny tags
  "--r-control":        "6",   // inputs, small buttons
  "--r-card":           "9",   // cards, table wrappers, callouts
  "--r-panel":          "12",  // large containers, modals
  "--r-sheet":          "20",  // bottom sheets
  "--font-size":        "16",
  "--font-weight":      "400",
  "--line-height":      "1.5",

  // ── Home header ─────────────────────────────────────────
  "--home-header-bg":          "#18181b",
  "--home-header-text":        "#ffffff",
  "--home-header-padding":     "36",
  "--home-heading-font-size":  "22",
  "--home-heading-font-weight":"800",
  "--home-subhead-font-size":  "14",
  "--home-subhead-font-weight":"400",

  // ── Home page content ────────────────────────────────────
  "site-logo":    "🌿",
  "site-heading": "Evergreen Compost",
  "site-subhead": "Tap your route to get started",

  // ── Route cards (home page) ──────────────────────────────
  "--route-card-radius": "16",
  "route-card-text":     "#ffffff",
  "route-tues-dv":         "#0ea5e9",
  "route-tues-4wd":        "#f97316",
  "route-weds-res":        "#22c55e",
  "route-weds-commercial": "#a855f7",
  "route-thurs-uv":        "#06b6d4",
  "route-thurs-comeagle":  "#ef4444",
  "route-friday":          "#eab308",
  "route-monday":          "#ec4899",
  "route-max-routes":      "#6366f1",

  // ── Route header (driver page) ───────────────────────────
  "--route-header-text":         "#ffffff",
  "--route-title-font-size":     "22",
  "--route-title-font-weight":   "700",
  "--progress-bar-fill":         "#ffffff",

  // ── Section headers ──────────────────────────────────────
  "--section-header-font-size":      "11.5",
  "--section-header-font-weight":    "700",
  "--completed-section-bg":          "#dcfce7",
  "--completed-section-text":        "#15803d",
  "--completed-section-border":      "#bbf7d0",

  // ── Stop card ────────────────────────────────────────────
  "--stop-account-font-size":   "16",
  "--stop-account-font-weight": "600",
  "--stop-address-font-size":   "13",
  "--stop-address-font-weight": "400",
  "--stop-done-bg":             "#f0fdf4",
  "--stop-done-border":         "#bbf7d0",

  // ── Note chips ───────────────────────────────────────────
  "--urgent-bg":         "#fee2e2",
  "--urgent-text":       "#991b1b",
  "--hold-bg":           "#fef3c7",
  "--hold-text":         "#92400e",
  "--stop-note-font-size":   "13",
  "--stop-note-font-weight": "400",

  // ── Note textarea ────────────────────────────────────────
  "--note-edit-bg":          "#ffffff",
  "--note-edit-font-size":   "13",
  "--note-edit-font-weight": "400",

  // ── Done button ──────────────────────────────────────────
  "--done-btn-bg":      "#22c55e",
  "--done-btn-text":    "#ffffff",
  "--done-btn-done-bg": "#93c5fd",

  // ── Map / Directions buttons ─────────────────────────────
  "--action-btn-bg":         "#ffffff",
  "--action-btn-text":       "#71717a",
  "--action-btn-border":     "#e4e4e7",
  "--action-btn-font-size":  "12",
  "--action-btn-font-weight":"500",

  // ── Bottom action bar ────────────────────────────────────
  "--action-bar-bg": "#ffffff",

  // ── Primary button (Day Complete / Start My Day) ─────────
  "--primary-btn-text":        "#ffffff",
  "--primary-btn-font-size":   "14",
  "--primary-btn-font-weight": "600",

  // ── Toast notification ───────────────────────────────────
  "--toast-bg":          "#18181b",
  "--toast-text":        "#ffffff",
  "--toast-font-size":   "13",
  "--toast-font-weight": "400",
};

export function getStyles() {
  const rows = db.prepare("SELECT key, value FROM styles").all();
  const result = { ...DEFAULT_STYLES };
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function setStyles(patch) {
  const stmt = db.prepare("INSERT OR REPLACE INTO styles (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULT_STYLES) stmt.run(key, String(value));
  }
  return getStyles();
}
