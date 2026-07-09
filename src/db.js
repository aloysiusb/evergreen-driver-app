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
  "--bg":            "#e8f0e4",
  "--bg-opacity":    "1",
  "--card-bg":       "#ffffff",
  "--card-opacity":  "1",
  "--text":          "#1a2e17",
  "--header-bg":     "#2d5a27",
  "--header-text":   "#ffffff",
  "--accent":        "#4a9e3f",
  "--done-bg":       "#d6edcf",
  "--done-text":     "#1a5c12",
  "--border":        "#c8dbc4",
  "--font-size":     "15",
  "--font-weight":   "400",
  "--line-height":   "1.5",
  "--radius":        "10",
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
