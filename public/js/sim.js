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

   SAFETY: a test drive never writes anything real. EVERY non-GET to the
   app's own API is intercepted and logged on screen instead — not just the
   route ones. That distinction mattered: when this only held back
   /api/routes/*, a test drive put a truck on the dispatch board as a live
   position and filed a rockslide that every other driver saw on their map
   for eight hours. Reads still hit the real server, so you drive real stops
   and see real hazards.

   The one exception is error reporting, which is about the app rather than
   the fleet and is worth having from a test drive like anywhere else.
   ───────────────────────────────────────────────────────────────────────── */

(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('sim') !== '1') return;   // not a test drive — do nothing

  const API_WRITE_PATH = '/api/routes/';

  /* Writes that are still allowed out. Diagnostics only: a crash during a
     test drive is a real crash, and /api/sim-event is how the board is told
     that a simulated stop was completed (it goes through realFetch below, so
     it never reaches this test — it is named here so the intent is on the
     page rather than in the routing). */
  const SIM_ALLOWED_WRITES = ['/api/client-errors', '/api/sim-event'];

  // ── Fake network ────────────────────────────────────────────────────────
  // hasSignal drives the offline queue: switch it off and writes reject the
  // way a dead zone rejects them, so you can watch the queue fill and drain.
  let hasSignal = true;
  const writeLog = [];

  const realFetch = window.fetch.bind(window);

  window.fetch = function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    const u = String(url);
    /* Anything that changes something on the server, whatever it is. An
       allowlist of paths to BLOCK is a list that is always one endpoint out
       of date — and the endpoint it is missing is the one that gets written
       for real from a test drive. */
    const isWrite = method !== 'GET' && u.includes('/api/') &&
                    !SIM_ALLOWED_WRITES.some(p => u.includes(p));

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
    /* Route writes read better without the long prefix; everything else is
       shown as its own path, since there is no common stem any more. */
    const i = url.indexOf(API_WRITE_PATH);
    let shown;
    if (i >= 0) {
      shown = url.slice(i + API_WRITE_PATH.length);
    } else {
      try { shown = new URL(url, location.origin).pathname; } catch { shown = String(url); }
    }
    writeLog.unshift({
      t: new Date().toLocaleTimeString(),
      outcome,
      path: shown,
      body: String(body),
    });
    if (writeLog.length > 40) writeLog.length = 40;
    renderLog();
    // The panel is added after the map has already worked out its height.
    if (typeof window.sizeMap === 'function') window.sizeMap();
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

  /* Speed.
     The baseline is one truck-speed on a collection round: 11 m/s, about
     25 mph, which is what the stretches between stops actually look like.
     The slider on top of it is FAST FORWARD, not the accelerator — it
     compresses time so you can reach stop forty without driving to stop forty.

     This used to be an 11 m/s baseline in all but name with the slider
     defaulting to 3, which meant the truck left the kerb at 87 mph and the top
     of the slider was 291 mph. At one position a second nobody could tell. At
     twelve a second it looks like the driver can fly, which is the honest
     rendering of 87 mph down a residential street.

     So: default to ×1, and put the real number on the screen. Anyone who wants
     to skip ahead still can, and now they can see what they asked for. */
  const BASE_MPS = 11;
  const MPH = 2.23694;
  let speed = 1;
  let legIdx = 0;             // which stop-to-stop leg we are on
  let legT = 0;               // 0..1 progress along the current leg
  let pos = null;

  /* How often the truck moves. This was one second, which meant the marker
     jumped 13 m at a stroke and the drive read as a slideshow next to the
     walkthrough — that one runs its loop every 60 ms for exactly this reason.
     Distance per tick is scaled by the same figure below, so the truck covers
     the ground at the same speed it always did; only the number of steps it
     takes to get there changes. */
  const TICK_MS = 80;
  /* The status line is text and nobody reads it twelve times a second.
     Redrawn about twice a second instead, which keeps the DOM out of the
     animation's way. */
  const STATUS_EVERY = Math.round(500 / TICK_MS);
  let tickCount = 0;

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
        speed: playing ? BASE_MPS * speed : 0,
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

  /* ── Driving on the roads ────────────────────────────────────────────────
     The truck used to interpolate straight from one stop's coordinates to the
     next, which is a crow's flight: across fields, through buildings, over the
     river. A hovercraft, not a truck.

     So ask Google how you actually get there, and walk the answer. The route
     between two stops comes back as a list of points along the road; driving
     those in order is driving the street.

     One leg at a time, fetched the first time it is needed and then cached,
     with the next one warmed while the current one is being driven. A round
     here can be two hundred stops and asking for all of it up front would be
     two hundred stops' worth of Directions quota to watch the first ten.

     If the request fails — offline, quota, no key — the leg keeps its straight
     line. The test drive carries on; it just looks like it used to. */
  const legPaths = new Map();   // legIdx → [{lat,lng}, …] along the road
  const legPending = new Set();
  let directions = null;

  function pathFor(from, to, idx) {
    const cached = legPaths.get(idx);
    if (cached) return cached;
    requestPath(from, to, idx);
    return null;                // straight line until it lands
  }

  function requestPath(from, to, idx) {
    if (legPending.has(idx) || legPaths.has(idx)) return;
    if (!window.google?.maps?.DirectionsService) return;
    legPending.add(idx);
    try {
      directions = directions || new google.maps.DirectionsService();
      directions.route({
        origin: { lat: from.lat, lng: from.lng },
        destination: { lat: to.lat, lng: to.lng },
        travelMode: google.maps.TravelMode.DRIVING,
      }, (res, status) => {
        legPending.delete(idx);
        if (status !== 'OK' || !res?.routes?.[0]) return;
        /* steps[].path is the full road geometry. overview_path is a
           simplified version of the same thing — good enough to fall back on,
           but it cuts corners visibly, so prefer the detailed one. */
        const pts = [];
        for (const leg of res.routes[0].legs || []) {
          for (const stepLeg of leg.steps || []) {
            for (const p of stepLeg.path || []) pts.push({ lat: p.lat(), lng: p.lng() });
          }
        }
        const path = pts.length > 1
          ? pts
          : (res.routes[0].overview_path || []).map(p => ({ lat: p.lat(), lng: p.lng() }));
        if (path.length > 1) legPaths.set(idx, path);
      });
    } catch {
      legPending.delete(idx);   // no Directions available; straight line it is
    }
  }

  /* Where along a path of many points does a fraction t land, and which way is
     the truck pointing when it gets there? Walked by distance, not by point
     count, or the truck would crawl through a cluster of points on a bend and
     bolt down a long straight. */
  function alongPath(path, t) {
    let total = 0;
    const segs = [];
    for (let i = 1; i < path.length; i++) {
      const d = metresBetween(path[i - 1], path[i]);
      segs.push(d);
      total += d;
    }
    if (total <= 0) return { lat: path[0].lat, lng: path[0].lng, heading: 0 };

    let want = Math.max(0, Math.min(t, 1)) * total;
    for (let i = 0; i < segs.length; i++) {
      if (want > segs[i] && i < segs.length - 1) { want -= segs[i]; continue; }
      const a = path[i], b = path[i + 1];
      const f = segs[i] > 0 ? Math.min(want / segs[i], 1) : 0;
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lng: a.lng + (b.lng - a.lng) * f,
        heading: bearing(a, b),
      };
    }
    const last = path[path.length - 1];
    return { lat: last.lat, lng: last.lng, heading: 0 };
  }

  function metresBetween(a, b) {
    const dx = (b.lng - a.lng) * 85000;
    const dy = (b.lat - a.lat) * 111000;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pathLength(path) {
    let m = 0;
    for (let i = 1; i < path.length; i++) m += metresBetween(path[i - 1], path[i]);
    return m;
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

    // The road, if we have it yet. Null means the request is still out (or
    // failed), and this leg flies straight the way it always did.
    const path = pathFor(from, to, legIdx);

    // Warm the next leg while this one is being driven, so the truck does not
    // arrive at a corner and fly the following leg while it waits.
    if (legIdx + 2 < r.length) requestPath(r[legIdx + 1], r[legIdx + 2], legIdx + 1);

    /* Metres for this leg, so the pace stays believable instead of crawling on
       long legs and teleporting across short ones. The road is always longer
       than the crow's flight, and measuring the road is the point: a stop two
       streets away that is a mile round the one-way system should take a mile's
       worth of driving. */
    const legM = Math.max(path ? pathLength(path) : metresBetween(from, to), 1);
    // Scaled to the tick so the pace is unchanged by how often we step — a
    // shorter tick moves a shorter distance, not slower.
    const perTick = (BASE_MPS * speed * (TICK_MS / 1000)) / legM;

    legT += perTick;
    if (legT >= 1) { legT = 0; legIdx++; }

    const t = Math.min(legT, 1);
    pos = path
      ? alongPath(path, t)
      : {
          lat: from.lat + (to.lat - from.lat) * t,
          lng: from.lng + (to.lng - from.lng) * t,
          heading: bearing(from, to),
        };

    if (gpsCb) gpsCb(makePosition(pos));
    if (tickCount++ % STATUS_EVERY === 0) renderStatusLine(r);
  }

  function play() {
    if (playing) return;
    playing = true;
    simTimer = setInterval(step, TICK_MS);
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
        '<label>Speed <input id="sim-speed" type="range" min="1" max="10" step="1" value="1">' +
          '<span id="sim-speed-read"></span></label>' +
        '<button id="sim-reset" type="button">↺ Restart</button>' +
        '<button id="sim-toggle-log" type="button">Writes (0)</button>' +
      '</div>' +
      '<div id="sim-log" hidden></div>';
    document.body.appendChild(el);

    document.getElementById('sim-play').onclick = () => (playing ? pause() : play());
    document.getElementById('sim-reset').onclick = () => {
      pause(); legIdx = 0; legT = 0; pos = null; setStatus('ready');
    };
    document.getElementById('sim-speed').oninput = (e) => {
      speed = Number(e.target.value);
      showSpeed();
    };
    showSpeed();
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
      /* Opening the log makes this panel taller, and the panel is what the map
         leaves room for. Nothing fires a resize for a hidden attribute, so the
         map has to be told or the dock slides under the log. */
      if (typeof window.sizeMap === 'function') window.sizeMap();
    };
    renderLog();
  }

  /* Says what the slider is actually doing. ×1 is a truck; anything above it
     is time being compressed, and the mph is there so nobody has to wonder why
     the driver appears to be flying. */
  function showSpeed() {
    const el = document.getElementById('sim-speed-read');
    if (!el) return;
    const mph = Math.round(BASE_MPS * speed * MPH);
    el.textContent = '×' + speed + ' · ' + mph + ' mph';
    el.classList.toggle('fast', mph > 60);
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
