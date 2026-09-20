const LOYPE_LINE_COLOR = '#ff9800';

let routePoints = [];
let routePolyline = null;
let routeMarkers = [];

function onLoypeRouteClick(e) {
  addRoutePoint(e.latLng.lat(), e.latLng.lng());
}

let undoStack = [];

function addRoutePoint(lat, lng) {
  const pt = { lat, lng };
  routePoints.push(pt);
  undoStack.push(pt);
  redrawRoutePolyline();
  redrawRouteMarkers();
  updateLoypeControls();
  updateDistanceAndChart();
  fetchAndStoreElevation(pt, routePoints.length - 1);
}

function onLoypeRouteRightClick(e) {
  e.domEvent?.preventDefault();

  const lat = e.latLng.lat();
  const lng = e.latLng.lng();
  let insertIndex;
  if (routePoints.length < 2) {
    insertIndex = 0;
  } else {
    const clickPt = turf.point([lng, lat]);
    const line = turf.lineString(routePoints.map(p => [p.lng, p.lat]));
    const snapped = turf.nearestPointOnLine(line, clickPt);
    const startPt = routePoints[0];
    const endPt = routePoints[routePoints.length - 1];
    const distToStart = turf.distance(clickPt, turf.point([startPt.lng, startPt.lat]));
    const distToEnd = turf.distance(clickPt, turf.point([endPt.lng, endPt.lat]));
    const distToLine = snapped.properties.dist;

    // Nærmest linja ELLERS foretrekkes; men hvis klikket egentlig ligger
    // nærmere å forlenge ruten forbi start eller slutt, gjør det i stedet
    // for å tvinge inn et punkt midt i en delstrekning.
    if (distToStart <= distToLine && distToStart <= distToEnd) {
      insertIndex = 0;
    } else if (distToEnd <= distToLine && distToEnd <= distToStart) {
      insertIndex = routePoints.length;
    } else {
      insertIndex = snapped.properties.index + 1;
    }
  }

  const pt = { lat, lng };
  routePoints.splice(insertIndex, 0, pt);
  routeElevations.splice(insertIndex, 0, undefined);
  undoStack.push(pt);
  redrawRoutePolyline();
  redrawRouteMarkers();
  updateLoypeControls();
  updateDistanceAndChart();
  fetchAndStoreElevation(pt, insertIndex);
}

let myLocationMarker = null;

function useMyLocationForRoute() {
  if (!navigator.geolocation) {
    showLoypeError('Enheten din støtter ikke geolokasjon.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      showMyLocationMarker(pos.coords.latitude, pos.coords.longitude);
      map.panTo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      map.setZoom(16);
    },
    () => {
      showLoypeError('Fikk ikke tilgang til posisjonen din.');
    }
  );
}

function showMyLocationMarker(lat, lng) {
  if (myLocationMarker) myLocationMarker.map = null;
  const dot = document.createElement('div');
  dot.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#4285f4;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)';
  myLocationMarker = new google.maps.marker.AdvancedMarkerElement({
    position: { lat, lng },
    map,
    content: dot,
  });
}

function redrawRoutePolyline() {
  if (routePolyline) {
    routePolyline.setMap(null);
    routePolyline = null;
  }
  if (routePoints.length < 2) return;
  routePolyline = new google.maps.Polyline({
    path: routePoints,
    strokeColor: LOYPE_LINE_COLOR,
    strokeWeight: 3,
    strokeOpacity: 0.9,
    map,
  });
}

function redrawRouteMarkers() {
  routeMarkers.forEach(m => { m.map = null; });
  routeMarkers = routePoints.map(pt => {
    const dot = document.createElement('div');
    dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${LOYPE_LINE_COLOR};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)`;
    return new google.maps.marker.AdvancedMarkerElement({
      position: pt,
      map,
      content: dot,
    });
  });
}

function undoLastRoutePoint() {
  const pt = undoStack.pop();
  if (!pt) return;
  const index = routePoints.indexOf(pt);
  if (index === -1) return;
  routePoints.splice(index, 1);
  routeElevations.splice(index, 1);
  redrawRoutePolyline();
  redrawRouteMarkers();
  updateLoypeControls();
  updateDistanceAndChart();
}

function clearRoute() {
  routePoints = [];
  routeElevations = [];
  undoStack = [];
  redrawRoutePolyline();
  redrawRouteMarkers();
  updateLoypeControls();
  updateDistanceAndChart();
}

function updateLoypeControls() {
  document.getElementById('loype-undo-btn').disabled = routePoints.length === 0;
  document.getElementById('loype-clear-btn').disabled = routePoints.length === 0;
  document.getElementById('loype-share-btn').disabled = routePoints.length < 2;
  document.getElementById('loype-gpx-btn').disabled = routePoints.length < 2;
  updateFavoriteAddButtonState();
}

function showLoypeError(msg) {
  const el = document.getElementById('loype-error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLoypeError() {
  document.getElementById('loype-error-msg').classList.add('hidden');
}

const KARTVERKET_HOYDEDATA_URL = 'https://ws.geonorge.no/hoydedata/v1/punkt';

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Kartverket sitt GET-endepunkt tar koordinatene som en URL-parameter — med
// mange punkter (lengre ruter, delte/favoritt-ruter lastet inn på én gang)
// blir URL-en fort for lang og feiler. Open-Elevation sin gratis-instans er
// også kjent for å bli ustabil med store batcher i én omgang. Begge deles
// derfor opp i mindre, sekvensielle biter i stedet for én stor forespørsel.
const ELEVATION_CHUNK_SIZE = 30;

async function fetchKartverketElevation(points) {
  const results = [];
  for (const chunk of chunkArray(points, ELEVATION_CHUNK_SIZE)) {
    const coords = JSON.stringify(chunk.map(p => [p.lng, p.lat]));
    const url = `${KARTVERKET_HOYDEDATA_URL}?punkter=${encodeURIComponent(coords)}&koordsys=4326`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    results.push(...data.punkter.map(p => p.z));
  }
  return results;
}

async function fetchOpenElevation(points) {
  const results = [];
  for (const chunk of chunkArray(points, ELEVATION_CHUNK_SIZE)) {
    const resp = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        locations: chunk.map(p => ({ latitude: p.lat, longitude: p.lng })),
      }),
    });
    if (resp.status === 429) throw new Error('rate_limit');
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('Open-Elevation error', resp.status, body);
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    results.push(...data.results.map(r => r.elevation));
  }
  return results;
}

// Kartverket gir Norges egen høyoppløselige høydemodell (gratis, ingen nøkkel),
// men returnerer z: null utenfor Norge. Open-Elevation brukes kun som
// reserveløsning for punkter Kartverket ikke dekker.
async function fetchRouteElevation(points) {
  let kartverketElevations;
  try {
    kartverketElevations = await fetchKartverketElevation(points);
  } catch (err) {
    kartverketElevations = points.map(() => null);
  }

  const missingIndexes = kartverketElevations
    .map((e, i) => (e === null || e === undefined ? i : -1))
    .filter(i => i !== -1);

  if (missingIndexes.length === 0) {
    return kartverketElevations;
  }

  const fallbackPoints = missingIndexes.map(i => points[i]);
  const fallbackElevations = await fetchOpenElevation(fallbackPoints);
  const merged = [...kartverketElevations];
  missingIndexes.forEach((i, j) => { merged[i] = fallbackElevations[j]; });
  return merged;
}

function renderElevationChart(elevations, km) {
  const svg = document.getElementById('loype-elevation-chart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (elevations.length === 0) return;

  const width = 240, height = 90, pad = 4, axisLeft = 30, axisBottom = 12;
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const range = Math.max(max - min, 1);

  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = `Høydeprofil: ${Math.round(min)}–${Math.round(max)} m`;
  svg.appendChild(title);

  const plotLeft = axisLeft;
  const plotRight = width - pad;
  const plotTop = pad;
  const plotBottom = height - axisBottom;

  const yAxisLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  yAxisLine.setAttribute('x1', String(plotLeft));
  yAxisLine.setAttribute('y1', String(plotTop));
  yAxisLine.setAttribute('x2', String(plotLeft));
  yAxisLine.setAttribute('y2', String(plotBottom));
  yAxisLine.setAttribute('stroke', '#ccc');
  yAxisLine.setAttribute('stroke-width', '1');
  svg.appendChild(yAxisLine);

  const xAxisLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxisLine.setAttribute('x1', String(plotLeft));
  xAxisLine.setAttribute('y1', String(plotBottom));
  xAxisLine.setAttribute('x2', String(plotRight));
  xAxisLine.setAttribute('y2', String(plotBottom));
  xAxisLine.setAttribute('stroke', '#ccc');
  xAxisLine.setAttribute('stroke-width', '1');
  svg.appendChild(xAxisLine);

  function addXLabel(x, text, anchor) {
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(height - 2));
    label.setAttribute('text-anchor', anchor);
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', '#5f6368');
    label.textContent = text;
    svg.appendChild(label);
  }

  addXLabel(plotLeft, '0 km', 'start');
  addXLabel(plotRight, `${km.toFixed(2)} km`, 'end');

  function addTick(y, value) {
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', String(plotLeft - 4));
    tick.setAttribute('y1', String(y));
    tick.setAttribute('x2', String(plotLeft));
    tick.setAttribute('y2', String(y));
    tick.setAttribute('stroke', '#ccc');
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(plotLeft - 6));
    label.setAttribute('y', String(Math.min(Math.max(y + 3, pad + 8), height - 2)));
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', '#5f6368');
    label.textContent = `${Math.round(value)} m`;
    svg.appendChild(label);
  }

  addTick(plotTop, max);
  if (min !== max) {
    addTick(plotBottom, min);
  }

  const stepX = elevations.length > 1 ? (plotRight - plotLeft) / (elevations.length - 1) : 0;
  const pointsAttr = elevations.map((e, i) => {
    const x = plotLeft + i * stepX;
    const y = plotTop + (1 - (e - min) / range) * (plotBottom - plotTop);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', pointsAttr);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', LOYPE_LINE_COLOR);
  polyline.setAttribute('stroke-width', '2');
  svg.appendChild(polyline);
}

let routeElevations = [];

function updateDistanceAndChart() {
  if (routePoints.length < 2) {
    hideLoypeError();
    document.getElementById('loype-result').classList.add('hidden');
    return;
  }
  const mirror = document.getElementById('loype-mirror-checkbox').checked;

  const line = turf.lineString(routePoints.map(p => [p.lng, p.lat]));
  let km = turf.length(line, { units: 'kilometers' });
  if (mirror) km *= 2;

  document.getElementById('loype-distance-value').textContent = `${km.toFixed(2)} km`;
  document.getElementById('loype-result').classList.remove('hidden');

  let known = routeElevations.filter(e => e !== undefined);
  if (mirror && known.length > 0) {
    known = known.concat(known.slice(0, -1).reverse());
  }
  renderElevationChart(known, km);
  updateEstimatedTime();
  updateEstimatedEnergy();
}

function parsePaceToSecondsPerKm(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+):([0-5]?\d)$/);
  if (match) {
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }
  const asNumber = parseFloat(trimmed.replace(',', '.'));
  if (!isNaN(asNumber) && asNumber > 0) {
    return asNumber * 60;
  }
  return null;
}

function formatDuration(totalSeconds) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}t ${minutes}min` : `${minutes} min`;
}

// Grad-avhengig tidsstraff per delstrekning. Ved ~10% stigning gir dette en
// faktor på ca. 2x (stemmer grovt med Naismith's rule for turgåing), og
// eskalerer brattere for virkelig steile partier (>20%) i tråd med at
// energikostnaden ved klatring vokser mer enn proporsjonalt med helningen.
// Nedoverbakke gir ingen bonus (holdes enkelt/konservativt).
function segmentTimeSeconds(paceSecPerKm, reverseGrade) {
  let seconds = 0;
  for (let i = 1; i < routePoints.length; i++) {
    const a = routePoints[i - 1];
    const b = routePoints[i];
    const segKm = turf.distance(
      turf.point([a.lng, a.lat]),
      turf.point([b.lng, b.lat]),
      { units: 'kilometers' }
    );
    if (segKm === 0) continue;

    let climbGrade = 0;
    const ea = routeElevations[i - 1];
    const eb = routeElevations[i];
    if (ea !== undefined && eb !== undefined) {
      let dz = eb - ea;
      if (reverseGrade) dz = -dz;
      climbGrade = Math.max(0, dz / (segKm * 1000));
    }
    const factor = 1 + 10 * climbGrade + 20 * climbGrade * climbGrade;
    seconds += segKm * paceSecPerKm * factor;
  }
  return seconds;
}

function updateEstimatedTime() {
  const timeEl = document.getElementById('loype-time-value');
  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  if (!paceSecPerKm || routePoints.length < 2) {
    timeEl.classList.add('hidden');
    return;
  }
  const mirror = document.getElementById('loype-mirror-checkbox').checked;

  let seconds = segmentTimeSeconds(paceSecPerKm, false);
  if (mirror) {
    // Returveien følger samme delstrekninger baklengs — det som var
    // nedoverbakke på vei ut er oppoverbakke på vei tilbake.
    seconds += segmentTimeSeconds(paceSecPerKm, true);
  }

  timeEl.textContent = `Estimert tid: ${formatDuration(seconds)} (høydejustert)`;
  timeEl.classList.remove('hidden');
}

// ACSM sine metabolske ligninger regner oksygenopptak (VO2, ml/kg/min) ut fra
// fart og stigning. Ligningene er validert med fast fart per underlag, så i
// motsetning til tidsestimatet (som senker farten i bakker) brukes brukerens
// innstilte fart uendret her — stigningen alene gir det økte forbruket.
function segmentEnergyKcal(paceSecPerKm, weightKg, isRunning, reverseGrade) {
  const speedMetersPerMin = 60000 / paceSecPerKm;
  let kcal = 0;
  for (let i = 1; i < routePoints.length; i++) {
    const a = routePoints[i - 1];
    const b = routePoints[i];
    const segKm = turf.distance(
      turf.point([a.lng, a.lat]),
      turf.point([b.lng, b.lat]),
      { units: 'kilometers' }
    );
    if (segKm === 0) continue;

    let grade = 0;
    const ea = routeElevations[i - 1];
    const eb = routeElevations[i];
    if (ea !== undefined && eb !== undefined) {
      let dz = eb - ea;
      if (reverseGrade) dz = -dz;
      grade = Math.max(-0.4, Math.min(0.4, dz / (segKm * 1000)));
    }

    const vo2 = isRunning
      ? 0.2 * speedMetersPerMin + 0.9 * speedMetersPerMin * grade + 3.5
      : 0.1 * speedMetersPerMin + 1.8 * speedMetersPerMin * grade + 3.5;

    const minutes = (segKm * 1000) / speedMetersPerMin;
    kcal += (vo2 * weightKg / 1000) * 5 * minutes;
  }
  return kcal;
}

function updateEstimatedEnergy() {
  const energyEl = document.getElementById('loype-energy-value');
  const weightKg = parseFloat(loadProfile().weight);
  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  if (!weightKg || !paceSecPerKm || routePoints.length < 2) {
    energyEl.classList.add('hidden');
    return;
  }
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const isRunning = paceMode === 'run';

  let kcal = segmentEnergyKcal(paceSecPerKm, weightKg, isRunning, false);
  if (mirror) {
    kcal += segmentEnergyKcal(paceSecPerKm, weightKg, isRunning, true);
  }
  const kj = kcal * 4.184;

  energyEl.textContent = `Energi: ${Math.round(kj)} kJ / ${Math.round(kcal)} kcal`;
  energyEl.classList.remove('hidden');
}

async function fetchAndStoreElevation(pt, index) {
  try {
    const [elevation] = await fetchRouteElevation([pt]);
    if (routePoints[index] !== pt) return;
    routeElevations[index] = elevation;
    hideLoypeError();
    updateDistanceAndChart();
  } catch (err) {
    if (routePoints[index] !== pt) return;
    showLoypeError(err.message === 'rate_limit'
      ? 'Høyde-API er overbelastet. Prøv igjen om litt.'
      : `Kunne ikke hente høydedata (${err.message}). Prøv igjen.`);
  }
}

// To hastigheter (løp/gå) huskes hver for seg per bruker, siden farten
// naturlig er svært forskjellig mellom aktivitetene.
const PACE_DEFAULTS = { run: '5:30', walk: '12:00' };
let paceMode = 'run';

function setPaceMode(mode) {
  paceMode = mode;
  const profile = loadProfile();
  document.getElementById('loype-pace-input').value = profile[`pace_${mode}`] || PACE_DEFAULTS[mode];
  document.getElementById('loype-pace-run-btn').classList.toggle('active', mode === 'run');
  document.getElementById('loype-pace-walk-btn').classList.toggle('active', mode === 'walk');
  saveProfile({ ...profile, paceMode: mode });
  updateDistanceAndChart();
}

function persistPaceValue() {
  const profile = loadProfile();
  saveProfile({ ...profile, [`pace_${paceMode}`]: document.getElementById('loype-pace-input').value, paceMode });
}

function initLoypePanel() {
  document.getElementById('loype-geolocate-btn').addEventListener('click', useMyLocationForRoute);
  document.getElementById('loype-undo-btn').addEventListener('click', undoLastRoutePoint);
  document.getElementById('loype-clear-btn').addEventListener('click', clearRoute);
  document.getElementById('loype-mirror-checkbox').addEventListener('change', updateDistanceAndChart);
  document.getElementById('loype-pace-input').addEventListener('input', () => {
    persistPaceValue();
    updateDistanceAndChart();
  });
  document.getElementById('loype-pace-run-btn').addEventListener('click', () => setPaceMode('run'));
  document.getElementById('loype-pace-walk-btn').addEventListener('click', () => setPaceMode('walk'));
  document.getElementById('loype-pace-reset-btn').addEventListener('click', () => {
    document.getElementById('loype-pace-input').value = PACE_DEFAULTS[paceMode];
    persistPaceValue();
    updateDistanceAndChart();
  });
  initPanelCollapse('loype-panel', 'loype-panel-collapse-btn');
  updateLoypeControls();

  const profile = loadProfile();
  paceMode = profile.paceMode || 'run';
  document.getElementById('loype-pace-input').value = profile[`pace_${paceMode}`] || PACE_DEFAULTS[paceMode];
  document.getElementById('loype-pace-run-btn').classList.toggle('active', paceMode === 'run');
  document.getElementById('loype-pace-walk-btn').classList.toggle('active', paceMode === 'walk');
}

document.addEventListener('DOMContentLoaded', initLoypePanel);
