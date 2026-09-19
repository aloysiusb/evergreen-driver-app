/* check-html.mjs — parse every inline <script> in public/*.html.
 *
 * node --check covers .js files. It does not look inside HTML, and the
 * dispatcher board shipped with a regex whose backslashes had been eaten —
 * /https://drive.google.com/S+/ — which meant its entire script failed to
 * parse and the board sat on "Loading routes…" for a day without one error
 * message anyone would see.
 *
 * A page whose script does not parse is a blank page. Worth ten lines.
 *
 *   npm run check
 */
import fs from "node:fs";
import path from "node:path";

const dir = "public";
let bad = 0;
let scripts = 0;

for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".html"))) {
  const full = path.join(dir, file);
  const src = fs.readFileSync(full, "utf8");

  // Inline scripts only — <script src="..."> has nothing between the tags,
  // and those files are checked by node --check separately.
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = m[1];
    if (!body.trim()) continue;
    if (/\btype\s*=\s*["']?(application\/json|text\/template)/.test(m[0])) continue;
    scripts++;
    const line = src.slice(0, m.index).split("\n").length;
    try {
      new Function(body);
    } catch (err) {
      bad++;
      console.error(`FAIL ${full}:${line} — ${err.message}`);
    }
  }
}

console.log(`${scripts} inline scripts checked, ${bad} broken`);
process.exit(bad ? 1 : 0);
