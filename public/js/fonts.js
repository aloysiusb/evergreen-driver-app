/* fonts.js — the typefaces the style panel can choose between.
 *
 * Shared by the driver pages and the style editor so there is one list, not
 * two that drift apart.
 *
 * Picking a font is not just naming it: the browser has to fetch it. Setting
 * --font-display to "Fraunces" on a page that only ever linked Source Serif
 * gets you the fallback and a confused look. So each choice carries the Google
 * Fonts query it needs, and applyFont() injects that stylesheet the first time
 * the font is used — once per family, no matter how often it is re-applied.
 *
 * Every stack ends in a real system fallback, so a font that fails to load
 * degrades to something sensible rather than to Times.
 */

const FONT_CHOICES = {
  // ── Serif — for headings that want some voice ──────────────────────────
  'Source Serif 4': {
    stack: "'Source Serif 4', Georgia, serif",
    google: 'Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700',
    note: 'Current. Quiet, newspaper-ish.',
  },
  'Fraunces': {
    stack: "'Fraunces', Georgia, serif",
    google: 'Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700',
    note: 'Warmer, a bit characterful.',
  },
  'Bitter': {
    stack: "'Bitter', Georgia, serif",
    google: 'Bitter:wght@400;600;700',
    note: 'Slab serif. Sturdy, reads well small.',
  },
  'DM Serif Display': {
    stack: "'DM Serif Display', Georgia, serif",
    google: 'DM+Serif+Display',
    note: 'High contrast. Headlines only.',
  },
  'Playfair Display': {
    stack: "'Playfair Display', Georgia, serif",
    google: 'Playfair+Display:wght@500;600;700',
    note: 'Elegant, quite formal.',
  },

  // ── Sans — for headings that want to get out of the way ────────────────
  'Barlow Semi Condensed': {
    stack: "'Barlow Semi Condensed', system-ui, sans-serif",
    google: 'Barlow+Semi+Condensed:wght@500;600;700',
    note: 'Condensed. What the dispatcher board uses.',
  },
  'Archivo': {
    stack: "'Archivo', system-ui, sans-serif",
    google: 'Archivo:wght@500;600;700',
    note: 'Solid grotesque. Very legible.',
  },
  'IBM Plex Sans': {
    stack: "'IBM Plex Sans', system-ui, sans-serif",
    google: 'IBM+Plex+Sans:wght@400;500;600',
    note: 'Matches the body text.',
  },
  'DM Sans': {
    stack: "'DM Sans', system-ui, sans-serif",
    google: 'DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700',
    note: 'Geometric, friendly.',
  },
  'Google Sans Flex': {
    stack: "'Google Sans Flex', -apple-system, sans-serif",
    google: 'Google+Sans+Flex:opsz,wght@6..144,100..1000',
    note: 'What the app used before.',
  },
};

const loadedFonts = new Set();

/* The page links its default faces in the markup so it can render before the
 * style API answers. Without noticing those, applying the default setting
 * would request the very same font a second time on every page load.
 *
 * Matching on the Google query fragment ("Source+Serif+4") rather than the
 * display name means no escaping and no guessing at how the href was written.
 */
(function seedFromMarkup() {
  const hrefs = Array.from(
    document.querySelectorAll('link[href*="fonts.googleapis.com/css2"]')
  ).map((l) => l.href);

  for (const [name, choice] of Object.entries(FONT_CHOICES)) {
    const fragment = 'family=' + choice.google.split(':')[0];
    if (hrefs.some((h) => h.indexOf(fragment) !== -1)) loadedFonts.add(name);
  }
})();

/** Fetch a family's stylesheet once, then hand back its CSS stack. */
function applyFont(cssVar, familyName) {
  const choice = FONT_CHOICES[familyName];
  if (!choice) return null;   // unknown name — leave whatever is there alone

  if (!loadedFonts.has(familyName)) {
    loadedFonts.add(familyName);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=' + choice.google + '&display=swap';
    document.head.appendChild(link);
  }

  if (cssVar) document.documentElement.style.setProperty(cssVar, choice.stack);
  return choice.stack;
}

/** True for the two settings whose value is a family name, not a colour. */
function isFontVar(key) {
  return key === '--font' || key === '--font-display';
}
