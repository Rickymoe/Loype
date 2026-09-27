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
  // Punktene kom fra en lenke, ikke fra en fil — ingen GPX-merke, og ingen
  // klokketid å vise (lenken bærer bare koordinatene).
  routeSource = null;
  routeStartTime = null;
  routeEndTime = null;
  routeTimes = null;
  routeHrAvg = null;
  routeHrMax = null;
  routeActivity = null;
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

// Puls kan ligge i flere navnerom: Garmin skriver <ns3:hr> og Strava
// <gpxtpx:hr>, og prefikset er nettopp det som varierer mellom verktøyene.
// querySelector matcher ikke navnerom i det hele tatt, så vi leter i stedet
// etter første element der localName er «hr» — den er lik i alle variantene.
function lesPuls(el) {
  for (const node of el.getElementsByTagName('*')) {
    if (node.localName !== 'hr') continue;
    const verdi = parseFloat(node.textContent);
    return Number.isFinite(verdi) ? verdi : null;
  }
  return null;
}

// Aktiviteten fila selv oppgir: <type> rett under <trk>. Vi leter bare blant
// trk sine direkte barn, siden extensions kan ha egne <type>-elementer.
// Filas egne ord er mer til å stole på enn en knapp i panelet, men verdiene
// varierer (Garmin skriver «running», Strava «Run», tredjepartsverktøy kan
// skrive «hiking»), så de normaliseres til de tre vi har koeffisienter for.
function parseGpxActivity(doc) {
  const trk = doc.getElementsByTagName('trk')[0];
  if (!trk) return null;
  for (const barn of trk.children) {
    if (barn.localName !== 'type') continue;
    const verdi = (barn.textContent || '').trim().toLowerCase();
    if (verdi.indexOf('cycl') !== -1 || verdi.indexOf('bik') !== -1) return 'cycling';
    if (verdi.indexOf('walk') !== -1 || verdi.indexOf('hik') !== -1) return 'walking';
    if (verdi.indexOf('run') !== -1) return 'running';
    return null;
  }
  return null;
}

// Godtar både <trkpt> (spor) og <rtept> (rute) siden ulike verktøy
// (Strava, Garmin, kartverket.no m.fl.) eksporterer det ene eller det andre.
function parseGpxPoints(gpxText) {
  const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Ugyldig GPX-fil.');

  let els = Array.from(doc.querySelectorAll('trkpt'));
  if (els.length === 0) els = Array.from(doc.querySelectorAll('rtept'));
  if (els.length === 0) throw new Error('Fant ingen rutepunkter i GPX-filen.');

  // Aktiviteten gjelder hele fila, ikke det enkelte punktet. Den legges på
  // punktene her fordi loadRouteFromGpxPoints bare får punktene å jobbe med.
  const activity = parseGpxActivity(doc);

  const points = els.map(el => {
    const lat = parseFloat(el.getAttribute('lat'));
    const lng = parseFloat(el.getAttribute('lon'));
    const eleEl = el.querySelector('ele');
    const elevation = eleEl ? parseFloat(eleEl.textContent) : undefined;
    // Klokketid fra fila. Ugyldig eller manglende <time> blir null i stedet
    // for en Invalid Date som ville spredd seg til formateringen senere.
    const timeEl = el.querySelector('time');
    const lest = timeEl ? new Date(timeEl.textContent) : null;
    const time = lest && Number.isFinite(lest.getTime()) ? lest : null;
    return { lat, lng, elevation, time, hr: lesPuls(el), activity };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  if (points.length === 0) throw new Error('Fant ingen gyldige koordinater i GPX-filen.');
  return points;
}

// Klokketid per punkt i sekunder fra start, parallelt med routePoints. Punkter
// uten eget tidsstempel får et interpolert et mellom naboene sine, så ingen
// delstrekning faller ut av energiberegningen eller tidsaksen. Returen er
// stigende så lenge filas egne tidsstempler er det.
function buildRouteTimes(points, start) {
  const kjent = [];
  points.forEach((p, i) => {
    if (p.time) kjent.push({ i, t: (p.time - start) / 1000 });
  });
  if (kjent.length === 0) return null;

  const tider = new Array(points.length);
  for (let k = 0; k < kjent.length; k++) {
    const fra = kjent[k];
    const til = kjent[k + 1];
    tider[fra.i] = fra.t;
    if (!til) {
      // Halen etter siste tidsstempel beholder den siste kjente tiden. Det
      // gjør delstrekningene der til null minutter, som er riktigere enn å
      // gjette en fart for dem.
      for (let i = fra.i + 1; i < points.length; i++) tider[i] = fra.t;
      break;
    }
    const steg = til.i - fra.i;
    for (let d = 1; d < steg; d++) {
      tider[fra.i + d] = fra.t + ((til.t - fra.t) * d) / steg;
    }
  }
  // Ingenting er målt før første tidsstempel heller — de punktene får den
  // første kjente tiden.
  for (let i = 0; i < kjent[0].i; i++) tider[i] = kjent[0].t;
  return tider;
}

// Bruker høyde fra fila der den finnes (unngår unødvendige API-kall) og
// henter bare inn de manglende punktene etterpå, samme mønster som
// loadSharedRouteFromUrl.
function loadRouteFromGpxPoints(points) {
  routePoints = points.map(p => ({ lat: p.lat, lng: p.lng }));
  routeElevations = points.map(p => (Number.isFinite(p.elevation) ? p.elevation : undefined));
  undoStack = [];
  // Må settes før updateLoypeControls() under, som er det som tegner merket.
  routeSource = 'gpx';
  // Første og siste punkt som har et tidsstempel. Enkelte verktøy skriver
  // <time> bare på noen av punktene, så vi kan ikke bare lese [0] og [siste].
  const tider = points.map(p => p.time).filter(Boolean);
  routeStartTime = tider.length ? tider[0] : null;
  routeEndTime = tider.length ? tider[tider.length - 1] : null;

  // Faktatallene resten av appen bygger på når ruten er en målt tur: tiden
  // per punkt og pulsen fra fila. Alle er null for filer som ikke har dem.
  routeTimes = routeStartTime ? buildRouteTimes(points, routeStartTime) : null;
  const pulser = points.map(p => p.hr).filter(v => typeof v === 'number');
  routeHrAvg = pulser.length ? Math.round(pulser.reduce((a, b) => a + b, 0) / pulser.length) : null;
  routeHrMax = pulser.length ? Math.round(Math.max(...pulser)) : null;
  routeActivity = points.find(p => p.activity)?.activity || null;

  document.getElementById('loype-mirror-checkbox').checked = false;

  redrawRoutePolyline();
  redrawRouteMarkers();
  updateLoypeControls();
  updateDistanceAndChart();

  const bounds = new google.maps.LatLngBounds();
  routePoints.forEach(p => bounds.extend(p));
  map.fitBounds(bounds);

  const missingIndexes = routeElevations
    .map((e, i) => (e === undefined ? i : -1))
    .filter(i => i !== -1);
  if (missingIndexes.length === 0) return;

  fetchRouteElevation(missingIndexes.map(i => routePoints[i]))
    .then(elevations => {
      missingIndexes.forEach((i, j) => { routeElevations[i] = elevations[j]; });
      updateDistanceAndChart();
    })
    .catch(() => {
      showLoypeError('Kunne ikke hente høydedata for deler av den opplastede ruten.');
    });
}

function handleGpxFileUpload(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const points = parseGpxPoints(reader.result);
      loadRouteFromGpxPoints(points);
      hideLoypeError();
    } catch (err) {
      showLoypeError(err.message || 'Kunne ikke lese GPX-filen.');
    }
  };
  reader.onerror = () => showLoypeError('Kunne ikke lese GPX-filen.');
  reader.readAsText(file);
}

function initRouteExport() {
  document.getElementById('loype-gpx-btn').addEventListener('click', downloadRouteGpx);
  document.getElementById('loype-share-btn').addEventListener('click', shareRoute);
  document.getElementById('loype-gpx-upload-btn').addEventListener('click', () => {
    document.getElementById('loype-gpx-file-input').click();
  });
  document.getElementById('loype-gpx-file-input').addEventListener('change', handleGpxFileUpload);
}

document.addEventListener('DOMContentLoaded', initRouteExport);
