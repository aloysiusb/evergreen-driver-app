// Map tab — Google Maps with stop markers, notes, traffic, and route optimization

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
let infoWindow = null;
let directionsRenderer = null;

async function initMap() {
  const statusEl = document.getElementById('map-loading');
  statusEl.textContent = 'Loading map…';

  // Fetch Maps API key from server
  let apiKey;
  try {
    const res = await fetch('/api/maps-key');
    if (!res.ok) throw new Error('key not found');
    const data = await res.json();
    apiKey = data.key;
  } catch {
    statusEl.textContent = 'Maps not configured — add GOOGLE_MAPS_API_KEY in Render.';
    return;
  }

  // Load Google Maps JS API dynamically
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Maps script failed to load'));
    document.head.appendChild(script);
  });

  statusEl.style.display = 'none';

  const mapEl = document.getElementById('route-map');

  gMap = new google.maps.Map(mapEl, {
    zoom: 12,
    center: { lat: 29.4241, lng: -98.4936 }, // San Antonio default — recenters on stops
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
  });

  // Live traffic layer
  const trafficLayer = new google.maps.TrafficLayer();
  trafficLayer.setMap(gMap);

  infoWindow = new google.maps.InfoWindow();
  directionsRenderer = new google.maps.DirectionsRenderer({
    suppressMarkers: false,
    polylineOptions: { strokeColor: '#22c55e', strokeWeight: 5 },
  });

  plotStops();
}

function rowColorToHex(rowColor) {
  if (!rowColor) return null;
  const r = Math.round((rowColor.red   ?? 0) * 255);
  const g = Math.round((rowColor.green ?? 0) * 255);
  const b = Math.round((rowColor.blue  ?? 0) * 255);
  // Treat near-white as no color
  if (r > 240 && g > 240 && b > 240) return null;
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function makeMarkerIcon(color, done) {
  const fill = done ? '#9ca3af' : (color || '#22c55e');
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: fill,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
    scale: 10,
  };
}

function plotStops() {
  if (!window.allStops) return;
  const bounds = new google.maps.LatLngBounds();
  const geocoder = new google.maps.Geocoder();
  const stops = window.allStops.filter(s => !s.isSectionHeader && s.address);

  markers.forEach(m => m.setMap(null));
  markers = [];

  let geocoded = 0;
  const total = stops.length;

  stops.forEach((stop, idx) => {
    const addr = stop.address + (stop.city ? ', ' + stop.city : '') + ', TX';
    geocoder.geocode({ address: addr }, (results, status) => {
      geocoded++;
      if (status === 'OK' && results[0]) {
        const pos = results[0].geometry.location;
        bounds.extend(pos);

        const color = rowColorToHex(stop.rowColor);
        const marker = new google.maps.Marker({
          position: pos,
          map: gMap,
          icon: makeMarkerIcon(color, stop.done),
          title: stop.accountName || stop.address,
          zIndex: stop.done ? 1 : 10,
        });

        const nameOrAddr = stop.accountName || stop.address;
        const addrLine = stop.accountName ? stop.address + (stop.city ? ', ' + stop.city : '') : '';
        const noteHtml = stop.notes
          ? `<div style="margin-top:6px;font-size:13px;background:#f0fdf4;border-left:3px solid #22c55e;padding:6px 8px;border-radius:0 6px 6px 0;">${stop.notes}</div>`
          : '';
        const statusBadge = stop.done
          ? `<span style="font-size:11px;background:#dcfce7;color:#166534;padding:2px 7px;border-radius:99px;font-weight:600;">✓ Done</span>`
          : '';

        const content = `
          <div style="font-family:system-ui,sans-serif;max-width:240px;padding:4px 0;">
            <div style="font-weight:700;font-size:14px;margin-bottom:2px;">${nameOrAddr}</div>
            ${addrLine ? `<div style="font-size:12px;color:#6b7280;">${addrLine}</div>` : ''}
            ${statusBadge}
            ${noteHtml}
          </div>`;

        marker.addListener('click', () => {
          infoWindow.setContent(content);
          infoWindow.open(gMap, marker);
        });

        // Store position for optimization
        stop._latLng = pos;
        markers.push(marker);
      }

      if (geocoded === total && !bounds.isEmpty()) {
        gMap.fitBounds(bounds);
      }
    });
  });
}

window.optimizeRoute = async function() {
  const btn = document.getElementById('optimize-btn');
  const statusEl = document.getElementById('optimize-status');
  const stops = (window.allStops || []).filter(s => !s.isSectionHeader && s.address && s._latLng && !s.done);

  if (stops.length < 2) {
    statusEl.textContent = 'Need at least 2 remaining stops to optimize.';
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Calculating best route…';

  const origin = stops[0]._latLng;
  const destination = stops[stops.length - 1]._latLng;
  const waypoints = stops.slice(1, -1).map(s => ({
    location: s._latLng,
    stopover: true,
  }));

  const directionsService = new google.maps.DirectionsService();
  directionsService.route({
    origin,
    destination,
    waypoints,
    optimizeWaypoints: true,
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: {
      departureTime: new Date(),
      trafficModel: google.maps.TrafficModel.BEST_GUESS,
    },
  }, (result, status) => {
    btn.disabled = false;
    if (status !== 'OK') {
      statusEl.textContent = 'Could not calculate route — try again.';
      return;
    }

    directionsRenderer.setMap(gMap);
    directionsRenderer.setDirections(result);

    const order = result.routes[0].waypoint_order;
    const reordered = [stops[0], ...order.map(i => stops[i + 1]), stops[stops.length - 1]];
    const leg = result.routes[0].legs;
    const totalTime = leg.reduce((sum, l) => sum + l.duration_in_traffic.value, 0);
    const mins = Math.round(totalTime / 60);
    statusEl.textContent = `Optimized — ~${mins} min with traffic`;

    // Open a full Google Maps multi-stop URL
    const mapsUrl = 'https://www.google.com/maps/dir/' +
      reordered.map(s => encodeURIComponent(s.address + (s.city ? ', ' + s.city : ''))).join('/');
    const link = document.createElement('a');
    link.href = mapsUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = ' Open in Maps →';
    link.style.cssText = 'font-size:13px;color:#22c55e;font-weight:600;';
    statusEl.appendChild(link);
  });
};

// Called by driver.js after stops load so the map can re-plot if already open
window.notifyStopsUpdated = function() {
  if (window._mapInitialized && gMap) plotStops();
};
