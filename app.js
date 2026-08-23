const ZONE_META = {
  rotatory: { label: 'Rotatory (trawnik)', color: '#2f7bb5' },
  statyki: { label: 'Statyki (trawnik)', color: '#4f9a3f' },
  kroplowanie: { label: 'Kroplowanie (pomidory)', color: '#c67a2b' },
  kroplowanie_projektowana: { label: 'Kroplowanie — projektowane', color: '#8e5db2' },
  reczne: { label: 'Ręczne / brak', color: '#7f8c8d' },
};
const TIER_LABEL = { wysokie: 'Wysokie', srednie: 'Średnie', niskie: 'Niskie' };
const WATER_TIER_INFO = {
  wysokie: { label: 'Wysokie zapotrzebowanie', dawka: '~10-15 l/tydzień/roślinę w suszę (bez deszczu)', czestotliwosc: '2-3x/tydzień latem, kontrola co 2-3 dni' },
  srednie: { label: 'Średnie zapotrzebowanie', dawka: '~5-8 l/tydzień/roślinę w suszę', czestotliwosc: '1-2x/tydzień latem' },
  niskie: { label: 'Niskie zapotrzebowanie (po ukorzenieniu)', dawka: '~2-4 l/tydzień/roślinę, tylko w długiej suszy', czestotliwosc: 'raz na 1-2 tygodnie, po ukorzenieniu prawie wcale' },
};
const PRESETS = [
  { filename: 'plan-plansza3.png', label: 'Plansza 3 — Zestawienie roślinności (z numerami gatunków)' },
  { filename: 'plan-plansza2.png', label: 'Plansza 2 — Wymiarowanie (czysty rzut terenu)' },
];

// Klucz Gemini NIE jest tu wpisany — klucze AI Studio powiazane z kontem uslugi
// nie wspieraja ograniczenia do domeny (Application restrictions), wiec zamiast
// osadzac klucz publicznie, appka woła maly proxy na Cloudflare Workers, ktory
// trzyma klucz jako sekret. Zobacz cloudflare-worker/gemini-proxy.js.
const GEMINI_PROXY_URL = 'https://small-surf-600c.robertkmis.workers.dev';
const GEMINI_PROXY_TOKEN = 'QKm4VWEhhigSrZvZcaT-MV4NBqlzKPMo';

const { openDB } = idb;
const dbPromise = openDB('ogrod-db', 1, {
  upgrade(db) {
    db.createObjectStore('plants', { keyPath: 'id', autoIncrement: true });
    db.createObjectStore('plan', { keyPath: 'id' });
  },
});

let speciesDB = {};
let planMeta = null; // {exists, image_url, width, height, isBlobUrl}
let map = null;
let imageOverlay = null;
let markerLayer = null;
let plantsCache = [];
let pendingPoint = null;
let editingId = null;
let selectedZone = 'reczne';

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---------------------------------------------------------------- tabs

document.querySelectorAll('nav.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.getElementById('view-' + view).classList.add('active');
    if (view === 'pogoda') loadWeather();
    if (view === 'rosliny') renderPlantTable();
    if (view === 'nawadnianie') renderIrrigationProposal();
    if (view === 'plan' && map) setTimeout(() => map.invalidateSize(), 50);
  });
});

// ---------------------------------------------------------------- species

async function loadSpecies() {
  const res = await fetch('plant_db.json');
  speciesDB = await res.json();
  const sel = document.getElementById('fSpecies');
  sel.innerHTML = '';
  const withLp = Object.entries(speciesDB).filter(([, v]) => v.lp !== undefined).sort((a, b) => a[1].lp - b[1].lp);
  const other = Object.entries(speciesDB).filter(([k, v]) => v.lp === undefined && k !== 'inne');
  const inne = Object.entries(speciesDB).filter(([k]) => k === 'inne');

  const addGroup = (label, entries) => {
    if (!entries.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    entries.forEach(([key, v]) => {
      const opt = document.createElement('option');
      opt.value = key;
      const label2 = v.qty_plan ? `${v.name} (${v.qty_plan} szt. wg projektu)` : v.name;
      opt.textContent = `${v.icon || '🌱'} ${label2}`;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  };
  addGroup('Projekt zieleni (OMI studio, Plansza 3)', withLp);
  addGroup('Warzywnik / trawnik', other);
  addGroup('Inne', inne);

  sel.addEventListener('change', updateCareBox);
}

function updateCareBox() {
  const key = document.getElementById('fSpecies').value;
  const sp = speciesDB[key];
  const box = document.getElementById('fCareBox');
  if (!sp) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="care-box">
    <b>Stanowisko</b>${sp.sun || '-'}
    <b style="margin-top:6px">Podlewanie</b>${sp.water || '-'}
    ${sp.critical_phase ? `<b style="margin-top:6px">Faza krytyczna</b>${sp.critical_phase}` : ''}
    ${sp.notes ? `<b style="margin-top:6px">Uwagi</b>${sp.notes}` : ''}
  </div>`;
  if (!editingId && sp.zone_hint) selectZone(sp.zone_hint);
}

// ---------------------------------------------------------------- plan (PZT) w IndexedDB

async function loadPlan() {
  const db = await dbPromise;
  const rec = await db.get('plan', 1);
  if (rec) {
    const url = rec.type === 'custom' ? URL.createObjectURL(rec.blob) : rec.preset_filename;
    planMeta = { exists: true, image_url: url, width: rec.width, height: rec.height, raw: rec };
    document.getElementById('planCard').style.display = '';
    document.getElementById('uploadCard').style.display = 'none';
    initMap();
    await loadPlants();
  } else {
    planMeta = { exists: false };
    document.getElementById('planCard').style.display = 'none';
    document.getElementById('uploadCard').style.display = '';
    loadPresets();
    updatePill();
  }
}

function loadPresets() {
  const list = document.getElementById('presetList');
  list.innerHTML = '';
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.textContent = '📐 ' + p.label;
    btn.onclick = () => usePreset(p);
    list.appendChild(btn);
  });
}

function imageDims(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  });
}

async function usePreset(p) {
  const { w, h } = await imageDims(p.filename);
  const db = await dbPromise;
  await db.put('plan', { id: 1, type: 'preset', preset_filename: p.filename, width: w, height: h });
  toast('Plan wgrany');
  await loadPlan();
}

document.getElementById('planFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const { w, h } = await imageDims(url);
  const db = await dbPromise;
  await db.put('plan', { id: 1, type: 'custom', blob: file, width: w, height: h });
  toast('Plan wgrany');
  await loadPlan();
});

document.getElementById('changePlanBtn').addEventListener('click', () => {
  document.getElementById('uploadCard').style.display = '';
  loadPresets();
  document.getElementById('uploadCard').scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------- mapa

function initMap() {
  const w = planMeta.width, h = planMeta.height;
  if (map) { map.remove(); map = null; }
  map = L.map('map', { crs: L.CRS.Simple, minZoom: -4, zoomSnap: 0.25 });
  const bounds = [[0, 0], [h, w]];
  imageOverlay = L.imageOverlay(planMeta.image_url, bounds).addTo(map);
  map.fitBounds(bounds);
  markerLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    const px = e.latlng.lng;
    const py = h - e.latlng.lat;
    pendingPoint = { x: px / w, y: py / h };
    editingId = null;
    openSheet('add');
  });
}

function pxToLatLng(u, v) {
  const w = planMeta.width, h = planMeta.height;
  const px = u * w, py = v * h;
  return [h - py, px];
}

async function loadPlants() {
  const db = await dbPromise;
  plantsCache = await db.getAll('plants');
  plantsCache.forEach((p) => { p.photo_url = p.photo ? URL.createObjectURL(p.photo) : null; });
  renderMarkers();
  updatePill();
}

function updatePill() {
  const pill = document.getElementById('pill');
  const txt = document.getElementById('pillTxt');
  if (!planMeta || !planMeta.exists) {
    pill.classList.remove('ok');
    txt.textContent = 'Brak planu';
    return;
  }
  const count = plantsCache.reduce((sum, p) => sum + p.qty, 0);
  pill.classList.add('ok');
  txt.textContent = `${plantsCache.length} pozycji · ${count} szt.`;
}

function renderMarkers() {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  plantsCache.forEach((plant) => {
    const sp = speciesDB[plant.species] || {};
    const zoneMeta = ZONE_META[plant.zone] || ZONE_META.reczne;
    const icon = L.divIcon({
      html: `<div class="plant-marker" style="--zone-color:${zoneMeta.color}">${sp.icon || '🌱'}</div>`,
      className: 'plant-div-icon',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
    const marker = L.marker(pxToLatLng(plant.x, plant.y), { icon });
    marker.on('click', (e) => { L.DomEvent.stopPropagation(e); showPlantDetail(plant); });
    marker.addTo(markerLayer);
  });
}

// Kalendarz Google (bez logowania/API) — przypomnienie cykliczne dla stref bez automatyki.
function buildCalendarUrl(plant, sp) {
  const RULE_BY_TIER = {
    wysokie: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
    srednie: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH',
    niskie: 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
  };
  const rule = RULE_BY_TIER[sp.water_tier] || RULE_BY_TIER.srednie;
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(8, 0, 0, 0);
  const end = new Date(start.getTime() + 15 * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const title = `Podlej: ${sp.name || plant.species}${plant.custom_name ? ' — ' + plant.custom_name : ''}`;
  const details = `${sp.water || 'Sprawdź i podlej ręcznie.'}\n\nDodane z aplikacji Ogród (strefa: ręczne podlewanie).`;
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: title, dates: `${fmt(start)}/${fmt(end)}`, details, recur: rule,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildDetailHtml(plant) {
  const sp = speciesDB[plant.species] || { name: plant.species };
  const zoneMeta = ZONE_META[plant.zone] || ZONE_META.reczne;
  const div = document.createElement('div');
  div.className = 'pop';
  div.innerHTML = `
    <span class="badge" style="background:${zoneMeta.color}">${zoneMeta.label}</span>
    <h3>${sp.icon || '🌱'} ${sp.name}${plant.custom_name ? ' — ' + plant.custom_name : ''}</h3>
    ${sp.latin ? `<div class="lat">${sp.latin}</div>` : ''}
    ${plant.photo_url ? `<img src="${plant.photo_url}">` : ''}
    <div class="field"><b>Ilość</b>${plant.qty} szt.</div>
    ${plant.planted_date ? `<div class="field"><b>Posadzono</b>${plant.planted_date}</div>` : ''}
    ${sp.water ? `<div class="field"><b>Podlewanie</b>${sp.water}</div>` : ''}
    ${plant.notes ? `<div class="field"><b>Notatki</b>${plant.notes.replace(/\n/g, '<br>')}</div>` : ''}
    ${plant.zone === 'reczne' ? `<a class="cal-btn" href="${buildCalendarUrl(plant, sp)}" target="_blank" rel="noopener">📅 Przypomnienie o podlewaniu w Kalendarzu Google</a>` : ''}
    <div class="actions">
      <button class="edit">Edytuj</button>
      ${plant.photo ? '<button class="ai">Analizuj AI</button>' : ''}
      <button class="del">Usuń</button>
    </div>
  `;
  div.querySelector('.edit').onclick = () => { editingId = plant.id; openSheet('edit', plant); closeDetail(); };
  div.querySelector('.del').onclick = () => deletePlant(plant.id);
  const aiBtn = div.querySelector('.ai');
  if (aiBtn) aiBtn.onclick = () => analyzeSavedPlant(plant.id);
  return div;
}

function showPlantDetail(plant) {
  const content = document.getElementById('detailContent');
  content.innerHTML = '';
  content.appendChild(buildDetailHtml(plant));
  document.getElementById('detailOverlay').classList.add('show');
}

function closeDetail() {
  document.getElementById('detailOverlay').classList.remove('show');
}

document.getElementById('detailOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'detailOverlay') closeDetail();
});

async function deletePlant(id) {
  if (!confirm('Usunąć tę roślinę z planu?')) return;
  const db = await dbPromise;
  await db.delete('plants', id);
  closeDetail();
  toast('Usunięto');
  await loadPlants();
}

// ---------------------------------------------------------------- AI (Gemini, bezposrednio z przegladarki)

const ANALYZE_PROMPT_TEMPLATE = (speciesList) => (
  "To zdjęcie rośliny z ogrodu przydomowego w Polsce. Baza gatunków dla tej posesji " +
  "(format klucz: nazwa polska / nazwa łacińska):\n" + speciesList + "\n\n" +
  "Zidentyfikuj roślinę na zdjęciu. Jeśli pasuje do jednej z pozycji w bazie (nawet " +
  "przybliżenie — np. ten sam rodzaj), podaj JEJ KLUCZ w polu \"klucz\". Jeśli nic nie " +
  "pasuje, zostaw \"klucz\" jako pusty string i opisz gatunek własnymi słowami w polach " +
  "gatunek/lacina. Odpowiedz WYŁĄCZNIE w formacie JSON (bez markdown, bez ```): " +
  '{"klucz": "klucz-z-bazy-lub-puste", "gatunek": "nazwa polska", ' +
  '"lacina": "nazwa łacińska", "pewnosc": "wysoka|srednia|niska", ' +
  '"opis": "krótki opis stanu rośliny na zdjęciu po polsku", ' +
  '"podlewanie": "konkretna wskazówka podlewania po polsku"}'
);

function parseJsonResponse(text) {
  text = text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '');
  }
  return JSON.parse(text.trim());
}

async function callGemini(base64Data, mime, prompt) {
  if (!GEMINI_PROXY_URL || GEMINI_PROXY_URL.startsWith('WKLEJ_TU')) {
    throw new Error('Proxy AI jeszcze nie skonfigurowany (GEMINI_PROXY_URL w app.js) — patrz cloudflare-worker/gemini-proxy.js');
  }
  const res = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': GEMINI_PROXY_TOKEN },
    body: JSON.stringify({ prompt, mime, data: base64Data }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`AI proxy HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text;
  return parseJsonResponse(text);
}

async function analyzeBlob(blob) {
  const b64 = await blobToBase64(blob);
  const speciesList = Object.entries(speciesDB).map(([k, v]) => `- ${k}: ${v.name} (${v.latin || '-'})`).join('\n');
  const prompt = ANALYZE_PROMPT_TEMPLATE(speciesList);
  const parsed = await callGemini(b64, blob.type || 'image/jpeg', prompt);
  if (!parsed.klucz || !speciesDB[parsed.klucz]) parsed.klucz = '';
  return parsed;
}

async function analyzeSavedPlant(id) {
  const db = await dbPromise;
  const plant = await db.get('plants', id);
  if (!plant || !plant.photo) { alert('Brak zdjęcia dla tej rośliny'); return; }
  toast('Analizuję zdjęcie (AI)…');
  try {
    const parsed = await analyzeBlob(plant.photo);
    const addition = `[AI/gemini, pewność ${parsed.pewnosc || '?'}] ${parsed.gatunek || '?'} (${parsed.lacina || '?'}) — ${parsed.opis || ''} Podlewanie: ${parsed.podlewanie || ''}`;
    plant.notes = plant.notes ? plant.notes + '\n\n' + addition : addition;
    plant.ai_generated = true;
    plant.updated_at = new Date().toISOString();
    await db.put('plants', plant);
    closeDetail();
    toast('Gotowe — opis dodany do notatek');
    await loadPlants();
  } catch (e) {
    alert('Błąd analizy AI: ' + e.message);
  }
}

// ---------------------------------------------------------------- sheet (add/edit)

function selectZone(zone) {
  selectedZone = zone;
  document.querySelectorAll('#fZoneTags button').forEach((b) => {
    const active = b.dataset.zone === zone;
    b.classList.toggle('sel', active);
    b.style.background = active ? ZONE_META[zone].color : '';
  });
}

document.querySelectorAll('#fZoneTags button').forEach((b) => {
  b.addEventListener('click', () => selectZone(b.dataset.zone));
});

let pendingPhotoBlob = null; // Blob wybrany w formularzu, jeszcze niezapisany

function openSheet(mode, plant) {
  document.getElementById('sheetTitle').textContent = mode === 'add' ? 'Dodaj roślinę' : 'Edytuj roślinę';
  const form = document.getElementById('plantForm');
  form.reset();
  pendingPhotoBlob = null;
  document.getElementById('fPhotoPreview').innerHTML = '';
  document.getElementById('analyzeFormBtn').style.display = 'none';
  if (mode === 'edit' && plant) {
    document.getElementById('fSpecies').value = plant.species;
    document.getElementById('fCustomName').value = plant.custom_name || '';
    document.getElementById('fQty').value = plant.qty;
    document.getElementById('fPlantedDate').value = plant.planted_date || '';
    document.getElementById('fNotes').value = plant.notes || '';
    selectZone(plant.zone);
    if (plant.photo_url) {
      document.getElementById('fPhotoPreview').innerHTML = `<img src="${plant.photo_url}" style="max-width:100%;border-radius:10px;margin-top:6px">`;
    }
  } else {
    document.getElementById('fQty').value = 1;
    document.getElementById('fPlantedDate').value = new Date().toISOString().slice(0, 10);
    selectZone('reczne');
  }
  updateCareBox();
  document.getElementById('sheetOverlay').classList.add('show');
}

function closeSheet() {
  document.getElementById('sheetOverlay').classList.remove('show');
  pendingPoint = null;
  editingId = null;
  pendingPhotoBlob = null;
}

document.getElementById('sheetCancel').addEventListener('click', closeSheet);

document.getElementById('fPhoto').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const btn = document.getElementById('analyzeFormBtn');
  const preview = document.getElementById('fPhotoPreview');
  if (!file) { btn.style.display = 'none'; pendingPhotoBlob = null; return; }
  pendingPhotoBlob = file;
  preview.innerHTML = `<img src="${URL.createObjectURL(file)}" style="max-width:100%;border-radius:10px;margin-top:6px">`;
  btn.style.display = 'block';
});

document.getElementById('analyzeFormBtn').addEventListener('click', async () => {
  if (!pendingPhotoBlob) return;
  const btn = document.getElementById('analyzeFormBtn');
  btn.disabled = true;
  btn.textContent = 'Analizuję…';
  try {
    const parsed = await analyzeBlob(pendingPhotoBlob);
    if (parsed.klucz && speciesDB[parsed.klucz]) {
      document.getElementById('fSpecies').value = parsed.klucz;
    } else {
      document.getElementById('fSpecies').value = 'inne';
      const nameField = document.getElementById('fCustomName');
      if (!nameField.value) nameField.value = parsed.gatunek || '';
    }
    updateCareBox();
    const notesField = document.getElementById('fNotes');
    const addition = `[AI/gemini, pewność ${parsed.pewnosc || '?'}] ${parsed.gatunek || '?'} (${parsed.lacina || '?'}) — ${parsed.opis || ''} Podlewanie: ${parsed.podlewanie || ''}`;
    notesField.value = notesField.value ? notesField.value + '\n\n' + addition : addition;
    toast('Gotowe — pola uzupełnione przez AI');
  } catch (e) {
    alert('Błąd analizy AI: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔎 Analizuj zdjęcie (AI)';
  }
});

document.getElementById('plantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById('sheetSave');
  saveBtn.disabled = true;
  try {
    const db = await dbPromise;
    const now = new Date().toISOString();
    const base = {
      species: document.getElementById('fSpecies').value,
      custom_name: document.getElementById('fCustomName').value,
      qty: parseInt(document.getElementById('fQty').value || '1', 10),
      zone: selectedZone,
      planted_date: document.getElementById('fPlantedDate').value,
      notes: document.getElementById('fNotes').value,
      updated_at: now,
    };

    if (editingId) {
      const existing = await db.get('plants', editingId);
      const updated = { ...existing, ...base };
      if (pendingPhotoBlob) updated.photo = pendingPhotoBlob;
      await db.put('plants', updated);
    } else {
      const record = { ...base, x: pendingPoint.x, y: pendingPoint.y, ai_generated: false, created_at: now };
      if (pendingPhotoBlob) record.photo = pendingPhotoBlob;
      await db.add('plants', record);
    }
    toast('Zapisano');
    closeSheet();
    await loadPlants();
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------- lista roślin (tab)

function renderPlantTable() {
  const tbody = document.querySelector('#plantTable tbody');
  tbody.innerHTML = '';
  plantsCache.forEach((plant) => {
    const sp = speciesDB[plant.species] || { name: plant.species };
    const zoneMeta = ZONE_META[plant.zone] || ZONE_META.reczne;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${sp.icon || '🌱'} ${sp.name}</b>${plant.custom_name ? `<br><span class="muted">${plant.custom_name}</span>` : ''}</td>
      <td>${plant.qty}</td>
      <td><span style="color:${zoneMeta.color};font-weight:700">${zoneMeta.label}</span></td>
      <td>${plant.planted_date || '-'}</td>
      <td>${plant.photo_url ? `<img src="${plant.photo_url}" style="width:40px;height:40px;object-fit:cover;border-radius:8px">` : '-'}</td>
      <td></td>
    `;
    const actionsTd = tr.querySelector('td:last-child');
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edytuj';
    editBtn.onclick = () => { editingId = plant.id; openSheet('edit', plant); };
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Usuń';
    delBtn.onclick = () => deletePlant(plant.id);
    actionsTd.append(editBtn, delBtn);
    tbody.appendChild(tr);
  });
  if (!plantsCache.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Brak jeszcze dodanych roślin — kliknij na planie w zakładce "Plan ogrodu".</td></tr>';
  }
}

// ---------------------------------------------------------------- pogoda

function getSeason(date) {
  const m = date.getMonth() + 1;
  if ([12, 1, 2].includes(m)) return 'zima';
  if ([3, 4, 5].includes(m)) return 'wiosna';
  if ([6, 7, 8].includes(m)) return 'lato';
  return 'jesien';
}
const SEASON_LABEL = { zima: 'Zima', wiosna: 'Wiosna', lato: 'Lato', jesien: 'Jesień' };
const LAT = 51.043527, LON = 17.373855;

async function loadWeather() {
  const wxDiv = document.getElementById('wxContent');
  wxDiv.textContent = 'Ładowanie…';
  const season = getSeason(new Date());
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,precipitation,weather_code&daily=precipitation_sum&timezone=Europe%2FWarsaw&forecast_days=1`;
    const res = await fetch(url);
    const data = await res.json();
    const temp = data.current?.temperature_2m;
    const precipNow = data.current?.precipitation;
    const precipToday = data.daily?.precipitation_sum?.[0] ?? 0;
    const enough = precipToday >= 5;
    wxDiv.innerHTML = `
      <div class="wx-hero">
        <div class="temp">${temp != null ? temp + '°C' : '—'}</div>
        <div>
          <div class="season"><b>Pora roku:</b> ${SEASON_LABEL[season]}</div>
          <div class="season">Opad teraz: ${precipNow ?? 0} mm/h · dziś łącznie: ${precipToday} mm</div>
        </div>
      </div>
      <div class="banner ${enough ? 'ok' : 'warn'}">
        ${enough
          ? `Padało dziś ${precipToday} mm (≥ 5 mm) — możesz pominąć dzisiejsze podlewanie.`
          : `Mało opadów dziś (${precipToday} mm, próg 5 mm) — podlewaj zgodnie z planem.`}
      </div>
      <div class="d">Źródło: Open-Meteo (współrzędne stacji ICHWAO1, Chwałowice) — próg 5 mm z docs/agrotechnika.md.</div>
    `;
  } catch (e) {
    wxDiv.innerHTML = `<div class="muted">Nie udało się pobrać pogody: ${e}</div>`;
  }

  const tipsDiv = document.getElementById('seasonTips');
  const seen = new Set();
  const tips = [];
  plantsCache.forEach((plant) => {
    const sp = speciesDB[plant.species];
    if (!sp || seen.has(plant.species)) return;
    const note = sp.season_notes && sp.season_notes[season];
    if (note) { tips.push({ name: sp.name, note }); seen.add(plant.species); }
  });
  if (!plantsCache.length) {
    tipsDiv.innerHTML = '<div class="muted">Brak jeszcze dodanych roślin.</div>';
  } else if (!tips.length) {
    tipsDiv.innerHTML = `<div class="muted">Brak specjalnych uwag sezonowych (${SEASON_LABEL[season]}) dla obecnie posadzonych roślin.</div>`;
  } else {
    tipsDiv.innerHTML = tips.map((t) => `<div class="tip"><b>${t.name}</b>${t.note}</div>`).join('');
  }
}

// ---------------------------------------------------------------- propozycja nawadniania (lokalnie)

function renderIrrigationProposal() {
  const div = document.getElementById('irrigationContent');
  if (!plantsCache.length) {
    div.innerHTML = '<div class="muted">Brak jeszcze dodanych roślin — dodaj je w zakładce "Plan ogrodu".</div>';
    return;
  }
  const groups = {};
  plantsCache.forEach((p) => {
    const sp = speciesDB[p.species] || {};
    const tier = sp.water_tier || 'srednie';
    const g = groups[tier] || (groups[tier] = { plants: [], count: 0 });
    g.plants.push({ name: sp.name || p.species, custom_name: p.custom_name, qty: p.qty });
    g.count += p.qty;
  });
  let html = '';
  ['wysokie', 'srednie', 'niskie'].forEach((tier) => {
    if (!groups[tier]) return;
    const info = WATER_TIER_INFO[tier];
    const g = groups[tier];
    html += `<div class="tier-block ${tier}">
      <h3>${TIER_LABEL[tier]} zapotrzebowanie — ${g.count} szt.</h3>
      <div class="meta">Dawka: ${info.dawka} · Częstotliwość: ${info.czestotliwosc}</div>
      <div class="plants">${g.plants.map((p) => `${p.name}${p.custom_name ? ' (' + p.custom_name + ')' : ''} × ${p.qty}`).join(', ')}</div>
    </div>`;
  });
  html += `<div class="care-box"><b>Zasada hydrostrefowania</b>Rozdziel rośliny na osobne linie/strefy kroplujące wg grupy zapotrzebowania wodnego (hydrostrefowanie) — nie mieszaj wysokiego i niskiego zapotrzebowania na jednej linii, bo albo zaleje się rośliny sucholubne, albo zagłodzi wodochłonne.</div>
    <div class="care-box" style="margin-top:8px"><b>Gleba</b>Gleba piaszczysta (jak w istniejącej instalacji nawadniania) — woda przesiąka głównie pionowo, strefa zwilżania z kroplownika ~20-30 cm. Rozstaw emiterów co 20 cm (max 30 cm).</div>
    <div class="care-box" style="margin-top:8px"><b>Sprzęt</b>Istniejący ESP32-S3 (nawadnianie2.yaml) ma jedno wolne wyjście na 8. przekaźnik (GPIO15, jeszcze nieprzypisane) — kandydat na nową, osobną strefę kroplującą dla tych nasadzeń, niezależną od obecnej strefy 'kroplowanie' (pomidory).</div>`;
  div.innerHTML = html;
}

// ---------------------------------------------------------------- analiza AI calego ogrodu

async function fetchPlanImageAsBase64() {
  let blob;
  let mime;
  if (planMeta.raw.type === 'custom') {
    blob = planMeta.raw.blob;
    mime = blob.type || 'image/png';
  } else {
    const res = await fetch(planMeta.raw.preset_filename);
    blob = await res.blob();
    mime = 'image/png';
  }
  return { b64: await blobToBase64(blob), mime };
}

document.getElementById('analyzeGardenBtn').addEventListener('click', async () => {
  const btn = document.getElementById('analyzeGardenBtn');
  const out = document.getElementById('gardenAnalysisContent');
  if (!planMeta || !planMeta.exists) { out.innerHTML = '<div class="muted">Najpierw wgraj plan ogrodu.</div>'; return; }
  if (!plantsCache.length) { out.innerHTML = '<div class="muted">Dodaj przynajmniej jedną roślinę na planie.</div>'; return; }
  btn.disabled = true;
  btn.textContent = 'Analizuję…';
  out.innerHTML = '';
  try {
    const { b64, mime } = await fetchPlanImageAsBase64();
    const lines = plantsCache.map((p) => {
      const sp = speciesDB[p.species] || {};
      return `- ${sp.name || p.species}${p.custom_name ? ' (' + p.custom_name + ')' : ''}, ${p.qty} szt., strefa: ${p.zone}, pozycja: x=${Math.round(p.x * 100)}%/y=${Math.round(p.y * 100)}%, potrzeby wodne: ${sp.water_tier || '?'}`;
    });
    const prompt =
      `Jesteś doradcą ds. projektowania ogrodów i nawadniania kroplowego. Załączony obraz to ` +
      `plan zagospodarowania terenu (PZT) prawdziwej posesji w Polsce, ${Math.round(planMeta.width)}x${Math.round(planMeta.height)} px.\n\n` +
      `Na tym planie posadzono/zaplanowano te rośliny (pozycja jako % szerokości/wysokości planu, ` +
      `licząc od lewego górnego rogu — x rośnie w prawo, y rośnie w dół):\n${lines.join('\n')}\n\n` +
      `Gleba na tej posesji jest PIASZCZYSTA: woda przesiąka głównie pionowo, strefa zwilżania ` +
      `z kroplownika to ~20-30 cm, więc rozstaw emiterów musi być gęsty (co 20 cm, max 30 cm). ` +
      `Rotatory/statyki obsługują trawnik, jedna istniejąca linia kroplująca obsługuje pomidory — ` +
      `reszta roślin z listy jeszcze NIE ma przydzielonej fizycznej instalacji kroplującej.\n\n` +
      `Spójrz na obraz planu i na powyższą listę razem, i zaproponuj konkretne, praktyczne ` +
      `usprawnienia. Bądź konkretny i zwięzły, po polsku. ` +
      `Odpowiedz WYŁĄCZNIE w formacie JSON (bez markdown, bez \`\`\`): ` +
      '{"podsumowanie": "1-2 zdania ogólnej oceny", "problemy": ["..."], "sugestie": ["..."]}';
    const parsed = await callGemini(b64, mime, prompt);
    out.innerHTML = `
      <div class="ai-result">
        <div class="sum">${parsed.podsumowanie || ''}</div>
        ${parsed.problemy && parsed.problemy.length ? `<div class="h">Do sprawdzenia</div><ul>${parsed.problemy.map((p) => `<li>${p}</li>`).join('')}</ul>` : ''}
        ${parsed.sugestie && parsed.sugestie.length ? `<div class="h">Sugestie</div><ul>${parsed.sugestie.map((s) => `<li>${s}</li>`).join('')}</ul>` : ''}
        <div class="muted" style="margin-top:6px;font-size:.72rem">Źródło: gemini</div>
      </div>
    `;
  } catch (e) {
    out.innerHTML = `<div class="muted">Błąd: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Poproś AI o analizę ogrodu';
  }
});

// ---------------------------------------------------------------- eksport CSV

document.getElementById('csvLink').addEventListener('click', (e) => {
  e.preventDefault();
  const lines = ['id;gatunek;nazwa_wlasna;szt;strefa;data_sadzenia;notatki;ai'];
  plantsCache.forEach((p) => {
    const sp = speciesDB[p.species] || {};
    lines.push([
      p.id, sp.name || p.species, p.custom_name || '', p.qty, p.zone,
      p.planted_date || '', (p.notes || '').replace(/\n/g, ' ').replace(/;/g, ','),
      p.ai_generated ? 'tak' : 'nie',
    ].join(';'));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'rosliny.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------- kopia zapasowa (eksport/import JSON)

document.getElementById('backupLink').addEventListener('click', async (e) => {
  e.preventDefault();
  toast('Przygotowuję kopię zapasową…');
  try {
    const db = await dbPromise;
    const plan = await db.get('plan', 1);
    const plants = await db.getAll('plants');

    const backup = { version: 1, exported_at: new Date().toISOString(), plan: null, plants: [] };
    if (plan) {
      backup.plan = { type: plan.type, preset_filename: plan.preset_filename || null, width: plan.width, height: plan.height };
      if (plan.type === 'custom' && plan.blob) {
        backup.plan.blob_b64 = await blobToBase64(plan.blob);
        backup.plan.blob_type = plan.blob.type;
      }
    }
    for (const p of plants) {
      const entry = { ...p };
      delete entry.photo;
      delete entry.photo_url;
      if (p.photo) {
        entry.photo_b64 = await blobToBase64(p.photo);
        entry.photo_type = p.photo.type;
      }
      backup.plants.push(entry);
    }

    const json = JSON.stringify(backup);
    const blob = new Blob([json], { type: 'application/json' });
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const filename = `ogrod-kopia-zapasowa_${ts}.json`;
    const file = new File([blob], filename, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Kopia zapasowa ogrodu' });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    alert('Błąd tworzenia kopii zapasowej: ' + err.message);
  }
});

document.getElementById('restoreLink').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('restoreInput').click();
});

document.getElementById('restoreInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('To NADPISZE obecne dane w tym telefonie danymi z kopii zapasowej. Kontynuować?')) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    const db = await dbPromise;

    if (backup.plan) {
      const rec = { id: 1, type: backup.plan.type, preset_filename: backup.plan.preset_filename, width: backup.plan.width, height: backup.plan.height };
      if (backup.plan.type === 'custom' && backup.plan.blob_b64) {
        rec.blob = base64ToBlob(backup.plan.blob_b64, backup.plan.blob_type || 'image/png');
      }
      await db.put('plan', rec);
    }

    const tx = db.transaction('plants', 'readwrite');
    await tx.store.clear();
    for (const p of backup.plants || []) {
      const rec = { ...p };
      if (p.photo_b64) {
        rec.photo = base64ToBlob(p.photo_b64, p.photo_type || 'image/jpeg');
        delete rec.photo_b64;
        delete rec.photo_type;
      }
      await tx.store.put(rec);
    }
    await tx.done;

    toast('Przywrócono kopię zapasową');
    await loadPlan();
  } catch (err) {
    alert('Błąd przywracania kopii zapasowej: ' + err.message);
  }
});

// ---------------------------------------------------------------- start

(async function init() {
  await loadSpecies();
  await loadPlan();
})();
