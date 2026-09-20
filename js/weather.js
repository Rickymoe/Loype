// Samme MET Norway-endepunkt (Locationforecast) som allerede er bevist i
// Globus-prosjektet (js/yr-weather.js). Ingen egen User-Agent-header settes
// her — det viste seg ved nærmere sjekk at det kan utløse en CORS-preflight
// som MET sitt enkle GET-endepunkt ikke nødvendigvis håndterer, så vi holder
// oss til det som er bevist å fungere.
const YR_LOCATIONFORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

const WEATHER_SYMBOL_EMOJI = {
  clearsky: '☀️', fair: '🌤', partlycloudy: '⛅', cloudy: '☁️',
  fog: '🌫', lightrainshowers: '🌦', rainshowers: '🌦', heavyrainshowers: '🌧',
  lightrain: '🌦', rain: '🌧', heavyrain: '🌧',
  lightsleet: '🌨', sleet: '🌨', heavysleet: '🌨',
  lightsnow: '❄️', snow: '❄️', heavysnow: '❄️', snowshowers: '🌨',
  thunder: '⛈', rainandthunder: '⛈', snowandthunder: '⛈',
};

function weatherSymbolEmoji(code) {
  if (!code) return '🌡';
  const base = code.replace(/_(day|night|polartwilight)$/, '');
  for (const [k, v] of Object.entries(WEATHER_SYMBOL_EMOJI)) {
    if (base === k || base.startsWith(k)) return v;
  }
  return '🌡';
}

function weatherWindDir(deg) {
  return ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'][Math.round(deg / 45) % 8];
}

// Uten et valgt klokkeslett bruker vi: "i dag" → værsituasjonen akkurat nå
// (som Globus), en fremtidig dato → kl. 12 lokal tid som representativt
// punkt, inntil vi ev. legger til time-for-time senere.
async function fetchWeatherForPoint(lat, lng, isoDate) {
  const resp = await fetch(`${YR_LOCATIONFORECAST_URL}?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const series = data.properties.timeseries;

  const todayIso = toIsoDateLocal(new Date());
  let entry;
  if (isoDate === todayIso) {
    entry = series[0];
  } else {
    const target = new Date(`${isoDate}T12:00:00`);
    entry = series.reduce((closest, ts) => (
      Math.abs(new Date(ts.time) - target) < Math.abs(new Date(closest.time) - target) ? ts : closest
    ), series[0]);
  }

  const inst = entry.data.instant.details;
  const next = entry.data.next_1_hours ?? entry.data.next_6_hours;

  return {
    time: entry.time,
    temp: inst.air_temperature,
    windSpeed: inst.wind_speed,
    windDir: inst.wind_from_direction,
    humidity: inst.relative_humidity,
    precipitation: next?.details?.precipitation_amount,
    symbolCode: next?.summary?.symbol_code,
  };
}

function buildWeatherLineHtml(weather) {
  const parts = [`${weatherSymbolEmoji(weather.symbolCode)} ${weather.temp != null ? Math.round(weather.temp) + '°C' : '–'}`];
  if (weather.windSpeed != null) parts.push(`💨 ${weather.windSpeed.toFixed(1)} m/s ${weatherWindDir(weather.windDir ?? 0)}`);
  if (weather.precipitation != null) parts.push(`🌧 ${weather.precipitation.toFixed(1)} mm`);
  if (weather.humidity != null) parts.push(`💧 ${Math.round(weather.humidity)}%`);
  return parts.join(' · ');
}

// Henter hele time-for-time-serien for nedbør (kun der MET faktisk gir
// timesoppløsning, dvs. de nærmeste ~48 timene — next_1_hours mangler
// lenger frem, og da lar vi rett og slett vinduet være tomt).
async function fetchHourlyPrecipitation(lat, lng) {
  const resp = await fetch(`${YR_LOCATIONFORECAST_URL}?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.properties.timeseries
    .filter(ts => ts.data.next_1_hours)
    .map(ts => ({
      time: new Date(ts.time),
      precipitation: ts.data.next_1_hours.details?.precipitation_amount ?? 0,
    }));
}

// Finner det tørreste SAMMENHENGENDE vinduet som er langt nok til hele
// ruten (ikke bare den tørreste enkelttimen) — krever et fullt, ubrutt
// vindu innenfor time-for-time-dekningen for den valgte dagen.
function findDriestWindow(hourly, isoDate, durationHours) {
  const dayStart = new Date(`${isoDate}T00:00:00`);
  const dayEnd = new Date(`${isoDate}T23:59:59`);
  const dayEntries = hourly.filter(h => h.time >= dayStart && h.time <= dayEnd);

  const slots = Math.max(1, Math.round(durationHours));
  if (dayEntries.length < slots) return null;

  let best = null;
  for (let i = 0; i + slots <= dayEntries.length; i++) {
    const windowEntries = dayEntries.slice(i, i + slots);
    const total = windowEntries.reduce((sum, h) => sum + h.precipitation, 0);
    if (!best || total < best.total) {
      best = {
        start: windowEntries[0].time,
        end: new Date(windowEntries[windowEntries.length - 1].time.getTime() + 3600000),
        total,
      };
    }
  }
  return best;
}

function formatClock(d) {
  return d.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
}

async function refreshDetailRainWindow(durationHours) {
  const el = document.getElementById('loype-detail-rain-window');
  if (!el || !currentProfile || !durationHours) {
    if (el) el.classList.add('hidden');
    return;
  }
  const start = currentProfile[0];

  try {
    const hourly = await fetchHourlyPrecipitation(start.lat, start.lng);
    if (!document.getElementById('loype-detail-rain-window')) return; // modal lukket i mellomtiden

    const window = findDriestWindow(hourly, selectedForecastDate, durationHours);
    if (!window) {
      el.classList.add('hidden');
      return;
    }

    el.textContent = window.total < 0.1
      ? `🌂 Beste vindu: kl. ${formatClock(window.start)}–${formatClock(window.end)} (tørt)`
      : `🌂 Beste vindu: kl. ${formatClock(window.start)}–${formatClock(window.end)} (~${window.total.toFixed(1)} mm)`;
    el.classList.remove('hidden');
  } catch (err) {
    el.classList.add('hidden');
  }
}

// Siste vellykkede værhenting — lar oss regne væsketapet på nytt når fart
// eller Løp/Gå endres, uten å måtte spørre MET Norway igjen for det alene.
let lastWeatherResult = null;

// Vær og soltider hentes parallelt og rendres i én omgang, slik at det ene
// kallet aldri kan overskrive det andres resultat i den samme linja.
async function refreshDetailWeather() {
  const el = document.getElementById('loype-detail-weather');
  if (!currentProfile || !el) return;
  const start = currentProfile[0];

  el.textContent = 'Henter vær …';
  el.classList.remove('hidden');

  const [weatherResult, sunResult] = await Promise.allSettled([
    fetchWeatherForPoint(start.lat, start.lng, selectedForecastDate),
    fetchSunTimes(start.lat, start.lng, selectedForecastDate),
  ]);

  if (!document.getElementById('loype-detail-weather')) return; // modal lukket i mellomtiden

  if (weatherResult.status !== 'fulfilled') {
    el.textContent = 'Kunne ikke hente værdata.';
    document.getElementById('loype-detail-hydration')?.classList.add('hidden');
    lastWeatherResult = null;
    return;
  }

  const sunHtml = sunResult.status === 'fulfilled' ? buildSunTimesHtml(sunResult.value) : '';
  el.innerHTML = buildWeatherLineHtml(weatherResult.value) + sunHtml;

  lastWeatherResult = weatherResult.value;
  renderHydration(weatherResult.value);
}

function refreshHydrationIfApplicable() {
  if (lastWeatherResult) renderHydration(lastWeatherResult);
}

// Fysiologisk overslag, ikke en presis måling (varierer mye person til
// person — genetikk, akklimatisering, klær):
// 1) ~75 % av energiforbruket blir kroppsvarme, resten mekanisk arbeid.
// 2) ~580 kcal må fordampes som svette per liter væske for å kvitte seg
//    med den varmen.
// 3) Jo varmere/mer fuktig, jo dårligere fordamper svetten — justeres opp.
function estimateFluidLossLiters(energyKcal, tempC, humidityPct) {
  const heatKcal = energyKcal * 0.75;
  const baseSweatL = heatKcal / 580;
  const tempFactor = 1 + Math.max(0, tempC - 15) * 0.03;
  const humidityFactor = 1 + Math.max(0, humidityPct - 50) * 0.005;
  return baseSweatL * tempFactor * humidityFactor;
}

function computeRouteEnergyKcal() {
  const paceSecPerKm = parsePaceToSecondsPerKm(document.getElementById('loype-pace-input').value);
  const weightKg = parseFloat(loadProfile().weight);
  if (!paceSecPerKm || !weightKg || routePoints.length < 2) return null;

  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const isRunning = paceMode === 'run';
  let kcal = segmentEnergyKcal(paceSecPerKm, weightKg, isRunning, false);
  if (mirror) kcal += segmentEnergyKcal(paceSecPerKm, weightKg, isRunning, true);
  return kcal;
}

// ACSM sin anbefaling (samme kilde som energiformelen): erstatt væske
// tilsvarende 150 % av svettetapet under en økt.
function renderHydration(weather) {
  const el = document.getElementById('loype-detail-hydration');
  if (!el) return;

  const energyKcal = computeRouteEnergyKcal();
  if (!energyKcal || weather.temp == null) {
    el.classList.add('hidden');
    return;
  }

  const sweatL = estimateFluidLossLiters(energyKcal, weather.temp, weather.humidity ?? 50);
  const intakeL = sweatL * 1.5;
  el.textContent = `💦 Estimert væsketap: ${sweatL.toFixed(1)} L · 🥤 Anbefalt inntak: ${intakeL.toFixed(1)} L`;
  el.classList.remove('hidden');
}
