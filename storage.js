/**
 * RoadOptimiser v3 — storage.js
 * Persistance locale, contrat de données `roadoptimizur.v3`, import/export.
 * Aucune dépendance externe.
 */

export const STORAGE_KEY = 'roadoptimizur.v3';
export const GEO_CACHE_KEY = 'geoCache';
export const APP_VERSION = 3;

/* ------------------------------------------------------------------ */
/* Utilitaires génériques                                              */
/* ------------------------------------------------------------------ */

export function uid(prefix = 'id') {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function todayISO(d = new Date()) {
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}

export function addDaysISO(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return todayISO(d);
}

/** Lundi de la semaine contenant `iso`. */
export function mondayISO(iso = todayISO()) {
  const d = new Date(`${iso}T12:00:00`);
  const day = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - day);
  return todayISO(d);
}

export function minutesFromHHMM(hhmm, fallback = 480) {
  if (!hhmm || typeof hhmm !== 'string') return fallback;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2])));
}

export function hhmmFromMinutes(min) {
  const v = Math.max(0, Math.round(min));
  const h = Math.floor(v / 60) % 24;
  const m = v % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isoAt(dateISO, minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${dateISO}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

export function formatDateFR(iso, opts = {}) {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR', {
    weekday: opts.weekday === false ? undefined : 'long',
    day: '2-digit',
    month: opts.month === 'short' ? 'short' : 'long',
    ...(opts.year ? { year: 'numeric' } : {}),
  });
}

export function formatDateTimeFR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ */
/* Modèle par défaut (contrat § Modèle de données)                     */
/* ------------------------------------------------------------------ */

export function defaultState() {
  const date = todayISO();
  return {
    version: APP_VERSION,
    settings: {
      depot: { name: 'Dépôt principal', address: '', lat: 48.8566, lng: 2.3522 },
      routing: {
        profile: 'auto',
        avoidMotorways: false,
        vehicle: { height: 2.5, weight: 7.5, length: 6, axles: 2, hazardous: false },
      },
      hours: { workStart: '08:00', workEnd: '18:00', serviceDefaultMin: 10, avgSpeedKmh: 45 },
      midDepot: { enabled: false, dwellMin: 15 },
      podForm: [
        { id: 'f1', label: 'Contenant consigné', type: 'check' },
        { id: 'f2', label: 'Nombre de colis', type: 'number' },
        { id: 'f3', label: 'Photo du colis', type: 'photo' },
      ],
      company: { name: '', phone: '' },
    },
    drivers: [],
    stops: [],
    planning: { dates: [date], activeDate: date },
    history: [],
  };
}

export function newDriver(partial = {}) {
  const hue = Math.floor(Math.random() * 360);
  return {
    id: uid('dri'),
    name: '',
    phone: '',
    home: { lat: 0, lng: 0, address: '' },
    shift: { start: '08:00', end: '18:00' },
    hourlyCost: 30,
    capacity: { kg: 800, m3: 8, pallets: 6 },
    skills: ['fr'],
    active: true,
    color: `hsl(${hue} 70% 45%)`,
    ...partial,
    home: { lat: 0, lng: 0, address: '', ...(partial.home || {}) },
    shift: { start: '08:00', end: '18:00', ...(partial.shift || {}) },
    capacity: { kg: 800, m3: 8, pallets: 6, ...(partial.capacity || {}) },
    skills: Array.isArray(partial.skills) ? partial.skills : ['fr'],
  };
}

export function isValidFrenchCP(cp) {
  return /^(0[1-9]|[1-8]\d|9[0-5])\d{3}$/.test(String(cp)) || /^97[1-6]\d{2}$/.test(String(cp));
}

/** Parse un code-barres de colis (Code 128 type Chronopost/Colissimo/Mondial Relay).
 *  Ces étiquettes n'embarquent pas l'adresse, mais le numéro de suivi code souvent
 *  le code postal de destination (ex. « 0064 260X… » → 64260, « FR-64260 » → 64260). */
export function parseParcelBarcode(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const compact = text.replace(/[^A-Za-z0-9]+/g, '').toUpperCase();
  const cands = [];
  const fr = compact.match(/FR(\d{5})/);
  if (fr) cands.push(fr[1]);
  const chronopost = compact.match(/^00(\d{5})/);
  if (chronopost) cands.push(chronopost[1]);
  for (const m of compact.matchAll(/(\d{5})/g)) cands.push(m[1]);
  const cp = cands.find(isValidFrenchCP) || null;
  return { tracking: compact, cp, raw: text };
}

export function newStop(partial = {}) {
  const date = partial.date || todayISO();
  return {
    id: uid('stp'),
    name: '',
    address: '',
    phone: '',
    email: '',
    notes: '',
    geo: { lat: 0, lng: 0, display: '' },
    type: 'delivery', // delivery | pickup
    pairedWith: null,
    date,
    priority: 1,
    windowStart: null,
    windowEnd: null,
    serviceMin: 10,
    weightKg: 0,
    volumeM3: 0,
    skillsRequired: [],
    teamGroup: null,
    status: 'pending',
    driverId: null,
    seq: null,
    eta: null,
    arrivedAt: null,
    completedAt: null,
    pod: { signature: null, photos: [], fields: {}, scans: [], geo: null, completedAt: null },
    feedback: { stars: null, comment: null, date: null },
    breadcrumb: [],
    ...partial,
    geo: { lat: 0, lng: 0, display: '', ...(partial.geo || {}) },
    pod: {
      signature: null,
      photos: [],
      fields: {},
      scans: [],
      geo: null,
      completedAt: null,
      ...(partial.pod || {}),
    },
    feedback: { stars: null, comment: null, date: null, ...(partial.feedback || {}) },
    breadcrumb: Array.isArray(partial.breadcrumb) ? partial.breadcrumb : [],
    skillsRequired: Array.isArray(partial.skillsRequired) ? partial.skillsRequired : [],
  };
}

function normalizeStop(s) {
  return newStop(s);
}

function normalizeDriver(d) {
  return newDriver(d);
}

export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const state = {
    version: APP_VERSION,
    settings: {
      ...base.settings,
      ...settings,
      depot: { ...base.settings.depot, ...(settings.depot || {}) },
      routing: {
        ...base.settings.routing,
        ...(settings.routing || {}),
        vehicle: { ...base.settings.routing.vehicle, ...((settings.routing || {}).vehicle || {}) },
      },
      hours: { ...base.settings.hours, ...(settings.hours || {}) },
      podForm: Array.isArray(settings.podForm) ? settings.podForm : base.settings.podForm,
      company: { ...base.settings.company, ...(settings.company || {}) },
    },
    drivers: Array.isArray(raw.drivers) ? raw.drivers.map(normalizeDriver) : [],
    stops: Array.isArray(raw.stops) ? raw.stops.map(normalizeStop) : [],
    planning: {
      dates: Array.isArray(raw.planning?.dates) && raw.planning.dates.length
        ? raw.planning.dates.filter(Boolean)
        : base.planning.dates,
      activeDate: raw.planning?.activeDate || base.planning.activeDate,
    },
    history: Array.isArray(raw.history) ? raw.history : [],
  };
  // Cohérence des dates planifiées
  for (const s of state.stops) {
    if (s.date && !state.planning.dates.includes(s.date)) state.planning.dates.push(s.date);
  }
  state.planning.dates.sort();
  if (!state.planning.dates.includes(state.planning.activeDate)) {
    state.planning.activeDate = state.planning.dates[0] || todayISO();
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* Lecture / écriture                                                  */
/* ------------------------------------------------------------------ */

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    console.warn('[storage] lecture impossible, état par défaut', err);
    return defaultState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error('[storage] sauvegarde impossible (quota ?)', err);
    return false;
  }
}

export function resetState() {
  const fresh = defaultState();
  saveState(fresh);
  return fresh;
}

/* ------------------------------------------------------------------ */
/* Import / export JSON                                                */
/* ------------------------------------------------------------------ */

export function download(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function exportJSON(state) {
  download(`roadoptimizur-${todayISO()}.json`, JSON.stringify(state, null, 2));
}

export async function importJSONFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  return normalizeState(parsed);
}

/* ------------------------------------------------------------------ */
/* CSV commandes                                                       */
/* ------------------------------------------------------------------ */

/** Parse un CSV (séparateur , ou ;) en lignes d'objets. Gère les guillemets. */
export function parseCSV(text) {
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = clean.split('\n')[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (rows[r][idx] || '').trim(); });
    data.push(obj);
  }
  return data;
}

function pick(obj, keys, fallback = '') {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return fallback;
}

function parseNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function parseSkills(v) {
  if (!v) return [];
  return String(v).split(/[|,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Convertit une ligne CSV en stop partiel (sans géocodage). */
export function csvRowToStop(row, defaults = {}) {
  const dateRaw = pick(row, ['date', 'jour', 'date_livraison', 'delivery_date']);
  let date = defaults.date || todayISO();
  if (dateRaw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) date = dateRaw;
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateRaw)) {
      const [d, m, y] = dateRaw.split('/');
      date = `${y}-${m}-${d}`;
    }
  }
  const wsRaw = pick(row, ['debut', 'window_start', 'heure_debut', 'creneau_debut']);
  const weRaw = pick(row, ['fin', 'window_end', 'heure_fin', 'creneau_fin']);
  const normTime = (v) => {
    if (!v) return null;
    const m = String(v).match(/(\d{1,2})[h:]?(\d{2})?/);
    if (!m) return null;
    return `${String(Math.min(23, Number(m[1]))).padStart(2, '0')}:${String(Math.min(59, Number(m[2] || 0))).padStart(2, '0')}`;
  };
  const typeRaw = String(pick(row, ['type', 'type_tache'], 'delivery')).toLowerCase();
  return {
    name: pick(row, ['nom', 'client', 'name', 'destinataire']),
    address: pick(row, ['adresse', 'address', 'adresse_complete']),
    phone: pick(row, ['telephone', 'tel', 'phone', 'mobile']),
    email: pick(row, ['email', 'mail', 'courriel']),
    notes: pick(row, ['notes', 'commentaire', 'instructions', 'remarques']),
    date,
    type: /pick|collect|ramass|enlev/.test(typeRaw) ? 'pickup' : 'delivery',
    priority: Math.min(3, Math.max(1, parseNumber(pick(row, ['priorite', 'priority'], '1'), 1))),
    windowStart: normTime(wsRaw),
    windowEnd: normTime(weRaw),
    serviceMin: parseNumber(pick(row, ['service', 'service_min', 'duree'], ''), null) ?? undefined,
    weightKg: parseNumber(pick(row, ['poids', 'poids_kg', 'weight', 'kg'], '0'), 0),
    volumeM3: parseNumber(pick(row, ['volume', 'volume_m3', 'm3'], '0'), 0),
    skillsRequired: parseSkills(pick(row, ['competences', 'skills', 'competences_requises'], '')),
    teamGroup: pick(row, ['equipe', 'team', 'teamgroup', 'groupe'], '') || null,
  };
}

/** Export CSV des arrêts avec POD + feedback. */
export function stopsToCSV(stops, drivers = []) {
  const driverName = (id) => drivers.find((d) => d.id === id)?.name || '';
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'date', 'conducteur', 'sequence', 'type', 'nom', 'adresse', 'telephone', 'email',
    'priorite', 'fenetre_debut', 'fenetre_fin', 'service_min', 'poids_kg', 'volume_m3',
    'statut', 'eta', 'arrivee', 'termine', 'signature', 'photos', 'scan', 'champs_pod',
    'note_client', 'commentaire_client', 'notes',
  ];
  const lines = [head.join(';')];
  for (const s of stops) {
    lines.push([
      s.date, driverName(s.driverId), s.seq ?? '', s.type, s.name, s.address, s.phone, s.email,
      s.priority, s.windowStart || '', s.windowEnd || '', s.serviceMin, s.weightKg, s.volumeM3,
      s.status, s.eta || '', s.arrivedAt || '', s.completedAt || '',
      s.pod?.signature ? 'oui' : 'non', (s.pod?.photos || []).length, (s.pod?.scans || []).join('|'),
      JSON.stringify(s.pod?.fields || {}), s.feedback?.stars ?? '', s.feedback?.comment ?? '', s.notes,
    ].map(esc).join(';'));
  }
  return `\uFEFF${lines.join('\n')}`;
}

export function csvStopsFilename(prefix = 'commandes') {
  return `${prefix}-${todayISO()}.csv`;
}

/* ------------------------------------------------------------------ */
/* Raccourcis d'accès                                                  */
/* ------------------------------------------------------------------ */

export function getStopsForDate(state, date, { includeAll = false } = {}) {
  return state.stops.filter((s) => (includeAll || s.date === date));
}

export function getDriver(state, id) {
  return state.drivers.find((d) => d.id === id) || null;
}

export function getStop(state, id) {
  return state.stops.find((s) => s.id === id) || null;
}

export function getDriverRoute(state, driverId, date, { includeCompleted = true } = {}) {
  return state.stops
    .filter((s) => s.driverId === driverId && s.date === date && (includeCompleted || s.status === 'pending'))
    .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999));
}

export function activeDate(state) {
  return state.planning?.activeDate || todayISO();
}

export function ensureDate(state, date) {
  if (!date) return;
  if (!state.planning.dates.includes(date)) state.planning.dates.push(date);
  state.planning.dates.sort();
}

/* ------------------------------------------------------------------ */
/* Étiquette transporteur — code Aztec GEPIR (Chronopost/Chronofresh) */
/* ------------------------------------------------------------------ */

const GEPIR_RS = '\x1e', GEPIR_GS = '\x1d', GEPIR_US = '\x1f';

/** Certains décodeurs renvoient les séparateurs GS1 sous forme de symboles
 *  visibles (U+241E etc.) au lieu des caractères de contrôle : on normalise. */
function normalizeGepir(text) {
  return String(text || '')
    .replace(/\u241e/g, GEPIR_RS)
    .replace(/\u241d/g, GEPIR_GS)
    .replace(/\u241f/g, GEPIR_US)
    .replace(/\u2420/g, ' ');
}

export function looksLikeGepirLabel(text) {
  const t = normalizeGepir(text);
  return t.includes('[)>') && (t.includes(GEPIR_RS) || t.includes(GEPIR_GS));
}

/** Parse le payload Aztec d'une étiquette Chronopost/Chronofresh.
 *  Renvoie { tracking, recipient:{...}, sender:{...}, orderRef, weightKg,
 *  bestBefore, shipDate, fullAddress, display } ou null si ce n'est pas du GEPIR. */
export function parseLabelPayload(raw) {
  let text = normalizeGepir(raw);
  if (!text.includes('[)>')) return null;
  const out = { recipient: {}, sender: {}, raw: String(raw || '') };
  const usBlock = (seg) => {
    for (const f of seg.split(GEPIR_GS)) if (f.includes(GEPIR_US)) return f.split(GEPIR_US).map((s) => s.trim());
    return [];
  };
  for (const seg of text.split(GEPIR_RS)) {
    const fields = seg.split(GEPIR_GS).map((f) => f.trim());
    const head = fields[0];
    if (!head) continue;
    if (head === '01') {
      const g = fields.slice(1).filter(Boolean);
      const m = seg.match(/X[A-Z]\d{9,}/);
      if (m) out.tracking = m[0];
      const zm = g.find((f) => /^00\d{5}$/.test(f));
      if (zm) out.recipient.zip = zm.slice(2, 7);
      const words = seg.split(GEPIR_GS).filter((f) => /[A-Za-z]{3}/.test(f) && !f.includes('GEOP'));
      if (words.length >= 3) {
        out.recipient.street = words[0];
        out.recipient.city = words[1];
        out.recipient.company = words[words.length - 1];
      }
      const kg = seg.match(/(\d+(?:[.,]\d+)?)KG/);
      if (kg) out.weightKg = Number(kg[1].replace(',', '.'));
    } else if (head === '07' && fields[1] === 'G03') {
      const a = usBlock(seg);
      if (a[0]) out.recipient.company = a[0];
      if (a[1]) out.recipient.name = a[1];
      if (a[2]) out.recipient.contact = a[2];
      if (a[3]) out.recipient.phone = a[3];
      const em = a.find((x) => x.includes('@'));
      if (em) out.recipient.email = em;
      const extra = a.slice(8).find(Boolean);
      if (extra) out.recipient.address2 = extra;
      // variantes d'étiquettes : nom parfois en a[2] seulement (a[0]/a[1] vides)
      if (!a[0] && !a[1] && !out.recipient.name) {
        const first = a.find((x) => x && x !== out.recipient.phone && !x.includes('@'));
        if (first) out.recipient.name = first;
      }
      const ref = seg.match(/[A-Z]{2}\d{4}-\d{4}/);
      if (ref) out.orderRef = ref[0];
    } else if (head === '07' && fields[1] === 'S010') {
      const a = usBlock(seg);
      out.sender = {
        name: a[0] || '', phone: a[1] || '', contact: a[2] || '',
        street: a[4] || '', city: a[6] || '', zip: a[7] || '',
      };
    } else if (head === '07' && fields[1] && fields[1].startsWith('D001011')) {
      const g = fields.filter(Boolean).slice(2);
      out.shipDate = g[0] || null;
      out.itemRef = g[1] || null;
    } else if (head === '07' && fields[1] && fields[1].startsWith('D001031')) {
      const g = fields.filter(Boolean).slice(2);
      out.bestBefore = g[0] || null;
    }
  }
  if (!out.recipient.name && !out.recipient.street) return null;
  const r = out.recipient;
  const zipCity = r.zip && r.city ? `${r.zip} ${r.city}` : (r.city || '');
  out.fullAddress = [r.street, zipCity].filter(Boolean).join(', ');
  out.display = [r.company || r.name, r.address2, out.fullAddress].filter(Boolean).join(' — ');
  return out;
}
