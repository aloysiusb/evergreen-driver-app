/* report-errors.js — the app tells us when it breaks.
 *
 * Loaded first on the driver pages. It catches what the browser throws, plus
 * API calls that come back as failures, and posts them somewhere we can look.
 *
 * Rules it follows, because a reporter that misbehaves is worse than none:
 *
 *   It never throws. Everything is wrapped; a broken reporter must not break
 *   the app it is reporting on.
 *   It never blocks. Errors are buffered and flushed on a timer.
 *   It never floods. One bug can fire per GPS tick, so identical messages are
 *   counted locally and a session is capped.
 *   It never reports itself. Its own failed POST is dropped, not queued —
 *   otherwise a server outage becomes an infinite loop.
 *   It sends no page content. Message, source, line, stack and the page URL.
 *   Nothing is read out of the DOM, so customer data stays where it is.
 */
(function () {
  var ENDPOINT = '/api/client-errors';
  var FLUSH_MS = 15000;
  var MAX_PER_SESSION = 25;      // a broken page should not post forever
  var buffer = [];
  var seen = Object.create(null);
  var sent = 0;
  var posting = false;

  function key(e) { return [e.kind, e.message, e.source, e.line].join('|'); }

  function queue(e) {
    try {
      if (sent >= MAX_PER_SESSION) return;
      var k = key(e);
      if (seen[k]) { seen[k]++; return; }   // already going out this flush
      seen[k] = 1;
      buffer.push(e);
      if (buffer.length > 10) flush();
    } catch (_) { /* a reporter must never throw */ }
  }

  function flush() {
    if (posting || !buffer.length) return;
    var batch = buffer.splice(0, buffer.length);
    posting = true;
    sent += batch.length;
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errors: batch }),
        keepalive: true,
      })
        .catch(function () { /* dropped on purpose — see the note above */ })
        .then(function () { posting = false; });
    } catch (_) {
      posting = false;
    }
  }

  window.addEventListener('error', function (ev) {
    queue({
      kind: 'error',
      message: String(ev.message || 'Unknown error'),
      source: String(ev.filename || '').split('/').pop(),
      line: ev.lineno || null,
      stack: ev.error && ev.error.stack ? String(ev.error.stack) : '',
      page: location.pathname,
      agent: navigator.userAgent,
    });
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    queue({
      kind: 'promise',
      message: String((r && (r.message || r)) || 'Unhandled rejection'),
      source: '',
      line: null,
      stack: r && r.stack ? String(r.stack) : '',
      page: location.pathname,
      agent: navigator.userAgent,
    });
  });

  /* API failures are the ones that hid the waypoint bug: no exception, no
     rejection, just a response nobody checked. Wrapping fetch catches them
     without every call site having to remember. */
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return realFetch.apply(this, arguments).then(function (res) {
      try {
        if (!res.ok && url.indexOf('/api/') !== -1 && url.indexOf(ENDPOINT) === -1) {
          queue({
            kind: 'api',
            message: 'HTTP ' + res.status + ' from ' + url.split('?')[0],
            source: url.split('?')[0],
            line: null,
            stack: '',
            page: location.pathname,
            agent: navigator.userAgent,
          });
        }
      } catch (_) {}
      return res;
    });
  };

  /* Something the app can call when it swallows a failure on purpose but
     still wants it counted — the Directions callbacks, for instance. */
  window.reportIssue = function (message, source) {
    queue({
      kind: 'app', message: String(message || '').slice(0, 400),
      source: String(source || ''), line: null, stack: '',
      page: location.pathname, agent: navigator.userAgent,
    });
  };

  setInterval(flush, FLUSH_MS);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
})();
