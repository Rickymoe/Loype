// Enkel lokal profil (vekt/høyde) inntil vi har en ekte backend (Notion +
// innlogging). Lagres kun i denne nettleseren via localStorage.
const PROFILE_STORAGE_KEY = 'loype-profile';

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function saveProfile(profile) {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (err) {
    // localStorage utilgjengelig (f.eks. privat vindu) — greit å bare ikke lagre.
  }
}

function updateBmiDisplay() {
  const weightInput = document.getElementById('loype-weight-input');
  const heightInput = document.getElementById('loype-height-input');
  const bmiEl = document.getElementById('loype-bmi-value');

  const weight = parseFloat(weightInput.value);
  const heightCm = parseFloat(heightInput.value);

  if (!weight || !heightCm) {
    bmiEl.classList.add('hidden');
    return;
  }

  const heightM = heightCm / 100;
  const bmi = weight / (heightM * heightM);
  bmiEl.textContent = `BMI: ${bmi.toFixed(1)}`;
  bmiEl.classList.remove('hidden');
}

function initProfile() {
  const weightInput = document.getElementById('loype-weight-input');
  const heightInput = document.getElementById('loype-height-input');
  const profile = loadProfile();

  if (profile.weight) weightInput.value = profile.weight;
  if (profile.height) heightInput.value = profile.height;
  updateBmiDisplay();

  function persist() {
    saveProfile({
      ...loadProfile(),
      weight: weightInput.value,
      height: heightInput.value,
    });
    updateBmiDisplay();
    updateEstimatedEnergy();
  }

  weightInput.addEventListener('input', persist);
  heightInput.addEventListener('input', persist);
}

document.addEventListener('DOMContentLoaded', initProfile);
