/* ─────────────────────────────────────────────────────────────────────────
   sim.js — test drive the REAL driver app from a desk.

   Activates only on ?sim=1. Inert otherwise, so it costs drivers nothing.

   The point is to exercise the code drivers actually run — map.js, driver.js,
   follow mode, arrival prompts, the offline queue — rather than a separate
   mock of it. So it doesn't call into any of that directly. It swaps out the
   two things the app talks to the outside world through:

     navigator.geolocation  → synthetic positions walking the real route
     window.fetch (writes)  → a fake network you can switch off

   Nothing in map.js or driver.js knows it is being simulated, so this file
   cannot quietly drift out of sync with them.

   SAFETY: writes never reach the Google Sheet in sim mode. Every non-GET to
   /api/routes/* is intercepted and logged on screen instead. Alyssa's live
   route data cannot be marked done by a test drive.
   ───────────────────────────────────────────────────────────────────────── */

(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('sim') !== '1') return;   // not a test drive — do nothing

  const API_WRITE_PATH = '/api/routes/';

  // ── Fake network ────────────────────────────────────────────────────────
  // hasSignal drives the offline queue: switch it off and writes reject the
  // way a dead zone rejects them, so you can watch the queue fill and drain.
  let hasSignal = true;
  const writeLog = [];

  const realFetch = window.fetch.bind(window);

  window.fetch = function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    const u = String(url);
    const isWrite = method !== 'GET' && u.includes(API_WRITE_PATH);

    if (!isWrite) {
      // Reads still hit the real server so you drive your real stops, and
      // they fail like everything else when signal is off.
      if (!hasSignal && u.includes('/api/')) {
        return Promise.reject(new TypeError('sim: no signal'));
      }
      return realFetch(url, opts);
    }

    // A write. Never let it leave the browser.
    if (!hasSignal) {
      logWrite('blocked (no signal)', u, opts);
      return Promise.reject(new TypeError('sim: no signal'));
    }
    logWrite('accepted (not sent)', u, opts);
    announce(u, opts);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
  };

  function logWrite(outcome, url, opts) {
    const body = (opts && opts.body) || '';
    const i = url.indexOf(API_WRITE_PATH);
    writeLog.unshift({
      t: new Date().toLocaleTimeString(),
      outcome,
      path: i >= 0 ? url.slice(i + API_WRITE_PATH.length) : url,
      body: String(body),
    });
    if (writeLog.length > 40) writeLog.length = 40;
    renderLog();
  }

  /* The write never leaves the browser — but the dispatcher board is the
     screen you most want to show someone while demonstrating, and it was
     seeing nothing at all.

     So say what happened, to a route that only broadcasts and never opens the
     spreadsheet. Fire and forget: if it fails the test drive carries on
     exactly as before, because nothing depends on it. */
  function announce(url, opts) {
    if (!hasSignal) return;                       // a dead zone is a dead zone
    const m = String(url).match(/\/api\/routes\/([^/]+)\/stops\/(\d+)(\/notes)?/);
    if (!m) return;

    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { return; }

    realFetch('/api/sim-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: m[3] ? 'note-updated' : 'stop-updated',
        tabName: decodeURIComponent(m[1]),
        rowNumber: Number(m[2]),
        done: body.done,
        notes: body.notes,
      }),
    }).catch(() => {});
  }

  // ── Synthetic GPS ───────────────────────────────────────────────────────
  // We capture whatever callback map.js hands to watchPosition and drive it
  // ourselves, so the real GPS code path runs untouched.
  let gpsCb = null;
  let simTimer = null;
  let playing = false;
  let speed = 3;              // multiplier on a ~13 m/s baseline
  let legIdx = 0;             // which stop-to-stop leg we are on
  let legT = 0;               // 0..1 progress along the current leg
  let pos = null;

  navigator.geolocation.watchPosition = function (success) {
    gpsCb = success;
    return 1;
  };
  navigator.geolocation.clearWatch = function () { gpsCb = null; };
  navigator.geolocation.getCurrentPosition = function (success) {
    if (pos) success(makePosition(pos));
  };

  function makePosition(p) {
    return {
      coords: {
        latitude: p.lat,
        longitude: p.lng,
        accuracy: 8,
        heading: p.heading,
        speed: playing ? 13 * speed : 0,
        altitude: null,
        altitudeAccuracy: null,
      },
      timestamp: Date.now(),
    };
  }

  // Stop coordinates come from map.js once it has geocoded the route.
  function route() {
    const stops = (typeof navStops !== 'undefined' && navStops) || [];
    return stops
      .filter(s => s && s._latLng)
      .map(s => ({
        lat: s._latLng.lat(),
        lng: s._latLng.lng(),
        name: s.accountName || s.address || 'stop',
      }));
  }

  function bearing(a, b) {
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
              Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
              Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function step() {
    const r = route();
    if (r.length < 2) { setStatus('waiting for the route to load…'); return; }
    if (legIdx >= r.length - 1) { pause(); setStatus('end of route'); return; }

    const from = r[legIdx];
    const to = r[legIdx + 1];

    // Rough metres for this leg, so the pace stays believable instead of
    // crawling on long legs and teleporting across short ones.
    const dx = (to.lng - from.lng) * 85000;
    const dy = (to.lat - from.lat) * 111000;
    const legM = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const perTick = (13 * speed) / legM;   // ~13 m/s baseline, one tick a second

    legT += perTick;
    if (legT >= 1) { legT = 0; legIdx++; }

    const t = Math.min(legT, 1);
    pos = {
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
      heading: bearing(from, to),
    };

    if (gpsCb) gpsCb(makePosition(pos));
    renderStatusLine(r);
  }

  function play() {
    if (playing) return;
    playing = true;
    simTimer = setInterval(step, 1000);
    const b = document.getElementById('sim-play');
    if (b) b.textContent = '⏸ Pause';
  }

  function pause() {
    playing = false;
    if (simTimer) clearInterval(simTimer);
    simTimer = null;
    const b = document.getElementById('sim-play');
    if (b) b.textContent = '▶ Drive';
  }

  // ── Control panel ───────────────────────────────────────────────────────
  function panel() {
    const el = document.createElement('div');
    el.id = 'sim-panel';
    el.innerHTML =
      '<div id="sim-bar">' +
        '<strong>SIM</strong>' +
        '<span id="sim-status">ready</span>' +
        '<button id="sim-play" type="button">▶ Drive</button>' +
        '<button id="sim-signal" type="button">📶 Signal: on</button>' +
        '<label>Speed <input id="sim-speed" type="range" min="1" max="10" step="1" value="3"></label>' +
        '<button id="sim-reset" type="button">↺ Restart</button>' +
        '<button id="sim-toggle-log" type="button">Writes (0)</button>' +
      '</div>' +
      '<div id="sim-log" hidden></div>';
    document.body.appendChild(el);

    document.getElementById('sim-play').onclick = () => (playing ? pause() : play());
    document.getElementById('sim-reset').onclick = () => {
      pause(); legIdx = 0; legT = 0; pos = null; setStatus('ready');
    };
    document.getElementById('sim-speed').oninput = (e) => { speed = Number(e.target.value); };
    document.getElementById('sim-signal').onclick = () => {
      hasSignal = !hasSignal;
      const b = document.getElementById('sim-signal');
      b.textContent = hasSignal ? '📶 Signal: on' : '📵 Signal: OFF';
      b.classList.toggle('off', !hasSignal);
      // Coming back online is what the driver app listens for to flush.
      if (hasSignal) window.dispatchEvent(new Event('online'));
    };
    document.getElementById('sim-toggle-log').onclick = () => {
      const log = document.getElementById('sim-log');
      log.hidden = !log.hidden;
    };
    renderLog();
  }

  function setStatus(msg) {
    const el = document.getElementById('sim-status');
    if (el) el.textContent = msg;
  }

  function renderStatusLine(r) {
    const next = r[Math.min(legIdx + 1, r.length - 1)];
    setStatus('leg ' + (legIdx + 1) + '/' + (r.length - 1) + ' → ' + next.name);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderLog() {
    const btn = document.getElementById('sim-toggle-log');
    if (btn) btn.textContent = 'Writes (' + writeLog.length + ')';
    const log = document.getElementById('sim-log');
    if (!log) return;
    log.innerHTML = writeLog.length
      ? writeLog.map(w =>
          '<div class="sim-row">' +
            '<span class="sim-t">' + esc(w.t) + '</span>' +
            '<span class="sim-outcome ' +
              (w.outcome.indexOf('blocked') === 0 ? 'bad' : 'ok') + '">' +
              esc(w.outcome) + '</span>' +
            '<code>' + esc(w.path) + '</code>' +
            '<code class="sim-body">' + esc(w.body) + '</code>' +
          '</div>'
        ).join('')
      : '<div class="sim-row">No writes yet — nothing has been sent to the sheet.</div>';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', panel);
  } else {
    panel();
  }
})();
