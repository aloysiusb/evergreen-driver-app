// Map tab — navigation mode, planned vs live route modes

/* Open a route straight onto its map with ?view=map.
 *
 * The dispatcher board links here: the office wants to see where a route goes
 * without first landing on a list of stops and hunting for the tab. The map
 * only builds itself when it is actually shown, so this waits for the page to
 * be ready rather than racing it. */
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'map') {
    // A moment for the route data to arrive, or the map draws an empty route.
    setTimeout(() => window.switchView('map'), 400);
  }
});

window.switchView = function(view) {
  document.getElementById('view-stops').style.display = view === 'stops' ? 'block' : 'none';
  document.getElementById('view-map').style.display   = view === 'map'   ? 'block' : 'none';
  document.getElementById('tab-stops').classList.toggle('active', view === 'stops');
  document.getElementById('tab-map').classList.toggle('active',   view === 'map');
  if (view === 'map' && !window._mapInitialized) {
    window._mapInitialized = true;
    initMap();
  }
};

/* Adding up how long a route takes.
 *
 * Google only returns duration_in_traffic where it HAS traffic data. On a
 * rural county road, and outside the hours it models, the field is simply
 * absent — and reading .value off the missing object throws, taking the whole
 * callback with it: no estimate, no reorder, no nudge, and no error anyone
 * would see.
 *
 * This was guarded in one of the three places that did the sum. The error log
 * caught the other two in production, on Thursday Com/Eagle and Wednesday
 * Residential. One helper now, so there is no fourth.
 */
function legSeconds(leg, preferTraffic) {
  if (!leg) return 0;
  const d = (preferTraffic && leg.duration_in_traffic) || leg.duration;
  return d && typeof d.value === 'number' ? d.value : 0;
}

function routeMinutes(legs, preferTraffic) {
  if (!Array.isArray(legs) || !legs.length) return null;
  return Math.round(legs.reduce((sum, leg) => sum + legSeconds(leg, preferTraffic), 0) / 60);
}

let gMap = null;
let markers = [];
let navStops = [];          // current display order
let plannedOrder = [];      // original sheet order (never mutated)
let currentIdx = 0;
let routeMode = 'planned';  // 'planned' | 'live'
let plannedMins = null;
let plannedFailed = false;   // distinguishes "could not work it out" from "still working it out"
let liveMins = null;
let directionsRenderer = null;
let directionsService = null;

// ── GPS tracking state ────────────────────────────────────────────────────────
let gpsWatchId = null;
let gpsMarker = null;
let gpsCircle = null;
let lastGpsPos = null;
let lastGpsHeading = null;
let nextEtaMins = null;
let etaService = null;
const ARRIVAL_RADIUS_M = 80; // metres from stop to auto-prompt arrival

// ── Turn-by-turn ──────────────────────────────────────────────────────────
// The app used to hand navigation off to Google Maps or Waze entirely, which
// meant the driver left our screen — and the stop notes, access codes and the
// Done button with it. This keeps the next manoeuvre on our own screen.
//
// Distances use the existing haversineM() rather than google.maps.geometry,
// because map.js loads only the "places" library and pulling in another one
// for a distance calculation we already have would be silly.
const MANEUVER_ICONS = {
  'turn-right': '↱', 'turn-left': '↰',
  'turn-slight-right': '↗', 'turn-slight-left': '↖',
  'turn-sharp-right': '⤳', 'turn-sharp-left': '⤪',
  'uturn-right': '⤵', 'uturn-left': '⤴',
  'merge': '⤸', 'fork-right': '↗', 'fork-left': '↖',
  'ramp-right': '↗', 'ramp-left': '↖',
  'roundabout-right': '⟳', 'roundabout-left': '⟲',
  'straight': '↑',
};

let turnSteps = [];            // manoeuvres from here to the current stop
let curStepIdx = 0;
let turnTargetRow = null;      // which stop these steps lead to
let turnFetchedAt = 0;
let turnFetching = false;

const STEP_ADVANCE_M = 30;     // within this of a manoeuvre point, move to the next
const OFF_ROUTE_M = 150;       // further than this from the next manoeuvre: re-route
const TURN_MIN_REFETCH_MS = 20000;      // never hammer the Directions API
// Off-route is different: the driver is being shown a manoeuvre that is no
// longer ahead of them, and the distance to it visibly grows. Twenty seconds
// of that at 40 mph is a third of a mile of wrong instruction, so re-route
// sooner. Still throttled — Directions is billed per call.
const TURN_OFFROUTE_REFETCH_MS = 6000;
// Re-arm the arrival prompt only once the driver has genuinely left. The gap
// between the two radii is hysteresis, so GPS jitter at the boundary can't
// re-trigger the prompt while they're parked at the stop.
const ARRIVAL_CLEAR_RADIUS_M = ARRIVAL_RADIUS_M * 1.5;

// ── Follow mode (navigation-style view) ───────────────────────────────────
// On by default: the driver opens the Map tab and it behaves like a nav
// system — the map rides with them at street level instead of sitting parked
// on the destination. Panning the map by hand drops out of follow (otherwise
// it fights you); the 🧭 button puts it back.
let followMode = true;
let followZoom = 17;          // street level; the old default of 15 is too far out to read side streets
let suppressFollowOff = false; // set while WE move the map, so our own pans don't count as manual

// ── Traffic + auto-reroute state ──────────────────────────────────────────
let trafficDelayMins = null;   // minutes lost to traffic vs free-flow
let rerouteTimer = null;
let rerouteDismissed = false;  // driver said "no thanks" this session
const REROUTE_CHECK_MS = 3 * 60 * 1000;  // re-check every 3 minutes
const REROUTE_MIN_SAVING = 8;            // only nudge if it saves 8+ minutes

// Google's Directions API accepts at most 25 waypoints besides the origin and
// destination. Every call in this file used to pass EVERY remaining stop — 208
// of them on Valley Residential — so the request was rejected outright and,
// because each callback only acted on status === 'OK', it failed silently.
// The route line never drew and the time estimate never appeared on any real
// route. Nobody saw an error because there was nothing to see.
//
// A driver cares about the stretch in front of them, not a 215-stop polyline,
// so we ask about the next 25 and say so.
const MAX_WAYPOINTS = 23;
const ROUTE_CHUNK = MAX_WAYPOINTS + 2;    // origin + waypoints + destination

function routeChunk(stops) {
  return stops.slice(0, ROUTE_CHUNK);
}

function chunkNote(stops) {
  return stops.length > ROUTE_CHUNK ? ` · next ${ROUTE_CHUNK} stops` : '';
}

const PLANNED_COLOR = '#22c55e';
const LIVE_COLOR    = '#f59e0b';

// The Google Maps bundle is ~300 KB. On a weak mountain signal or with data
// saver on, make the driver opt in rather than spending their data by default.
function onSlowConnection() {
  const c = navigator.connection;
  if (!c) return false;
  return c.saveData === true || /^(slow-)?2g$/.test(c.effectiveType || '');
}

async function initMap() {
  const loadingEl = document.getElementById('map-loading');

  if (onSlowConnection() && !window._mapForced) {
    loadingEl.style.display = 'block';
    loadingEl.innerHTML =
      'Slow connection detected.<br>' +
      '<span style="font-size:12px;opacity:.8">The map uses about 300 KB of data.</span><br>' +
      '<button id="map-load-anyway" style="margin-top:10px;padding:9px 18px;border:none;' +
      'border-radius:var(--r-control);background:var(--route-color,#22c55e);color:#fff;font-weight:600;' +
      'font-family:inherit;font-size:14px;cursor:pointer;">Load map anyway</button>';
    document.getElementById('map-load-anyway').addEventListener('click', () => {
      window._mapForced = true;
      initMap();
    });
    return;
  }

  loadingEl.textContent = 'Loading map…';
  loadingEl.style.display = 'block';

  let apiKey;
  try {
    const res = await fetch('/api/maps-key');
    if (!res.ok) throw new Error();
    apiKey = (await res.json()).key;
  } catch {
    loadingEl.textContent = 'Maps not configured — add GOOGLE_MAPS_API_KEY in Render.';
    return;
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Maps failed'));
    document.head.appendChild(s);
  });

  loadingEl.style.display = 'none';

  gMap = new google.maps.Map(document.getElementById('route-map'), {
    zoom: 15,
    center: { lat: 39.4022, lng: -107.2117 },   // Carbondale, CO
    gestureHandling: 'greedy',
    // Full Google Maps capability for drivers
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
      position: google.maps.ControlPosition.TOP_LEFT,
      mapTypeIds: ['roadmap', 'satellite', 'hybrid', 'terrain'],
    },
    fullscreenControl: true,
    streetViewControl: true,   // drop pegman to scout an unfamiliar driveway
    zoomControl: true,
    scaleControl: true,
    rotateControl: true,
    clickableIcons: true,      // tap POIs — gas stations, etc.
  });

  new google.maps.TrafficLayer().setMap(gMap);

  watchForManualPan();
  setFollow(true);
  updateAlertChip();

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    suppressMarkers: true,
    polylineOptions: { strokeColor: PLANNED_COLOR, strokeWeight: 5, strokeOpacity: 0.8 },
  });
  directionsRenderer.setMap(gMap);

  etaService = new google.maps.DistanceMatrixService();
  await geocodeAndPlot();
  startGpsTracking();
  startRerouteWatcher();
}

function rowColorToHex(rowColor) {
  if (!rowColor) return null;
  const r = Math.round((rowColor.red   ?? 0) * 255);
  const g = Math.round((rowColor.green ?? 0) * 255);
  const b = Math.round((rowColor.blue  ?? 0) * 255);
  if (r > 240 && g > 240 && b > 240) return null;
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function makePin(color, done, isCurrent) {
  const lineColor = routeMode === 'live' ? LIVE_COLOR : PLANNED_COLOR;
  if (isCurrent) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: color || lineColor,
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 3,
      scale: 14,
    };
  }
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: done ? '#d1d5db' : (color || '#86efac'),
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
    scale: 8,
  };
}

// A real stop needs a street number — filters out note rows that slipped
// through the parser ("Testing", "GET 06/23 EOW") and would otherwise
// geocode to random locations far off route.
// US street addresses start with a house number: "2561 Dolores Way".
// Note rows that happen to contain digits ("GET 06/23 EOW") do not.
function looksLikeAddress(s) {
  return /^\d+\s+\S/.test((s.address || '').trim());
}

// Discard geocode results that land absurdly far from the route's centre —
// a wrong match in another state would wreck the route line and ETA.
const MAX_STOP_SPREAD_KM = 80;
function rejectOutliers(list) {
  if (list.length < 3) return list;
  const lats = list.map(s => s._latLng.lat()).sort((a,b) => a-b);
  const lngs = list.map(s => s._latLng.lng()).sort((a,b) => a-b);
  const mLat = lats[Math.floor(lats.length/2)];
  const mLng = lngs[Math.floor(lngs.length/2)];
  return list.filter(s => {
    const dLat = (s._latLng.lat() - mLat) * 111;
    const dLng = (s._latLng.lng() - mLng) * 111 * Math.cos(mLat * Math.PI/180);
    return Math.sqrt(dLat*dLat + dLng*dLng) < MAX_STOP_SPREAD_KM;
  });
}

async function geocodeAndPlot() {
  const loadingEl = document.getElementById('map-loading');
  const stops = (window.allStops || []).filter(s => !s.isSectionHeader && looksLikeAddress(s));
  if (!stops.length) { loadingEl.textContent = 'No stops to show.'; loadingEl.style.display = 'block'; return; }

  loadingEl.textContent = `Locating ${stops.length} stops…`;
  loadingEl.style.display = 'block';

  const geocoder = new google.maps.Geocoder();
  markers.forEach(m => m.setMap(null));
  markers = [];
  navStops = [];
  plannedOrder = [];
  liveMins = null;
  plannedMins = null;

  await Promise.all(stops.map(stop => new Promise(resolve => {
    const addr = stop.address + (stop.city ? ', ' + stop.city : '') + ', CO';
    geocoder.geocode({ address: addr }, (results, status) => {
      if (status === 'OK' && results[0]) {
        stop._latLng = results[0].geometry.location;
        navStops.push(stop);
      }
      resolve();
    });
  })));

  navStops = rejectOutliers(navStops);

  // Sort to original sheet order
  navStops.sort((a, b) => window.allStops.indexOf(a) - window.allStops.indexOf(b));
  plannedOrder = [...navStops];

  placeMarkers();
  loadingEl.style.display = 'none';

  currentIdx = Math.max(0, navStops.findIndex(s => !s.done));
  routeMode = 'planned';
  updateModeUI();
  drawRouteLine();
  renderNavCard();
  centerOnCurrent();

  // Fetch planned travel time in background
  fetchPlannedTime();
}

function placeMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = navStops.map((stop, idx) => {
    const color = rowColorToHex(stop.rowColor);
    const m = new google.maps.Marker({
      position: stop._latLng,
      map: gMap,
      icon: makePin(color, stop.done, idx === currentIdx),
      zIndex: idx === currentIdx ? 100 : (stop.done ? 1 : 10),
      title: stop.accountName || stop.address,
    });
    m.addListener('click', () => jumpTo(idx));
    return m;
  });
}

function centerOnCurrent() {
  // While following the driver, the driver is the subject — don't yank the
  // view over to the stop only for the next GPS tick to drag it back.
  if (followMode && lastGpsPos) return;
  const stop = navStops[currentIdx];
  if (stop?._latLng) gMap.panTo(stop._latLng);
}

function updateMarkerIcons() {
  navStops.forEach((stop, idx) => {
    const color = rowColorToHex(stop.rowColor);
    markers[idx]?.setIcon(makePin(color, stop.done, idx === currentIdx));
    markers[idx]?.setZIndex(idx === currentIdx ? 100 : (stop.done ? 1 : 10));
  });
}

function drawRouteLine() {
  const lineColor = routeMode === 'live' ? LIVE_COLOR : PLANNED_COLOR;
  directionsRenderer.setOptions({
    polylineOptions: { strokeColor: lineColor, strokeWeight: 5, strokeOpacity: 0.8 },
  });

  const all = navStops.filter(s => !s.done && s._latLng);
  if (all.length < 2) { directionsRenderer.setDirections({ routes: [] }); return; }
  const remaining = routeChunk(all);

  directionsService.route({
    origin: remaining[0]._latLng,
    destination: remaining[remaining.length - 1]._latLng,
    waypoints: remaining.slice(1, -1).map(s => ({ location: s._latLng, stopover: false })),
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
  }, (result, status) => {
    if (status === 'OK') directionsRenderer.setDirections(result);
    else {
      console.warn('[map] route line:', status);
      window.reportIssue?.('route line: ' + status, 'map.js');
    }
  });
}

function fetchPlannedTime() {
  const remaining = routeChunk(plannedOrder.filter(s => !s.done && s._latLng));
  if (remaining.length < 2) return;
  directionsService.route({
    origin: remaining[0]._latLng,
    destination: remaining[remaining.length - 1]._latLng,
    waypoints: remaining.slice(1, -1).map(s => ({ location: s._latLng, stopover: true })),
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
  }, (result, status) => {
    if (status === 'OK') {
      const legs = result.routes[0].legs;
      plannedMins = routeMinutes(legs, true);
      const freeFlow = routeMinutes(legs, false);
      trafficDelayMins = (plannedMins === null || freeFlow === null)
        ? 0
        : Math.max(0, plannedMins - freeFlow);
      plannedFailed = false;
    } else {
      // This used to fall through, leaving plannedMins null and the status bar
      // blank — which looks exactly like "still loading". That is how the
      // waypoint bug stayed hidden: the estimate had been failing on every
      // real route and nothing on screen ever said so.
      console.warn('[map] planned time:', status);
      window.reportIssue?.('planned time: ' + status, 'map.js');
      plannedFailed = true;
    }
    updateModeUI();
  });
}

// ── Traffic conditions ────────────────────────────────────────────────────
function trafficLabel() {
  if (trafficDelayMins === null) return '';
  if (trafficDelayMins <= 3)  return '🟢 Light traffic';
  if (trafficDelayMins <= 12) return `🟡 Moderate · +${trafficDelayMins} min`;
  return `🔴 Heavy · +${trafficDelayMins} min`;
}

// ── Auto-reroute watcher ──────────────────────────────────────────────────
// Every few minutes, silently check whether traffic has shifted enough that
// re-optimizing would meaningfully help. Only nudges — never switches on its own.
function startRerouteWatcher() {
  if (rerouteTimer) clearInterval(rerouteTimer);
  rerouteTimer = setInterval(checkForBetterRoute, REROUTE_CHECK_MS);
}

function checkForBetterRoute() {
  if (routeMode !== 'planned') return;
  if (rerouteDismissed) return;
  const remaining = routeChunk(plannedOrder.filter(s => !s.done && s._latLng));
  if (remaining.length < 3) return;

  directionsService.route({
    origin: remaining[0]._latLng,
    destination: remaining[remaining.length - 1]._latLng,
    waypoints: remaining.slice(1, -1).map(s => ({ location: s._latLng, stopover: true })),
    optimizeWaypoints: true,
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
  }, (result, status) => {
    if (status !== 'OK') return;
    const optMins = routeMinutes(result.routes[0].legs, true);
    if (plannedMins === null || optMins === null) return;
    const saving = plannedMins - optMins;
    if (saving >= REROUTE_MIN_SAVING) showRerouteNudge(saving);
  });
}

function showRerouteNudge(saving) {
  const toast = document.getElementById('toast');
  toast.innerHTML =
    `Traffic shifted — <b>Live route saves ~${saving} min</b> ` +
    `<button id="reroute-yes" style="margin-left:8px;padding:4px 10px;border:none;border-radius:var(--r-control);background:${LIVE_COLOR};color:#fff;font-weight:700;cursor:pointer;">⚡ Switch</button>` +
    `<button id="reroute-no" style="margin-left:4px;padding:4px 8px;border:none;border-radius:var(--r-control);background:transparent;color:inherit;opacity:0.6;cursor:pointer;">Dismiss</button>`;
  toast.classList.add('show');

  document.getElementById('reroute-yes').addEventListener('click', () => {
    toast.classList.remove('show');
    window.setRouteMode('live');
  });
  document.getElementById('reroute-no').addEventListener('click', () => {
    toast.classList.remove('show');
    rerouteDismissed = true;  // don't nag again this session
  });

  setTimeout(() => toast.classList.remove('show'), 15000);
}

// ── Navigation app handoff ────────────────────────────────────────────────
//
// We do not write a navigation system. There is no web API for turn-by-turn —
// a browser cannot give voice guidance with the screen off or hold GPS in the
// background — so anything built here would be a worse Google Maps. Instead we
// hand the route to the app the driver already knows.
//
// This used to send ONE stop. On a 200-stop route that is 200 round trips
// between two apps in a working day. Google's URL API takes intermediate
// waypoints, so we send the next several stops as a single multi-stop route
// and the driver stays in their nav app through a whole run of them.
//
// Waze and Apple Maps take a single destination only — that is their URL
// scheme, not an oversight — so those stay one stop at a time.

const HANDOFF_MAX_STOPS = 9;   // Google's consumer URL tops out around here

function stopAddress(stop) {
  if (!stop) return '';
  const base = stop.address + (stop.city ? ', ' + stop.city : '');
  // Rural addresses are ambiguous without a state; every route is in Colorado.
  return /\bCO\b/i.test(base) ? base : base + ', CO';
}

/** Coordinates beat a typed address — no geocoding to get wrong. */
function stopPoint(stop) {
  if (stop && stop._latLng) return stop._latLng.lat() + ',' + stop._latLng.lng();
  return stopAddress(stop);
}

/** The run of stops ahead of the driver, starting with the one they are on. */
function upcomingStops(max) {
  const out = [];
  for (let i = currentIdx; i < navStops.length && out.length < max; i++) {
    const s = navStops[i];
    if (s && !s.done) out.push(s);
  }
  return out;
}

window.navOpenIn = function(app) {
  const stop = navStops[currentIdx];
  if (!stop) return;

  let url;
  if (app === 'waze') {
    const p = stop._latLng
      ? `ll=${stop._latLng.lat()},${stop._latLng.lng()}`
      : `q=${encodeURIComponent(stopAddress(stop))}`;
    url = `https://www.waze.com/ul?${p}&navigate=yes`;
  } else if (app === 'apple') {
    url = `https://maps.apple.com/?daddr=${encodeURIComponent(stopAddress(stop))}&dirflg=d`;
  } else {
    const run = upcomingStops(HANDOFF_MAX_STOPS);
    const destination = run[run.length - 1] || stop;
    const between = run.slice(0, -1);

    url = 'https://www.google.com/maps/dir/?api=1'
        + '&destination=' + encodeURIComponent(stopPoint(destination))
        + (between.length
            ? '&waypoints=' + encodeURIComponent(between.map(stopPoint).join('|'))
            : '')
        + '&travelmode=driving';
  }
  window.open(url, '_blank', 'noopener');
  closeNavPicker();
};

/** How many stops the Google handoff will cover — shown on the button. */
window.navHandoffCount = function() {
  return upcomingStops(HANDOFF_MAX_STOPS).length;
};

window.toggleNavPicker = function() {
  const el = document.getElementById('nav-app-picker');
  if (el) el.style.display = el.style.display === 'flex' ? 'none' : 'flex';
};

function closeNavPicker() {
  const el = document.getElementById('nav-app-picker');
  if (el) el.style.display = 'none';
}

function updateModeUI() {
  document.getElementById('mode-planned').classList.toggle('active', routeMode === 'planned');
  document.getElementById('mode-live').classList.toggle('active',    routeMode === 'live');

  const statusEl = document.getElementById('optimize-status');
  const tl = trafficLabel();
  if (routeMode === 'planned') {
    statusEl.textContent = plannedMins
      ? `~${plannedMins} min${tl ? ' · ' + tl : ''}`
      : plannedFailed
        ? `drive time unavailable${tl ? ' · ' + tl : ''}`
        : (tl || 'Calculating…');
  } else if (routeMode === 'live') {
    if (liveMins !== null && plannedMins !== null) {
      const saved = plannedMins - liveMins;
      statusEl.textContent = saved > 0
        ? `~${liveMins} min · saves ~${saved} min${tl ? ' · ' + tl : ''}`
        : `~${liveMins} min · already optimal${tl ? ' · ' + tl : ''}`;
    } else if (liveMins !== null) {
      statusEl.textContent = `~${liveMins} min${tl ? ' · ' + tl : ''}`;
    } else {
      statusEl.textContent = plannedFailed ? 'drive time unavailable' : 'Calculating…';
    }
  }
}

// ── Turn-by-turn ─────────────────────────────────────────────────────────────

function currentNavStop() {
  const s = navStops[currentIdx];
  return s && !s.done && s._latLng ? s : null;
}

// Directions from where the driver actually is to the stop they're heading
// for. Deliberately throttled — this is a billed API call, not a free one.
function fetchTurnSteps(fromLatLng) {
  const stop = currentNavStop();
  if (!stop || turnFetching || !directionsService) return;

  turnFetching = true;
  turnFetchedAt = Date.now();

  directionsService.route({
    origin: fromLatLng,
    destination: stop._latLng,
    travelMode: google.maps.TravelMode.DRIVING,
  }, (result, status) => {
    turnFetching = false;
    if (status !== 'OK' || !result.routes.length) return;

    const steps = [];
    result.routes[0].legs.forEach(leg => {
      leg.steps.forEach(st => {
        steps.push({
          lat: st.end_location.lat(),
          lng: st.end_location.lng(),
          // instructions come back as HTML from Google; strip to plain text
          instruction: (st.instructions || '').replace(/<[^>]+>/g, ' ')
                          .replace(/\s+/g, ' ').trim(),
          maneuver: st.maneuver || 'straight',
        });
      });
    });

    // The stop may have changed while the request was in flight — if so, drop
    // this result rather than pointing the driver at a stop they've passed.
    const now = currentNavStop();
    if (!now || now.rowNumber !== stop.rowNumber) return;

    turnSteps = steps;
    curStepIdx = 0;
    turnTargetRow = stop.rowNumber;
  });
}

function fmtDistance(m) {
  const feet = m * 3.281;
  if (feet > 1000) return (m / 1609).toFixed(1) + ' mi';
  return Math.max(50, Math.round(feet / 50) * 50) + ' ft';
}

function updateTurnBanner(lat, lng) {
  const banner = document.getElementById('turn-banner');
  if (!banner) return;

  const stop = currentNavStop();
  if (!stop) { banner.classList.remove('show'); return; }

  // Steps are stale if they lead somewhere else — the driver advanced, or
  // reordered into Live mode. Clear the throttle too: arriving at a new stop
  // is exactly when directions are needed NOW, not up to 20 s later, and the
  // driver would otherwise sit looking at "Getting directions…" while moving.
  if (turnTargetRow !== stop.rowNumber) {
    turnSteps = [];
    turnTargetRow = stop.rowNumber;   // claim it so we only reset once
    turnFetchedAt = 0;
  }

  if (!turnSteps.length) {
    banner.classList.add('show');
    banner.classList.remove('arriving');
    document.getElementById('turn-arrow').textContent = '↑';
    document.getElementById('turn-dist').textContent = '—';
    document.getElementById('turn-text').textContent = 'Getting directions…';
    document.getElementById('turn-next').textContent = '';
    if (Date.now() - turnFetchedAt > TURN_MIN_REFETCH_MS) {
      fetchTurnSteps(new google.maps.LatLng(lat, lng));
    }
    return;
  }

  // Walk past manoeuvres we've reached. Only ever forwards — GPS jitter
  // shouldn't send the driver back a turn.
  while (curStepIdx < turnSteps.length) {
    const s = turnSteps[curStepIdx];
    if (haversineM(lat, lng, s.lat, s.lng) < STEP_ADVANCE_M) curStepIdx++;
    else break;
  }

  banner.classList.add('show');

  if (curStepIdx >= turnSteps.length) {
    const side = sideOfApproach(lat, lng, stop._latLng);
    banner.classList.add('arriving');
    document.getElementById('turn-arrow').textContent =
      side === 'left' ? '⬅' : side === 'right' ? '➡' : '🏁';
    document.getElementById('turn-dist').textContent = 'Arriving';
    document.getElementById('turn-text').textContent =
      stop.accountName || stop.address || 'Destination';
    document.getElementById('turn-next').textContent = sideLabel(side);
    return;
  }

  const step = turnSteps[curStepIdx];
  const next = turnSteps[curStepIdx + 1];
  const dist = haversineM(lat, lng, step.lat, step.lng);

  // Well off the expected line — ask for a fresh route rather than confidently
  // pointing at a turn the driver has already left behind.
  if (dist > OFF_ROUTE_M && Date.now() - turnFetchedAt > TURN_OFFROUTE_REFETCH_MS) {
    fetchTurnSteps(new google.maps.LatLng(lat, lng));
  }

  banner.classList.remove('arriving');
  document.getElementById('turn-arrow').textContent =
    MANEUVER_ICONS[step.maneuver] || '↑';
  document.getElementById('turn-dist').textContent = fmtDistance(dist);
  document.getElementById('turn-text').textContent = step.instruction;
  document.getElementById('turn-next').textContent = next
    ? 'Then: ' + next.instruction
    : 'Then: arrive at ' + (stop.accountName || 'the stop');
}

// ── Follow mode ──────────────────────────────────────────────────────────────

function applyFollow(latLng, heading, snapZoom) {
  if (!followMode || !gMap) return;
  suppressFollowOff = true;
  gMap.panTo(latLng);
  // Only on engage — re-asserting zoom every tick would fight a driver who
  // deliberately zoomed out to see the rest of the route.
  if (snapZoom && gMap.getZoom() < followZoom) gMap.setZoom(followZoom);
  // Heading-up rotation only takes effect on a vector map (needs a vector
  // mapId from the Google Cloud console). On a raster map this is a no-op,
  // which is why the view stays north-up today.
  if (typeof heading === 'number' && !Number.isNaN(heading) && gMap.setHeading) {
    // Raster maps throw rather than ignore it; nothing to do and nothing to say.
    try { gMap.setHeading(heading); } catch { /* raster map, heading unsupported */ }
  }
  setTimeout(() => { suppressFollowOff = false; }, 0);
}

function setFollow(on) {
  followMode = on;
  const btn = document.getElementById('mode-follow');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.title = on ? 'Following you — tap to stop' : 'Re-centre on your location';
  }
  if (on && lastGpsPos) {
    applyFollow(new google.maps.LatLng(lastGpsPos.lat, lastGpsPos.lng), lastGpsHeading, true);
  }
}

window.toggleFollow = function() { setFollow(!followMode); };

// Dragging the map by hand means the driver wants to look somewhere else —
// stop chasing them until they ask for it back.
function watchForManualPan() {
  if (!gMap) return;
  gMap.addListener('dragstart', () => { if (!suppressFollowOff) setFollow(false); });
}

// ── Satellite toggle ─────────────────────────────────────────────────────────
// Hybrid (aerial + labels) helps drivers spot driveways, bin placement and
// gates on rural properties before they pull up.
window.toggleSatellite = function() {
  if (!gMap) return;
  const isSat = gMap.getMapTypeId() !== 'roadmap';
  gMap.setMapTypeId(isSat ? 'roadmap' : 'hybrid');
  document.getElementById('mode-sat')?.classList.toggle('active', !isSat);
};

// ── GPS tracking ─────────────────────────────────────────────────────────────

function startGpsTracking() {
  if (!navigator.geolocation) return;
  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);

  gpsWatchId = navigator.geolocation.watchPosition(
    onGpsUpdate,
    (err) => console.warn('GPS:', err.message),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

function onGpsUpdate(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const accuracy = pos.coords.accuracy;
  lastGpsPos = { lat, lng };
  // heading is null when stationary — keep the last good one so the view
  // doesn't snap back to north at every red light
  if (typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)
      && pos.coords.speed > 0.5) {
    lastGpsHeading = pos.coords.heading;
  }

  const latLng = new google.maps.LatLng(lat, lng);

  // Blue GPS dot
  if (!gpsMarker) {
    gpsMarker = new google.maps.Marker({
      position: latLng,
      map: gMap,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: '#2563eb',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2.5,
        scale: 10,
      },
      zIndex: 200,
      title: 'Your location',
    });
    gpsCircle = new google.maps.Circle({
      map: gMap,
      center: latLng,
      radius: accuracy,
      strokeColor: '#2563eb',
      strokeOpacity: 0.25,
      strokeWeight: 1,
      fillColor: '#2563eb',
      fillOpacity: 0.08,
    });
  } else {
    gpsMarker.setPosition(latLng);
    gpsCircle.setCenter(latLng);
    gpsCircle.setRadius(accuracy);
  }

  // Ride along with the driver
  applyFollow(latLng, lastGpsHeading);

  // Next manoeuvre on our own screen
  updateTurnBanner(lat, lng);

  // ETA to next undone stop
  fetchNextEta(latLng);

  // Check proximity to current stop → auto-arrive prompt
  const cur = navStops[currentIdx];
  if (cur && !cur.done && cur._latLng) {
    const dist = haversineM(lat, lng, cur._latLng.lat(), cur._latLng.lng());
    if (dist < ARRIVAL_RADIUS_M) {
      promptArrival(cur);
    } else if (dist > ARRIVAL_CLEAR_RADIUS_M && arrivalHandledRow === cur.rowNumber) {
      arrivalHandledRow = null;   // properly left — a later return may prompt again
    }
  }
}

// Which side of the truck the stop is on, so the driver knows which window to
// look out of instead of hunting both sides of the road.
//
// Only meaningful when we know which way they are actually pointing: GPS
// heading is nonsense below walking pace, so lastGpsHeading is left null when
// stationary and this returns nothing rather than guessing. Saying "on your
// right" when it is on the left is worse than saying nothing.
const SIDE_MAX_M = 160;        // far enough out to be useful, close enough to be right
const SIDE_AHEAD_DEG = 22;     // within this of dead ahead, it isn't a side

function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** "left" | "right" | "ahead" | null (null = we cannot say honestly). */
function sideOfApproach(lat, lng, stopLatLng) {
  if (typeof lastGpsHeading !== "number" || Number.isNaN(lastGpsHeading)) return null;
  if (!stopLatLng) return null;

  const dist = haversineM(lat, lng, stopLatLng.lat(), stopLatLng.lng());
  if (dist > SIDE_MAX_M) return null;

  const toStop = bearingDeg(lat, lng, stopLatLng.lat(), stopLatLng.lng());
  let rel = ((toStop - lastGpsHeading + 540) % 360) - 180;   // -180..180
  if (Math.abs(rel) <= SIDE_AHEAD_DEG) return "ahead";
  return rel > 0 ? "right" : "left";
}

function sideLabel(side) {
  if (side === "left") return "⬅ on your left";
  if (side === "right") return "on your right ➡";
  if (side === "ahead") return "straight ahead";
  return "";
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Arrival alerts ────────────────────────────────────────────────────────
//
// A driver's eyes are on the road, so sound is the channel that actually
// works. The design goal is distinctive rather than loud: two soft notes at
// low volume are noticed without being an alarm, and a driver hears them
// forty times a day — anything sharper becomes something they resent and
// eventually mute.
//
// Three modes, because one truck is not another:
//   sound   — two-note chime, a short buzz, and the visual
//   silent  — buzz and visual only, for a quiet cab or a passenger asleep
//   off     — visual only
//
// Stored per device rather than in the shared settings table on purpose.
// There is no per-driver identity in this app — the access code is shared —
// so a value in the database would force one driver's choice onto everyone.
// This is a preference about one person's phone, so it lives on that phone.

const ALERT_MODES = ['sound', 'silent', 'off'];
const ALERT_KEY = 'ev_alert_mode';

function alertMode() {
  try {
    const v = localStorage.getItem(ALERT_KEY);
    return ALERT_MODES.includes(v) ? v : 'sound';
  } catch { return 'sound'; }     // private mode, blocked storage
}

function setAlertMode(mode) {
  try { localStorage.setItem(ALERT_KEY, mode); } catch {}
  updateAlertChip();
}

let audioCtx = null;

// Browsers refuse to make noise until the user has interacted with the page.
// The driver taps to open their route, so we build the context on that first
// gesture — otherwise the very first arrival of the day would be silent.
function primeAudio() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } catch {}
}
['pointerdown', 'keydown'].forEach(ev =>
  window.addEventListener(ev, primeAudio, { once: true, passive: true }));

/** Two soft notes. Synthesised, so there is no audio file to load or lose. */
function chime() {
  if (!audioCtx) primeAudio();
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    [[660, 0], [880, 0.12]].forEach(([freq, offset]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';                       // no harshness
      osc.frequency.value = freq;
      // Quick fade in and out: a hard start is what makes a beep feel like an
      // alarm, and the tail is what makes it feel like a chime.
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.13, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.24);
    });
  } catch {}
}

/** Fire the alert for the current mode. Visual always happens either way. */
function fireArrivalAlert() {
  const mode = alertMode();
  if (mode === 'off') return;
  // Two short taps rather than one long buzz — a long one reads as a phone
  // call and makes a driver reach for the phone.
  try { navigator.vibrate?.([90, 70, 90]); } catch { /* iOS has no vibrate */ }
  if (mode === 'sound') chime();
}

// The chip is in the page from the start, so it has to show the saved choice
// immediately. Doing this only on map init left a driver who picked Silent
// looking at a chip that said Sound until they opened the map tab.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", updateAlertChip);
} else {
  updateAlertChip();
}

window.cycleAlertMode = function () {
  const next = ALERT_MODES[(ALERT_MODES.indexOf(alertMode()) + 1) % ALERT_MODES.length];
  setAlertMode(next);
  primeAudio();
  if (next === 'sound') chime();      // let them hear what they just chose
  else if (next === 'silent') { try { navigator.vibrate?.([90, 70, 90]); } catch {} }
};

function updateAlertChip() {
  const el = document.getElementById('mode-alert');
  if (!el) return;
  const mode = alertMode();
  el.textContent = mode === 'sound' ? '🔔 Sound'
                 : mode === 'silent' ? '📳 Silent'
                 : '🔕 Alerts off';
  el.classList.toggle('active', mode !== 'off');
  el.title = 'Arrival alerts: ' + mode + ' — tap to change';
}

let arrivalPromptRow = null;   // the toast currently on screen
let arrivalHandledRow = null;  // already prompted for this visit — see below

function promptArrival(stop) {
  // The auto-dismiss below used to clear this, so a driver parked at a stop
  // got re-prompted every ~12 s for as long as they were servicing it. Now
  // that the prompt also buzzes the phone, that would be a repeating jab in
  // the pocket. One prompt per arrival; leaving the radius re-arms it.
  if (arrivalHandledRow === stop.rowNumber) return;
  arrivalHandledRow = stop.rowNumber;
  arrivalPromptRow = stop.rowNumber;

  // A driver watching the road will not see a toast, so the alert has to reach
  // them some other way. Honours the sound/silent/off choice.
  fireArrivalAlert();

  const side = lastGpsPos
    ? sideOfApproach(lastGpsPos.lat, lastGpsPos.lng, stop._latLng)
    : null;
  const sideBit = side && side !== 'ahead' ? ` · ${sideLabel(side)}` : '';

  const toast = document.getElementById('toast');
  toast.innerHTML = `Arrived at <b>${escHtml(stop.accountName || stop.address)}</b>?${sideBit} <button id="arrive-yes" style="margin-left:8px;padding:4px 10px;border:none;border-radius:var(--r-control);background:#22c55e;color:#fff;font-weight:700;cursor:pointer;">✓ Done</button>`;
  toast.classList.add('show');

  document.getElementById('arrive-yes').addEventListener('click', () => {
    toast.classList.remove('show');
    arrivalPromptRow = null;
    arrivalHandledRow = null;   // stop is done and we advance — safe to re-arm
    window.navDone();
  });

  // Auto-dismiss after 12 s if ignored. Deliberately does NOT clear
  // arrivalHandledRow — hiding the toast must not re-arm the prompt.
  setTimeout(() => {
    if (arrivalPromptRow === stop.rowNumber) {
      toast.classList.remove('show');
      arrivalPromptRow = null;
    }
  }, 12000);
}

function fetchNextEta(fromLatLng) {
  if (!etaService) return;
  const cur = navStops[currentIdx];
  if (!cur || cur.done || !cur._latLng) return;

  etaService.getDistanceMatrix({
    origins: [fromLatLng],
    destinations: [cur._latLng],
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
  }, (resp, status) => {
    if (status !== 'OK') return;
    const el = resp.rows[0]?.elements[0];
    if (!el || el.status !== 'OK') return;
    // Same helper as the route totals, so the last direct .value read is gone.
    const secs = legSeconds(el, true);
    if (!secs) return;   // nothing useful to show; keep the previous ETA
    nextEtaMins = Math.ceil(secs / 60);
    renderNavCard(); // refresh card with updated ETA
  });
}

window.setRouteMode = function(mode) {
  if (mode === routeMode) return;
  routeMode = mode;

  if (mode === 'planned') {
    // Restore original order, keeping done status
    navStops = [...plannedOrder];
    placeMarkers();
    currentIdx = Math.max(0, navStops.findIndex(s => !s.done));
    updateModeUI();
    drawRouteLine();
    renderNavCard();
    centerOnCurrent();
  } else {
    // Live: optimize remaining stops
    const remaining = routeChunk(plannedOrder.filter(s => !s.done && s._latLng));
    if (remaining.length < 2) {
      routeMode = 'planned';
      updateModeUI();
      document.getElementById('optimize-status').textContent = 'Need 2+ remaining stops to optimize.';
      return;
    }

    document.getElementById('optimize-status').textContent = 'Calculating live route…';
    document.getElementById('mode-live').disabled = true;

    directionsService.route({
      origin: remaining[0]._latLng,
      destination: remaining[remaining.length - 1]._latLng,
      waypoints: remaining.slice(1, -1).map(s => ({ location: s._latLng, stopover: true })),
      optimizeWaypoints: true,
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
    }, (result, status) => {
      document.getElementById('mode-live').disabled = false;
      if (status !== 'OK') {
        routeMode = 'planned';
        updateModeUI();
        document.getElementById('optimize-status').textContent = 'Could not calculate live route.';
        return;
      }

      const order = result.routes[0].waypoint_order;
      const reordered = [remaining[0], ...order.map(i => remaining[i + 1]), remaining[remaining.length - 1]];
      liveMins = routeMinutes(result.routes[0].legs, true);

      const done = plannedOrder.filter(s => s.done);
      navStops = [...reordered, ...done];
      placeMarkers();
      currentIdx = 0;
      directionsRenderer.setOptions({
        polylineOptions: { strokeColor: LIVE_COLOR, strokeWeight: 5, strokeOpacity: 0.8 },
      });
      directionsRenderer.setDirections(result);
      updateModeUI();
      renderNavCard();
      centerOnCurrent();
    });
  }
};

function renderNavCard() {
  const card = document.getElementById('nav-card');
  if (!navStops.length) { card.style.display = 'none'; return; }

  const stop = navStops[currentIdx];
  const total = navStops.length;
  const doneCount = navStops.filter(s => s.done).length;
  const color = rowColorToHex(stop.rowColor);
  const nameOrAddr = stop.accountName || stop.address;
  const addrLine = stop.accountName ? (stop.address + (stop.city ? ', ' + stop.city : '')) : (stop.city || '');
  const modeBadge = routeMode === 'live'
    ? `<span class="nav-mode-badge live">⚡ Live</span>`
    : `<span class="nav-mode-badge planned">📋 Planned</span>`;

  const accessHtml = stop.directions
    ? `<div class="nav-access-chip">🔑 ${escHtml(stop.directions)}</div>`
    : '';

  const tabName = window._routeTabName || '';
  const row = stop.rowNumber;

  // Classify existing note for styling
  const noteClass = stop.noteUrgency === 'urgent' ? 'nav-note urgent'
                  : stop.noteUrgency === 'hold'   ? 'nav-note hold'
                  : 'nav-note';

  const noteHtmlStyled = stop.notes
    ? `<div class="${noteClass}">${escHtml(stop.notes)}</div>`
    : '';

  const etaHtml = (!stop.done && nextEtaMins !== null)
    ? `<span class="nav-eta">🚗 ${nextEtaMins} min away</span>`
    : '';

  card.style.display = 'block';
  card.innerHTML = `
    <div class="nav-progress-row">
      <span class="nav-stop-count">${currentIdx + 1} of ${total} ${modeBadge}</span>
      <span class="nav-done-count">${doneCount} done ${etaHtml}</span>
    </div>
    <div class="nav-stop-name" style="${color ? `border-left:4px solid ${color};padding-left:10px;` : ''}">${escHtml(nameOrAddr)}</div>
    ${addrLine ? `<div class="nav-stop-addr">${escHtml(addrLine)}</div>` : ''}
    ${accessHtml}
    ${noteHtmlStyled}
    <div class="nav-report-btns">
      <button class="report-quick-btn contamination" onclick="reportFile('contamination',${row},'${escHtml(tabName)}')">🚫 Contamination</button>
      <button class="report-quick-btn overflow"      onclick="reportFile('overflow',${row},'${escHtml(tabName)}')">📦 Overflow</button>
      <button class="report-quick-btn skip"          onclick="reportFile('skip',${row},'${escHtml(tabName)}')">⏭ Skip</button>
      <button class="report-quick-btn photo"         onclick="reportFile('photo',${row},'${escHtml(tabName)}')">📷 Photo</button>
    </div>
    <div id="nav-app-picker">
      <button class="nav-app-btn" onclick="navOpenIn('google')">🗺 Google Maps · next ${navHandoffCount()} stops</button>
      <button class="nav-app-btn" onclick="navOpenIn('waze')">🚦 Waze</button>
      <button class="nav-app-btn" onclick="navOpenIn('apple')">🍎 Apple Maps</button>
    </div>
    <div class="nav-actions">
      <button class="nav-btn nav-btn-prev" onclick="navStep(-1)" ${currentIdx === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="nav-btn nav-btn-maps" onclick="toggleNavPicker()">↗ Navigate</button>
      ${stop.done
        ? `<button class="nav-btn nav-btn-undo" onclick="navUndo()">Undo</button>`
        : `<button class="nav-btn nav-btn-done" onclick="navDone()">✓ Done</button>`}
      <button class="nav-btn nav-btn-next" onclick="navStep(1)" ${currentIdx === total - 1 ? 'disabled' : ''}>Next →</button>
    </div>`;
}

function jumpTo(idx) {
  currentIdx = idx;
  nextEtaMins = null;       // clear stale ETA; fetchNextEta will refresh
  arrivalPromptRow = null;  // reset arrival guard for new stop
  updateMarkerIcons();
  renderNavCard();
  centerOnCurrent();
  if (lastGpsPos) fetchNextEta(new google.maps.LatLng(lastGpsPos.lat, lastGpsPos.lng));
}

window.navStep = function(dir) {
  const next = currentIdx + dir;
  if (next < 0 || next >= navStops.length) return;
  jumpTo(next);
};

window.navDone = async function() {
  const stop = navStops[currentIdx];
  if (!stop) return;
  stop.done = true;
  // Keep plannedOrder in sync
  const ps = plannedOrder.find(s => s.rowNumber === stop.rowNumber);
  if (ps) ps.done = true;
  updateMarkerIcons();
  drawRouteLine();
  renderNavCard();
  if (window.allStops) {
    const s = window.allStops.find(x => x.rowNumber === stop.rowNumber);
    if (s) s.done = true;
    if (window.syncStopDone) window.syncStopDone(stop.rowNumber, true);
  }
  const nextIdx = navStops.findIndex((s, i) => i > currentIdx && !s.done);
  if (nextIdx >= 0) setTimeout(() => jumpTo(nextIdx), 300);
};

window.navUndo = async function() {
  const stop = navStops[currentIdx];
  if (!stop) return;
  stop.done = false;
  const ps = plannedOrder.find(s => s.rowNumber === stop.rowNumber);
  if (ps) ps.done = false;
  updateMarkerIcons();
  drawRouteLine();
  renderNavCard();
  if (window.allStops) {
    const s = window.allStops.find(x => x.rowNumber === stop.rowNumber);
    if (s) s.done = false;
    if (window.syncStopDone) window.syncStopDone(stop.rowNumber, false);
  }
};

window.renderNavCard = renderNavCard;

window.notifyStopsUpdated = function() {
  if (!window._mapInitialized || !gMap) return;
  geocodeAndPlot();
};

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
