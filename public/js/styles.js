/* styles.js — the one place that turns saved style settings into live CSS.
 *
 * Every page that should follow the style editor includes this and calls
 * initStyles() once. Before it existed the same fetch-and-apply loop was
 * written out separately in index.html and driver.js, and the dispatcher board
 * had no copy at all, which is why it ignored the editor entirely.
 *
 * Requires style-units.js (needsPx, shouldApplyStyleVar) and fonts.js
 * (isFontVar, applyFont), loaded before it.
 */
(function () {
  const root = document.documentElement;

  /* Values arrive unitless from SQLite, and some are font family NAMES rather
     than CSS values, so neither can simply be assigned. */
  function applyStyleVars(styles) {
    if (!styles) return;
    for (const [key, val] of Object.entries(styles)) {
      if (!key.startsWith('--')) continue;
      if (typeof shouldApplyStyleVar === 'function' && !shouldApplyStyleVar(key)) continue;
      if (typeof isFontVar === 'function' && isFontVar(key)) applyFont(key, val);
      else root.style.setProperty(key, typeof needsPx === 'function' && needsPx(key) ? val + 'px' : val);
    }
  }

  /* The paint button, so the editor is reachable from the page you are looking
     at rather than only by knowing the URL. Opt-in per page via
     <html data-style-button> — deliberately not automatic, because it must
     never appear on the customer portal. */
  function addStyleButton() {
    if (!root.hasAttribute('data-style-button')) return;
    if (document.querySelector('.style-link')) return;
    const a = document.createElement('a');
    a.className = 'style-link';
    a.href = '/admin';
    a.title = 'Open the style editor';
    a.setAttribute('aria-label', 'Open the style editor');
    a.textContent = '\u{1F3A8}';
    document.body.appendChild(a);
  }

  /**
   * Fetch the saved styles, apply them, and keep applying them as they change.
   *
   * @param onStyles   optional — for the page-specific bits that are not plain
   *                   CSS variables (route card colours, editable headings).
   * @param opts.socket open a WebSocket of this page's own. Pages that already
   *                    have one should leave this off and call
   *                    window.onStyleMessage(msg) from their existing handler
   *                    instead, rather than holding a second connection open.
   */
  window.initStyles = function (onStyles, opts) {
    const handle = (styles) => {
      applyStyleVars(styles);
      if (typeof onStyles === 'function') onStyles(styles);
    };

    // A failed fetch is survivable: the stylesheet's own values still stand.
    // Never leave the page unstyled because the settings did not load.
    fetch('/api/styles').then(r => r.json()).then(handle).catch(() => {});

    window.onStyleMessage = function (msg) {
      if (msg && msg.type === 'style-updated') handle(msg.styles);
    };

    if (opts && opts.socket) {
      const connect = () => {
        const ws = new WebSocket(
          // The server mounts its WebSocket at /ws. Without the path the
          // handshake is refused and this quietly retries forever.
          (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
        );
        ws.onmessage = (e) => {
          try { window.onStyleMessage(JSON.parse(e.data)); } catch (err) { /* not ours */ }
        };
        ws.onclose = () => setTimeout(connect, 4000);
      };
      connect();
    }

    if (document.body) addStyleButton();
    else document.addEventListener('DOMContentLoaded', addStyleButton);

    return handle;
  };

  window.applyStyleVars = applyStyleVars;
})();
