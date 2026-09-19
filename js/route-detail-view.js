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

// Dybde-forskyvning for den ekstruderte 3D-følelsen: toppflaten (veien) og
// endeflaten flyttes dette mange enheter opp/høyre relativt til frontflaten.
const DEPTH_DX = 50;
const DEPTH_DY = -22;

function depthOffset(pt) {
  return { x: pt.x + DEPTH_DX, y: pt.y + DEPTH_DY };
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

let detailModal = null;

function openRouteDetailView() {
  const profile = buildDistanceProfile();
  if (profile.length < 2) return;

  buildDetailModalSkeleton();
  renderDetailSummary(profile);
  renderDetailChart(profile);
  loadPlaceLabels(profile);
}

function closeRouteDetailView() {
  if (detailModal) {
    detailModal.remove();
    detailModal = null;
  }
}

function buildDetailModalSkeleton() {
  if (detailModal) detailModal.remove();
  detailModal = document.createElement('div');
  detailModal.id = 'loype-detail-modal';
  detailModal.innerHTML = `
    <div id="loype-detail-backdrop"></div>
    <div id="loype-detail-panel">
      <button id="loype-detail-close" aria-label="Lukk">&times;</button>
      <div id="loype-detail-summary"></div>
      <svg id="loype-detail-chart" viewBox="0 0 1100 380" preserveAspectRatio="xMidYMid meet" role="img"></svg>
    </div>
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
  let timeText = '';
  if (paceSecPerKm) {
    const mirror = document.getElementById('loype-mirror-checkbox').checked;
    let seconds = segmentTimeSeconds(paceSecPerKm, false);
    if (mirror) seconds += segmentTimeSeconds(paceSecPerKm, true);
    timeText = ` · Estimert tid: ${formatDuration(seconds)}`;
  }

  document.getElementById('loype-detail-summary').textContent =
    `${totalKm.toFixed(2)} km · ${Math.round(gain)} m stigning${timeText}`;
}

function renderDetailChart(profile) {
  const svg = document.getElementById('loype-detail-chart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const width = 1100, height = 380;
  const plotLeft = 30, plotRight = width - 150, plotTop = 60, plotBottom = height - 90;
  const baseHeight = 22;
  const rulerX = plotRight + DEPTH_DX + 25;

  const totalKm = profile[profile.length - 1].distKm;
  const elevations = profile.map(p => p.elevation);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const range = Math.max(max - min, 1);

  const xFor = distKm => plotLeft + (totalKm > 0 ? (distKm / totalKm) : 0) * (plotRight - plotLeft);
  const yFor = elevation => plotTop + (1 - (elevation - min) / range) * (plotBottom - plotTop);

  const poly = (points, fill) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    el.setAttribute('points', points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    el.setAttribute('fill', fill);
    svg.appendChild(el);
    return el;
  };

  // --- Svart 3D-sokkel bakken står på ---
  const baseFTL = { x: plotLeft, y: plotBottom };
  const baseFTR = { x: plotRight, y: plotBottom };
  const baseFBL = { x: plotLeft, y: plotBottom + baseHeight };
  const baseFBR = { x: plotRight, y: plotBottom + baseHeight };
  const baseBTL = depthOffset(baseFTL);
  const baseBTR = depthOffset(baseFTR);
  const baseBBR = depthOffset(baseFBR);

  poly([baseFTL, baseFTR, baseBTR, baseBTL], '#3a3a3a'); // toppflate
  poly([baseFTL, baseFTR, baseFBR, baseFBL], '#1f1f1f'); // frontflate
  poly([baseFTR, baseFBR, baseBBR, baseBTR], '#111');    // endeflate

  // --- Terreng: frontflate per delstrekning ---
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

  // --- Terreng: toppflate (veien du løper på) per delstrekning ---
  const backPts = frontPts.map(depthOffset);
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    const segKm = b.distKm - a.distKm;
    const grade = segKm > 0 ? Math.max(0, (b.elevation - a.elevation) / (segKm * 1000)) : 0;
    const bucket = GRADE_BUCKETS[gradeBucketIndex(grade)];
    poly([frontPts[i - 1], frontPts[i], backPts[i], backPts[i - 1]], bucket.light);
  }

  // --- Terreng: endeflate helt til høyre, lukker den ekstruderte formen ---
  const lastFront = frontPts[frontPts.length - 1];
  const lastBase = { x: lastFront.x, y: plotBottom };
  const lastBackFront = depthOffset(lastFront);
  const lastBackBase = depthOffset(lastBase);
  const lastGrade = profile.length > 1
    ? Math.max(0, (profile[profile.length - 1].elevation - profile[profile.length - 2].elevation) /
        Math.max((profile[profile.length - 1].distKm - profile[profile.length - 2].distKm) * 1000, 0.001))
    : 0;
  poly([lastBase, lastFront, lastBackFront, lastBackBase], GRADE_BUCKETS[gradeBucketIndex(lastGrade)].dark);

  // --- Prikk for hvert punkt du faktisk klikket, langs ridgen ---
  frontPts.forEach(p => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(p.x));
    dot.setAttribute('cy', String(p.y));
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', LOYPE_LINE_COLOR);
    dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', '2');
    svg.appendChild(dot);
  });

  // --- Høyderuler til høyre ---
  const rulerTick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  rulerTick.setAttribute('x1', String(rulerX));
  rulerTick.setAttribute('y1', String(plotTop));
  rulerTick.setAttribute('x2', String(rulerX));
  rulerTick.setAttribute('y2', String(plotBottom));
  rulerTick.setAttribute('stroke', '#999');
  svg.appendChild(rulerTick);

  const yTickCount = 4;
  for (let i = 0; i <= yTickCount; i++) {
    const value = min + (range * i) / yTickCount;
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

  // --- Distansemerker på den svarte sokkelen ---
  const xStepKm = totalKm > 5 ? 1 : (totalKm > 1 ? 0.5 : 0.1);
  for (let d = 0; d <= totalKm + 0.001; d += xStepKm) {
    const x = xFor(d);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(plotBottom + baseHeight - 6));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#fff');
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

async function loadPlaceLabels(profile) {
  const start = profile[0];
  const end = profile[profile.length - 1];
  const peak = profile.reduce((a, b) => (b.elevation > a.elevation ? b : a));

  const [startName, endName, peakName] = await Promise.all([
    fetchPlaceName(start.lat, start.lng),
    fetchPlaceName(end.lat, end.lng),
    peak !== start && peak !== end ? fetchPlaceName(peak.lat, peak.lng) : Promise.resolve(null),
  ]);

  if (!document.getElementById('loype-detail-chart')) return; // modal lukket i mellomtiden

  addDetailLabel(profile, start, startName || 'Start');
  addDetailLabel(profile, end, endName || 'Slutt');
  if (peak !== start && peak !== end) {
    addDetailLabel(profile, peak, peakName || 'Høyeste punkt');
  }
}

function initRouteDetailView() {
  document.getElementById('loype-elevation-chart').addEventListener('click', openRouteDetailView);
}

document.addEventListener('DOMContentLoaded', initRouteDetailView);
