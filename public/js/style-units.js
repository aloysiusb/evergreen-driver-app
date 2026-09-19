/* Shared by index.html, driver.js and admin.html.
   Style values are stored unitless in SQLite ("12", not "12px"); this decides
   which ones get "px" back when they're written to the DOM. Keep it here only —
   it used to be copy-pasted in three places and had already started to drift. */
function needsPx(key) {
  return key.startsWith('--r-') ||        // corner radius scale (tokens.css)
    key === '--radius' ||
    key.endsWith('-radius') ||            // --route-card-radius, --report-btn-radius
    key.endsWith('-font-size') ||
    key.endsWith('-padding') ||
    // NOT --line-height, which is a bare ratio and would become '1.5px'.
    (key.endsWith('-height') && key !== '--line-height') ||
    key.endsWith('-min-width') ||
    key.endsWith('-gap') ||
    key.endsWith('-space') ||
    key.endsWith('-icon-size');
}

/* Pages that declare a radius preset (data-radius="tight"|"soft" on <html>)
   have deliberately picked their own corner scale. The style editor pushes the
   standard scale, and an inline style on :root beats any stylesheet selector,
   so skip --r-* on those pages rather than flattening them back to standard. */
function shouldApplyStyleVar(key) {
  if (!key.startsWith('--r-')) return true;
  return !document.documentElement.dataset.radius;
}
