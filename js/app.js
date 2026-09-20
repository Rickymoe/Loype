let map;

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 59.9139, lng: 10.7522 },
    zoom: 12,
    mapTypeId: 'roadmap',
    disableDefaultUI: false,
    clickableIcons: false,
    draggableCursor: 'crosshair',
    draggingCursor: 'crosshair',
    mapId: 'DEMO_MAP_ID',
    mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
    streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
  });

  map.addListener('click', onLoypeRouteClick);
  map.addListener('rightclick', onLoypeRouteRightClick);

  useMyLocationForRoute();
}

function initPanelCollapse(panelId, buttonId) {
  const panel = document.getElementById(panelId);
  const btn = document.getElementById(buttonId);
  btn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▸' : '▾';
  });
}

function initInfoPanel() {
  const infoPanel = document.getElementById('loype-info-panel');
  document.getElementById('loype-info-btn').addEventListener('click', () => {
    infoPanel.classList.toggle('hidden');
  });
  infoPanel.querySelector('.close-btn').addEventListener('click', () => {
    infoPanel.classList.add('hidden');
  });
}

document.addEventListener('DOMContentLoaded', initInfoPanel);
