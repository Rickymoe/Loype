const LOYPE_LINE_COLOR = '#ff9800';

let routePoints = [];
let routePolyline = null;
let routeMarkers = [];

// Hvor ruten på kartet kommer fra: 'gpx' når den er lastet opp fra en fil,
// ellers null. Se isGpxRouteUntouched.
let routeSource = null;

// Når turen faktisk ble gjennomført, lest fra <time> i GPX-fila (første og
// siste punkt som har et gyldig tidsstempel). Brukes av faktalinja i
// detaljpanelet — se renderDetailRunFacts. Null når ruten ikke kom fra en
// fil, eller når fila ikke har tidsstempler i det hele tatt.
let routeStartTime = null;
let routeEndTime = null;

// Klokketid per punkt, i sekunder fra routeStartTime, parallelt med
// routePoints. Tegner den ekte tidsaksen i detaljvisningen. Null for ruter
// uten tidsstempler.
let routeTimes = null;

// Puls fra fila. Snittet over alle målingene og den høyeste — begge er
// målinger, ikke overslag. Null når fila ikke har puls.
let routeHrAvg = null;
let routeHrMax = null;

// Aktiviteten fila selv oppgir (<type> i GPX-en: running, walking, cycling),
// satt av parseGpxPoints. Styrer hvilke ACSM-koeffisienter det beregnede
// energiforbruket bruker — fila vet bedre enn en knapp i panelet hva slags
// tur den inneholder.
let routeActivity = null;

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
      showLoypeError('Fikk ikke tilgang til posisjonen din. Du kan fortsatt bruke kartet som normalt.');
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
  routeSource = null;
  routeStartTime = null;
  routeEndTime = null;
  routeTimes = null;
  routeHrAvg = null;
  routeHrMax = null;
  routeActivity = null;
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
  updateRouteSourceMark();
}

// Om ruten er en opplastet GPX-fil som fortsatt er urørt. «Urørt» kan leses
// rett ut av undoStack: den får bare punkter brukeren har satt selv
// (addRoutePoint og høyreklikk-innsetting) og tømmes av hver vei som
// erstatter ruten. «source er gpx og stakken er tom» betyr derfor nøyaktig
// «lastet opp, ingen egne punkter siden». Setter brukeren inn et punkt og
// angrer, er ruten urørt igjen av seg selv — uten at noe må huske det.
// To ting bygger på dette: GPX-merket og faktalinja med tidspunktet turen
// faktisk ble gjennomført (se renderDetailRunFacts). Selve regelen står her,
// så de to ikke kan komme ut av synk.
function isGpxRouteUntouched() {
  return routeSource === 'gpx' && undoStack.length === 0;
}

// Om ruten kommer fra en fil som inneholder en faktisk gjennomført tur, med
// tidsstempler å vise. Da beskriver appen turen i stedet for å planlegge den:
// panelet og sidebaren viser målte tall, og været, den beste luka og
// væsketapet skjules — de er alle sammen spørsmål om en tur som ennå ikke
// har skjedd. Se openRouteDetailView.
function hasRunFacts() {
  return isGpxRouteUntouched() && !!(routeStartTime && routeEndTime);
}

// Turens lengde i sekunder, målt fra fila. Null når turen ikke er målt.
function measuredDurationSeconds() {
  if (!routeStartTime || !routeEndTime) return null;
  return Math.round((routeEndTime - routeStartTime) / 1000);
}

// Merket på den lille grafen og i detaljpanelet som sier at ruten kom fra en
// opplastet GPX-fil og ikke fra klikk på kartet.
//
// Klassen settes på <body> fordi detaljpanelet bygges på nytt hver gang det
// åpnes; se .loype-gpx-badge i css/style.css.
function updateRouteSourceMark() {
  document.body.classList.toggle('fra-gpx', isGpxRouteUntouched());

  // «Speil retur» er en plan for en retur som ikke har skjedd, og den passer
  // ikke sammen med tallene fra en gjennomført tur: panelet ville sagt
  // 16,5 km mens turen var 8,25. Avkrysningen sperres derfor så lenge fila
  // beskriver en målt tur. Filer uten tidsstempler er upåvirket.
  const speil = document.getElementById('loype-mirror-checkbox');
  if (speil) {
    const sperret = hasRunFacts();
    speil.disabled = sperret;
    if (sperret) speil.checked = false;
    // En sperret avkrysning uten forklaring ser ut som en feil, så tittelen
    // sier hvorfor. Den henger på label-elementet, som er det brukeren peker
    // på, og forsvinner sammen med sperren.
    speil.parentElement.title = sperret
      ? 'Fila beskriver en gjennomført tur — retur er en plan, og passer ikke sammen med målte tall'
      : '';
  }
}

// Feilmeldinger (f.eks. avslått posisjonstilgang) forsvant tidligere aldri
// av seg selv og hadde ingen måte å lukke dem på — de sto der resten av
// økten uansett om brukeren brydde seg eller ikke.
function showLoypeError(msg) {
  const el = document.getElementById('loype-error-msg');
  el.innerHTML = '';

  const content = document.createElement('div');
  content.className = 'loype-error-content';

  const text = document.createElement('span');
  text.textContent = msg;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'loype-error-close';
  closeBtn.setAttribute('aria-label', 'Lukk feilmelding');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', hideLoypeError);

  content.appendChild(text);
  content.appendChild(closeBtn);
  el.appendChild(content);
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
const ELEVATION_FETCH_TIMEOUT_MS = 10000;

// Uten dette kan en fetch() som verken lykkes eller feiler (observert mot
// Kartverkets endepunkt — tilkoblingen bare henger) la løftet stå uavgjort
// for alltid. Da kjører aldri .then() eller .catch() hos kalleren, og
// høydegrafen blir stående tom uten at brukeren får noen feilmelding.
async function fetchWithTimeout(url, options, timeoutMs = ELEVATION_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('tidsavbrudd');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKartverketElevation(points) {
  const results = [];
  for (const chunk of chunkArray(points, ELEVATION_CHUNK_SIZE)) {
    const coords = JSON.stringify(chunk.map(p => [p.lng, p.lat]));
    const url = `${KARTVERKET_HOYDEDATA_URL}?punkter=${encodeURIComponent(coords)}&koordsys=4326`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    results.push(...data.punkter.map(p => p.z));
  }
  return results;
}

async function fetchOpenElevation(points) {
  const results = [];
  for (const chunk of chunkArray(points, ELEVATION_CHUNK_SIZE)) {
    const resp = await fetchWithTimeout('https://api.open-elevation.com/api/v1/lookup', {
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
// Høydemodellene returnerer av og til svakt negative verdier rett ved
// kysten/over vann (modell-støy ved havnivå, ikke reell terrenghøyde) — det
// leser som en feil i grafene ("-5 m"), så vi klemmer til 0 som gulv.
function clampElevation(e) {
  return e === null || e === undefined ? e : Math.max(0, e);
}

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
    return kartverketElevations.map(clampElevation);
  }

  const fallbackPoints = missingIndexes.map(i => points[i]);
  const fallbackElevations = await fetchOpenElevation(fallbackPoints);
  const merged = [...kartverketElevations];
  missingIndexes.forEach((i, j) => { merged[i] = fallbackElevations[j]; });
  return merged.map(clampElevation);
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
  title.textContent = `Høydeprofil: ${formatNo(min)}–${formatNo(max)} m`;
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
  addXLabel(plotRight, `${formatNo(km, 2)} km`, 'end');

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
    label.textContent = `${formatNo(value)} m`;
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

  // Antyder samme visuelle språk som den store detaljgrafen (linje + fylt
  // flate under) i stedet for å være to helt urelaterte diagramtyper.
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  area.setAttribute('points', `${plotLeft},${plotBottom} ${pointsAttr} ${plotRight},${plotBottom}`);
  area.setAttribute('fill', LOYPE_LINE_COLOR);
  area.setAttribute('fill-opacity', '0.15');
  svg.appendChild(area);

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

  document.getElementById('loype-distance-value').textContent = `${formatNo(km, 2)} km`;
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

// Norsk tallformat (komma som desimaltegn, mellomrom som tusenskille) i
// stedet for toFixed()'s alltid-engelske punktum. Kun for tall som faktisk
// vises til brukeren — API-kall, SVG-koordinater og GPX forblir upåvirket,
// siden de må ha standard desimalpunktum uansett.
function formatNo(value, decimals = 0) {
  return value.toLocaleString('nb-NO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatDuration(totalSeconds) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}t ${minutes}min` : `${minutes} min`;
}

// Målt tid, med sekunder. formatDuration runder til hele minutter, som er
// riktig for et overslag («47 min») men feil for en stoppeklokke: turen varte
// 47:07, og et panel som sier «47 min» om en målt tid påstår mer presisjon
// enn det har. Over timen faller sekundene bort igjen — «2t 14min» er da den
// lesbare formen.
function formatStopwatch(totalSeconds) {
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}t ${minutes}min`;
  const rest = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
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

  // Kommer ruten fra en fil med tidsstempler, står den målte tiden her i
  // stedet for estimatet. Panelet viser de samme tallene, og skjermen skal
  // ikke oppgi to ulike tider for samme tur.
  const malt = measuredDurationSeconds();
  if (hasRunFacts() && malt !== null) {
    timeEl.textContent = `Målt tid: ${formatStopwatch(malt)}`;
    timeEl.classList.remove('hidden');
    return;
  }

  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  const weightKg = parseFloat(loadProfile().weight);
  // Sykkelmodellen trenger vekt (inngår i massen); løp/gå trenger den ikke
  // for selve tidsestimatet.
  if (!paceSecPerKm || routePoints.length < 2 || (paceMode === 'bike' && !weightKg)) {
    timeEl.classList.add('hidden');
    return;
  }
  const mirror = document.getElementById('loype-mirror-checkbox').checked;

  let seconds = routeSegmentSeconds(paceSecPerKm, weightKg, false);
  if (mirror) {
    // Returveien følger samme delstrekninger baklengs — det som var
    // nedoverbakke på vei ut er oppoverbakke på vei tilbake.
    seconds += routeSegmentSeconds(paceSecPerKm, weightKg, true);
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

    const minutes = (segKm * 1000) / speedMetersPerMin;
    kcal += acsmKcalPerMin(speedMetersPerMin, grade, weightKg, isRunning) * minutes;
  }
  return kcal;
}

// ACSM-ligningen på ett sted: oksygenopptak (VO2, ml/kg/min) fra fart og
// stigning, gjort om til kcal per minutt. Løpe- og gå-koeffisientene er ulike
// — gå-koeffisienten for stigning (1,8) er dobbelt av løpe-koeffisienten
// (0,9), så å gå oppover koster langt mer enn å løpe samme bakke.
function acsmKcalPerMin(speedMetersPerMin, grade, weightKg, isRunning) {
  const vo2 = isRunning
    ? 0.2 * speedMetersPerMin + 0.9 * speedMetersPerMin * grade + 3.5
    : 0.1 * speedMetersPerMin + 1.8 * speedMetersPerMin * grade + 3.5;
  return (vo2 * weightKg / 1000) * 5;
}

// Energiforbruket for turen slik den faktisk ble gått: samme ACSM-ligning,
// men med de målte minuttene per delstrekning i stedet for en antatt fart.
// Farten blir da en følge av tid og distanse fra fila, og tallet trenger
// verken alder eller kjønn — i motsetning til pulsbaserte formler (Keytel),
// som skiller rundt 50 % mellom kvinner og menn ved samme puls og derfor er
// ubrukelige uten et kjønnsfelt vi ikke har.
//
// Aktiviteten avgjør koeffisientene: gå-koeffisientene for stigning er mer
// enn dobbelt så bratte som løpe-koeffisientene, så det er stor forskjell på
// å gjette. Sier fila ingenting, behandles turen som en løpetur.
//
// Sykling gir null: ACSM for sykling regner på effekt i watt, og det har
// ikke GPX-fila.
function measuredRunKcal(weightKg) {
  if (!weightKg || !routeTimes || routePoints.length < 2) return null;
  if (routeActivity === 'cycling') return null;
  const isRunning = routeActivity !== 'walking';

  let kcal = 0;
  for (let i = 1; i < routePoints.length; i++) {
    const minutes = (routeTimes[i] - routeTimes[i - 1]) / 60;
    if (!(minutes > 0)) continue;
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
      grade = Math.max(-0.4, Math.min(0.4, (eb - ea) / (segKm * 1000)));
    }

    const speedMetersPerMin = (segKm * 1000) / minutes;
    kcal += acsmKcalPerMin(speedMetersPerMin, grade, weightKg, isRunning) * minutes;
  }
  return kcal;
}

// «Snitttid flatt terreng» målt fra fila: hvor fort turen faktisk gikk der
// det var flatt. Ruten deles i vinduer på 250 m, og et vindu teller bare når
// netto stigning gjennom hele vinduet er innenfor ±2 % — da er det terrenget,
// og ikke bakkene, som har satt farten. Farten blir sum tid delt på sum
// distanse over de vinduene som kvalifiserer.
//
// Netto stigning over vinduet, ikke stigning per delstrekning: en 250 m
// bakke som går opp og ned igjen er flat terreng å løpe i, selv om hver
// meter av den heller.
//
// Delstrekninger under 2 km/h holdes utenfor. Det er å stå stille — pause,
// lyskryss, GPS-hull — og ikke gange; tok vi dem med, ville pausen gjort den
// målte farten langsommere enn turen var. Delstrekninger over taket holdes
// også utenfor, for et GPS-sprang på noen hundre meter ville gitt en pace
// ingen kunne løpe. Taket er romsligere for sykkel, der 40 km/h er ekte fart.
//
// Returnerer null når for lite av ruten er flat nok. En pace målt over 300 m
// sier ingenting, og feltet skal heller stå urørt enn å fylles med et tall
// brukeren ikke kan stole på.
const FLAT_PACE_WINDOW_METERS = 250;
const FLAT_PACE_MAX_GRADE = 0.02;
const FLAT_PACE_MIN_SPEED_KMH = 2;
const FLAT_PACE_MAX_SPEED_KMH = 30;
const FLAT_PACE_BIKE_MAX_SPEED_KMH = 70;
const FLAT_PACE_MIN_DISTANCE_KM = 1;

function measuredFlatPace() {
  if (!routeTimes || routeTimes.length !== routePoints.length || routePoints.length < 2) return null;
  if (!routeElevations.some(e => e !== undefined)) return null;

  const maksKmh = routeActivity === 'cycling' ? FLAT_PACE_BIKE_MAX_SPEED_KMH : FLAT_PACE_MAX_SPEED_KMH;

  let flatKm = 0;
  let flatSeconds = 0;

  // Vinduet som bygges nå: distanse, tid og høyden ved vinduets første og
  // siste punkt.
  let vindusKm = 0;
  let vindusSek = 0;
  let vindusStartHoyde = undefined;
  let vindusSluttHoyde = undefined;

  const lukkVindu = () => {
    const langtNok = vindusKm * 1000 >= FLAT_PACE_WINDOW_METERS;
    const harHoyde = Number.isFinite(vindusStartHoyde) && Number.isFinite(vindusSluttHoyde);
    if (langtNok && harHoyde) {
      const stigning = (vindusSluttHoyde - vindusStartHoyde) / (vindusKm * 1000);
      if (Math.abs(stigning) <= FLAT_PACE_MAX_GRADE) {
        flatKm += vindusKm;
        flatSeconds += vindusSek;
      }
    }
    vindusKm = 0;
    vindusSek = 0;
    vindusStartHoyde = undefined;
    vindusSluttHoyde = undefined;
  };

  for (let i = 1; i < routePoints.length; i++) {
    const sek = routeTimes[i] - routeTimes[i - 1];
    if (!(sek > 0)) continue;
    const a = routePoints[i - 1];
    const b = routePoints[i];
    const segKm = turf.distance(
      turf.point([a.lng, a.lat]),
      turf.point([b.lng, b.lat]),
      { units: 'kilometers' }
    );
    if (!(segKm > 0)) continue;
    const kmh = (segKm / sek) * 3600;
    if (kmh < FLAT_PACE_MIN_SPEED_KMH || kmh > maksKmh) continue;

    if (vindusKm === 0) vindusStartHoyde = routeElevations[i - 1];
    vindusKm += segKm;
    vindusSek += sek;
    vindusSluttHoyde = routeElevations[i];
    if (vindusKm * 1000 >= FLAT_PACE_WINDOW_METERS) lukkVindu();
  }
  lukkVindu();

  if (flatKm < FLAT_PACE_MIN_DISTANCE_KM) return null;
  return { secondsPerKm: Math.round(flatSeconds / flatKm), km: flatKm };
}

// Pace skrevet slik feltet vil ha den: «5:36». Samme format som brukeren
// skriver selv, og som parsePaceToSecondsPerKm() leser tilbake — så det som
// står i feltet, er nøyaktig det som lagres.
function formatPaceInput(secondsPerKm) {
  const sek = Math.round(secondsPerKm);
  return `${Math.floor(sek / 60)}:${String(sek % 60).padStart(2, '0')}`;
}

// Fila beskriver en tur som er gått, og da vet vi også hvor fort den gikk på
// flatt — som er nettopp det «Snitttid flatt terreng» spør om. Farten fylles
// derfor inn automatisk og lagres som om brukeren hadde skrevet den selv.
// Uten dette måtte hver bruker finne tallet sitt med stoppeklokke og kart.
//
// Aktiviteten i fila bestemmer hvilken av de tre fartsinnstillingene som
// kalibreres. Siden panelet bare viser én av dem om gangen, bytter det til
// filas aktivitet — ellers ville feltet brukeren ser stått urørt mens et
// annet ble endret i det stille. Sier fila ingenting om aktivitet, gjelder
// målingen den aktiviteten brukeren selv står i.
//
// Filer uten tidsstempler, uten høyde eller med for lite flat terreng lar
// feltet stå urørt.
function applyMeasuredFlatPace() {
  const malt = measuredFlatPace();
  if (!malt) return;
  const input = document.getElementById('loype-pace-input');
  if (!input) return;

  const mode = FILE_ACTIVITY_TO_MODE[routeActivity];
  if (mode && mode !== paceMode) setPaceMode(mode);

  input.value = formatPaceInput(malt.secondsPerKm);
  persistPaceValue();
}

// Fysikkbasert sykkelmodell (i stedet for ACSM, som er laget for
// ergometersykling og ikke passer utendørs helning/vind). Konstant tråkkeffekt
// antas i flatt/oppover; nedover trappes effekten lineært ned mot null
// (ren utforkjøring) — folk hviler jo bena i nedoverbakker. Per delstrekning
// løses en tredjegradsligning (kraftbalanse) for farten den effekten gir.
const BIKE_MASS_KG = 12;
const BIKE_CRR = 0.005;
const BIKE_CDA = 0.35;
const BIKE_AIR_DENSITY = 1.225;
const BIKE_EFFICIENCY = 0.22;
const BIKE_DOWNHILL_REST_GRADE = 0.04;
const GRAVITY = 9.81;

// Kraftbalanse: effekt = tyngdekraft/rullemotstand-ledd (lineært i fart) +
// luftmotstand (∝ fart³). Løses numerisk med binærsøk — funksjonen er
// garantert å krysse null nøyaktig én gang for fart > 0, selv når det
// lineære leddet er negativt (nedoverbakke, tyngdekraften bidrar).
function solveBikeSpeedMs(power, grade, mass) {
  const linearCoeff = mass * GRAVITY * (grade + BIKE_CRR);
  const aeroCoeff = 0.5 * BIKE_CDA * BIKE_AIR_DENSITY;
  const f = v => linearCoeff * v + aeroCoeff * v * v * v - power;

  let lo = 0, hi = 30; // m/s, ca. 108 km/t — godt over noe realistisk utfor-fart
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Regner tid og energi sammen per delstrekning — begge trenger akkurat
// samme kraft/fart-løsning, så vi unngår å løse tredjegradsligningen to ganger.
function computeBikeSegmentStats(paceSecPerKm, weightKg, reverseGrade) {
  const vFlat = 1000 / paceSecPerKm;
  const mass = weightKg + BIKE_MASS_KG;
  const pFlat = mass * GRAVITY * BIKE_CRR * vFlat + 0.5 * BIKE_CDA * BIKE_AIR_DENSITY * vFlat ** 3;

  let seconds = 0;
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
      grade = dz / (segKm * 1000);
    }

    const power = grade >= 0
      ? pFlat
      : pFlat * Math.max(0, 1 - Math.abs(grade) / BIKE_DOWNHILL_REST_GRADE);

    const v = solveBikeSpeedMs(power, grade, mass);
    const segSeconds = (segKm * 1000) / v;

    seconds += segSeconds;
    kcal += (power / BIKE_EFFICIENCY) * segSeconds / 4184;
  }
  return { seconds, kcal };
}

// Fasade som lar resten av appen spørre om tid/energi uten å bry seg om
// hvilken modell som brukes under panseret.
function routeSegmentSeconds(paceSecPerKm, weightKg, reverseGrade) {
  return paceMode === 'bike'
    ? computeBikeSegmentStats(paceSecPerKm, weightKg, reverseGrade).seconds
    : segmentTimeSeconds(paceSecPerKm, reverseGrade);
}

function routeSegmentKcal(paceSecPerKm, weightKg, reverseGrade) {
  return paceMode === 'bike'
    ? computeBikeSegmentStats(paceSecPerKm, weightKg, reverseGrade).kcal
    : segmentEnergyKcal(paceSecPerKm, weightKg, paceMode === 'run', reverseGrade);
}

function updateEstimatedEnergy() {
  const energyEl = document.getElementById('loype-energy-value');
  const weightKg = parseFloat(loadProfile().weight);

  // Faktamodus: samme beregning som panelet (se measuredRunKcal), merket som
  // beregnet fordi fila ikke inneholder noen energimåling — bare tid, puls og
  // stigning å regne fra.
  if (hasRunFacts()) {
    const maltKcal = measuredRunKcal(weightKg);
    if (!maltKcal) {
      energyEl.classList.add('hidden');
      return;
    }
    energyEl.textContent = `Energi: ${formatNo(maltKcal * 4.184)} kJ / ${formatNo(maltKcal)} kcal (beregnet)`;
    energyEl.classList.remove('hidden');
    return;
  }

  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  if (!weightKg || !paceSecPerKm || routePoints.length < 2) {
    energyEl.classList.add('hidden');
    return;
  }
  const mirror = document.getElementById('loype-mirror-checkbox').checked;

  let kcal = routeSegmentKcal(paceSecPerKm, weightKg, false);
  if (mirror) {
    kcal += routeSegmentKcal(paceSecPerKm, weightKg, true);
  }
  const kj = kcal * 4.184;

  energyEl.textContent = `Energi: ${formatNo(kj)} kJ / ${formatNo(kcal)} kcal`;
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

// Tre hastigheter (løp/gå/sykkel) huskes hver for seg per bruker, siden
// farten naturlig er svært forskjellig mellom aktivitetene.
const PACE_DEFAULTS = { run: '5:30', walk: '12:00', bike: '2:30' };
const PACE_MODE_BUTTON_IDS = { run: 'loype-pace-run-btn', walk: 'loype-pace-walk-btn', bike: 'loype-pace-bike-btn' };

// Filas aktivitetsnavn oversatt til de samme nøklene som bryteren i panelet
// bruker. Fila skriver «running», bryteren heter «run» — oversettelsen brukes
// både av AI-spørringen (fortidsverbet) og av den målte flatfarten, som
// fylles inn i feltet for filas egen aktivitet.
const FILE_ACTIVITY_TO_MODE = { running: 'run', walking: 'walk', cycling: 'bike' };

let paceMode = 'run';

function syncPaceModeButtons(mode) {
  Object.entries(PACE_MODE_BUTTON_IDS).forEach(([m, id]) => {
    const btn = document.getElementById(id);
    const active = m === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function setPaceMode(mode) {
  paceMode = mode;
  const profile = loadProfile();
  document.getElementById('loype-pace-input').value = profile[`pace_${mode}`] || PACE_DEFAULTS[mode];
  syncPaceModeButtons(mode);
  saveProfile({ ...profile, paceMode: mode });
  updateDistanceAndChart();
}

function persistPaceValue() {
  const profile = loadProfile();
  saveProfile({ ...profile, [`pace_${paceMode}`]: document.getElementById('loype-pace-input').value, paceMode });
}

// Ett trykk arm-er en destruktiv handling ("Sikker?"), et andre trykk innen
// noen sekunder utfører den. Unngår en avbrytende, nativ confirm()-dialog
// samtidig som "Tøm rute" ikke lenger skjer på ett uhellstrykk.
function armConfirmButton(btn, onConfirm, confirmText = 'Sikker?', timeoutMs = 3000) {
  const original = btn.textContent;
  let armed = false;
  let timer = null;

  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmText;
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = original;
      }, timeoutMs);
      return;
    }
    clearTimeout(timer);
    armed = false;
    btn.textContent = original;
    onConfirm();
  });
}

function initLoypePanel() {
  document.getElementById('loype-geolocate-btn').addEventListener('click', useMyLocationForRoute);
  document.getElementById('loype-undo-btn').addEventListener('click', undoLastRoutePoint);
  armConfirmButton(document.getElementById('loype-clear-btn'), clearRoute);
  document.getElementById('loype-mirror-checkbox').addEventListener('change', updateDistanceAndChart);
  document.getElementById('loype-pace-input').addEventListener('input', () => {
    persistPaceValue();
    updateDistanceAndChart();
  });
  Object.entries(PACE_MODE_BUTTON_IDS).forEach(([mode, id]) => {
    document.getElementById(id).addEventListener('click', () => setPaceMode(mode));
  });
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
  syncPaceModeButtons(paceMode);
}

document.addEventListener('DOMContentLoaded', initLoypePanel);
