// Favorittruter lagres lokalt (samme mønster som profile.js), og gjenbruker
// akkurat samme punkt-koding som Del rute (route-export.js). Hver favoritt
// er nå kun et valgt ikon — ikke noe navn — vist som en liten firkant på
// samme rad som "Min posisjon".
const FAVORITES_STORAGE_KEY = 'loype-favorites';
const FAVORITE_ICON_CHOICES = ['🏔️', '🌲', '🌊', '🏙️', '🚩', '❤️', '🐾', '⭐'];

function loadFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY)) || [];
  } catch (err) {
    return [];
  }
}

function saveFavoritesList(list) {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    // localStorage utilgjengelig (f.eks. privat vindu) — greit å bare ikke lagre.
  }
}

function renderFavoritesIcons() {
  const container = document.getElementById('loype-favorites-icons');
  const favorites = loadFavorites();
  container.innerHTML = '';

  favorites.forEach((fav, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'loype-favorite-icon-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loype-favorite-icon-btn';
    btn.textContent = fav.icon || '⭐';
    btn.title = 'Last inn favorittrute';
    btn.addEventListener('click', () => loadFavoriteRoute(fav));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'loype-favorite-delete-badge';
    del.setAttribute('aria-label', 'Slett favoritt');
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const updated = loadFavorites();
      updated.splice(index, 1);
      saveFavoritesList(updated);
      renderFavoritesIcons();
    });

    wrap.appendChild(btn);
    wrap.appendChild(del);
    container.appendChild(wrap);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.id = 'loype-add-favorite-btn';
  addBtn.className = 'loype-favorite-icon-btn loype-favorite-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Lagre denne ruten som favoritt';
  addBtn.disabled = routePoints.length < 2;
  addBtn.addEventListener('click', toggleIconPicker);
  container.appendChild(addBtn);
}

function updateFavoriteAddButtonState() {
  const btn = document.getElementById('loype-add-favorite-btn');
  if (btn) btn.disabled = routePoints.length < 2;
}

function toggleIconPicker(e) {
  e.stopPropagation();
  const existing = document.getElementById('loype-icon-picker');
  if (existing) {
    existing.remove();
    return;
  }
  if (routePoints.length < 2) return;

  const picker = document.createElement('div');
  picker.id = 'loype-icon-picker';
  picker.className = 'loype-icon-picker';

  FAVORITE_ICON_CHOICES.forEach(icon => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'loype-icon-picker-option';
    opt.textContent = icon;
    opt.addEventListener('click', () => {
      saveFavoriteWithIcon(icon);
      picker.remove();
    });
    picker.appendChild(opt);
  });

  document.getElementById('loype-favorites-icons').appendChild(picker);

  document.addEventListener('click', function closeOnce(ev) {
    if (!picker.contains(ev.target)) {
      picker.remove();
      document.removeEventListener('click', closeOnce);
    }
  });
}

function saveFavoriteWithIcon(icon) {
  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const points = routePoints.map(p => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
  // Lagres sammen med punktene slik at innlasting er øyeblikkelig og ikke
  // avhenger av at Kartverket/Open-Elevation svarer på nytt hver gang.
  const elevations = routeElevations.map(e => (e === undefined || e === null ? null : Math.round(e * 10) / 10));
  // Vekt/høyde tatt med slik at tid/energi stemmer med det som faktisk var
  // satt da ruten ble lagret, uten å avhenge av profilen som gjelder nå.
  const weight = document.getElementById('loype-weight-input').value;
  const height = document.getElementById('loype-height-input').value;

  const favorites = loadFavorites();
  favorites.push({ icon, points, elevations, mirror, weight, height, savedAt: new Date().toISOString() });
  saveFavoritesList(favorites);
  renderFavoritesIcons();
}

// Bruker lagret høyde direkte når den finnes (øyeblikkelig, ingen nettverk).
// Eldre favoritter uten lagret høyde, eller enkeltpunkter som av en eller
// annen grunn manglet høyde ved lagring, faller tilbake til å hente kun de
// manglende punktene på nytt.
function loadFavoriteRoute(fav) {
  routePoints = fav.points.map(([lat, lng]) => ({ lat, lng }));
  routeElevations = (fav.elevations && fav.elevations.length === routePoints.length)
    ? fav.elevations.map(e => (e === null ? undefined : e))
    : routePoints.map(() => undefined);
  undoStack = [];
  document.getElementById('loype-mirror-checkbox').checked = !!fav.mirror;

  if (fav.weight || fav.height) {
    const weightInput = document.getElementById('loype-weight-input');
    const heightInput = document.getElementById('loype-height-input');
    if (fav.weight) weightInput.value = fav.weight;
    if (fav.height) heightInput.value = fav.height;
    saveProfile({ ...loadProfile(), weight: weightInput.value, height: heightInput.value });
    updateBmiDisplay();
  }

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
      showLoypeError('Kunne ikke hente høydedata for enkelte punkter i favorittruten.');
    });
}

function initFavorites() {
  renderFavoritesIcons();
}

document.addEventListener('DOMContentLoaded', initFavorites);
