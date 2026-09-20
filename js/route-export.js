// Bygger punktlisten som faktisk eksporteres (inkl. speilet retur), uten å
// filtrere bort punkter der høyden ennå ikke er hentet — i motsetning til
// buildDistanceProfile (route-detail-view.js), som dropper dem helt og ville
// gitt en ufullstendig GPX-geometri.
function buildExportPoints() {
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const pts = routePoints.map((p, i) => ({ lat: p.lat, lng: p.lng, elevation: routeElevations[i] }));
  if (mirror && pts.length > 1) {
    return pts.concat(pts.slice(0, -1).reverse());
  }
  return pts;
}

function downloadRouteGpx() {
  const points = buildExportPoints();
  if (points.length < 2) return;

  const trkpts = points.map(p => {
    const eleTag = p.elevation !== undefined ? `<ele>${p.elevation.toFixed(1)}</ele>` : '';
    return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${eleTag}</trkpt>`;
  }).join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Løype" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Løype</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `loype-${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}

// Google sin polyline-algoritme (samme som Google Maps/Strava bruker til
// akkurat dette): koder differansen mellom påfølgende punkter i stedet for
// fulle koordinater, og pakker det inn i noen få ASCII-tegn per punkt i
// stedet for et JSON-objekt med hakeparanteser/komma/punktum + base64-
// overhead. Kutter en delt lenke til brøkdelen av lengden på lange ruter.
function encodePolylineValue(value) {
  let v = value < 0 ? ~(value << 1) : (value << 1);
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points) {
  let result = '';
  let prevLat = 0, prevLng = 0;
  for (const [lat, lng] of points) {
    const lat5 = Math.round(lat * 1e5);
    const lng5 = Math.round(lng * 1e5);
    result += encodePolylineValue(lat5 - prevLat);
    result += encodePolylineValue(lng5 - prevLng);
    prevLat = lat5;
    prevLng = lng5;
  }
  return result;
}

function decodePolyline(str) {
  const points = [];
  let index = 0, lat = 0, lng = 0;

  function decodeValue() {
    let result = 0, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  }

  while (index < str.length) {
    lat += decodeValue();
    lng += decodeValue();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// Lenken bærer kun punktene og speil-valget — vekt og fart er personlige
// innstillinger som mottakeren allerede har lagret lokalt hos seg selv.
function buildShareUrl() {
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const points = routePoints.map(p => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
  const encoded = encodeURIComponent(encodePolyline(points));
  const url = new URL(location.href);
  url.search = `r=${encoded}${mirror ? '&m=1' : ''}`;
  return url.toString();
}

function showLoypeShareStatus(msg) {
  const el = document.getElementById('loype-share-status');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showLoypeShareStatus.timer);
  showLoypeShareStatus.timer = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function shareRoute() {
  const url = buildShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    showLoypeShareStatus('Lenke kopiert til utklippstavlen!');
  } catch (err) {
    showLoypeShareStatus(url);
  }
}

// Leser en delt rute fra URL-en (?r=...) og bygger den opp igjen. Returnerer
// true hvis en rute ble lastet, slik at kalleren kan la være å geolokalisere
// brukeren i stedet.
function loadSharedRouteFromUrl() {
  const params = new URLSearchParams(location.search);
  const encoded = params.get('r');
  if (!encoded) return false;

  let points;
  try {
    points = decodePolyline(encoded);
  } catch (err) {
    return false;
  }
  if (points.length < 1) return false;

  routePoints = points.map(([lat, lng]) => ({ lat, lng }));
  routeElevations = routePoints.map(() => undefined);
  undoStack = [];
  if (params.get('m') === '1') document.getElementById('loype-mirror-checkbox').checked = true;

  redrawRoutePolyline();
  redrawRouteMarkers();
  updateLoypeControls();
  updateDistanceAndChart();

  const bounds = new google.maps.LatLngBounds();
  routePoints.forEach(p => bounds.extend(p));
  map.fitBounds(bounds);

  fetchRouteElevation(routePoints)
    .then(elevations => {
      routeElevations = elevations;
      updateDistanceAndChart();
    })
    .catch(() => {
      showLoypeError('Kunne ikke hente høydedata for den delte ruten.');
    });

  return true;
}

function initRouteExport() {
  document.getElementById('loype-gpx-btn').addEventListener('click', downloadRouteGpx);
  document.getElementById('loype-share-btn').addEventListener('click', shareRoute);
}

document.addEventListener('DOMContentLoaded', initRouteExport);
