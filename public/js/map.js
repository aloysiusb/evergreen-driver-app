// Map tab — navigation mode, planned vs live route modes

/* Open a route straight onto its map with ?view=map.
 *
 * The dispatcher board links here: the office wants to see where a route goes
 * without first landing on a list of stops and hunting for the tab. The map
 * only builds itself when it is actually shown, so this waits for the page to
 * be ready rather than racing it. */
/* The map is the default now. A driver opening their route is about to drive
 * it, not read it, and the list is one tap away — where the map used to be.
 * ?view=stops opens on the list; the dispatcher board's ?view=map links are
 * unchanged. */
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') === 'stops' ? 'stops' : 'map';
  // A moment for the route data to arrive, or the map draws an empty route.
  setTimeout(() => window.switchView(view), 400);
});

/* Make the map exactly as tall as the room it has.
 *
 * Everything above it (app bar, header line) is in the flow, so the map's own
 * top tells us how much is gone. What is easy to miss is the action bar at the
 * foot: it is position:fixed, so it occupies no space and the map ran happily
 * underneath it — which put the dock's captions behind "Start My Day" where
 * they could be neither read nor tapped.
 *
 * Measured rather than guessed, because both ends move: the header's height
 * depends on the route name, and the action bar's on which buttons it shows. */
function sizeMap() {
  const map = document.getElementById('route-map');
  if (!map || map.offsetParent === null) return;   // not on screen; nothing to size

  /* visualViewport, not innerHeight.
   *
   * On a phone innerHeight counts the strip behind the browser's address bar.
   * That is real layout, but it is NOT on screen while the bar is showing, so
   * sizing the map to it made the map taller than the visible window — and the
   * dock, which hung off the map's bottom, ended up below the fold underneath
   * the fixed action bar. A driver saw "Start My Day" where the controls should
   * be and no sign the dock existed at all.
   *
   * visualViewport.height is what is actually visible. */
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  const top = map.getBoundingClientRect().top;

  /* Everything pinned to the foot of the screen, not just the action bar.
     On a test drive the sim panel sits at bottom:0 on top of it, 126px of it,
     and the map was sized as though only the action bar were there — so the
     dock's lower row ended up buried under the sim's own controls. Both are
     fixed and both start at the bottom, so the taller one is the clearance
     that matters. */
  const bar = document.querySelector('.action-bar');
  const sim = document.getElementById('sim-panel');
  const barH = Math.max(
    bar ? bar.getBoundingClientRect().height : 0,
    sim ? sim.getBoundingClientRect().height : 0
  );
  /* The floor is 180, not 260. A phone held sideways is about 360px tall, and
     after the bars there is roughly 190 left — forcing 260 made the map taller
     than the room it had, so the page overflowed and the dock came to rest on
     top of the head-up display. Better a short map that fits than a tall one
     that does not. */
  const h = Math.max(vh - top - barH, 180);
  map.style.height = h + 'px';

  /* And the dock is anchored to the action bar rather than to the map, set
     from here because only JS can know how tall that bar is. Belt and braces
     with the sizing above: even if the map ends up the wrong height on some
     browser, the dock still sits in the visible window rather than wherever
     the map happens to end. */
  /* 32, not 14. Google's logo and its Terms links sit about 6px up from the
     map's bottom edge and stand roughly 17px tall, and the map's bottom edge is
     the action bar's top. A 14px gap put the tray straight back over both of
     them — measured, after the first attempt at this. 32 clears them with room
     to spare and still reads as a bar at the foot of the map. */
  document.documentElement.style.setProperty('--dock-bottom', (barH + 32) + 'px');

  /* The dock is at the TOP of the map now, and its height decides where the
     compass, the directions and both pickers start. A narrower window wraps
     it onto another row, so it is re-measured whenever the map is. */
  window.measureDock?.();

  // Google needs telling, or it keeps painting tiles for the old box.
  if (gMap && window.google?.maps?.event) {
    google.maps.event.trigger(gMap, 'resize');
  }
}
window.sizeMap = sizeMap;

/* Where the route line sticks to.
 *
 * The app bar is sticky at the top and the route line sticks directly under
 * it, so the route line has to know how tall the app bar is. That is not a
 * constant: the bar's company name and page label come from the style editor,
 * so a longer name or a bigger font changes it. Measured, so the two never
 * overlap and never leave a stripe of scrolling page between them. */
function setBarOffsets() {
  const bar = document.querySelector('.app-bar');
  if (!bar) return;
  document.documentElement.style.setProperty(
    '--appbar-h', Math.round(bar.getBoundingClientRect().height) + 'px');
}
window.setBarOffsets = setBarOffsets;
document.addEventListener('DOMContentLoaded', setBarOffsets);
window.addEventListener('resize', setBarOffsets);
// Webfonts land after first paint and bring a different line height with them.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(setBarOffsets);

/* Rotating the phone, the action bar gaining a button, and — the one that
   actually bites on a phone — the address bar sliding away as the driver
   scrolls, which changes the visible height without firing a window resize. */
window.addEventListener('resize', sizeMap);
window.addEventListener('orientationchange', () => setTimeout(sizeMap, 250));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', sizeMap);
  window.visualViewport.addEventListener('scroll', sizeMap);
}

/* The header collapses to a hamburger on a phone: the links and the date go
   inside it. Stops / Map never does — that is the control, not a detail. */
window.toggleHeaderMenu = function () {
  const drawer = document.getElementById('hdr-drawer');
  const btn = document.getElementById('hdr-menu');
  if (!drawer || !btn) return;
  const open = drawer.hidden;
  drawer.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
};

window.switchView = function(view) {
  document.getElementById('view-stops').style.display = view === 'stops' ? 'block' : 'none';
  document.getElementById('view-map').style.display   = view === 'map'   ? 'block' : 'none';
  document.getElementById('tab-stops').classList.toggle('active', view === 'stops');
  document.getElementById('tab-map').classList.toggle('active',   view === 'map');
  if (view === 'map') {
    // Size it now it is visible — a hidden element measures as nothing.
    sizeMap();
    if (!window._mapInitialized) {
      window._mapInitialized = true;
      initMap();
    }
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
// Kept so the dock's GPS button can show the fix rather than just implying it.
let lastGpsAccuracy = null;
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
// Street level. This was 17, which reads the side streets fine but sits
// further back than the walkthrough's driving view — that one is 18, and 18 is
// what people mean when they say they want the view from the video.
let followZoom = 16;          // see ZOOM_DRIVING
// The single point where the zoom is allowed to change. Everything else asks
// this, and nothing calls setZoom directly.
function goToZoom(z) {
  if (!gMap) return;
  zoomLocked = z;
  // Unpin, move, re-pin. Pinned means minZoom === maxZoom, which is what stops
  // a pinch doing anything at all — the slider is the way zoom changes.
  gMap.setOptions({ minZoom: null, maxZoom: null });
  gMap.setZoom(z);
  gMap.setOptions({ minZoom: z, maxZoom: z });
  const slider = document.getElementById('zoom-slider');
  if (slider && Number(slider.value) !== z) slider.value = z;
}

/* The slider. A driver dragging it is deciding, so it does exactly what it is
   told — including leaving the route view, since a zoom they chose by hand is
   no longer the framing the Route button set up. */
window.setZoomFromSlider = function (v) {
  const z = Number(v);
  if (!Number.isFinite(z)) return;
  if (overviewOn) { overviewOn = false; syncViewButtons(); }
  goToZoom(z);
};

/* The + and − ends. Same thing one step at a time, for a gloved thumb that
   would rather tap than drag. */
window.nudgeZoom = function (delta) {
  const slider = document.getElementById('zoom-slider');
  if (!slider) return;
  const z = Math.min(Math.max(Number(slider.value) + delta, Number(slider.min)), Number(slider.max));
  slider.value = z;
  window.setZoomFromSlider(z);
};
let suppressFollowOff = false; // set while WE move the map, so our own pans don't count as manual

// The vector Map ID, if one is configured on the server. Null on a raster map,
// and that is the whole difference: tilt and heading-up are silently ignored
// without it. Everything below checks this rather than trying and hoping.
let mapId = null;
const FOLLOW_TILT = 45;       // matches the walkthrough's driving view

/* ── Zoom: two considered views, not a gesture to fight ───────────────────
 *
 * Pinch zoom is continuous and very sensitive, and on a map that is also
 * riding along with you it is genuinely unpleasant: a fingertip's travel is
 * several zoom levels, every one of them re-rendering, and you end up either
 * in the weeds or in orbit and hunting for the level you actually wanted.
 *
 * So the map has TWO views and no dial:
 *
 *   Driving   close in, riding with the truck                (the default)
 *   Route     pulled back far enough to see what is still to do
 *
 * and the zoom is LOCKED to whichever one is showing. Locked literally —
 * minZoom and maxZoom are pinned to the same number, so a stray pinch has
 * nowhere to go and simply does nothing. The buttons unlock, move, and re-lock.
 * Panning is untouched: dragging to look around still works, and still drops
 * follow.
 *
 * The effect is that the zoom cannot be nudged, only chosen — which is the
 * point. Nothing between the two views is a view anybody asked for. */
/* The distance the map sits at when it is riding with the driver.
 *
 * It was 18, which is a block and a half — close enough that the next turn is
 * off the edge of the screen and the map is a moving carpet rather than a
 * picture of where you are. 16 shows the grid of the roads around the truck:
 * the turn coming up, the one after it, and how the streets join. That is the
 * distance a driver is actually reading for.
 *
 * One number, used by the opening view, by Default, and by Recentre, so all
 * three agree about what "usual" means. */
const ZOOM_DRIVING = 16;
let zoomLocked = null;          // the level the map is currently pinned to
let overviewOn = false;
// fitBounds picks its own zoom and reports it back asynchronously, so the lock
// has to wait for the map to settle before it can pin the result.
let pendingLock = false;

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
    const cfg = await res.json();
    apiKey = cfg.key;
    mapId = cfg.mapId || null;
  } catch {
    loadingEl.textContent = 'Maps not configured — add GOOGLE_MAPS_API_KEY in Render.';
    return;
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // map_ids lets Google fetch the style for this map before the map is
    // created, so a vector map paints in one pass instead of two.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places` +
            (mapId ? `&map_ids=${encodeURIComponent(mapId)}` : '');
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Maps failed'));
    document.head.appendChild(s);
  });

  loadingEl.style.display = 'none';

  gMap = new google.maps.Map(document.getElementById('route-map'), {
    // Open at the driving zoom rather than at 15 and then snapping in once
    // GPS arrives. That snap was a visible lurch on every load, and the close
    // view is the one the driver wants anyway.
    zoom: followZoom,
    center: { lat: 39.4022, lng: -107.2117 },   // Carbondale, CO
    // Pinned from the start, so the zoom is never a thing a finger can nudge.
    // The two view buttons move between levels; see the zoom notes at the top.
    minZoom: followZoom,
    maxZoom: followZoom,
    gestureHandling: 'greedy',
    // The rest of the ways a map normally changes zoom, all of them
    // accidental on a phone on a dashboard mount.
    zoomControl: false,
    scrollwheel: false,
    disableDoubleClickZoom: true,
    // Only passed when one is configured. Handing Google a mapId of null or
    // an empty string is not the same as omitting it — it asks for a map that
    // does not exist, and the map fails to load rather than falling back.
    ...(mapId ? { mapId } : {}),
    /* Both top corners are given over to the head-up display: where you are,
       which way you are pointing, and the next manoeuvre. So Google's own two
       controls up there go, and neither is a loss.

       The map-type dropdown is replaced by the dock's 🛰 Sat button, which is
       the same choice in a place a thumb can reach.

       Fullscreen is worse than redundant: the map already fills the screen,
       and going fullscreen takes the dock with it — a driver would lose every
       control they have to get a map that is the same size. */
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: true,           // drop pegman to scout a driveway
    /* Google puts the pegman and the rotate control at RIGHT_BOTTOM by
       default, which is exactly where the dock's right-hand buttons now are,
       and the scale bar at BOTTOM_LEFT, under its left-hand ones. Moved to the
       left edge, which nothing else uses.

       The two things that CANNOT be moved are the Google logo (bottom left)
       and the Terms / "report a map error" links (bottom right). They have to
       stay visible — that is a condition of using the API, not a preference —
       so the dock is inset from both bottom corners rather than drawn over
       them. See #map-dock in app.css. */
    streetViewControlOptions: { position: google.maps.ControlPosition.LEFT_CENTER },
    rotateControl: true,
    rotateControlOptions: { position: google.maps.ControlPosition.LEFT_CENTER },
    // A scale bar tells a compost driver nothing they act on, and it lives in
    // the one corner that has to stay clear for Google's logo.
    scaleControl: false,
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
  // What other drivers have already reported today, before the socket starts
  // carrying what happens next.
  loadHazards();
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

/* The picker is part of the map now, not part of the stop card, so it is
   written once in the page and only shown and hidden here. Rebuilding it with
   the card is what used to anchor it to the bottom of the screen. */
window.toggleNavPicker = function(show) {
  const el = document.getElementById('nav-app-picker');
  if (!el) return;
  const open = show === undefined ? el.hidden : Boolean(show);
  if (open) {
    // The Google handoff covers a run of stops, and how many depends on where
    // the driver is up to — so it is worked out as the picker opens.
    const n = navHandoffCount();
    const cap = document.getElementById('nav-handoff-count');
    if (cap) cap.textContent = n > 1 ? `next ${n} stops` : 'this stop';
  }
  el.hidden = !open;
};

window.closeNavPicker = function closeNavPicker() {
  const el = document.getElementById('nav-app-picker');
  if (el) el.hidden = true;
};

/* Floating over the map, it needs a way out that is not a button — a driver
   who opened it by accident should be able to tap the map and carry on. */
document.addEventListener('click', (e) => {
  const el = document.getElementById('nav-app-picker');
  if (!el || el.hidden) return;
  if (el.contains(e.target) || e.target.closest('.nav-btn-maps')) return;
  el.hidden = true;
}, true);

function updateModeUI() {
  /* One dock button for both orders now, so it says which one it is showing
     rather than lighting one of a pair. Lit means Live, because Live is the
     one that is doing something to the order the sheet gave you. */
  const orderBtn = document.getElementById('mode-live');
  const orderCap = document.getElementById('order-cap');
  const orderIco = orderBtn && orderBtn.querySelector('.dock-ico');
  if (orderBtn) {
    orderBtn.classList.toggle('on', routeMode === 'live');
    orderBtn.title = routeMode === 'live'
      ? 'Quickest order from here — tap for the sheet order'
      : 'Sheet order — tap for the quickest order from here';
  }
  /* Whole words now the menu is a list. They were clipped to "Plan" and "Live"
     because a 46px circle was all the room a caption had. */
  if (orderCap) orderCap.textContent =
    routeMode === 'live' ? 'Quickest order' : 'Sheet order';
  if (orderIco) orderIco.textContent = routeMode === 'live' ? '⚡' : '📋';

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

/* What is between here and the stop: the traffic Google reports, and anything
 * a driver has flagged on the road.
 *
 * Only the nearest hazard, and only one that is actually near — a rockslide
 * eleven miles away on a road nobody is taking is noise, and noise is what
 * teaches people to stop reading the banner. Distance is straight-line, which
 * understates road distance; that errs towards warning early, which is the
 * right way to be wrong about a rockslide. */
const HAZARD_ALERT_M = 8000;   // about five miles

/* ── What is on the road, across the top of the map ───────────────────────
 *
 * The Waze half of this app: what the other drivers have reported, where a
 * driver will see it without asking. It was only ever a single chip inside the
 * directions panel, which is off by default — so a rockslide two miles ahead
 * was behind a setting.
 *
 * Two lines, because two is what you take in at a glance and the rest is
 * reference. Anything past that sits behind "more". Nearest first: a slide you
 * are about to reach matters more than one at the far end of the round.
 *
 * Gone entirely when nobody has reported anything, which is most days. */
let hazardStripOpen = false;

/* On by default — a driver should not have to go looking for "there is a slide
   on the road you are driving down". But it is their screen, so it can be put
   away, and putting it away leaves a count behind rather than nothing: a note
   that vanishes completely is one nobody remembers they turned off. */
const HAZARD_NOTE_KEY = 'ev_hazard_note_hidden';
let hazardNoteHidden = false;
try { hazardNoteHidden = localStorage.getItem(HAZARD_NOTE_KEY) === '1'; } catch {}

window.toggleHazardStrip = function () {
  hazardStripOpen = !hazardStripOpen;
  renderHazardStrip();
};

window.hideHazardNote = function () {
  hazardNoteHidden = true;
  hazardStripOpen = false;
  try { localStorage.setItem(HAZARD_NOTE_KEY, '1'); } catch {}
  renderHazardStrip();
};

window.showHazardNote = function () {
  hazardNoteHidden = false;
  try { localStorage.setItem(HAZARD_NOTE_KEY, '0'); } catch {}
  renderHazardStrip();
};

function renderHazardStrip() {
  const wrap = document.getElementById('hazard-strip');
  const row = document.getElementById('hz-strip-row');
  const more = document.getElementById('hz-strip-more');
  if (!wrap || !row) return;

  const list = [...hazardData.values()].map(h => {
    const d = lastGpsPos ? haversineM(lastGpsPos.lat, lastGpsPos.lng, h.lat, h.lng) : null;
    return { ...h, _d: d };
  }).sort((a, b) => (a._d ?? Infinity) - (b._d ?? Infinity));

  const badge = document.getElementById('hazard-badge');

  if (!list.length) {
    wrap.hidden = true;
    if (badge) badge.hidden = true;
    hazardStripOpen = false;
    document.documentElement.style.setProperty('--hz-strip-h', '0px');
    return;
  }

  /* Put away: the note goes, a count stays. */
  if (hazardNoteHidden) {
    wrap.hidden = true;
    if (badge) {
      badge.hidden = false;
      badge.textContent = '⚠ ' + list.length;
      badge.title = list.length === 1
        ? '1 road report — tap to show'
        : list.length + ' road reports — tap to show';
    }
    document.documentElement.style.setProperty('--hz-strip-h', '0px');
    return;
  }

  wrap.hidden = false;
  if (badge) badge.hidden = true;

  wrap.classList.toggle('open', hazardStripOpen);
  /* Lines in a box, not buttons on the map. Seven red pills across the top
     read as an alarm going off — which is wrong for "somebody saw ice up the
     valley this morning". This is a note, so it looks like one. */
  row.innerHTML = list.map(h =>
    '<div class="hz-line">' +
      '<span class="hz-line-ico">' + (h.icon || '⚠️') + '</span>' +
      '<span class="hz-line-what">' + escHtml(h.label) + '</span>' +
      (h._d !== null ? '<span class="hz-line-dist">' + fmtDistance(h._d) + '</span>' : '') +
    '</div>'
  ).join('');

  /* Whether "more" is needed is a question about the rendered height, not
     about how many there are: three short ones fit on two lines and two long
     ones may not. Measured after a frame, for the same reason the dock's
     height is. */
  requestAnimationFrame(() => {
    const overflowing = row.scrollHeight > row.clientHeight + 2;
    if (more) {
      more.hidden = !overflowing && !hazardStripOpen;
      more.textContent = hazardStripOpen ? 'Show less' : 'More';
    }
    /* Publish the height so the directions, when a driver has them on, start
       below the warnings rather than behind them. */
    document.documentElement.style.setProperty(
      '--hz-strip-h', (wrap.offsetHeight + 6) + 'px');
  });
}
window.renderHazardStrip = renderHazardStrip;

/* focusHazard() lived here — each hazard was a button that put the map on
   it. The list is plain text now, so there is nothing to click and nothing to
   send anywhere. */

function updateConditions(lat, lng) {
  const el = document.getElementById('turn-conditions');
  if (!el) return;
  const chips = [];

  const traffic = typeof trafficLabel === 'function' ? trafficLabel() : '';
  if (traffic) chips.push('<span class="cond-chip">' + escHtml(traffic) + '</span>');

  let nearest = null, nearestM = Infinity;
  for (const h of hazardData.values()) {
    const d = haversineM(lat, lng, h.lat, h.lng);
    if (d < nearestM) { nearest = h; nearestM = d; }
  }
  if (nearest && nearestM <= HAZARD_ALERT_M) {
    chips.push('<span class="cond-chip hazard">' + (nearest.icon || '⚠️') + ' ' +
      escHtml(nearest.label) + ' · ' + fmtDistance(nearestM) + '</span>');
  }

  el.innerHTML = chips.join('');
}

function updateTurnBanner(lat, lng) {
  const banner = document.getElementById('turn-banner');
  if (!banner) return;

  const stop = currentNavStop();
  if (!stop) { banner.classList.remove('show'); return; }

  // Conditions are about the road, not about the manoeuvre, so they are worked
  // out before any of the early returns below — a driver waiting on directions
  // still wants to know there is a slide ahead.
  updateConditions(lat, lng);
  /* The distances on the strip are only true for where the truck is now. */
  renderHazardStrip();

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

  /* Cleared on the next tick WHATEVER happens below, which is why it is here
     and not at the end.
     It used to be the last line of this function — after `if (!mapId) return`,
     the early exit for a map without vector rendering. That is every map in
     production: the vector Map ID has never been created. So the first GPS fix
     set this flag and nothing ever cleared it, and from then on a manual pan
     was not recognised as manual. A driver dragging the map to look up the
     road had the next fix, a second later, haul it straight back under their
     thumb — over and over, which is what "the map is all over the place"
     actually was. */
  setTimeout(() => { suppressFollowOff = false; }, 0);

  /* setCenter, not panTo, and this is the whole reason the map still looked
     jumpy after the GPS updates were smoothed out.

     panTo is an ANIMATED pan: it eases the map across over a few hundred
     milliseconds. That was fine at one position a second, because each
     animation finished long before the next arrived. At a position every 80 ms
     each pan interrupts the one before it a fraction of the way through its
     easing curve, and a map that is forever restarting an ease looks like it
     is stuttering — worse than the slideshow it replaced.

     setCenter moves instantly. Thirteen small instant steps a second is what
     smooth motion is; it is how the walkthrough does it, and how video does
     it. The animation was never the thing making it smooth. */
  gMap.setCenter(latLng);

  // Coming back to the driving view from the route view. Otherwise the zoom is
  // already pinned where it belongs and there is nothing to do — no re-assert
  // on every engage, which is what used to haul a driver back in.
  if (snapZoom && zoomLocked !== followZoom && !overviewOn) goToZoom(followZoom);

  // Tilt and heading-up only exist on a vector map, which means a Map ID made
  // with vector rendering in the Google Cloud console and set as
  // GOOGLE_MAPS_MAP_ID. Without one both calls are ignored, so there is
  // nothing to gain by making them and a tilt to un-do if one appears later.
  if (!mapId) return;

  // Lean the map over on engage only, for the same reason as the zoom: a
  // driver who flattened it deliberately should not have it pushed back.
  if (snapZoom && gMap.setTilt) gMap.setTilt(FOLLOW_TILT);

  if (typeof heading === 'number' && !Number.isNaN(heading) && gMap.setHeading) {
    gMap.setHeading(heading);   // rotates so the way they are driving is "up"
  }
}

/* Driving and Route are one choice with two answers, so they are painted from
   one place and from the state itself — never toggled independently.
   They used to be two separate booleans each lighting its own button, so
   tapping Driving while the Route view was on lit BOTH, and the next tap of
   Route then did the opposite of what the button said. */
function syncViewButtons() {
  const drive = document.getElementById('mode-follow');
  const route = document.getElementById('mode-overview');
  if (drive) drive.classList.toggle('active', !overviewOn);
  if (route) route.classList.toggle('active', overviewOn);
}

/* What the two buttons call. Picking one IS leaving the other, which is the
   whole point of a choice, and is why neither of them is a toggle. */
window.setMapView = function (view) {
  cancelFollowResume();
  if (view === 'route') setOverview(true);
  else { setOverview(false); setFollow(true); }
};

function setFollow(on) {
  followMode = on;
  updateRecenterBtn();
  // Choosing to ride along is choosing the driving view.
  if (on && overviewOn) { overviewOn = false; goToZoom(followZoom); }
  syncViewButtons();
  // Re-centres, but does NOT haul the zoom back. Tapping 🧭 after looking
  // around used to snap you to zoom 18 whatever you had chosen, which is the
  // map "jumping" for no reason a driver asked for.
  if (on && lastGpsPos) {
    applyFollow(new google.maps.LatLng(lastGpsPos.lat, lastGpsPos.lng), lastGpsHeading, true);
  }
  // Dropping out of follow is how a driver asks to look at the route as a
  // whole, and a tilted, rotated map is the wrong shape for that. Put it back
  // flat and north-up so 🧭 is the toggle between the two views rather than a
  // one-way trip into the driving one. No extra button for it.
  if (!on && mapId && gMap) {
    if (gMap.setTilt) gMap.setTilt(0);
    if (gMap.setHeading) gMap.setHeading(0);
  }
}

// Dragging the map by hand means the driver wants to look somewhere else —
// stop chasing them until they ask for it back.
/* How long the map stays where a driver put it before it comes back to them.
 *
 * Dragging used to switch following off for good. On a desk that is fine — you
 * drag, you look, you tap Driving. On a phone held in one hand on a bumpy road
 * it fires on the smallest touch, silently, and the map then sits where it was
 * while the truck drives off it. That is what "it's all over the place" is:
 * not the map moving, the map NOT moving.
 *
 * So a drag pauses the follow rather than ending it, and it resumes on its own
 * once the driver has stopped touching the map. Long enough to read a junction
 * ahead, short enough that nobody has to remember to undo it. */
const FOLLOW_RESUME_MS = 8000;
let followResumeTimer = null;

function pauseFollow() {
  setFollow(false);
  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => {
    /* Not while they are looking at the whole round — that is a view they
       chose from the menu, not a nudge of the map. */
    if (!overviewOn && lastGpsPos) window.recenterMap();
  }, FOLLOW_RESUME_MS);
}

/* Their own decision beats the timer: tapping Route, or Driving, or the
   recentre button means they have said what they want. */
function cancelFollowResume() { clearTimeout(followResumeTimer); }

function watchForManualPan() {
  if (!gMap) return;
  gMap.addListener('dragstart', () => { if (!suppressFollowOff) pauseFollow(); });

  /* fitBounds is the one place the app does not know the zoom in advance — it
     asks Google to frame the stops and takes whatever level that needs. Wait
     for the map to settle, then pin the result, so the route view is as locked
     as the driving view is. */
  gMap.addListener('idle', () => {
    if (!pendingLock) return;
    pendingLock = false;
    const z = gMap.getZoom();
    zoomLocked = z;
    gMap.setOptions({ minZoom: z, maxZoom: z });
  });
}

/* ── The pulled-back look ──────────────────────────────────────────────────
 * The driving view is the default and stays the default. This is the deliberate
 * step back out of it: one tap to see the shape of the round, one tap to get
 * back in the cab. Nothing else in the app pulls the camera out on its own.
 *
 * Both buttons are painted by syncViewButtons from overviewOn alone, so the
 * pair cannot disagree with each other or with what the map is showing. */
function setOverview(on) {
  overviewOn = on;
  syncViewButtons();
  if (!gMap) return;

  if (on) {
    setFollow(false);              // looking at the round, not riding along
    const rest = navStops.filter(s => !s.done && s._latLng);
    if (rest.length > 1) {
      /* Frame what is actually left to do, which is more useful than a fixed
         zoom on a round that might be four blocks or forty miles. fitBounds
         needs room to choose, so unpin first and let the idle handler pin
         whatever it settles on. */
      const b = new google.maps.LatLngBounds();
      rest.forEach(s => b.extend(s._latLng));
      if (lastGpsPos) b.extend(new google.maps.LatLng(lastGpsPos.lat, lastGpsPos.lng));
      gMap.setOptions({ minZoom: null, maxZoom: null });
      pendingLock = true;
      gMap.fitBounds(b, 48);
    } else {
      // One stop left, or none placed yet: nothing to frame, so just step back.
      goToZoom(Math.max(ZOOM_DRIVING - 4, 1));
    }
  } else {
    goToZoom(followZoom);
    setFollow(true);               // back in the cab
  }
}

/* ── Getting back ─────────────────────────────────────────────────────────
 *
 * Two different problems, which is why they are two buttons.
 *
 * RECENTRE is for the map having drifted off. Dragging it stops the app
 * chasing you — deliberately, because a driver looking ahead down the road
 * does not want the map hauling itself back every second. This puts them back
 * in the middle, at the distance the map is meant to sit at: one tap to undo
 * a drag and a pinch at once, without having to work out which of the two
 * left it looking wrong.
 *
 * It only appears once the map HAS drifted. A button that is always there is
 * one more thing to read; a button that appears when it is the answer is a
 * hint as well as a control.
 *
 * DEFAULT VIEW is for the map being wrong in ways a driver cannot quite name —
 * zoomed oddly, still on satellite from three stops ago, stepped back to the
 * whole round. One tap puts all of it back to how the app opens. */

window.recenterMap = function () {
  cancelFollowResume();
  if (!lastGpsPos) { setOptimizeStatus('No GPS fix yet.'); return; }
  if (overviewOn) { overviewOn = false; }
  followMode = true;
  syncViewButtons();
  /* snapZoom true: back to ZOOM_DRIVING, the same distance Default uses. */
  applyFollow(new google.maps.LatLng(lastGpsPos.lat, lastGpsPos.lng),
              lastGpsHeading, true);
  updateRecenterBtn();
};

window.resetMapView = function () {
  if (!gMap) return;
  /* Set it, do not ask first. Reading the map type back and only acting on a
     mismatch left the Sat button lit over a road map whenever the two had
     drifted apart — and "put it back" is a statement, not a negotiation. */
  gMap.setMapTypeId('roadmap');
  document.getElementById('mode-sat')?.classList.remove('on');
  window.setMapView('driving');   // out of the route view, riding along again
  goToZoom(ZOOM_DRIVING);         // and back to the zoom the app opens at
  updateRecenterBtn();
  setOptimizeStatus('Map back to its usual view.');
};

/* Shown only while it would do something: the map is off the driver and there
   is a position to go back to. */
function updateRecenterBtn() {
  const btn = document.getElementById('map-recenter');
  if (!btn) return;
  btn.hidden = followMode || !lastGpsPos;
}
window.updateRecenterBtn = updateRecenterBtn;

/* toggleFollow() and toggleOverview() were here: two buttons, each flipping
   its own switch, which let a driver turn both on at once and made the pair
   of them disagree about what the map was doing. The dock's Driving and Route
   call setMapView() instead, which sets one state and lights one button. */

/* ── Straight to this stop's card ─────────────────────────────────────────
 * Asked for as "a stop info button to take the driver to where the round
 * contamination / bear buttons are". It takes them there rather than drawing
 * a second set on the map, which matters: those buttons open a second array of
 * choices and re-render the list behind them, so a copy on the map would look
 * identical and behave half as well. One set of buttons, in one place, reached
 * from both. */
window.goToStopInfo = function () {
  const stop = navStops[currentIdx];
  if (!stop) { setOptimizeStatus('No stop selected yet.'); return; }
  switchView('stops');
  /* A tick for the list to be laid out — it is display:none until switchView
     runs, and an element with no box cannot be scrolled to. */
  setTimeout(() => {
    const card = document.querySelector('.stop-card[data-row="' + stop.rowNumber + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Say which one, or they land in the middle of a list of forty.
    card.classList.add('stop-card-flash');
    setTimeout(() => card.classList.remove('stop-card-flash'), 1700);
  }, 60);
};

/* ── Road hazards ─────────────────────────────────────────────────────────
 * Rockslides, closures, ice, police: what the drivers know and the others are
 * about to need. Not Waze's data — there is no public feed — but our own
 * drivers', which on a handful of trucks covering the same valley roads every
 * week is the half that is actually about these roads.
 */
let hazardKinds = {};
const hazardMarkers = new Map();   // id → google.maps.Marker
const hazardData = new Map();      // id → the hazard itself, for distances

function hazardPinIcon(icon) {
  /* Drawn rather than an image file: one less request, and it scales without
     a second asset. A circle with the emoji on it, so a hazard never looks
     like a stop — stops are pins, these are discs. */
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">' +
      '<circle cx="22" cy="22" r="17" fill="#b91c1c" stroke="#fff" stroke-width="3"/>' +
      '<text x="22" y="29" font-size="18" text-anchor="middle">' + icon + '</text>' +
    '</svg>';
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(38, 38),
    anchor: new google.maps.Point(19, 19),
  };
}

function drawHazard(h) {
  setTimeout(renderHazardStrip, 0);
  if (!gMap || hazardMarkers.has(h.id)) return;
  const marker = new google.maps.Marker({
    position: { lat: h.lat, lng: h.lng },
    map: gMap,
    icon: hazardPinIcon(h.icon || '⚠️'),
    zIndex: 400,                      // above the stops; this is the urgent one
    title: h.label + (h.note ? ' — ' + h.note : ''),
  });
  const info = new google.maps.InfoWindow({
    content:
      '<div style="font:600 13px/1.4 system-ui;color:#111">' +
        (h.icon || '⚠️') + ' ' + escHtml(h.label) +
        (h.note ? '<div style="font-weight:400">' + escHtml(h.note) + '</div>' : '') +
        '<button onclick="clearHazard(\'' + h.id + '\')" ' +
          'style="margin-top:8px;padding:7px 11px;border:none;border-radius:8px;' +
          'background:#166534;color:#fff;font:600 13px system-ui;cursor:pointer">' +
          'It is clear now</button>' +
      '</div>',
  });
  marker.addListener('click', () => info.open(gMap, marker));
  hazardMarkers.set(h.id, marker);
  hazardData.set(h.id, h);
}

function removeHazard(id) {
  /* Redrawn after the delete below, not before — the strip reads hazardData. */
  setTimeout(renderHazardStrip, 0);
  const m = hazardMarkers.get(id);
  if (m) { m.setMap(null); hazardMarkers.delete(id); }
  hazardData.delete(id);
}

/* The socket only carries what happens next, so a driver opening the app
   mid-round has to be told what is already out there. */
/* What is on the road NOW, replacing whatever we think is there.
 *
 * Called at startup and again whenever the socket comes back. The socket only
 * carries what happens while you are listening, so a driver who spent twenty
 * minutes in a canyon missed every hazard filed in them — and, just as badly,
 * still has the ones that were cleared or expired while they were away sitting
 * on their map.
 *
 * So this reconciles rather than adds: anything the server no longer lists is
 * taken off. Catching up and not being told old news are the same operation —
 * the server's list is the truth and this makes the map equal it. */
async function loadHazards() {
  try {
    const res = await fetch('/api/hazards');
    if (!res.ok) return;
    const body = await res.json();
    hazardKinds = body.kinds || {};
    renderHazardPicker();

    const live = body.hazards || [];
    const liveIds = new Set(live.map(h => h.id));
    for (const id of [...hazardMarkers.keys()]) {
      if (!liveIds.has(id)) removeHazard(id);   // cleared or expired while away
    }
    live.forEach(drawHazard);                   // drawHazard ignores ones we have
    renderHazardStrip();
  } catch { /* offline; the queue is for writes, and a hazard list can wait */ }
}

/* Everything this page should re-ask the server for after being out of touch.
   One place, so a reconnect and a phone waking up do the same thing. */
window.refreshLiveState = function () {
  loadHazards();
};

/* A phone that has been in a pocket, or a tab that has been in the background,
   has been listening to nothing. Coming back is the same situation as a
   reconnect, and the socket may not have noticed it dropped. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') window.refreshLiveState();
});

function renderHazardPicker() {
  const row = document.getElementById('hz-row');
  if (!row) return;
  row.innerHTML = Object.entries(hazardKinds).map(([kind, meta]) =>
    '<button class="hz-btn" onclick="fileHazard(\'' + kind + '\')">' +
      '<span class="hz-ico">' + meta.icon + '</span>' +
      '<span>' + escHtml(meta.label) + '</span>' +
    '</button>'
  ).join('');
}

window.toggleHazardPicker = function (force) {
  const el = document.getElementById('hazard-picker');
  const btn = document.getElementById('mode-hazard');
  if (!el) return;
  const show = typeof force === 'boolean' ? force : el.hidden;
  el.hidden = !show;
  if (btn) btn.classList.toggle('active', show);

  /* Clearance comes from --dock-h now, like everything else under the dock.
     It used to be worked out here from the window's height, which was the
     only way to place something against a dock that was fixed to the window
     rather than to the map. */
  if (show) window.measureDock?.();
};

window.fileHazard = async function (kind) {
  window.toggleHazardPicker(false);
  if (!lastGpsPos) { setOptimizeStatus('No GPS fix — cannot place a hazard.'); return; }
  try {
    const res = await fetch('/api/hazards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        lat: lastGpsPos.lat,
        lng: lastGpsPos.lng,
        tabName: window._routeTabName || '',
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    // Drawn from the broadcast like everybody else's, so there is one code
    // path and the filer sees exactly what the others see.
    setOptimizeStatus((hazardKinds[kind]?.label || 'Hazard') + ' shared with the other drivers.');
  } catch {
    setOptimizeStatus('Could not share that — try again in signal.');
  }
};

window.clearHazard = async function (id) {
  try {
    const res = await fetch('/api/hazards/' + encodeURIComponent(id) + '/clear', { method: 'POST' });
    if (!res.ok) throw new Error();
    setOptimizeStatus('Marked clear.');
  } catch {
    setOptimizeStatus('Could not clear that — try again in signal.');
  }
};

/* Live from the socket the rest of the app already uses. The driver page hands
   unknown messages here rather than growing a second connection. */
window.onHazardMessage = function (msg) {
  if (!msg) return;
  if (msg.type === 'hazard-added' && msg.hazard) drawHazard(msg.hazard);
  if (msg.type === 'hazard-cleared') removeHazard(msg.id);
};

/* ── Route order, photo and GPS: the rest of the dock ────────────────────── */

/* Planned and Live were two buttons for one either/or. On a round dock there
   is no room for a pair, and no need: one button that says which order it is
   showing and swaps when tapped. */
window.toggleRouteOrder = function () {
  setRouteMode(routeMode === 'planned' ? 'live' : 'planned');
};

/* The camera, from the map. It was only reachable from a stop's card in the
   list, which meant leaving the map to photograph the thing you are parked in
   front of. This photographs the stop you are actually at — the current one —
   and hands off to the same capture the list uses, so the upload, the Drive
   folder and the link written back to the sheet are all unchanged. */
window.photoFromMap = function () {
  const stop = navStops[currentIdx];
  if (!stop || typeof capturePhoto !== 'function') {
    setOptimizeStatus('No stop selected to photograph.');
    return;
  }
  capturePhoto(stop.rowNumber, window._routeTabName,
               stop.accountName);
};

/* ── GPS ──────────────────────────────────────────────────────────────────
 * Two jobs, one button.
 *
 * Evident: the dock button carries the fix. Dim and "GPS" before a position
 * arrives, lit and showing the accuracy in metres once one has. A driver can
 * tell at a glance whether the app knows where they are, which until now they
 * could only infer from whether the blue dot had appeared.
 *
 * Sendable: tapping it puts that position on the dispatcher's board. Not a
 * running feed — dispatch does not need to watch a truck all day, and the
 * driver should be able to say "here I am" at the moment it matters. */
/* The compass and the coordinates.
 *
 * Heading comes from the GPS and is only trustworthy while moving — a stopped
 * receiver reports whatever noise it last saw — so onGpsUpdate already keeps
 * the last good one rather than snapping to north at every red light, and this
 * just draws it. */
const COMPASS_POINTS = ['N','NE','E','SE','S','SW','W','NW'];

function cardinal(deg) {
  if (typeof deg !== 'number' || Number.isNaN(deg)) return '—';
  return COMPASS_POINTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function updateGeoChip() {
  const needle = document.getElementById('geo-needle');
  if (!needle) return;

  /* The coordinates are optional now. The driver app shows the rose alone —
     a compass is a glance, and a line of digits over the road was the longest
     piece of text on the map for something a driver needs about once a week.
     The demo still draws them, so this fills them when they are there.

     It used to bail out entirely when the element was missing, which would
     have stopped the needle turning as well. */
  const coords = document.getElementById('geo-coords');
  if (coords) {
    // Five decimal places is about a metre. More is noise a driver cannot use
    // and cannot read aloud.
    coords.textContent = lastGpsPos
      ? lastGpsPos.lat.toFixed(5) + ', ' + lastGpsPos.lng.toFixed(5)
      : 'waiting for GPS…';
  }
  if (!lastGpsPos) return;

  if (typeof lastGpsHeading === 'number' && !Number.isNaN(lastGpsHeading)) {
    /* An SVG group, so the rotation goes on the CSS transform with a
       transform-origin in USER UNITS (32,32 — the rose's centre), not on the
       element's box. Setting style.transform with a px origin would spin it
       around the wrong point. */
    needle.style.transform = 'rotate(' + lastGpsHeading + 'deg)';
  }
}

/* The dock's fold, its handle and its measured height all live in
   map-dock.js now — the demo draws the same tray and had none of it. This
   file still calls measureDock() when the map is resized. */

/* ── The directions panel ─────────────────────────────────────────────────
 *
 * Turn-by-turn, the ETA and the traffic: four lines of text across the top of
 * the map, on by default, whether or not anybody was reading them. On a phone
 * that is most of the road covered up.
 *
 * Off by default now, and on from the menu — the driver decides whether they
 * want the map or the words. Remembered per device, so a driver who wants it
 * gets it every day without asking twice. */
const DIRECTIONS_KEY = 'ev_show_directions';
let showDirections = false;

function applyDirections(on) {
  showDirections = on;
  const wrap = document.getElementById('map-hud');
  if (wrap) wrap.classList.toggle('with-directions', on);
  const btn = document.getElementById('mode-directions');
  if (btn) btn.classList.toggle('on', on);
  /* The banner shows itself when there is something to say; this only decides
     whether it is allowed to. */
  const banner = document.getElementById('turn-banner');
  if (banner) banner.classList.toggle('muted', !on);
  const status = document.getElementById('optimize-status');
  if (status) status.classList.toggle('muted', !on);
}

window.toggleDirections = function () {
  applyDirections(!showDirections);
  try { localStorage.setItem(DIRECTIONS_KEY, showDirections ? '1' : '0'); } catch {}
  setOptimizeStatus(showDirections ? 'Directions on.' : 'Directions off.');
};

document.addEventListener('DOMContentLoaded', () => {
  let want = false;
  try { want = localStorage.getItem(DIRECTIONS_KEY) === '1'; } catch {}
  applyDirections(want);
});

/* Reading a position over the radio is the actual use, so tapping puts it on
   the clipboard. Falls back to showing the numbers — clipboard access needs a
   secure context and a user gesture, and a driver who taps and gets nothing
   would reasonably assume the app is broken. */
window.copyCoords = async function () {
  if (!lastGpsPos) { setOptimizeStatus('No GPS fix yet.'); return; }
  const text = lastGpsPos.lat.toFixed(5) + ', ' + lastGpsPos.lng.toFixed(5);
  try {
    await navigator.clipboard.writeText(text);
    setOptimizeStatus('Copied ' + text);
  } catch {
    setOptimizeStatus(text);
  }
};

/* On a wide screen the coordinates are simply there, beside the rose. On a
   phone they are not, because a line of digits is the longest thing on the
   map and a driver needs it about once a week — so a tap on the rose brings
   them out, copies them, and lets them go again. */
window.showCoords = function () {
  const chip = document.getElementById('geo-chip');
  if (!chip) return;
  if (!lastGpsPos) { setOptimizeStatus('No GPS fix yet.'); return; }
  chip.classList.add('show-coords');
  window.copyCoords();
  clearTimeout(window.showCoords._t);
  window.showCoords._t = setTimeout(() => chip.classList.remove('show-coords'), 8000);
};

/* ── Sharing your position with dispatch ──────────────────────────────────
 *
 * Off until the driver turns it on, and it says so on their own screen the
 * whole time it is running. Being followed at work is not a setting to flip
 * quietly on somebody's behalf: the button is theirs, the state is visible
 * from the cab, and nothing is stored — the position is broadcast to whoever
 * has the board open at that moment and then it is gone.
 *
 * A tap turns it on and sends straight away, so the old behaviour — one tap,
 * one position, done — is still there as on-then-off.
 *
 * Remembered per device, because a driver who turned it on for the round
 * should not have to turn it on again at every stop. localStorage can throw
 * outright in a private window, so every touch of it is wrapped. */
const LIVE_SHARE_KEY = 'ev_live_share';

let liveShare = false;
let lastSentAt = 0;
let lastSentPos = null;
/* Set when a remembered 'on' is waiting for the first fix to act on. */
/* How often a moving truck reports in. Not every fix: watchPosition fires
   about once a second, which is 3,600 posts an hour to say the same thing
   about a truck sitting at a transfer station. Far enough to be a new place,
   or long enough that silence would look like a dropout. */
const LIVE_MIN_METRES = 25;
const LIVE_MIN_MS = 20000;

async function postLocation(mode) {
  if (!lastGpsPos) return false;
  const body = {
    lat: lastGpsPos.lat,
    lng: lastGpsPos.lng,
    accuracy: lastGpsAccuracy ?? null,
    heading: lastGpsHeading ?? null,
    tabName: window._routeTabName || '',
    stop: navStops[currentIdx]?.accountName || '',
    mode,                       // 'start' | 'ping' | 'stop' | 'once'
    live: mode !== 'stop' && mode !== 'once',
  };
  const res = await fetch('/api/driver-location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  lastSentAt = Date.now();
  lastSentPos = { ...lastGpsPos };
  return true;
}

/* Called from every GPS fix while sharing is on. */
function maybeSendLive() {
  if (!liveShare || !lastGpsPos) return;
  const movedFar = !lastSentPos || haversineM(
    lastSentPos.lat, lastSentPos.lng, lastGpsPos.lat, lastGpsPos.lng) >= LIVE_MIN_METRES;
  const waitedLong = Date.now() - lastSentAt >= LIVE_MIN_MS;
  if (!movedFar && !waitedLong) return;
  postLocation('ping').catch(() => { /* a dropped ping is the next one's problem */ });
}

window.toggleLiveShare = async function () {
  if (!liveShare && !lastGpsPos) {
    setOptimizeStatus('No GPS fix yet — nothing to share.');
    return;
  }
  liveShare = !liveShare;
  try { localStorage.setItem(LIVE_SHARE_KEY, liveShare ? '1' : '0'); } catch {}
  updateGpsChip();

  try {
    await postLocation(liveShare ? 'start' : 'stop');
    setOptimizeStatus(liveShare
      ? 'Sharing your position with dispatch.'
      : 'Stopped sharing your position.');
  } catch {
    /* Turning it OFF has to hold even if the message never lands: the driver
       asked to stop, and the board marks them stale on its own before long.
       Turning it ON is only true if dispatch heard, so that one goes back. */
    if (liveShare) {
      liveShare = false;
      try { localStorage.setItem(LIVE_SHARE_KEY, '0'); } catch {}
      updateGpsChip();
      setOptimizeStatus('Could not reach dispatch — not sharing.');
    } else {
      setOptimizeStatus('Stopped sharing (dispatch may not have heard).');
    }
  }
};

/* Closing the app is stopping. sendBeacon because a normal fetch is cancelled
   when the page goes, and a truck that appears parked forever at the last
   place it was seen is worse than one that simply drops off the board. */
addEventListener('pagehide', () => {
  if (!liveShare || !lastGpsPos || !navigator.sendBeacon) return;
  navigator.sendBeacon('/api/driver-location', new Blob([JSON.stringify({
    lat: lastGpsPos.lat, lng: lastGpsPos.lng,
    tabName: window._routeTabName || '', mode: 'stop', live: false,
  })], { type: 'application/json' }));
});

function updateGpsChip() {
  const btn = document.getElementById('mode-gps');
  const cap = document.getElementById('gps-cap');
  const chip = document.getElementById('live-chip');
  if (chip) chip.hidden = !liveShare;
  if (!btn || !cap) return;
  const has = Boolean(lastGpsPos);

  /* Lit means SHARING, not "has a fix". A button that lights up merely
     because the phone knows where it is would say the same thing whether
     dispatch could see the truck or not, which is the one distinction this
     button exists to make. */
  btn.classList.toggle('waiting', !has);
  btn.classList.toggle('on', liveShare);
  btn.classList.toggle('sharing', liveShare);

  if (liveShare) {
    cap.textContent = 'Stop sharing';
    btn.title = 'Dispatch can see you — tap to stop sharing';
  } else {
    /* It used to read the accuracy — "9 m" — which made sense as a caption
       under a circle and reads as nonsense as a line in a menu. The row says
       what tapping it does. */
    cap.textContent = has ? 'Share my position' : 'Waiting for GPS…';
    btn.title = has
      ? 'Tap to let dispatch see where you are'
      : 'Waiting for a GPS fix';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  /* Remembered, but not resumed silently: it only comes back on once there
     is a fix to send, and the first ping says 'start' so the board knows the
     truck is live rather than inferring it from a position. */
  let want = false;
  try { want = localStorage.getItem(LIVE_SHARE_KEY) === '1'; } catch {}
  if (want) pendingLiveResume = true;
  updateGpsChip();
});

let pendingLiveResume = false;

function setOptimizeStatus(msg) {
  const el = document.getElementById('optimize-status');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(setOptimizeStatus._t);
  setOptimizeStatus._t = setTimeout(() => { el.textContent = ''; }, 4000);
}

// ── Satellite toggle ─────────────────────────────────────────────────────────
// Hybrid (aerial + labels) helps drivers spot driveways, bin placement and
// gates on rural properties before they pull up.
window.toggleSatellite = function() {
  if (!gMap) return;
  const isSat = gMap.getMapTypeId() !== 'roadmap';
  gMap.setMapTypeId(isSat ? 'roadmap' : 'hybrid');
  document.getElementById('mode-sat')?.classList.toggle('on', !isSat);
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
  lastGpsAccuracy = accuracy;
  updateGpsChip();
  updateRecenterBtn();      // the first fix is what makes recentring possible
  // heading is null when stationary — keep the last good one so the view
  // doesn't snap back to north at every red light
  if (typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)
      && pos.coords.speed > 0.5) {
    lastGpsHeading = pos.coords.heading;
  }
  // After the heading is stored, not before, or the needle always draws the
  // PREVIOUS fix's direction.
  updateGeoChip();

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

  /* A remembered 'on' takes effect at the first fix, not at page load —
     there was nothing to send before this. */
  if (pendingLiveResume) {
    pendingLiveResume = false;
    liveShare = true;
    updateGpsChip();
    postLocation('start').catch(() => {
      liveShare = false;
      updateGpsChip();
      setOptimizeStatus('Could not reach dispatch — not sharing.');
    });
  } else {
    maybeSendLive();
  }

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
  /* Write into the icon and the caption, NOT into the button. Setting
     textContent on a dock button wipes the two spans it is built from, and the
     button loses its circle along with its label. */
  const ico = el.querySelector('.dock-ico');
  const cap = el.querySelector('.dock-cap');
  if (ico) ico.textContent = mode === 'sound' ? '🔔' : mode === 'silent' ? '📳' : '🔕';
  /* A row in a list, not a caption under a circle: it says what the setting
     IS, because "Sound" on its own could mean either state. */
  if (cap) cap.textContent = mode === 'sound' ? 'Arrival: sound'
                           : mode === 'silent' ? 'Arrival: vibrate'
                           : 'Arrival: off';
  // .on, not .active: this is a switch, not one of a pair of views.
  el.classList.toggle('on', mode !== 'off');
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

  /* Labelled "Access", not left to read as directions. Three things on this
     screen were competing for that word: Google's live turn-by-turn in the
     banner above, this column (the sheet's "Direction" — gate codes, which
     gravel drive, pull round the back), and the note below. Only the banner
     tells a driver where to go; these two tell them what to expect when they
     get there. The label is what makes that obvious at a glance. */
  const accessHtml = stop.directions
    ? `<div class="nav-access-chip"><span class="field-label">🔑 Access</span>${escHtml(stop.directions)}</div>`
    : '';

  const tabName = window._routeTabName || '';
  const row = stop.rowNumber;

  // Classify existing note for styling
  const noteClass = stop.noteUrgency === 'urgent' ? 'nav-note urgent'
                  : stop.noteUrgency === 'hold'   ? 'nav-note hold'
                  : 'nav-note';

  const noteHtmlStyled = stop.notes
    ? `<div class="${noteClass}"><span class="field-label">📝 Note</span>${escHtml(stop.notes)}</div>`
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
    ${typeof window.stopReportRowHtml === 'function' ? window.stopReportRowHtml(row) : ''}
    <div class="nav-actions">
      <button class="nav-btn nav-btn-prev" onclick="navStep(-1)" ${currentIdx === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="nav-btn nav-btn-maps" onclick="toggleNavPicker()">↗ Navigate</button>
      ${stop.done
        ? `<button class="nav-btn nav-btn-undo" onclick="navUndo()">Undo</button>`
        : `<button class="nav-btn nav-btn-done" onclick="navDone()">✓ Done</button>`}
      <button class="nav-btn nav-btn-next" onclick="navStep(1)" ${currentIdx === total - 1 ? 'disabled' : ''}>Next →</button>
    </div>`;

  /* The report buttons here are the stop list's own, markup and behaviour
     both, so they get the stop list's own listeners rather than a second
     handler that would have to reimplement the drill-down. */
  if (typeof window.attachStopReportListeners === 'function') {
    window.attachStopReportListeners(card);
  }
}

/* The drill-down state lives in driver.js, so when it re-renders the list —
   after a report is filed, or a sub-choice picked — this card has to follow or
   it sits showing the first array while the list shows the second.
   Guarded against running before the map exists, since the list renders on
   load whether or not anyone has opened the map. */
window.onStopsRendered = function () {
  if (!window._mapInitialized || !gMap) return;
  if (!navStops.length) return;
  renderNavCard();
};

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
