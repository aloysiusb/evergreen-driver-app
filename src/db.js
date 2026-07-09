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
