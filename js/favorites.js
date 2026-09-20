// Favorittruter lagres lokalt (samme mønster som profile.js), og gjenbruker
// akkurat samme punkt-koding som Del rute (route-export.js) — bare at
// resultatet havner under et navn i localStorage i stedet for i en URL.
const FAVORITES_STORAGE_KEY = 'loype-favorites';

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

function renderFavoritesList() {
  const container = document.getElementById('loype-favorites-list');
  const favorites = loadFavorites();
  container.innerHTML = '';

  if (favorites.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  favorites.forEach((fav, index) => {
    const row = document.createElement('div');
    row.className = 'loype-favorite-row';

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'loype-favorite-name';
    nameBtn.textContent = fav.name;
    nameBtn.addEventListener('click', () => loadFavoriteRoute(fav));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'loype-favorite-delete';
    deleteBtn.setAttribute('aria-label', `Slett ${fav.name}`);
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', () => {
      const updated = loadFavorites();
      updated.splice(index, 1);
      saveFavoritesList(updated);
      renderFavoritesList();
    });

    row.appendChild(nameBtn);
    row.appendChild(deleteBtn);
    container.appendChild(row);
  });
}

// Samme flyt som loadSharedRouteFromUrl (route-export.js): tegner opp
// punktene med det samme og henter høyde på nytt i etterkant.
function loadFavoriteRoute(fav) {
  routePoints = fav.points.map(([lat, lng]) => ({ lat, lng }));
  routeElevations = routePoints.map(() => undefined);
  undoStack = [];
  document.getElementById('loype-mirror-checkbox').checked = !!fav.mirror;

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
      showLoypeError('Kunne ikke hente høydedata for favorittruten.');
    });
}

function startSaveFavorite() {
  document.getElementById('loype-favorite-save-row').classList.remove('hidden');
  const input = document.getElementById('loype-favorite-name-input');
  input.value = '';
  input.focus();
}

function cancelSaveFavorite() {
  document.getElementById('loype-favorite-save-row').classList.add('hidden');
}

function confirmSaveFavorite() {
  const input = document.getElementById('loype-favorite-name-input');
  const name = input.value.trim();
  if (!name) return;

  const mirror = document.getElementById('loype-mirror-checkbox').checked;
  const points = routePoints.map(p => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);

  const favorites = loadFavorites();
  favorites.push({ name, points, mirror, savedAt: new Date().toISOString() });
  saveFavoritesList(favorites);

  cancelSaveFavorite();
  renderFavoritesList();
}

function initFavorites() {
  document.getElementById('loype-save-favorite-btn').addEventListener('click', startSaveFavorite);
  document.getElementById('loype-favorite-cancel-btn').addEventListener('click', cancelSaveFavorite);
  document.getElementById('loype-favorite-confirm-btn').addEventListener('click', confirmSaveFavorite);
  document.getElementById('loype-favorite-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSaveFavorite();
    if (e.key === 'Escape') cancelSaveFavorite();
  });
  renderFavoritesList();
}

document.addEventListener('DOMContentLoaded', initFavorites);
