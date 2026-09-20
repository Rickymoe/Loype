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

function renderDetailWeather(weather) {
  const el = document.getElementById('loype-detail-weather');
  if (!el) return;
  const parts = [`${weatherSymbolEmoji(weather.symbolCode)} ${weather.temp != null ? Math.round(weather.temp) + '°C' : '–'}`];
  if (weather.windSpeed != null) parts.push(`💨 ${weather.windSpeed.toFixed(1)} m/s ${weatherWindDir(weather.windDir ?? 0)}`);
  if (weather.precipitation != null) parts.push(`🌧 ${weather.precipitation.toFixed(1)} mm`);
  if (weather.humidity != null) parts.push(`💧 ${Math.round(weather.humidity)}%`);
  el.textContent = parts.join(' · ');
  el.classList.remove('hidden');
}

async function refreshDetailWeather() {
  const el = document.getElementById('loype-detail-weather');
  if (!currentProfile || !el) return;
  const start = currentProfile[0];

  el.textContent = 'Henter vær …';
  el.classList.remove('hidden');

  try {
    const weather = await fetchWeatherForPoint(start.lat, start.lng, selectedForecastDate);
    if (!document.getElementById('loype-detail-weather')) return; // modal lukket i mellomtiden
    renderDetailWeather(weather);
  } catch (err) {
    if (!document.getElementById('loype-detail-weather')) return;
    el.textContent = 'Kunne ikke hente værdata.';
  }
}
