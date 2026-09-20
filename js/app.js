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
    // Begge nederst til høyre — TOP_RIGHT kolliderte med panelet på smale
    // mobilskjermer, der panelet dekker mer enn halve bredden. Google
    // stabler kontroller på samme posisjon uten at de overlapper hverandre.
    // Kart/Satellitt som full to-knappersrad ble likevel bred nok til å
    // dekke ruten/stedsnavn på mobil — DROPDOWN_MENU gir én smal knapp.
    mapTypeControlOptions: {
      position: google.maps.ControlPosition.RIGHT_BOTTOM,
      style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
    },
    streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
  });

  map.addListener('click', onLoypeRouteClick);
  map.addListener('rightclick', onLoypeRouteRightClick);

  if (!loadSharedRouteFromUrl()) {
    useMyLocationForRoute();
  }
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
