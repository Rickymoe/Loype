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

// Lenken bærer kun punktene og speil-valget — vekt og fart er personlige
// innstillinger som mottakeren allerede har lagret lokalt hos seg selv.
function buildShareUrl() {
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const points = routePoints.map(p => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
  const encoded = encodeURIComponent(btoa(JSON.stringify({ p: points, m: mirror })));
  const url = new URL(location.href);
  url.search = `r=${encoded}`;
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
  const encoded = new URLSearchParams(location.search).get('r');
  if (!encoded) return false;

  let data;
  try {
    data = JSON.parse(atob(decodeURIComponent(encoded)));
  } catch (err) {
    return false;
  }
  if (!Array.isArray(data.p) || data.p.length < 1) return false;

  routePoints = data.p.map(([lat, lng]) => ({ lat, lng }));
  routeElevations = routePoints.map(() => undefined);
  undoStack = [];
  if (data.m) document.getElementById('loype-mirror-checkbox').checked = true;

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
