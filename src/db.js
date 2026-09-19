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
  "--bg":               "#0f1612",
  "--surface":          "#17201a",
  "--border":           "#2a372e",
  "--text":             "#e5ece7",
  "--text-muted":       "#8ea395",
  // ── Corner radius scale (see public/css/tokens.css) ─────
  // Roles, not sizes. Every border-radius in the app resolves
  // to one of these, so corners stay consistent site-wide.
  "--r-chip":           "4",   // badges, swatches, tiny tags
  "--r-control":        "6",   // inputs, small buttons
  "--r-card":           "9",   // cards, table wrappers, callouts
  "--r-panel":          "12",  // large containers, modals
  "--r-sheet":          "20",  // bottom sheets
  // Family NAMES, not CSS stacks — fonts.js turns one into the other and
  // fetches the webfont. Storing the stack here would mean the font was named
  // but never loaded.
  "--font":             "IBM Plex Sans",
  "--font-display":     "Source Serif 4",
  "--font-size":        "16",
  "--font-weight":      "400",
  "--line-height":      "1.5",

  // ── Home header ─────────────────────────────────────────
  "--home-header-bg":          "#17201a",
  "--home-header-text":        "#e5ece7",
  "--home-header-padding":     "36",
  "--home-heading-font-size":  "22",
  "--home-heading-font-weight":"800",
  "--home-subhead-font-size":  "14",
  "--home-subhead-font-weight":"400",

  // ── Home page content ────────────────────────────────────
  "site-logo":    "",
  "site-heading": "Evergreen Compost",
  "site-subhead": "Tap your route to get started",

  // ── Route cards (home page) ──────────────────────────────
  "--route-card-radius": "16",
  "route-card-text":     "#ffffff",
  "route-tues-dv":         "#3d7f91",
  "route-tues-4wd":        "#a06a3e",
  "route-weds-res":        "#4a8a5e",
  "route-weds-commercial": "#6e5f8a",
  "route-thurs-uv":        "#3f8a80",
  "route-thurs-comeagle":  "#9a5b52",
  "route-friday":          "#8a7c42",
  "route-monday":          "#8a5a70",
  "route-max-routes":      "#5a6a8a",

  // ── Route header (driver page) ───────────────────────────
  "--route-header-text":         "#f2f7f4",
  "--route-title-font-size":     "22",
  "--route-title-font-weight":   "700",
  "--progress-bar-fill":         "#63b681",

  // ── Section headers ──────────────────────────────────────
  "--section-header-font-size":      "11.5",
  "--section-header-font-weight":    "700",
  "--completed-section-bg":          "#e6f0e9",
  "--completed-section-text":        "#2f6b46",
  "--completed-section-border":      "#c4dccd",

  // ── Stop card ────────────────────────────────────────────
  "--stop-card-bg":     "#ffffff",
  "--stop-card-text":   "#16211a",
  "--stop-account-font-size":   "16",
  "--stop-account-font-weight": "600",
  "--stop-address-font-size":   "13",
  "--stop-address-font-weight": "400",
  "--stop-done-bg":             "#e6f0e9",
  "--stop-done-border":         "#c4dccd",

  // ── Note chips ───────────────────────────────────────────
  "--urgent-bg":         "#fbe4df",
  "--urgent-text":       "#8c3322",
  "--hold-bg":           "#fbf0d9",
  "--hold-text":         "#7a5210",
  "--stop-note-font-size":   "13",
  "--stop-note-font-weight": "400",

  // ── Note textarea ────────────────────────────────────────
  "--note-edit-bg":          "#ffffff",
  "--note-edit-font-size":   "13",
  "--note-edit-font-weight": "400",

  // ── Done button ──────────────────────────────────────────
  "--done-btn-bg":      "#2d7d4f",
  "--done-btn-text":    "#f2f7f4",
  "--done-btn-done-bg": "#3f5f52",

  // ── Map / Directions buttons ─────────────────────────────
  "--action-btn-bg":         "#f2f5f2",
  "--action-btn-text":       "#5d7065",
  "--action-btn-border":     "#d7e0d9",
  "--action-btn-font-size":  "12",
  "--action-btn-font-weight":"500",

  // ── Bottom action bar ────────────────────────────────────
  "--action-bar-bg": "#131c16",

  // ── Primary button (Day Complete / Start My Day) ─────────
  "--primary-btn-text":        "#f2f7f4",
  "--primary-btn-font-size":   "14",
  "--primary-btn-font-weight": "600",

  // ── Dispatcher board ─────────────────────────────────────
  // Inputs, not the live variables. dispatch.html reads these through
  // var(--dispatch-*, fallback) so its light/dark toggle keeps working —
  // see the comment at the top of that file's stylesheet.
  "--dispatch-bg":            "#f2f7f3",
  "--dispatch-surface":       "#ffffff",
  "--dispatch-border":        "#d4e8d8",
  "--dispatch-text":          "#1a2b1d",
  "--dispatch-muted":         "#5e7e63",
  "--dispatch-muted-bg":      "#e8f2ea",
  "--dispatch-accent":        "#16a34a",
  "--dispatch-warn":          "#d97706",
  "--dispatch-danger":        "#dc2626",
  "--dispatch-dark-bg":       "#0c160e",
  "--dispatch-dark-surface":  "#141f16",
  "--dispatch-dark-border":   "#1e3022",
  "--dispatch-dark-text":     "#e2ede4",
  "--dispatch-dark-muted":    "#6b9070",
  "--dispatch-dark-muted-bg": "#1a2e1d",
  "--dispatch-dark-accent":   "#4ade80",
  "--dispatch-dark-warn":     "#fbbf24",
  "--dispatch-dark-danger":   "#f87171",

  // ── Toast notification ───────────────────────────────────
  "--toast-bg":          "#e5ece7",
  "--toast-text":        "#14241b",
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
