// MET Norway sitt Sunrise 3.0-endepunkt, samme familie som Locationforecast
// (weather.js). Gratis, ingen nøkkel. Sola-prosjektet ble sjekket for
// gjenbrukbare soloppgang/solnedgang-ikoner, men det den har er en
// kompleks animert sol-over-horisont-effekt bygget for et annet formål
// (en "fant posisjon"-bekreftelse), ikke enkle statiske pictogrammer — så
// disse to er tegnet fra bunnen i samme minimale strek-stil som resten av
// Løype sine ikoner.
const MET_SUNRISE_URL = 'https://api.met.no/weatherapi/sunrise/3.0/sun';

function localUtcOffset() {
  const min = -new Date().getTimezoneOffset();
  const sign = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

// Returnerer null for sunrise/sunset ved polarnatt eller midnattssol —
// MET sier selv at begge kan være null.
async function fetchSunTimes(lat, lng, isoDate) {
  const url = `${MET_SUNRISE_URL}?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}&date=${isoDate}&offset=${localUtcOffset()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const props = data.properties;
  return {
    sunrise: props.sunrise?.time ? new Date(props.sunrise.time) : null,
    sunset: props.sunset?.time ? new Date(props.sunset.time) : null,
  };
}

const SUN_ICON_PATHS = {
  sunrise: '<path d="M2 18H22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    + '<path d="M7 18a5 5 0 0 1 10 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    + '<path d="M12 14V6M9 9L12 6L15 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  sunset: '<path d="M2 18H22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    + '<path d="M7 18a5 5 0 0 1 10 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    + '<path d="M12 6V14M9 11L12 14L15 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};

function sunBadgeHtml(kind, date) {
  const time = date.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  return `<span class="loype-sun-badge"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${SUN_ICON_PATHS[kind]}</svg>${time}</span>`;
}

function buildSunTimesHtml(sun) {
  if (!sun) return '';
  const parts = [];
  if (sun.sunrise) parts.push(sunBadgeHtml('sunrise', sun.sunrise));
  if (sun.sunset) parts.push(sunBadgeHtml('sunset', sun.sunset));
  return parts.join('');
}
