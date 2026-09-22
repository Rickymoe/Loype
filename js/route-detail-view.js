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

// Bygger en avstandsbasert profil (km langs ruten, ikke punktindeks),
// inkludert returbenet hvis "Speil retur" er huket av. Tar med ALLE punkter
// uansett om høyden er kjent ennå — punkter uten høyde ble tidligere
// utelatt helt, noe som både kuttet distansen kunstig kort (haltet et
// uinnlastet halepunkt) og gjorde at hele detaljvisningen nektet å åpne seg
// når ingen høyder var kjent (se profileHasElevation for hva grafen bruker).
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
    profile.push({ distKm: cum, elevation: routeElevations[i], lat: routePoints[i].lat, lng: routePoints[i].lng });
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

  // Aldri under 0 — høydemodellen kan gi svak negativ "støy" over vann, og
  // en akse som går under bakkenivå leser som en feil, ikke som data.
  const niceMin = Math.max(0, Math.floor(min / step) * step);
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

// Sykkel-varianten av buildCumulativeTimeProfile: fysikkbasert kraft/fart-
// løsning per delstrekning i stedet for grad-faktor (se route-recorder.js).
function buildCumulativeBikeProfile(profile, paceSecPerKm, weightKg) {
  const vFlat = 1000 / paceSecPerKm;
  const mass = weightKg + BIKE_MASS_KG;
  const pFlat = mass * GRAVITY * BIKE_CRR * vFlat + 0.5 * BIKE_CDA * BIKE_AIR_DENSITY * vFlat ** 3;

  const cumSeconds = [0];
  for (let i = 1; i < profile.length; i++) {
    const segKm = profile[i].distKm - profile[i - 1].distKm;
    if (segKm <= 0) {
      cumSeconds.push(cumSeconds[i - 1]);
      continue;
    }

    const grade = (profile[i].elevation - profile[i - 1].elevation) / (segKm * 1000);
    const power = grade >= 0
      ? pFlat
      : pFlat * Math.max(0, 1 - Math.abs(grade) / BIKE_DOWNHILL_REST_GRADE);

    const v = solveBikeSpeedMs(power, grade, mass);
    const segSeconds = (segKm * 1000) / v;

    cumSeconds.push(cumSeconds[i - 1] + segSeconds);
  }
  return cumSeconds;
}

let detailModal = null;
let currentProfile = null;
let cachedPlaceNames = null;

// Grafen (terrenget, høyderuleren, tidsaksen, stedsnavn-etikettene) trenger
// en kjent høyde på hvert eneste punkt — delvise data ville gitt NaN midt i
// tegningen. Resten av panelet (distanse, estimert tid/energi, vær, tørreste
// vindu, væsketap, AI-spørring) er derimot uavhengig av høyde og skal vises
// uansett.
function profileHasElevation(profile) {
  return profile.length > 0 && profile.every(p => p.elevation !== undefined);
}

function updateDetailElevationSection(profile) {
  const hasElevation = profileHasElevation(profile);
  // Både #loype-detail-legend og #loype-detail-chart har egne display-regler
  // (id-selektor, evt. en senere .klasse-regel for legend) som slår
  // .hidden i kaskaden — inline style er det som faktisk vinner over dem.
  document.getElementById('loype-detail-legend').style.display = hasElevation ? '' : 'none';
  document.getElementById('loype-detail-chart').style.display = hasElevation ? '' : 'none';
  document.getElementById('loype-detail-no-elevation').classList.toggle('hidden', hasElevation);
  if (hasElevation) {
    renderDetailChart(profile);
    loadPlaceLabels(profile);
  }
}

function openRouteDetailView() {
  if (routePoints.length < 2) return;
  const profile = buildDistanceProfile();
  currentProfile = profile;
  cachedPlaceNames = null;
  lastFocusedBeforeModal = document.activeElement;

  buildDetailModalSkeleton();
  initDetailPaceButtons();
  initDetailWhenButton();
  document.getElementById('loype-detail-ask-ai-btn').addEventListener('click', askAiAboutRoute);
  document.getElementById('loype-detail-copy-ai-btn').addEventListener('click', copyAiQuery);
  setupModalKeyboardHandling();
  setupDetailResizeHandling();
  refreshDetailWeather();
  refreshRainWindowIfApplicable();
  renderDetailSummary(profile);
  updateDetailElevationSection(profile);
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

  // Datofeltet ligger usynlig oppå knappen. På mus/desktop har det
  // pointer-events:none (se CSS): et nativt datofelt har egne interne
  // dag/måned/år-treffsoner som ikke dekker hele en oppskalert boks, så
  // knappen mottar klikket og kaller showPicker() selv. På touch
  // (pointer:coarse) mottar feltet tappet direkte — iOS Safari åpner ikke
  // dato-hjulet fra et felt uten pointer-events, og da når aldri tappet
  // denne handleren fordi feltet ligger oppå knappen.
  btn.addEventListener('click', () => {
    if (dateInput.showPicker) dateInput.showPicker();
    else dateInput.focus();
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
    const btn = document.getElementById(id);
    const active = mode === paceMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function refreshDetailView() {
  if (!currentProfile) return;
  renderDetailSummary(currentProfile);
  if (profileHasElevation(currentProfile)) {
    renderDetailChart(currentProfile);
    if (cachedPlaceNames) {
      applyPlaceLabels(currentProfile, cachedPlaceNames);
    } else {
      loadPlaceLabels(currentProfile);
    }
  }
  refreshRainWindowIfApplicable();
  refreshHydrationIfApplicable();
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

let lastFocusedBeforeModal = null;
let modalKeydownHandler = null;

function closeRouteDetailView() {
  if (detailModal) {
    detailModal.remove();
    detailModal = null;
  }
  currentProfile = null;
  cachedPlaceNames = null;

  if (modalKeydownHandler) {
    document.removeEventListener('keydown', modalKeydownHandler);
    modalKeydownHandler = null;
  }
  if (detailResizeHandler) {
    window.removeEventListener('resize', detailResizeHandler);
    detailResizeHandler = null;
  }
  // Fokus tilbake dit brukeren kom fra (grafen) i stedet for å forsvinne
  // til toppen av siden når modalen fjernes fra DOM-en.
  if (lastFocusedBeforeModal) {
    lastFocusedBeforeModal.focus();
    lastFocusedBeforeModal = null;
  }
}

// Escape lukker modalen, og Tab/Shift+Tab holdes inni den (fokusfelle) i
// stedet for å lekke ut til elementer bak i hovedpanelet — modalen hadde
// ingen av delene fra før.
function setupModalKeyboardHandling() {
  const panel = document.getElementById('loype-detail-panel');
  document.getElementById('loype-detail-close').focus();

  modalKeydownHandler = e => {
    if (e.key === 'Escape') {
      closeRouteDetailView();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = Array.from(
      panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]')
    ).filter(el => el.tabIndex !== -1 && !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', modalKeydownHandler);
}

function buildDetailModalSkeleton() {
  if (detailModal) detailModal.remove();
  detailModal = document.createElement('div');
  detailModal.id = 'loype-detail-modal';
  detailModal.innerHTML = `
    <div id="loype-detail-backdrop"></div>
    <div id="loype-detail-panel" role="dialog" aria-modal="true" aria-label="Rutedetaljer" tabindex="-1">
      <button id="loype-detail-close" aria-label="Lukk">&times;</button>
      <div class="loype-detail-header">
        <div id="loype-detail-summary"></div>
        <div class="loype-detail-controls">
          <div class="loype-detail-when">
            <button type="button" id="loype-detail-when-btn" class="loype-pace-mode-btn loype-when-btn">Nå</button>
            <input type="date" id="loype-detail-date-input" tabindex="-1" />
          </div>
          <div class="loype-pace-mode loype-detail-pace-mode" role="group" aria-label="Aktivitet">
            <button type="button" id="loype-detail-pace-walk-btn" class="loype-pace-mode-btn">Gå</button>
            <button type="button" id="loype-detail-pace-run-btn" class="loype-pace-mode-btn">Løp</button>
            <button type="button" id="loype-detail-pace-bike-btn" class="loype-pace-mode-btn">Sykkel</button>
          </div>
        </div>
      </div>
      <div id="loype-detail-weather" class="loype-detail-weather hidden" aria-live="polite"></div>
      <div id="loype-detail-rain-window" class="loype-detail-rain-window hidden" aria-live="polite"></div>
      <div id="loype-detail-hydration" class="loype-detail-hydration hidden" aria-live="polite"></div>
      <div class="loype-detail-ai-row">
        <button id="loype-detail-ask-ai-btn" class="loype-btn loype-btn-primary">🤖 Spør ChatGPT</button>
        <button id="loype-detail-copy-ai-btn" class="loype-btn loype-copy-btn" aria-label="Kopier spørring" title="Kopier for å lime inn i f.eks. Claude.ai">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <div id="loype-detail-legend" class="loype-detail-legend">
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#43a047"></span>Nedover</span>
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#ffb300"></span>Flatt</span>
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#ff7043"></span>Bratt</span>
        <span class="loype-legend-item"><span class="loype-legend-swatch" style="background:#e53935"></span>Svært bratt</span>
      </div>
      <div id="loype-detail-no-elevation" class="loype-detail-no-elevation hidden">Høydedata er ikke tilgjengelig for denne ruten akkurat nå. Resten av oversikten er upåvirket.</div>
      <svg id="loype-detail-chart" viewBox="0 0 1100 420" preserveAspectRatio="xMidYMid meet" role="img"></svg>
    </div>
  `;
  document.body.appendChild(detailModal);
  document.getElementById('loype-detail-close').addEventListener('click', closeRouteDetailView);
  document.getElementById('loype-detail-backdrop').addEventListener('click', closeRouteDetailView);
}

function renderDetailSummary(profile) {
  const totalKm = profile[profile.length - 1].distKm;
  const hasElevation = profileHasElevation(profile);
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
    energyText = ` · Energi: ${formatNo(kcal * 4.184)} kJ / ${formatNo(kcal)} kcal`;
  }

  const gainText = hasElevation ? ` · ${formatNo(gain)} m stigning` : '';
  document.getElementById('loype-detail-summary').textContent =
    `${formatNo(totalKm, 2)} km${gainText}${timeText}${energyText}`;
}

function isCompactChart(svg) {
  return svg.clientWidth > 0 && svg.clientWidth < 560;
}

// Grafen skaleres i bred modus, men tegnes i faktisk bredde i enkel modus,
// så den må tegnes på nytt når bredden endres der (rotasjon) eller når
// grensen mellom modusene krysses. Vær og stedsnavn hentes ikke på nytt.
let detailResizeHandler = null;
function redrawDetailChart() {
  if (!currentProfile || !document.getElementById('loype-detail-chart')) return;
  if (!profileHasElevation(currentProfile)) return;
  renderDetailChart(currentProfile);
  if (cachedPlaceNames) applyPlaceLabels(currentProfile, cachedPlaceNames);
}

function setupDetailResizeHandling() {
  const svg = document.getElementById('loype-detail-chart');
  const stateKey = () => (isCompactChart(svg) ? `c${Math.round(svg.clientWidth)}` : 'wide');
  let lastKey = stateKey();
  detailResizeHandler = () => {
    const key = stateKey();
    if (key === lastKey) return;
    lastKey = key;
    redrawDetailChart();
  };
  window.addEventListener('resize', detailResizeHandler);
}

function renderDetailChart(profile) {
  const svg = document.getElementById('loype-detail-chart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.labelBoxes = [];

  // På smale skjermer (mobil) tegnes en enklere graf i faktisk pikselbredde
  // i stedet for å skalere ned 1100 enheter (tekst ble ca. 4 px): kun terreng,
  // få km-merker og en toppverdi, uten tidsakse og høyderuler.
  const compact = isCompactChart(svg);
  const width = compact ? Math.round(svg.clientWidth) : 1100;
  const height = compact ? 250 : 420;
  const plotLeft = compact ? 12 : 30;
  const plotRight = compact ? width - 12 : width - 150;
  const plotTop = compact ? 26 : 104;
  const plotBottom = height - 56;
  const rulerX = plotRight + 25;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  const weightKg = parseFloat(loadProfile().weight);

  let cumSeconds = null;
  if (paceMode === 'bike') {
    if (paceSecPerKm && weightKg) {
      cumSeconds = buildCumulativeBikeProfile(profile, paceSecPerKm, weightKg);
    }
  } else {
    cumSeconds = paceSecPerKm ? buildCumulativeTimeProfile(profile, paceSecPerKm) : null;
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

  // --- Høyderuler til høyre (bred modus) ---
  if (!compact) {
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
      label.textContent = `${formatNo(value)} m`;
      svg.appendChild(label);
    }
  } else {
    // Enkel modus: topp og bunn av skalaen (ikke hvert trinn som i bred
    // modus — får ikke plass), som stiplet linje med verdi. Grunnlinja er
    // allerede tegnet over (samme linje som bunnverdien gjelder for).
    const topLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    topLine.setAttribute('x1', String(plotLeft));
    topLine.setAttribute('y1', String(plotTop));
    topLine.setAttribute('x2', String(plotRight));
    topLine.setAttribute('y2', String(plotTop));
    topLine.setAttribute('stroke', '#ccc');
    topLine.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(topLine);

    const topLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    topLabel.setAttribute('x', String(plotLeft));
    topLabel.setAttribute('y', String(plotTop - 6));
    topLabel.setAttribute('text-anchor', 'start');
    topLabel.setAttribute('font-size', '11');
    topLabel.setAttribute('fill', '#5f6368');
    topLabel.textContent = `${formatNo(niceBounds.max)} m`;
    svg.appendChild(topLabel);

    if (niceBounds.min !== niceBounds.max) {
      // Bunnlinja ligger alltid inntil terrengflaten (fylt helt til
      // plotBottom uansett fargesone), så etiketten trenger en hvit glorie
      // for å holde seg lesbar uansett hvilken helningsfarge den lander på —
      // toppen trenger det sjeldnere (mest tomrom der), men får samme
      // behandling for konsekvens.
      const bottomLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      bottomLabel.setAttribute('x', String(plotRight));
      bottomLabel.setAttribute('y', String(plotBottom - 6));
      bottomLabel.setAttribute('text-anchor', 'end');
      bottomLabel.setAttribute('font-size', '11');
      bottomLabel.setAttribute('fill', '#5f6368');
      bottomLabel.setAttribute('stroke', '#fff');
      bottomLabel.setAttribute('stroke-width', '3');
      bottomLabel.setAttribute('paint-order', 'stroke');
      bottomLabel.textContent = `${formatNo(niceBounds.min)} m`;
      svg.appendChild(bottomLabel);
    }
  }

  // --- Distansemerker under grunnlinja ---
  const xStepKm = compact
    ? ([0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50].find(st => totalKm / st <= 4) || 100)
    : (totalKm > 5 ? 1 : (totalKm > 1 ? 0.5 : 0.1));
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
    // Enkel modus har smal marg: første og siste merke kantjusteres.
    label.setAttribute('text-anchor',
      compact && x <= plotLeft + 1 ? 'start' : (compact && x >= plotRight - 22 ? 'end' : 'middle'));
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#5f6368');
    label.textContent = `${formatNo(d, Math.abs(d - Math.round(d)) < 0.001 ? 0 : 1)} km`;
    svg.appendChild(label);
  }

  // --- Tidsakse øverst, parallelt med distanseaksen. Tid og avstand henger
  // ikke lineært sammen (bakker koster tid), så hvert tidsmerke settes der
  // ruten faktisk når den tiden — ved å invertere den kumulative tiden. ---
  if (cumSeconds && !compact) {
    const axisY = 34;
    const totalMin = cumSeconds[cumSeconds.length - 1] / 60;
    const stepMin = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240].find(st => totalMin / st <= 8) || 240;
    const timeLabel = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}t${m % 60 ? ` ${m % 60}` : ''}`);
    const distAtSeconds = t => {
      let i = 1;
      while (i < cumSeconds.length - 1 && cumSeconds[i] < t) i++;
      const span = cumSeconds[i] - cumSeconds[i - 1];
      const frac = span > 0 ? Math.min(1, Math.max(0, (t - cumSeconds[i - 1]) / span)) : 0;
      return profile[i - 1].distKm + frac * (profile[i].distKm - profile[i - 1].distKm);
    };

    const axisLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    axisLine.setAttribute('x1', String(plotLeft));
    axisLine.setAttribute('y1', String(axisY));
    axisLine.setAttribute('x2', String(plotRight));
    axisLine.setAttribute('y2', String(axisY));
    axisLine.setAttribute('stroke', '#ccc');
    svg.appendChild(axisLine);

    for (let m = 0; m <= totalMin + 0.001; m += stepMin) {
      const x = xFor(distAtSeconds(m * 60));
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('y1', String(axisY));
      tick.setAttribute('x2', String(x));
      tick.setAttribute('y2', String(axisY - 6));
      tick.setAttribute('stroke', '#ccc');
      svg.appendChild(tick);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(x));
      label.setAttribute('y', String(axisY - 12));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '11');
      label.setAttribute('fill', '#5f6368');
      label.textContent = timeLabel(m);
      svg.appendChild(label);
    }
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

  // Navnet står i en rad under km-aksen, koblet til punktet med samme
  // prikk som på terrenget. Teksten legges på den siden av prikken som er
  // mest naturlig (mot midten av grafen) og byttes til den andre siden hvis
  // den kolliderer med et navn som allerede står der. Får den ikke plass
  // noen av stedene, utelates navnet; prikken og linja står fortsatt.
  const rowY = plotBottom + 42;
  const chartWidth = Number(svg.viewBox.baseVal.width);
  const text = `${name} · ${formatNo(point.elevation)} m`;

  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('y', String(rowY));
  label.setAttribute('font-size', '12');
  label.setAttribute('font-weight', '600');
  label.setAttribute('fill', '#1a1a2e');
  label.textContent = text;
  svg.appendChild(label);
  const textWidth = label.getComputedTextLength();

  const GAP = 8, PAD = 10;
  const preferRight = xClamped <= (plotLeft + plotRight) / 2;
  const boxFor = side => (side === 'start'
    ? { left: xClamped - 4, right: xClamped + GAP + textWidth }
    : { left: xClamped - GAP - textWidth, right: xClamped + 4 });
  const fits = box => box.left >= 4 && box.right <= chartWidth - 4
    && svg.labelBoxes.every(o => box.right + PAD <= o.left || box.left - PAD >= o.right);

  const side = (preferRight ? ['start', 'end'] : ['end', 'start']).find(sd => fits(boxFor(sd)));
  if (!side) {
    label.remove();
    return;
  }
  svg.labelBoxes.push(boxFor(side));

  label.setAttribute('text-anchor', side);
  label.setAttribute('x', String(side === 'start' ? xClamped + GAP : xClamped - GAP));

  const pin = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pin.setAttribute('cx', String(xClamped));
  pin.setAttribute('cy', String(rowY - 4));
  pin.setAttribute('r', '4');
  pin.setAttribute('fill', LOYPE_LINE_COLOR);
  pin.setAttribute('stroke', '#fff');
  pin.setAttribute('stroke-width', '2');
  svg.appendChild(pin);
}

// Er toppunktet for nær start eller slutt langs x-aksen, overlapper navnene
// hverandre. I så fall dropper vi topp-etiketten (start/slutt vinner).
function applyPlaceLabels(profile, names) {
  addDetailLabel(profile, profile[0], names.startName || 'Start');
  addDetailLabel(profile, profile[profile.length - 1], names.endName || 'Slutt');

  if (names.peakIndex !== 0 && names.peakIndex !== profile.length - 1) {
    const totalKm = profile[profile.length - 1].distKm;
    const minGapKm = Math.max(totalKm * 0.06, 0.05);
    const peakDistKm = profile[names.peakIndex].distKm;
    const farFromStart = peakDistKm - profile[0].distKm >= minGapKm;
    const farFromEnd = totalKm - peakDistKm >= minGapKm;
    if (farFromStart && farFromEnd) {
      addDetailLabel(profile, profile[names.peakIndex], names.peakName || 'Høyeste punkt');
    }
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
  const chart = document.getElementById('loype-elevation-chart');
  chart.addEventListener('click', openRouteDetailView);
  // Grafen er eneste inngang til detaljvisningen, men hadde ingen
  // tabindex — tastaturbrukere hoppet rett forbi den uansett hvor mange
  // ganger de trykket Tab. Enter/mellomrom er standard aktivering for
  // role="button".
  chart.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRouteDetailView();
    }
  });
}

document.addEventListener('DOMContentLoaded', initRouteDetailView);
