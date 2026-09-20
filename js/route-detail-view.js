async function fetchPlaceName(lat, lng) {
  try {
    const url = `https://ws.geonorge.no/stedsnavn/v1/punkt?nord=${lat}&ost=${lng}&koordsys=4326&radius=500&antall=1`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const hit = data.navn && data.navn[0];
    return hit ? hit.stedsnavn[0].skrivemåte : null;
  } catch (err) {
    return null;
  }
}

// Bygger en avstandsbasert høydeprofil (km langs ruten, ikke punktindeks),
// inkludert returbenet hvis "Speil retur" er huket av.
function buildDistanceProfile() {
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const profile = [];
  let cum = 0;
  for (let i = 0; i < routePoints.length; i++) {
    if (i > 0) {
      const segKm = turf.distance(
        turf.point([routePoints[i - 1].lng, routePoints[i - 1].lat]),
        turf.point([routePoints[i].lng, routePoints[i].lat]),
        { units: 'kilometers' }
      );
      cum += segKm;
    }
    if (routeElevations[i] !== undefined) {
      profile.push({ distKm: cum, elevation: routeElevations[i], lat: routePoints[i].lat, lng: routePoints[i].lng });
    }
  }

  if (mirror && profile.length > 1) {
    const totalOneWay = cum;
    const returnLeg = profile.slice(0, -1).reverse().map(p => ({
      distKm: totalOneWay + (totalOneWay - p.distKm),
      elevation: p.elevation,
      lat: p.lat,
      lng: p.lng,
    }));
    profile.push(...returnLeg);
  }

  return profile;
}

const GRADE_BUCKETS = [
  { max: 0.03, light: '#dcedc8', base: '#8bc34a', dark: '#5a8f2e' },
  { max: 0.06, light: '#fff3cd', base: '#ffc107', dark: '#c79400' },
  { max: 0.10, light: '#ffe0b2', base: '#ff9800', dark: '#c66f00' },
  { max: Infinity, light: '#ffcdd2', base: '#e53935', dark: '#a52521' },
];

function gradeBucketIndex(grade) {
  return GRADE_BUCKETS.findIndex(b => grade < b.max);
}

// Fargen på energilinja følger fortegnet helning (i motsetning til
// terrengfargen over, som kun bryr seg om oppoverbakke): nedover er billig
// (grønt), flatt er nøytralt, oppover er dyrt (rødt/oransje).
function energyLineColor(grade) {
  if (grade < -0.03) return '#43a047';
  if (grade < 0.02) return '#ffb300';
  if (grade < 0.08) return '#ff7043';
  return '#e53935';
}

// Y-aksen strakk seg alltid til nøyaktig min/maks høyde, så en tur med bare
// noen få meter reell høydeforskjell ble tegnet like bratt som en ekte
// fjellside. Regner i stedet ut "pene" akse-grenser (rundt trinn, avrundet
// ned/opp) med et minimumsspenn — en flat tur ser flat ut, en bratt tur
// ser bratt ut, uansett hvor liten variasjonen faktisk er.
function niceAxisBounds(min, max) {
  const MIN_DISPLAY_RANGE = 20;
  const displayRange = Math.max(max - min, MIN_DISPLAY_RANGE);

  const rawStep = displayRange / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let step;
  if (normalized < 1.5) step = 1 * magnitude;
  else if (normalized < 3) step = 2 * magnitude;
  else if (normalized < 7) step = 5 * magnitude;
  else step = 10 * magnitude;

  const niceMin = Math.floor(min / step) * step;
  let niceMax = Math.ceil(max / step) * step;
  while (niceMax - niceMin < MIN_DISPLAY_RANGE) niceMax += step;

  return { min: niceMin, max: niceMax, step };
}

// Kumulativ, høydejustert reisetid til hvert punkt i profilen — samme
// grad-avhengige modell som segmentTimeSeconds, men regnet direkte fra
// avstandsprofilen (som også dekker det speilede returbenet).
function buildCumulativeTimeProfile(profile, paceSecPerKm) {
  const cumSeconds = [0];
  for (let i = 1; i < profile.length; i++) {
    const segKm = profile[i].distKm - profile[i - 1].distKm;
    if (segKm <= 0) {
      cumSeconds.push(cumSeconds[i - 1]);
      continue;
    }
    const climbGrade = Math.max(0, (profile[i].elevation - profile[i - 1].elevation) / (segKm * 1000));
    const factor = 1 + 10 * climbGrade + 20 * climbGrade * climbGrade;
    cumSeconds.push(cumSeconds[i - 1] + segKm * paceSecPerKm * factor);
  }
  return cumSeconds;
}

// Kumulativt energiforbruk til hvert punkt i profilen — samme ACSM-modell
// som segmentEnergyKcal, regnet direkte fra avstandsprofilen.
function buildCumulativeEnergyProfile(profile, paceSecPerKm, weightKg, isRunning) {
  const speedMetersPerMin = 60000 / paceSecPerKm;
  const cumKcal = [0];
  for (let i = 1; i < profile.length; i++) {
    const segKm = profile[i].distKm - profile[i - 1].distKm;
    if (segKm <= 0) {
      cumKcal.push(cumKcal[i - 1]);
      continue;
    }
    const grade = Math.max(-0.4, Math.min(0.4, (profile[i].elevation - profile[i - 1].elevation) / (segKm * 1000)));
    const vo2 = isRunning
      ? 0.2 * speedMetersPerMin + 0.9 * speedMetersPerMin * grade + 3.5
      : 0.1 * speedMetersPerMin + 1.8 * speedMetersPerMin * grade + 3.5;
    const minutes = (segKm * 1000) / speedMetersPerMin;
    cumKcal.push(cumKcal[i - 1] + (vo2 * weightKg / 1000) * 5 * minutes);
  }
  return cumKcal;
}

// Sykkel-varianten av de to funksjonene over, slått sammen siden begge uansett
// trenger samme kraft/fart-løsning per delstrekning (se route-recorder.js).
function buildCumulativeBikeProfile(profile, paceSecPerKm, weightKg) {
  const vFlat = 1000 / paceSecPerKm;
  const mass = weightKg + BIKE_MASS_KG;
  const pFlat = mass * GRAVITY * BIKE_CRR * vFlat + 0.5 * BIKE_CDA * BIKE_AIR_DENSITY * vFlat ** 3;

  const cumSeconds = [0];
  const cumKcal = [0];
  for (let i = 1; i < profile.length; i++) {
    const segKm = profile[i].distKm - profile[i - 1].distKm;
    if (segKm <= 0) {
      cumSeconds.push(cumSeconds[i - 1]);
      cumKcal.push(cumKcal[i - 1]);
      continue;
    }

    const grade = (profile[i].elevation - profile[i - 1].elevation) / (segKm * 1000);
    const power = grade >= 0
      ? pFlat
      : pFlat * Math.max(0, 1 - Math.abs(grade) / BIKE_DOWNHILL_REST_GRADE);

    const v = solveBikeSpeedMs(power, grade, mass);
    const segSeconds = (segKm * 1000) / v;

    cumSeconds.push(cumSeconds[i - 1] + segSeconds);
    cumKcal.push(cumKcal[i - 1] + (power / BIKE_EFFICIENCY) * segSeconds / 4184);
  }
  return { cumSeconds, cumKcal };
}

// Egen, momentan tooltip i stedet for nettleserens innebygde <title>-hover,
// som alltid har en innebygd forsinkelse før den vises.
function showDetailTooltip(text, e) {
  const tooltip = document.getElementById('loype-detail-tooltip');
  tooltip.textContent = text;
  tooltip.classList.remove('hidden');
  positionDetailTooltip(e);
}

function positionDetailTooltip(e) {
  const tooltip = document.getElementById('loype-detail-tooltip');
  tooltip.style.left = `${e.clientX + 14}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
}

function hideDetailTooltip() {
  document.getElementById('loype-detail-tooltip').classList.add('hidden');
}

let detailModal = null;
let currentProfile = null;
let cachedPlaceNames = null;

function openRouteDetailView() {
  const profile = buildDistanceProfile();
  if (profile.length < 2) return;
  currentProfile = profile;
  cachedPlaceNames = null;

  buildDetailModalSkeleton();
  initDetailPaceButtons();
  initDetailWhenButton();
  document.getElementById('loype-detail-ask-ai-btn').addEventListener('click', askAiAboutRoute);
  document.getElementById('loype-detail-copy-ai-btn').addEventListener('click', copyAiQuery);
  refreshDetailWeather();
  refreshRainWindowIfApplicable();
  renderDetailSummary(profile);
  renderDetailChart(profile);
  loadPlaceLabels(profile);
}

const DETAIL_PACE_BUTTON_IDS = {
  run: 'loype-detail-pace-run-btn',
  walk: 'loype-detail-pace-walk-btn',
  bike: 'loype-detail-pace-bike-btn',
};

// Lar deg bytte Løp/Gå/Sykkel mens detaljvisningen er åpen, uten å måtte
// lukke den for å bruke bryteren i hovedpanelet. Stedsnavn er ofte allerede
// hentet, så vi gjenbruker dem i stedet for å spørre Kartverket på nytt.
function initDetailPaceButtons() {
  syncDetailPaceButtons();
  Object.entries(DETAIL_PACE_BUTTON_IDS).forEach(([mode, id]) => {
    document.getElementById(id).addEventListener('click', () => {
      setPaceMode(mode);
      syncDetailPaceButtons();
      refreshDetailView();
    });
  });
}

function toIsoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('no-NO', { day: '2-digit', month: '2-digit' });
}

// Datoen brukeren planlegger å løpe/gå ruten — brukes til værmelding/sol-tid
// når den funksjonen kommer på plass. MET Norway sine gratis API-er ser bare
// 9 dager frem, så velgeren begrenses tilsvarende.
let selectedForecastDate = null;

function initDetailWhenButton() {
  const btn = document.getElementById('loype-detail-when-btn');
  const dateInput = document.getElementById('loype-detail-date-input');

  const today = new Date();
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 9);
  const todayIso = toIsoDateLocal(today);

  dateInput.min = todayIso;
  dateInput.max = toIsoDateLocal(maxDate);
  dateInput.value = todayIso;
  selectedForecastDate = todayIso;
  btn.textContent = 'Nå';

  // Datofeltet ligger som et usynlig, men trykkbart lag oppå selve knappen
  // (se CSS) og mottar tappet direkte — i stedet for at knappen trigger
  // showPicker() via JS på et fjernt, krympet felt. iOS Safari forankrer
  // sin native dato-hjul-picker til feltets egen posisjon/størrelse, og det
  // viste seg upålitelig når feltet var 1×1px et annet sted i DOM-en.
  btn.addEventListener('click', () => {
    if (dateInput.showPicker) dateInput.showPicker();
  });

  // iOS Safari sin kalender-picker lar deg BLA til hvilken som helst
  // måned/år — det er Apples egen UI, ikke noe min/max-attributtene kan
  // begrense. Det de faktisk garanterer er at valgt VERDI ikke går utenfor
  // grensene, men vi klemmer den likevel her som en ekstra sikring på tvers
  // av nettlesere.
  dateInput.addEventListener('change', () => {
    const rawValue = dateInput.value;
    const outOfRange = rawValue < dateInput.min || rawValue > dateInput.max;

    let value = rawValue;
    if (value < dateInput.min) value = dateInput.min;
    if (value > dateInput.max) value = dateInput.max;
    if (value !== dateInput.value) dateInput.value = value;

    selectedForecastDate = value;
    btn.textContent = value === todayIso ? 'Nå' : formatShortDate(value);

    // Klemt til grensen er ikke det samme som "gyldig for grensen" — hvis
    // brukeren egentlig prøvde å velge noe utenfor vinduet, vil vi ikke vise
    // vær som ser ut til å gjelde den datoen de faktisk pekte på.
    if (outOfRange) {
      document.getElementById('loype-detail-weather').classList.add('hidden');
      document.getElementById('loype-detail-rain-window').classList.add('hidden');
      document.getElementById('loype-detail-hydration').classList.add('hidden');
    } else {
      refreshDetailWeather();
      refreshRainWindowIfApplicable();
    }
  });
}

function syncDetailPaceButtons() {
  Object.entries(DETAIL_PACE_BUTTON_IDS).forEach(([mode, id]) => {
    document.getElementById(id).classList.toggle('active', mode === paceMode);
  });
}

function refreshDetailView() {
  if (!currentProfile) return;
  renderDetailSummary(currentProfile);
  renderDetailChart(currentProfile);
  refreshRainWindowIfApplicable();
  refreshHydrationIfApplicable();
  if (cachedPlaceNames) {
    applyPlaceLabels(currentProfile, cachedPlaceNames);
  } else {
    loadPlaceLabels(currentProfile);
  }
}

// Ruteestimatets varighet avgjør hvor mange sammenhengende timer det
// tørreste vinduet må dekke — så dette må regnes på nytt hver gang farten
// eller Løp/Gå-modusen endres, ikke bare når dato bytter.
function refreshRainWindowIfApplicable() {
  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  const weightKg = parseFloat(loadProfile().weight);
  if (!paceSecPerKm || (paceMode === 'bike' && !weightKg)) {
    refreshDetailRainWindow(0);
    return;
  }
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  let seconds = routeSegmentSeconds(paceSecPerKm, weightKg, false);
  if (mirror) seconds += routeSegmentSeconds(paceSecPerKm, weightKg, true);
  refreshDetailRainWindow(seconds / 3600);
}

// Gjenbruker teksten som allerede står i detaljvisningen (oppsummering,
// vær, tørreste vindu) i stedet for å regne alt ut på nytt — unngår at
// spørringen kommer ut av synk med det brukeren faktisk ser.
function buildAiQuery() {
  const summary = document.getElementById('loype-detail-summary')?.textContent || '';
  const weatherEl = document.getElementById('loype-detail-weather');
  const rainEl = document.getElementById('loype-detail-rain-window');
  const hydrationEl = document.getElementById('loype-detail-hydration');

  const weather = weatherEl && !weatherEl.classList.contains('hidden') ? weatherEl.textContent : '';
  const rain = rainEl && !rainEl.classList.contains('hidden') ? rainEl.textContent : '';
  const hydration = hydrationEl && !hydrationEl.classList.contains('hidden') ? hydrationEl.textContent : '';

  const activity = { run: 'Jeg skal løpe en tur', walk: 'Jeg skal gå en tur', bike: 'Jeg skal sykle en tur' }[paceMode];
  const lines = [`${activity}: ${summary}.`];
  if (weather) lines.push(`Værmelding: ${weather}.`);
  if (rain) lines.push(`${rain}.`);
  if (hydration) lines.push(`${hydration}.`);
  lines.push('Har du noen tips til denne turen?');

  return lines.join(' ');
}

// "?q="-parameteret på chatgpt.com er ikke offisielt dokumentert og kan
// slutte å virke uten varsel — ingen annen stor AI-chat har noe tilsvarende
// i dag (sjekket: Perplexity har et lignende uoffisielt parameter, Claude.ai
// har ingenting — derav kopier-knappen ved siden av).
function askAiAboutRoute() {
  const url = `https://chatgpt.com/?q=${encodeURIComponent(buildAiQuery())}`;
  window.open(url, '_blank', 'noopener');
}

async function copyAiQuery() {
  const btn = document.getElementById('loype-detail-copy-ai-btn');
  try {
    await navigator.clipboard.writeText(buildAiQuery());
    const original = btn.innerHTML;
    btn.textContent = 'Kopiert!';
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  } catch (err) {
    // stille feiler — knappen endrer seg bare ikke
  }
}

function closeRouteDetailView() {
  if (detailModal) {
    detailModal.remove();
    detailModal = null;
  }
  currentProfile = null;
  cachedPlaceNames = null;
}

function buildDetailModalSkeleton() {
  if (detailModal) detailModal.remove();
  detailModal = document.createElement('div');
  detailModal.id = 'loype-detail-modal';
  detailModal.innerHTML = `
    <div id="loype-detail-backdrop"></div>
    <div id="loype-detail-panel">
      <button id="loype-detail-close" aria-label="Lukk">&times;</button>
      <div class="loype-detail-header">
        <div id="loype-detail-summary"></div>
        <div class="loype-detail-controls">
          <div class="loype-detail-when">
            <button type="button" id="loype-detail-when-btn" class="loype-pace-mode-btn loype-when-btn">Nå</button>
            <input type="date" id="loype-detail-date-input" />
          </div>
          <div class="loype-pace-mode loype-detail-pace-mode">
            <button type="button" id="loype-detail-pace-walk-btn" class="loype-pace-mode-btn">Gå</button>
            <button type="button" id="loype-detail-pace-run-btn" class="loype-pace-mode-btn">Løp</button>
            <button type="button" id="loype-detail-pace-bike-btn" class="loype-pace-mode-btn">Sykkel</button>
          </div>
        </div>
      </div>
      <div id="loype-detail-weather" class="loype-detail-weather hidden"></div>
      <div id="loype-detail-rain-window" class="loype-detail-rain-window hidden"></div>
      <div id="loype-detail-hydration" class="loype-detail-hydration hidden"></div>
      <div class="loype-detail-ai-row">
        <button id="loype-detail-ask-ai-btn" class="loype-btn">🤖 Spør ChatGPT</button>
        <button id="loype-detail-copy-ai-btn" class="loype-btn loype-copy-btn" aria-label="Kopier spørring" title="Kopier for å lime inn i f.eks. Claude.ai">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <div class="loype-detail-legend">
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#43a047"></span>Nedover</span>
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#ffb300"></span>Flatt</span>
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#ff7043"></span>Bratt</span>
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#e53935"></span>Svært bratt</span>
        <span class="loype-legend-note">— linja viser tid/energi langs ruten, hold musen over for detaljer</span>
      </div>
      <svg id="loype-detail-chart" viewBox="0 0 1100 380" preserveAspectRatio="xMidYMid meet" role="img"></svg>
    </div>
    <div id="loype-detail-tooltip" class="loype-detail-tooltip hidden"></div>
  `;
  document.body.appendChild(detailModal);
  document.getElementById('loype-detail-close').addEventListener('click', closeRouteDetailView);
  document.getElementById('loype-detail-backdrop').addEventListener('click', closeRouteDetailView);
}

function renderDetailSummary(profile) {
  const totalKm = profile[profile.length - 1].distKm;
  const gain = profile.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const diff = p.elevation - profile[i - 1].elevation;
    return sum + (diff > 0 ? diff : 0);
  }, 0);

  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const weightKg = parseFloat(loadProfile().weight);
  const hasPaceInput = paceSecPerKm && (paceMode !== 'bike' || weightKg);

  let timeText = '';
  if (hasPaceInput) {
    let seconds = routeSegmentSeconds(paceSecPerKm, weightKg, false);
    if (mirror) seconds += routeSegmentSeconds(paceSecPerKm, weightKg, true);
    timeText = ` · Estimert tid: ${formatDuration(seconds)}`;
  }

  let energyText = '';
  if (paceSecPerKm && weightKg) {
    let kcal = routeSegmentKcal(paceSecPerKm, weightKg, false);
    if (mirror) kcal += routeSegmentKcal(paceSecPerKm, weightKg, true);
    energyText = ` · Energi: ${Math.round(kcal * 4.184)} kJ / ${Math.round(kcal)} kcal`;
  }

  document.getElementById('loype-detail-summary').textContent =
    `${totalKm.toFixed(2)} km · ${Math.round(gain)} m stigning${timeText}${energyText}`;
}

function renderDetailChart(profile) {
  const svg = document.getElementById('loype-detail-chart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const width = 1100, height = 380;
  const plotLeft = 30, plotRight = width - 150, plotTop = 80, plotBottom = height - 40;
  const rulerX = plotRight + 25;
  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  const weightKg = parseFloat(loadProfile().weight);

  let cumSeconds = null;
  let cumKcal = null;
  if (paceMode === 'bike') {
    if (paceSecPerKm && weightKg) {
      const bikeProfile = buildCumulativeBikeProfile(profile, paceSecPerKm, weightKg);
      cumSeconds = bikeProfile.cumSeconds;
      cumKcal = bikeProfile.cumKcal;
    }
  } else {
    cumSeconds = paceSecPerKm ? buildCumulativeTimeProfile(profile, paceSecPerKm) : null;
    cumKcal = (paceSecPerKm && weightKg)
      ? buildCumulativeEnergyProfile(profile, paceSecPerKm, weightKg, paceMode === 'run')
      : null;
  }

  const totalKm = profile[profile.length - 1].distKm;
  const elevations = profile.map(p => p.elevation);
  const rawMin = Math.min(...elevations);
  const rawMax = Math.max(...elevations);
  const niceBounds = niceAxisBounds(rawMin, rawMax);
  const min = niceBounds.min;
  const range = niceBounds.max - niceBounds.min;

  const xFor = distKm => plotLeft + (totalKm > 0 ? (distKm / totalKm) : 0) * (plotRight - plotLeft);
  const yFor = elevation => plotTop + (1 - (elevation - min) / range) * (plotBottom - plotTop);

  const poly = (points, fill) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    el.setAttribute('points', points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    el.setAttribute('fill', fill);
    svg.appendChild(el);
    return el;
  };

  // --- Grunnlinje (bakken) ---
  const groundLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  groundLine.setAttribute('x1', String(plotLeft));
  groundLine.setAttribute('y1', String(plotBottom));
  groundLine.setAttribute('x2', String(plotRight));
  groundLine.setAttribute('y2', String(plotBottom));
  groundLine.setAttribute('stroke', '#ccc');
  groundLine.setAttribute('stroke-width', '1');
  svg.appendChild(groundLine);

  // --- Terreng: fylt flate per delstrekning, farget etter helning ---
  const frontPts = profile.map(p => ({ x: xFor(p.distKm), y: yFor(p.elevation) }));
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    const segKm = b.distKm - a.distKm;
    const grade = segKm > 0 ? Math.max(0, (b.elevation - a.elevation) / (segKm * 1000)) : 0;
    const bucket = GRADE_BUCKETS[gradeBucketIndex(grade)];
    poly(
      [{ x: frontPts[i - 1].x, y: plotBottom }, frontPts[i - 1], frontPts[i], { x: frontPts[i].x, y: plotBottom }],
      bucket.base
    );
  }

  // --- Terrengkontur — en tydelig strek langs selve ridgen, farget etter
  // samme helning som flaten under (i stedet for en nøytral svart strek). ---
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    const segKm = b.distKm - a.distKm;
    const grade = segKm > 0 ? Math.max(0, (b.elevation - a.elevation) / (segKm * 1000)) : 0;
    const bucket = GRADE_BUCKETS[gradeBucketIndex(grade)];
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    outline.setAttribute('x1', String(frontPts[i - 1].x));
    outline.setAttribute('y1', String(frontPts[i - 1].y));
    outline.setAttribute('x2', String(frontPts[i].x));
    outline.setAttribute('y2', String(frontPts[i].y));
    outline.setAttribute('stroke', bucket.dark);
    outline.setAttribute('stroke-width', '2');
    outline.setAttribute('stroke-linecap', 'round');
    svg.appendChild(outline);
  }

  // --- Svevende linje over terrenget: følger høydeprofilen, løftet opp et
  // fast antall piksler. Hover på et hvilket som helst punkt viser tid og
  // energiforbruk dit; ved start, topp og slutt trekkes tiden i tillegg
  // frem med en egen etikett. ---
  if (cumSeconds) {
    const LINE_LIFT = 30;
    const linePts = frontPts.map(p => ({ x: p.x, y: Math.max(20, p.y - LINE_LIFT) }));

    // Linja tegnes som ett segment per delstrekning, hver farget etter
    // hvor billig/dyr akkurat den biten er energimessig.
    for (let i = 1; i < linePts.length; i++) {
      const segKm = profile[i].distKm - profile[i - 1].distKm;
      const grade = segKm > 0 ? (profile[i].elevation - profile[i - 1].elevation) / (segKm * 1000) : 0;

      const seg = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      seg.setAttribute('x1', String(linePts[i - 1].x));
      seg.setAttribute('y1', String(linePts[i - 1].y));
      seg.setAttribute('x2', String(linePts[i].x));
      seg.setAttribute('y2', String(linePts[i].y));
      seg.setAttribute('stroke', energyLineColor(grade));
      seg.setAttribute('stroke-width', '3');
      seg.setAttribute('stroke-linecap', 'round');
      svg.appendChild(seg);
    }

    // Prikk som følger musepekeren langs linja og viser akkurat tid/energi
    // for punktet der pekeren faktisk treffer — interpolert mellom de to
    // nærmeste rutepunktene, ikke bare verdien ved enden av segmentet.
    const hoverIndicator = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hoverIndicator.setAttribute('r', '10');
    hoverIndicator.setAttribute('fill', LOYPE_LINE_COLOR);
    hoverIndicator.setAttribute('stroke', '#fff');
    hoverIndicator.setAttribute('stroke-width', '2');
    hoverIndicator.setAttribute('display', 'none');
    svg.appendChild(hoverIndicator);

    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    hitPath.setAttribute('points', linePts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    hitPath.setAttribute('fill', 'none');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', '20');
    svg.appendChild(hitPath);

    hitPath.addEventListener('mousemove', e => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
      const x = Math.min(Math.max(svgP.x, linePts[0].x), linePts[linePts.length - 1].x);

      let i = 1;
      while (i < linePts.length - 1 && linePts[i].x < x) i++;
      const x0 = linePts[i - 1].x, x1 = linePts[i].x;
      const frac = x1 > x0 ? (x - x0) / (x1 - x0) : 0;

      const segKm = profile[i].distKm - profile[i - 1].distKm;
      const grade = segKm > 0 ? (profile[i].elevation - profile[i - 1].elevation) / (segKm * 1000) : 0;
      hoverIndicator.setAttribute('fill', energyLineColor(grade));

      const distKm = profile[i - 1].distKm + frac * (profile[i].distKm - profile[i - 1].distKm);
      const seconds = cumSeconds[i - 1] + frac * (cumSeconds[i] - cumSeconds[i - 1]);
      let text = `${distKm.toFixed(2)} km · ${formatDuration(seconds)}`;
      if (cumKcal) {
        const kcal = cumKcal[i - 1] + frac * (cumKcal[i] - cumKcal[i - 1]);
        text += ` · ${Math.round(kcal * 4.184)} kJ / ${Math.round(kcal)} kcal`;
      }
      showDetailTooltip(text, e);

      const y = linePts[i - 1].y + frac * (linePts[i].y - linePts[i - 1].y);
      hoverIndicator.setAttribute('cx', String(x));
      hoverIndicator.setAttribute('cy', String(y));
      hoverIndicator.setAttribute('display', 'inline');
    });

    hitPath.addEventListener('mouseleave', () => {
      hideDetailTooltip();
      hoverIndicator.setAttribute('display', 'none');
    });

    let peakIndex = 0;
    for (let i = 1; i < profile.length; i++) {
      if (profile[i].elevation > profile[peakIndex].elevation) peakIndex = i;
    }
    const keyIndexes = [...new Set([0, peakIndex, profile.length - 1])];

    keyIndexes.forEach(i => {
      const x = linePts[i].x;

      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('y1', String(linePts[i].y));
      tick.setAttribute('x2', String(x));
      tick.setAttribute('y2', String(frontPts[i].y));
      tick.setAttribute('stroke', '#999');
      tick.setAttribute('stroke-width', '1');
      tick.setAttribute('stroke-dasharray', '3,3');
      svg.appendChild(tick);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(Math.min(Math.max(x, plotLeft + 20), plotRight - 20)));
      label.setAttribute('y', String(linePts[i].y - 8));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '11');
      label.setAttribute('font-weight', '600');
      label.setAttribute('fill', '#5f6368');
      label.textContent = formatDuration(cumSeconds[i]);
      svg.appendChild(label);
    });
  }

  // --- Høyderuler til høyre ---
  const rulerTick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  rulerTick.setAttribute('x1', String(rulerX));
  rulerTick.setAttribute('y1', String(plotTop));
  rulerTick.setAttribute('x2', String(rulerX));
  rulerTick.setAttribute('y2', String(plotBottom));
  rulerTick.setAttribute('stroke', '#999');
  svg.appendChild(rulerTick);

  for (let value = niceBounds.min; value <= niceBounds.max + 0.001; value += niceBounds.step) {
    const y = yFor(value);
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', String(rulerX));
    tick.setAttribute('y1', String(y));
    tick.setAttribute('x2', String(rulerX + 6));
    tick.setAttribute('y2', String(y));
    tick.setAttribute('stroke', '#999');
    svg.appendChild(tick);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(rulerX + 10));
    label.setAttribute('y', String(y + 3));
    label.setAttribute('text-anchor', 'start');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#5f6368');
    label.textContent = `${Math.round(value)} m`;
    svg.appendChild(label);
  }

  // --- Distansemerker under grunnlinja ---
  const xStepKm = totalKm > 5 ? 1 : (totalKm > 1 ? 0.5 : 0.1);
  for (let d = 0; d <= totalKm + 0.001; d += xStepKm) {
    const x = xFor(d);
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', String(x));
    tick.setAttribute('y1', String(plotBottom));
    tick.setAttribute('x2', String(x));
    tick.setAttribute('y2', String(plotBottom + 6));
    tick.setAttribute('stroke', '#ccc');
    svg.appendChild(tick);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(plotBottom + 20));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#5f6368');
    label.textContent = `${d.toFixed(d < 1 ? 1 : 0)} km`;
    svg.appendChild(label);
  }

  svg.dataset.plotLeft = String(plotLeft);
  svg.dataset.plotRight = String(plotRight);
  svg.dataset.plotTop = String(plotTop);
  svg.dataset.plotBottom = String(plotBottom);
  svg.dataset.totalKm = String(totalKm);
  svg.dataset.min = String(min);
  svg.dataset.range = String(range);
}

function addDetailLabel(profile, point, name) {
  const svg = document.getElementById('loype-detail-chart');
  if (!svg) return;
  const plotLeft = Number(svg.dataset.plotLeft);
  const plotRight = Number(svg.dataset.plotRight);
  const plotTop = Number(svg.dataset.plotTop);
  const plotBottom = Number(svg.dataset.plotBottom);
  const totalKm = Number(svg.dataset.totalKm);
  const min = Number(svg.dataset.min);
  const range = Number(svg.dataset.range);

  const x = plotLeft + (totalKm > 0 ? (point.distKm / totalKm) : 0) * (plotRight - plotLeft);
  const y = plotTop + (1 - (point.elevation - min) / range) * (plotBottom - plotTop);
  const xClamped = Math.min(Math.max(x, plotLeft + 5), plotRight - 5);

  // Stiplet linje fra grunnlinja opp til punktet, som i Tour de
  // France-profiler.
  const connector = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  connector.setAttribute('x1', String(xClamped));
  connector.setAttribute('y1', String(plotBottom));
  connector.setAttribute('x2', String(xClamped));
  connector.setAttribute('y2', String(y));
  connector.setAttribute('stroke', '#666');
  connector.setAttribute('stroke-width', '1');
  connector.setAttribute('stroke-dasharray', '3,3');
  svg.appendChild(connector);

  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', String(xClamped));
  dot.setAttribute('cy', String(y));
  dot.setAttribute('r', '4');
  dot.setAttribute('fill', LOYPE_LINE_COLOR);
  dot.setAttribute('stroke', '#fff');
  dot.setAttribute('stroke-width', '2');
  svg.appendChild(dot);

  // Vertikal tekst som vokser oppover fra grunnlinja, like til venstre for
  // den stiplede linja — samme plassering som stedsnavnene i TdF-profiler.
  const labelX = xClamped - 8;
  const labelY = plotBottom - 4;
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', String(labelX));
  label.setAttribute('y', String(labelY));
  label.setAttribute('text-anchor', 'start');
  label.setAttribute('font-size', '12');
  label.setAttribute('font-weight', '600');
  label.setAttribute('fill', '#1a1a2e');
  label.setAttribute('stroke', '#fff');
  label.setAttribute('stroke-width', '3');
  label.setAttribute('paint-order', 'stroke');
  label.setAttribute('transform', `rotate(-90 ${labelX} ${labelY})`);
  label.textContent = `${name} · ${point.distKm.toFixed(1)} km · ${Math.round(point.elevation)} m`;
  svg.appendChild(label);
}

function applyPlaceLabels(profile, names) {
  addDetailLabel(profile, profile[0], names.startName || 'Start');
  addDetailLabel(profile, profile[profile.length - 1], names.endName || 'Slutt');
  if (names.peakIndex !== 0 && names.peakIndex !== profile.length - 1) {
    addDetailLabel(profile, profile[names.peakIndex], names.peakName || 'Høyeste punkt');
  }
}

async function loadPlaceLabels(profile) {
  const start = profile[0];
  const end = profile[profile.length - 1];
  let peakIndex = 0;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i].elevation > profile[peakIndex].elevation) peakIndex = i;
  }
  const peak = profile[peakIndex];

  const [startName, endName, peakName] = await Promise.all([
    fetchPlaceName(start.lat, start.lng),
    fetchPlaceName(end.lat, end.lng),
    peakIndex !== 0 && peakIndex !== profile.length - 1 ? fetchPlaceName(peak.lat, peak.lng) : Promise.resolve(null),
  ]);

  if (!document.getElementById('loype-detail-chart')) return; // modal lukket i mellomtiden

  cachedPlaceNames = { startName, endName, peakName, peakIndex };
  applyPlaceLabels(profile, cachedPlaceNames);
}

function initRouteDetailView() {
  document.getElementById('loype-elevation-chart').addEventListener('click', openRouteDetailView);
}

document.addEventListener('DOMContentLoaded', initRouteDetailView);
