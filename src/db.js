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
  // Global
  "--bg":               "#f4f4f5",
  "--surface":          "#ffffff",
  "--border":           "#e4e4e7",
  "--text":             "#18181b",
  "--text-muted":       "#71717a",
  "--home-header-bg":   "#18181b",
  "--home-header-text": "#ffffff",
  "--radius":           "12",
  "--font-size":        "16",
  "--font-weight":      "400",
  "--line-height":      "1.5",
  "--route-card-radius":     "16",
  "--home-header-padding":   "36",
  // Driver page — done button
  "--done-btn-bg":           "#22c55e",
  "--done-btn-text":         "#ffffff",
  "--done-btn-done-bg":      "#93c5fd",
  // Driver page — stop cards
  "--route-header-text":     "#ffffff",
  "--stop-done-bg":          "#f0fdf4",
  "--stop-done-border":      "#bbf7d0",
  "--action-bar-bg":         "#ffffff",
  "--action-btn-bg":         "#ffffff",
  "--action-btn-text":       "#71717a",
  "--action-btn-border":     "#e4e4e7",
  // Home page content
  "site-logo":          "🌿",
  "site-heading":       "Evergreen Compost",
  "site-subhead":       "Tap your route to get started",
  // Route card text (applies to all cards on home page)
  "route-card-text":        "#ffffff",
  // Per-route colors (card bg + driver header)
  "route-tues-dv":          "#0ea5e9",
  "route-tues-4wd":         "#f97316",
  "route-weds-res":         "#22c55e",
  "route-weds-commercial":  "#a855f7",
  "route-thurs-uv":         "#06b6d4",
  "route-thurs-comeagle":   "#ef4444",
  "route-friday":           "#eab308",
  "route-monday":           "#ec4899",
  "route-max-routes":       "#6366f1",
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
