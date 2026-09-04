// Map tab — navigation mode, planned vs live route modes

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

let gMap = null;
let markers = [];
let navStops = [];          // current display order
let plannedOrder = [];      // original sheet order (never mutated)
let currentIdx = 0;
let routeMode = 'planned';  // 'planned' | 'live'
let plannedMins = null;
let liveMins = null;
let directionsRenderer = null;
let directionsService = null;

const PLANNED_COLOR = '#22c55e';
const LIVE_COLOR    = '#f59e0b';

async function initMap() {
  const loadingEl = document.getElementById('map-loading');
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
    center: { lat: 29.4241, lng: -98.4936 },
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
    zoomControl: true,
    gestureHandling: 'greedy',
  });

  new google.maps.TrafficLayer().setMap(gMap);

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    suppressMarkers: true,
    polylineOptions: { strokeColor: PLANNED_COLOR, strokeWeight: 5, strokeOpacity: 0.8 },
  });
  directionsRenderer.setMap(gMap);

  await geocodeAndPlot();
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

async function geocodeAndPlot() {
  const loadingEl = document.getElementById('map-loading');
  const stops = (window.allStops || []).filter(s => !s.isSectionHeader && s.address);
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
    const addr = stop.address + (stop.city ? ', ' + stop.city : '') + ', TX';
    geocoder.geocode({ address: addr }, (results, status) => {
      if (status === 'OK' && results[0]) {
        stop._latLng = results[0].geometry.location;
        navStops.push(stop);
      }
      resolve();
    });
  })));

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

  const remaining = navStops.filter(s => !s.done && s._latLng);
  if (remaining.length < 2) { directionsRenderer.setDirections({ routes: [] }); return; }

  directionsService.route({
    origin: remaining[0]._latLng,
    destination: remaining[remaining.length - 1]._latLng,
    waypoints: remaining.slice(1, -1).map(s => ({ location: s._latLng, stopover: false })),
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
  }, (result, status) => {
    if (status === 'OK') directionsRenderer.setDirections(result);
  });
}

function fetchPlannedTime() {
  const remaining = plannedOrder.filter(s => !s.done && s._latLng);
  if (remaining.length < 2) return;
  directionsService.route({
    origin: remaining[0]._latLng,
    destination: remaining[remaining.length - 1]._latLng,
    waypoints: remaining.slice(1, -1).map(s => ({ location: s._latLng, stopover: true })),
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS },
  }, (result, status) => {
    if (status === 'OK') {
      plannedMins = Math.round(result.routes[0].legs.reduce((s, l) => s + l.duration_in_traffic.value, 0) / 60);
      updateModeUI();
    }
  });
}

function updateModeUI() {
  document.getElementById('mode-planned').classList.toggle('active', routeMode === 'planned');
  document.getElementById('mode-live').classList.toggle('active',    routeMode === 'live');

  const statusEl = document.getElementById('optimize-status');
  if (routeMode === 'planned') {
    statusEl.textContent = plannedMins ? `~${plannedMins} min with traffic` : '';
  } else if (routeMode === 'live') {
    if (liveMins !== null && plannedMins !== null) {
      const saved = plannedMins - liveMins;
      statusEl.textContent = saved > 0
        ? `~${liveMins} min · saves ~${saved} min vs planned`
        : `~${liveMins} min · already optimal`;
    } else if (liveMins !== null) {
      statusEl.textContent = `~${liveMins} min with traffic`;
    } else {
      statusEl.textContent = 'Calculating…';
    }
  }
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
    const remaining = plannedOrder.filter(s => !s.done && s._latLng);
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
      liveMins = Math.round(result.routes[0].legs.reduce((s, l) => s + l.duration_in_traffic.value, 0) / 60);

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

  const noteHtml = stop.notes
    ? `<div class="nav-note">${escHtml(stop.notes)}</div>`
    : '';

  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.address + (stop.city ? ', ' + stop.city : '') + ', TX')}&travelmode=driving`;

  card.style.display = 'block';
  card.innerHTML = `
    <div class="nav-progress-row">
      <span class="nav-stop-count">${currentIdx + 1} of ${total} ${modeBadge}</span>
      <span class="nav-done-count">${doneCount} done</span>
    </div>
    <div class="nav-stop-name" style="${color ? `border-left:4px solid ${color};padding-left:10px;` : ''}">${escHtml(nameOrAddr)}</div>
    ${addrLine ? `<div class="nav-stop-addr">${escHtml(addrLine)}</div>` : ''}
    ${noteHtml}
    <div class="nav-actions">
      <button class="nav-btn nav-btn-prev" onclick="navStep(-1)" ${currentIdx === 0 ? 'disabled' : ''}>← Prev</button>
      <a class="nav-btn nav-btn-maps" href="${mapsUrl}" target="_blank" rel="noopener">↗ Navigate</a>
      ${stop.done
        ? `<button class="nav-btn nav-btn-undo" onclick="navUndo()">Undo</button>`
        : `<button class="nav-btn nav-btn-done" onclick="navDone()">✓ Done</button>`}
      <button class="nav-btn nav-btn-next" onclick="navStep(1)" ${currentIdx === total - 1 ? 'disabled' : ''}>Next →</button>
    </div>`;
}

function jumpTo(idx) {
  currentIdx = idx;
  updateMarkerIcons();
  renderNavCard();
  centerOnCurrent();
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

window.notifyStopsUpdated = function() {
  if (!window._mapInitialized || !gMap) return;
  geocodeAndPlot();
};

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
