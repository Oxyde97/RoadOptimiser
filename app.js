/**
 * RoadOptimiser v3 — app.js
 *
 * TODO PHASE 2 (serveur requis) :
 *  - #23 SSO / Active Directory (LDAP)
 *  - #24 API REST/JSON (Docker Syno)
 *  - #25 envoi automatique SMS / e-mail (passerelle)
 *  - #26 tracking client multi-appareils temps réel (WebSocket)
 * Amorçage, routeur de vues, planificateur (commandes, conducteurs, tournées,
 * planning hebdo, analytique, réglages), carte et impression.
 */

import {
  loadState, saveState, resetState, newStop, newDriver,
  exportJSON, importJSONFile, parseCSV, csvRowToStop, stopsToCSV, download, csvStopsFilename,
  todayISO, addDaysISO, mondayISO, formatDateFR, formatDateTimeFR, ensureDate,
  getDriver, getStop, getDriverRoute, uid, minutesFromHHMM, isoAt,
  parseParcelBarcode, parseLabelPayload,
} from './storage.js';
import { auth, api, mountLogin, logout, requireGate, showGateAgain, resolveApi } from './auth.js';
import { initDriverServerView } from './driver-server.js';
import { geocode, route as routeRoad, matrix as routeMatrix, navigationLinks, estimateTour } from './routing.js';
import { optimize, reoptimize, applyManualOrder, recomputeEtas, computeLoads } from './optimize.js';
import { initDriverView, trackingLinks } from './driver.js';
import { openPOD, openScanner, toast, escapeHtml, podPrintHTML } from './pod.js';
import { renderAnalytics, exportAnalyticsCSV } from './analytics.js';

/* ------------------------------------------------------------------ */
/* État global                                                         */
/* ------------------------------------------------------------------ */

let state = loadState();
let activeTab = 'stops';
let selectedDriverId = null;
let stopFilter = { q: '', status: 'all' };
let map = null;
let markersLayer = null;
let routeLayer = null;
let mapToken = 0;
const routeCache = new Map();
let driverViewController = null;
let depotViewPending = false;
let installPrompt = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const panel = () => document.getElementById('panel');
const modalRoot = () => document.getElementById('modal-root');

function save() {
  try { localStorage.setItem('roadoptimizur.ws.stamp', new Date().toISOString()); } catch {}
  scheduleWsPush();
  if (serverScope) scheduleTourPush();
  const ok = saveState(state);
  const badge = document.getElementById('save-state');
  if (badge) {
    badge.textContent = ok ? 'Enregistré' : 'Quota dépassé';
    badge.className = ok ? 'text-[10px] text-emerald-600' : 'text-[10px] text-red-600';
  }
  return ok;
}

function currentDate() {
  return state.planning?.activeDate || todayISO();
}

function setDate(date) {
  if (!date) return;
  ensureDate(state, date);
  state.planning.activeDate = date;
  save();
  renderAll();
  if (serverScope && !serverScope.dates[date]) driverPullWeek({ silent: true });
}

function driverOf(stop) {
  return stop?.driverId ? getDriver(state, stop.driverId) : null;
}

function statusBadge(status) {
  const mapStatus = {
    pending: ['À livrer', 'bg-slate-100 text-slate-600', 'fa-clock'],
    delivered: ['Livré', 'bg-emerald-100 text-emerald-700', 'fa-circle-check'],
    absent: ['Absent', 'bg-amber-100 text-amber-800', 'fa-user-slash'],
    failed: ['Échoué', 'bg-red-100 text-red-700', 'fa-circle-xmark'],
  };
  const [label, cls, icon] = mapStatus[status] || mapStatus.pending;
  return `<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}"><i class="fa-solid ${icon}"></i>${label}</span>`;
}

function priorityBadge(p) {
  const n = Number(p) || 1;
  if (n >= 3) return '<span class="text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">P3</span>';
  if (n === 2) return '<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">P2</span>';
  return '<span class="text-[10px] font-bold text-slate-500 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">P1</span>';
}

/* ------------------------------------------------------------------ */
/* Modale générique                                                    */
/* ------------------------------------------------------------------ */

function openModal(html, size = 'max-w-lg') {
  modalRoot().innerHTML = `
    <div class="fixed inset-0 z-[120] bg-slate-900/50 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-6" data-modal-overlay>
      <div class="bg-white w-full ${size} max-h-[92dvh] rounded-t-2xl md:rounded-2xl shadow-2xl overflow-y-auto" data-modal-card>
        ${html}
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalRoot().innerHTML = '';
  document.body.style.overflow = '';
}

function modalHeader(title, subtitle = '') {
  return `<div class="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200 px-4 py-3 flex items-center justify-between gap-3">
    <div class="min-w-0">
      <h2 class="font-extrabold text-slate-900 text-base truncate">${escapeHtml(title)}</h2>
      ${subtitle ? `<p class="text-[11px] text-slate-500">${escapeHtml(subtitle)}</p>` : ''}
    </div>
    <button type="button" data-modal-close class="w-10 h-10 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500"><i class="fa-solid fa-xmark"></i></button>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */

function initMap() {
  const node = document.getElementById('map');
  if (!node || typeof window.L === 'undefined') return;
  const depot = state.settings.depot;
  map = window.L.map(node, { zoomControl: false })
    .setView([depot.lat || 48.8566, depot.lng || 2.3522], 12);
  window.L.control.zoom({ position: 'bottomright' }).addTo(map);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  markersLayer = window.L.layerGroup().addTo(map);
  routeLayer = window.L.layerGroup().addTo(map);
  updateMap();
}

function pinIcon(color, text, opts = {}) {
  const size = opts.small ? 26 : 32;
  return window.L.divIcon({
    className: 'ro-marker',
    html: `<div class="ro-pin" style="--pin:${color};width:${size}px;height:${size}px">${text}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
}

function updateMap() {
  if (!map || !markersLayer) return;
  markersLayer.clearLayers();
  const depot = state.settings.depot;
  const depotIcon = window.L.divIcon({
    className: 'ro-marker',
    html: '<div class="ro-pin ro-pin-depot"><i class="fa-solid fa-warehouse"></i></div>',
    iconSize: [34, 34], iconAnchor: [17, 34],
  });
  window.L.marker([depot.lat || 48.8566, depot.lng || 2.3522], { icon: depotIcon })
    .bindPopup(`<b>${escapeHtml(depot.name || 'Dépôt')}</b><br><span class="text-xs">${escapeHtml(depot.address || '')}</span>`)
    .addTo(markersLayer);

  const stops = state.stops.filter((s) => s.date === currentDate() && s.geo?.lat);
  stops.forEach((s) => {
    const d = driverOf(s);
    const color = d?.color || (s.status === 'delivered' ? '#059669' : '#64748b');
    window.L.marker([s.geo.lat, s.geo.lng], { icon: pinIcon(color, s.seq ?? '•', { small: true }) })
      .bindPopup(`<div class="text-xs"><b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.address)}<br>${s.windowStart ? `⏰ ${s.windowStart}–${s.windowEnd || ''}<br>` : ''}${d ? `🚚 ${escapeHtml(d.name)}` : 'Non affecté'}</div>`)
      .addTo(markersLayer);
  });

  if (stops.length) {
    const pts = [[depot.lat || 48.8566, depot.lng || 2.3522], ...stops.map((s) => [s.geo.lat, s.geo.lng])];
    map.fitBounds(window.L.latLngBounds(pts).pad(0.15), { maxZoom: 14, animate: false });
  }
  drawRoutes();
  if (depotViewPending && map && depot && depot.lat && depot.lng) {
    try { map.setView([depot.lat, depot.lng], Math.max(map.getZoom(), 12)); depotViewPending = false; } catch { depotViewPending = false; }
  }
}

async function drawRoutes() {
  if (!map || !routeLayer) return;
  const token = ++mapToken;
  routeLayer.clearLayers();
  const depot = state.settings.depot;
  const date = currentDate();
  const drivers = state.drivers.filter((d) => state.stops.some((s) => s.driverId === d.id && s.date === date));
  const targets = activeTab === 'routes' && selectedDriverId
    ? drivers.filter((d) => d.id === selectedDriverId)
    : drivers.slice(0, 5);

  for (const d of targets) {
    const stops = getDriverRoute(state, d.id, date).filter((s) => s.geo?.lat);
    if (!stops.length) continue;
    const points = [depot, ...stops.map((s) => s.geo), depot];
    const key = `${date}|${d.id}|${stops.map((s) => s.id).join(',')}|${state.settings.routing.profile}`;
    try {
      let data = routeCache.get(key);
      if (!data) {
        data = await routeRoad(points, {
          profile: state.settings.routing.profile,
          vehicle: state.settings.routing.vehicle,
          avoidMotorways: state.settings.routing.avoidMotorways,
          avgSpeedKmh: state.settings.hours.avgSpeedKmh,
        });
        routeCache.set(key, data);
        if (routeCache.size > 40) routeCache.delete(routeCache.keys().next().value);
      }
      if (token !== mapToken) return;
      if (data.geometry?.length) {
        window.L.polyline(data.geometry, {
          color: d.color || '#0284c7', weight: 4, opacity: 0.75,
          dashArray: data.source === 'haversine' ? '6 8' : null,
        }).addTo(routeLayer);
      }
    } catch (err) {
      console.warn('[app] tracé itinéraire', err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Onglets / rendu global                                              */
/* ------------------------------------------------------------------ */

const TABS = ['stops', 'routes', 'drivers', 'planning', 'analytics', 'accounts', 'live', 'settings'];

function switchTab(tab) {
  if (tab !== 'live') { clearInterval(liveTimer); liveTimer = null; }
  if (!TABS.includes(tab)) tab = 'stops';
  activeTab = tab;
  $$('#planner-tabs [data-tab]').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('tab-active', active);
    b.classList.toggle('text-slate-500', !active);
  });
  renderPanel();
  setTimeout(() => map?.invalidateSize(), 50);
}

function renderPanel() {
  const p = panel();
  if (!p) return;
  if (activeTab === 'stops') renderStops();
  else if (activeTab === 'drivers') renderDrivers();
  else if (activeTab === 'routes') renderRoutes();
  else if (activeTab === 'planning') renderPlanning();
  else if (activeTab === 'analytics') renderAnalytics(p, state, currentDate());
  else if (activeTab === 'settings') renderSettings();
  else if (activeTab === 'accounts') renderAccounts();
  else if (activeTab === 'live') renderLive(p);
}

function renderAll() {
  scheduleTourPush();
  const input = document.getElementById('active-date');
  if (input) input.value = currentDate();
  const mobileInput = document.getElementById('active-date-mobile');
  if (mobileInput) mobileInput.value = currentDate();
  renderPanel();
  updateMap();
}

/* ------------------------------------------------------------------ */
/* Vue Commandes                                                       */
/* ------------------------------------------------------------------ */

function renderStops() {
  const date = currentDate();
  const stops = state.stops.filter((s) => s.date === date);
  if (serverScope && auth.user && auth.user.role === 'driver' && !stops.filter((s) => String(s.driverId) === serverScope.driverId).length) {
    panel().innerHTML = `<div class="p-4 space-y-3">
      <div class="rounded-xl bg-amber-50 border border-amber-300 p-4 text-amber-900">
        <p class="font-extrabold text-sm"><i class="fa-solid fa-circle-info mr-1"></i>Aucune tournée publiée pour ce jour</p>
        <p class="text-xs mt-1 leading-relaxed">Deux options : attendre que le dispatch publie sa tournée, ou <b>créer ta tournée toi-même</b> — ajoute tes livraisons ci-dessous puis optimise dans l'onglet Tournées. Tout est enregistré en ligne et visible par le dispatch.</p>
        <div class="mt-3 flex gap-2 flex-wrap">
          <button type="button" data-action="add-stop" class="h-10 px-4 rounded-xl bg-emerald-600 text-white text-xs font-bold"><i class="fa-solid fa-plus mr-1"></i>Ajouter une livraison</button>
          <button type="button" data-action="ws-repull" class="h-10 px-4 rounded-xl bg-amber-500 text-white text-xs font-bold"><i class="fa-solid fa-rotate mr-1"></i>Vérifier à nouveau</button>
        </div>
      </div></div>`;
    return;
  }
  const unassigned = stops.filter((s) => !s.driverId && s.status === 'pending').length;
  const delivered = stops.filter((s) => s.status === 'delivered').length;
  const depot = state.settings.depot;

  panel().innerHTML = `
    <div class="p-3 md:p-4 space-y-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900 leading-tight">Commandes</h1>
          <p class="text-xs text-slate-500">${formatDateFR(date)} · ${stops.length} arrêt(s)</p>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" data-action="scan-stop" class="min-h-[44px] px-3 bg-white border-2 border-brand-500 text-brand-700 active:bg-brand-50 rounded-xl text-xs font-bold flex items-center gap-1.5" title="Scanner une étiquette colis (Chronopost, Colissimo…)">
            <i class="fa-solid fa-barcode"></i> Scanner
          </button>
          <button type="button" data-action="add-stop" class="min-h-[44px] px-3 bg-brand-600 active:bg-brand-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm">
            <i class="fa-solid fa-plus"></i> Ajouter
          </button>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-9 h-9 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-warehouse"></i></span>
          <div class="min-w-0">
            <p class="text-[10px] uppercase font-bold tracking-wider text-slate-400">Dépôt</p>
            <p class="text-xs font-semibold text-slate-800 truncate">${escapeHtml(depot.name || 'Non configuré')}</p>
            <p class="text-[11px] text-slate-500 truncate">${escapeHtml(depot.address || '—')}</p>
          </div>
        </div>
        <button type="button" data-action="edit-depot" class="text-xs font-semibold text-brand-600 px-2 py-1">Modifier</button>
      </div>

      <div class="grid grid-cols-3 gap-2">
        <div class="bg-white rounded-lg border border-slate-200 p-2 text-center">
          <p class="text-lg font-extrabold text-slate-900">${stops.length}</p>
          <p class="text-[10px] text-slate-500">arrêts</p>
        </div>
        <div class="bg-white rounded-lg border border-slate-200 p-2 text-center">
          <p class="text-lg font-extrabold text-emerald-600">${delivered}</p>
          <p class="text-[10px] text-slate-500">livrés</p>
        </div>
        <div class="bg-white rounded-lg border border-slate-200 p-2 text-center">
          <p class="text-lg font-extrabold ${unassigned ? 'text-amber-600' : 'text-slate-900'}">${unassigned}</p>
          <p class="text-[10px] text-slate-500">non affectés</p>
        </div>
      </div>

      <div class="flex gap-2">
        <div class="relative flex-1">
          <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
          <input type="search" data-filter-q value="${escapeHtml(stopFilter.q)}" placeholder="Rechercher client, adresse…" class="w-full pl-8 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-base md:text-sm outline-none focus:ring-2 focus:ring-brand-500">
        </div>
        <select data-filter-status class="px-2 py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-700 outline-none">
          <option value="all" ${stopFilter.status === 'all' ? 'selected' : ''}>Tous</option>
          <option value="pending" ${stopFilter.status === 'pending' ? 'selected' : ''}>À livrer</option>
          <option value="delivered" ${stopFilter.status === 'delivered' ? 'selected' : ''}>Livrés</option>
          <option value="problem" ${stopFilter.status === 'problem' ? 'selected' : ''}>Problèmes</option>
        </select>
      </div>

      <div id="stops-list" class="space-y-2"></div>

      <div class="grid grid-cols-2 gap-2 pt-1">
        <label class="min-h-[44px] bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 flex items-center justify-center gap-2 cursor-pointer">
          <i class="fa-solid fa-file-csv text-emerald-600"></i> Importer CSV
          <input type="file" accept=".csv,text/csv" data-import-csv class="hidden">
        </label>
        <button type="button" data-action="export-stops-csv" class="min-h-[44px] bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 flex items-center justify-center gap-2">
          <i class="fa-solid fa-download text-slate-500"></i> Exporter CSV
        </button>
      </div>
      <p class="text-[10px] text-slate-400 text-center">Astuce : dans Tournées, glissez les arrêts pour les réordonner.</p>
    </div>
  `;
  renderStopsList();
}

function renderStopsList() {
  const list = document.getElementById('stops-list');
  if (!list) return;
  const all = state.stops.filter((s) => s.date === currentDate());
  const q = stopFilter.q.trim().toLowerCase();
  const filtered = all.filter((s) => {
    if (stopFilter.status === 'pending' && s.status !== 'pending') return false;
    if (stopFilter.status === 'delivered' && s.status !== 'delivered') return false;
    if (stopFilter.status === 'problem' && !['absent', 'failed'].includes(s.status)) return false;
    if (!q) return true;
    return [s.name, s.address, s.phone, s.notes, s.teamGroup, ...(s.skillsRequired || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  });

  if (!all.length) {
    list.innerHTML = `
      <div class="bg-white rounded-xl border border-dashed border-slate-300 p-6 text-center">
        <i class="fa-solid fa-box-open text-2xl text-slate-300"></i>
        <p class="text-sm font-semibold text-slate-700 mt-2">Aucune commande pour cette date</p>
        <p class="text-xs text-slate-500 mt-1">Ajoutez un arrêt, importez un CSV ou chargez une démo.</p>
        <button type="button" data-action="seed-demo" class="mt-3 min-h-[40px] px-3 bg-slate-900 text-white rounded-lg text-xs font-semibold">
          <i class="fa-solid fa-flask mr-1"></i> Charger la démo
        </button>
      </div>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<p class="text-center text-xs text-slate-400 py-6">Aucun résultat.</p>';
    return;
  }

  list.innerHTML = filtered.map((s) => {
    const d = driverOf(s);
    return `
      <article class="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
        <div class="flex items-start gap-2">
          <div class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-extrabold flex-shrink-0" style="background:${d ? d.color : '#e2e8f0'};color:${d ? '#fff' : '#475569'}">${s.seq ?? '–'}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-bold text-sm text-slate-900 break-words">${escapeHtml(s.name || 'Sans nom')}</h3>
              <div class="flex items-center gap-1 flex-shrink-0">${priorityBadge(s.priority)}${statusBadge(s.status)}</div>
            </div>
            <p class="text-[11px] text-slate-500 mt-0.5 break-words"><i class="fa-solid fa-location-dot mr-1"></i>${escapeHtml(s.address || 'Adresse manquante')}</p>
            <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px] text-slate-500">
              ${s.windowStart || s.windowEnd ? `<span><i class="fa-regular fa-clock mr-1"></i>${s.windowStart || '…'}–${s.windowEnd || '…'}</span>` : ''}
              <span><i class="fa-solid fa-box mr-1"></i>${s.weightKg || 0} kg</span>
              ${s.volumeM3 ? `<span>${s.volumeM3} m³</span>` : ''}
              ${s.type === 'pickup' ? '<span class="text-purple-700 font-semibold"><i class="fa-solid fa-box-open mr-1"></i>Collecte</span>' : ''}
              ${s.teamGroup ? `<span><i class="fa-solid fa-people-group mr-1"></i>${escapeHtml(s.teamGroup)}</span>` : ''}
              ${s.skillsRequired?.length ? `<span class="text-indigo-600"><i class="fa-solid fa-certificate mr-1"></i>${s.skillsRequired.map(escapeHtml).join(', ')}</span>` : ''}
            </div>
            <div class="flex items-center gap-2 mt-2">
              <select data-assign-stop="${s.id}" class="max-w-[150px] text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
                <option value="">Non affecté</option>
                ${state.drivers.filter((x) => x.active !== false).map((x) => `<option value="${x.id}" ${x.id === s.driverId ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}
              </select>
              ${s.eta ? `<span class="text-[11px] font-semibold text-brand-700"><i class="fa-regular fa-clock mr-1"></i>${new Date(s.eta).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="flex items-center justify-end gap-1 mt-2 pt-2 border-t border-slate-100">
          <button type="button" data-action="track-stop" data-id="${s.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 flex items-center justify-center" title="Lien de suivi client"><i class="fa-solid fa-share-nodes"></i></button>
          <button type="button" data-action="pod-stop" data-id="${s.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 flex items-center justify-center" title="Preuve de livraison"><i class="fa-solid fa-signature"></i></button>
          <button type="button" data-action="edit-stop" data-id="${s.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 flex items-center justify-center" title="Modifier"><i class="fa-solid fa-pen"></i></button>
          <button type="button" data-action="duplicate-stop" data-id="${s.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 flex items-center justify-center" title="Dupliquer"><i class="fa-regular fa-copy"></i></button>
          <button type="button" data-action="delete-stop" data-id="${s.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center" title="Supprimer"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </article>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* Formulaire arrêt                                                    */
/* ------------------------------------------------------------------ */

/** Scan d'étiquette colis → commande pré-remplie (CP extrait + géocodé, n° de suivi conservé). */
async function handleParcelScan(value) {
  const gepir = parseLabelPayload(value);
  if (gepir?.tracking) value = gepir.tracking;
  const info = parseParcelBarcode(value);
  if (!info) { toast('Code illisible.', 'error'); return; }
  const preset = {
    name: `Colis ${info.tracking.slice(-8)}`,
    notes: `N° de suivi : ${info.raw}`,
    barcodes: [...new Set([info.tracking, info.raw])],
  };
  if (info.cp) {
    toast(`Code postal détecté : ${info.cp} — géocodage…`, 'info');
    try {
      const geo = await geocode(info.cp);
      if (geo) {
        preset.address = `${info.cp} ${String(geo.display || '').split(',')[0]}`;
        preset.geo = { lat: geo.lat, lng: geo.lng, display: geo.display };
      } else {
        preset.address = info.cp;
      }
    } catch { preset.address = info.cp; }
  } else {
    toast('Aucun code postal reconnu dans ce numéro — complétez l’adresse.', 'warn', 5000);
  }
  openStopModal(null, null, preset);
}

/** Remplit le formulaire « Nouvel arrêt » depuis un scan d'étiquette.
 *  Aztec/GEPIR → tous les champs destinataire ; Code128 simple → suivi + CP. */
function fillStopFormFromScan(form, v) {
  const label = parseLabelPayload(v);
  const info = label
    ? { tracking: label.tracking || '', cp: label.recipient?.zip || null, raw: v }
    : parseParcelBarcode(v);
  if (!info || !info.tracking) { toast('Code illisible.', 'error'); return; }
  const q = (n) => form.querySelector(`[name=${n}]`);
  const nameI = q('name');
  const addrI = form.querySelector('[data-address]');
  const latI = q('lat');
  const lngI = q('lng');
  const noteI = q('notes');
  const hid = q('barcodes');
  const addrForGeo = label ? label.fullAddress : (info.cp || '');
  if (label) {
    const r = label.recipient;
    if (nameI && !nameI.value.trim()) nameI.value = r.company || r.name || `Colis ${String(label.tracking).slice(-8)}`;
    if (addrI && !addrI.value.trim() && label.fullAddress) addrI.value = label.fullAddress;
    const phoneI = q('phone'); if (phoneI && !phoneI.value.trim() && r.phone) phoneI.value = r.phone;
    const mailI = q('email'); if (mailI && !mailI.value.trim() && r.email) mailI.value = r.email;
    const wI = q('weightKg'); if (wI && !Number(wI.value) && label.weightKg) wI.value = label.weightKg;
    if (noteI && !String(noteI.value).includes('N° de suivi')) {
      const bits = [
        `N° de suivi : ${label.tracking || info.cp || '—'}`,
        label.orderRef ? `Réf. commande : ${label.orderRef}` : '',
        r.name ? `Destinataire : ${r.name}` : '',
        r.address2 ? `Point dit : ${r.address2}` : '',
        label.bestBefore ? `DLC : ${label.bestBefore}` : '',
      ].filter(Boolean);
      noteI.value = (noteI.value ? noteI.value + '\n' : '') + bits.join('\n');
    }
  } else {
    if (nameI && !nameI.value.trim()) nameI.value = `Colis ${info.tracking.slice(-8)}`;
    if (addrI && info.cp && !addrI.value.trim()) addrI.value = info.cp;
    if (noteI && !String(noteI.value).includes('N° de suivi')) noteI.value = (noteI.value ? noteI.value + '\n' : '') + `N° de suivi : ${info.raw}`;
  }
  if (hid) {
    const cur = String(hid.value || '').split('|').filter(Boolean);
    const rawShort = String(info.raw).replace(/[\x1e\x1d\x1f\u241d\u241e\u241f\u2420]/g, ' ').slice(0, 200);
    hid.value = [...new Set([...cur, info.tracking, rawShort])].join('|');
  }
  if (addrForGeo && latI && !Number(latI.value)) {
    const lab = form.querySelector('[data-geo-label]');
    if (lab) lab.textContent = 'Géocodage en cours…';
    geocode(addrForGeo).then((geo) => {
      if (!geo) { if (lab) lab.textContent = 'Adresse introuvable — vérifiez la saisie.'; return; }
      latI.value = geo.lat; lngI.value = geo.lng;
      if (addrI && !addrI.value.trim()) addrI.value = addrForGeo;
      if (lab) lab.textContent = `GPS ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} — ${String(geo.display).slice(0, 70)}`;
    }).catch(() => {});
  }
  toast(label ? `Étiquette lue : ${label.recipient.city || label.recipient.zip || ''} — champs remplis.` : 'Code-barres ajouté à la commande.', 'success');
}

function openStopModal(stop = null, presetDate = null, preset = null) {
  const isEdit = Boolean(stop);
  const s = stop || newStop({ date: presetDate || currentDate(), serviceMin: state.settings.hours.serviceDefaultMin });
  if (preset) Object.assign(s, preset);
  const date = s.date || currentDate();
  const pairedOptions = state.stops
    .filter((x) => x.id !== s.id && x.date === date)
    .map((x) => `<option value="${x.id}" ${s.pairedWith === x.id ? 'selected' : ''}>${escapeHtml(x.name || x.address || x.id)}</option>`)
    .join('');

  openModal(`
    ${modalHeader(isEdit ? 'Modifier l’arrêt' : 'Nouvel arrêt', isEdit ? s.name : formatDateFR(date))}
    <form data-stop-form data-id="${isEdit ? s.id : ''}" class="p-4 space-y-3">
      <div class="grid grid-cols-2 gap-2">
        <div class="col-span-2">
          <label class="block text-xs font-semibold text-slate-600 mb-1">Nom du client *</label>
          <input name="name" required value="${escapeHtml(s.name)}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="Ex: Boulangerie Martin">
        </div>
        <div class="col-span-2">
          <label class="block text-xs font-semibold text-slate-600 mb-1">Adresse *</label>
          <div class="flex gap-1">
            <input name="address" data-address required value="${escapeHtml(s.address)}" class="flex-1 min-w-0 px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="12 rue de la Paix, Paris">
            <button type="button" data-action="scan-into-stop" class="px-3 min-h-[44px] bg-brand-50 border border-brand-200 rounded-lg text-brand-600" title="Scanner une étiquette colis"><i class="fa-solid fa-barcode"></i></button>
            <button type="button" data-action="geocode-stop" class="px-3 min-h-[44px] bg-slate-100 border border-slate-300 rounded-lg text-slate-600" title="Géocoder"><i class="fa-solid fa-magnifying-glass-location"></i></button>
          </div>
          <p class="text-[10px] text-slate-400 mt-1" data-geo-label>${s.geo?.lat ? `GPS ${s.geo.lat.toFixed(5)}, ${s.geo.lng.toFixed(5)}` : 'Adresse non géocodée'}</p>
          ${(s.barcodes && s.barcodes.length) ? `<p class="text-[10px] font-mono text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1 break-all"><i class="fa-solid fa-barcode mr-1"></i>${escapeHtml(String(s.barcodes[0]))}</p>` : ''}
          <input type="hidden" name="barcodes" value="${escapeHtml((s.barcodes || []).join('|'))}">
          <input type="hidden" name="lat" value="${s.geo?.lat || 0}">
          <input type="hidden" name="lng" value="${s.geo?.lng || 0}">
        </div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Téléphone</label>
          <input name="phone" type="tel" value="${escapeHtml(s.phone)}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="06…"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">E-mail</label>
          <input name="email" type="email" value="${escapeHtml(s.email)}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="client@exemple.fr"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Type</label>
          <select name="type" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base">
            <option value="delivery" ${s.type === 'delivery' ? 'selected' : ''}>Livraison</option>
            <option value="pickup" ${s.type === 'pickup' ? 'selected' : ''}>Collecte</option>
          </select></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Date</label>
          <input name="date" type="date" value="${date}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Priorité</label>
          <select name="priority" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base">
            <option value="1" ${s.priority == 1 ? 'selected' : ''}>1 — normale</option>
            <option value="2" ${s.priority == 2 ? 'selected' : ''}>2 — haute</option>
            <option value="3" ${s.priority == 3 ? 'selected' : ''}>3 — urgente</option>
          </select></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Service (min)</label>
          <input name="serviceMin" type="number" min="0" value="${s.serviceMin ?? 10}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Fenêtre début</label>
          <input name="windowStart" type="time" value="${s.windowStart || ''}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Fenêtre fin</label>
          <input name="windowEnd" type="time" value="${s.windowEnd || ''}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Poids (kg)</label>
          <input name="weightKg" type="number" min="0" step="0.1" value="${s.weightKg || 0}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Volume (m³)</label>
          <input name="volumeM3" type="number" min="0" step="0.1" value="${s.volumeM3 || 0}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Palettes</label>
          <input name="pallets" type="number" min="0" value="${s.pallets || 0}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Compétences requises</label>
          <input name="skillsRequired" value="${escapeHtml((s.skillsRequired || []).join(', '))}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="fr, frigo"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Équipe (teamGroup)</label>
          <input name="teamGroup" value="${escapeHtml(s.teamGroup || '')}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="ex: chantier A"></div>
        <div class="col-span-2"><label class="block text-xs font-semibold text-slate-600 mb-1">Lié à (précédence pickup → delivery)</label>
          <select name="pairedWith" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base">
            <option value="">Aucun</option>${pairedOptions}
          </select></div>
        <div class="col-span-2"><label class="block text-xs font-semibold text-slate-600 mb-1">Notes / instructions</label>
          <textarea name="notes" rows="2" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="Code d’accès, étage, colis…">${escapeHtml(s.notes)}</textarea></div>
      </div>
      <div class="flex gap-2 pt-1">
        <button type="button" data-modal-close class="px-4 min-h-[48px] rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">Annuler</button>
        <button type="submit" class="flex-1 min-h-[48px] bg-brand-600 active:bg-brand-700 text-white rounded-xl text-sm font-bold"><i class="fa-solid fa-floppy-disk mr-2"></i>${isEdit ? 'Enregistrer' : 'Ajouter l’arrêt'}</button>
      </div>
    </form>
  `);
}

async function resolveGeo(addressInput, latInput, lngInput, label) {
  const address = addressInput.value.trim();
  if (!address) { toast('Saisissez une adresse.', 'warn'); return null; }
  label.textContent = 'Géocodage en cours…';
  const geo = await geocode(address);
  if (!geo) { label.textContent = 'Adresse introuvable — vérifiez la saisie.'; toast('Adresse introuvable.', 'error'); return null; }
  latInput.value = geo.lat;
  lngInput.value = geo.lng;
  label.textContent = `GPS ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} — ${geo.display.slice(0, 70)}`;
  return geo;
}

async function submitStopForm(form) {
  const fd = new FormData(form);
  const id = form.dataset.id;
  const existing = id ? getStop(state, id) : null;
  let lat = Number(fd.get('lat')) || 0;
  let lng = Number(fd.get('lng')) || 0;
  const address = String(fd.get('address') || '').trim();
  if (!lat && address) {
    const geo = await geocode(address);
    if (geo) { lat = geo.lat; lng = geo.lng; }
  }
  if (!lat) { toast('Adresse non géocodée : l’arrêt sera ignoré par l’optimisation.', 'warn', 5000); }
  const data = {
    name: String(fd.get('name') || '').trim(),
    address,
    phone: String(fd.get('phone') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    notes: String(fd.get('notes') || '').trim(),
    type: fd.get('type') === 'pickup' ? 'pickup' : 'delivery',
    date: String(fd.get('date') || currentDate()),
    priority: Math.min(3, Math.max(1, Number(fd.get('priority')) || 1)),
    windowStart: fd.get('windowStart') || null,
    windowEnd: fd.get('windowEnd') || null,
    serviceMin: Number(fd.get('serviceMin')) || 0,
    weightKg: Number(fd.get('weightKg')) || 0,
    volumeM3: Number(fd.get('volumeM3')) || 0,
    pallets: Number(fd.get('pallets')) || 0,
    skillsRequired: String(fd.get('skillsRequired') || '').split(',').map((x) => x.trim()).filter(Boolean),
    teamGroup: String(fd.get('teamGroup') || '').trim() || null,
    pairedWith: fd.get('pairedWith') || null,
    barcodes: String(fd.get('barcodes') || '').split('|').filter(Boolean),
    geo: { lat, lng, display: address },
  };
  if (!data.name || !data.address) { toast('Nom et adresse sont obligatoires.', 'error'); return; }

  ensureDate(state, data.date);
  if (existing) {
    if (existing.date !== data.date) {
      // Un arrêt déplacé de jour doit être réaffecté.
      data.driverId = null;
      data.seq = null;
      data.eta = null;
    }
    Object.assign(existing, data, { geo: { ...(existing.geo || {}), ...data.geo } });
  } else {
    const created = newStop(data);
    state.stops.push(created);
  }
  save();
  closeModal();
  activeTab = 'stops';
  switchTab('stops');
  updateMap();
  toast(existing ? 'Arrêt mis à jour.' : 'Arrêt ajouté.', 'success');
}

/* ------------------------------------------------------------------ */
/* Conducteurs                                                         */
/* ------------------------------------------------------------------ */

function renderDrivers() {
  const date = currentDate();
  const loads = computeLoads(state, date);
  panel().innerHTML = `
    <div class="p-3 md:p-4 space-y-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Conducteurs & véhicules</h1>
          <p class="text-xs text-slate-500">${state.drivers.length} ressource(s) · ${formatDateFR(date)}</p>
        </div>
        <button type="button" data-action="add-driver" class="min-h-[44px] px-3 bg-brand-600 text-white rounded-xl text-xs font-bold flex items-center gap-2">
          <i class="fa-solid fa-plus"></i> Ajouter
        </button>
      </div>
      <div class="space-y-2">
        ${state.drivers.map((d) => {
          const load = loads.get(d.id) || { stops: 0, weightKg: 0, pallets: 0, volumeM3: 0 };
          const util = d.capacity?.kg ? Math.round((load.weightKg / d.capacity.kg) * 100) : 0;
          return `
            <article class="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
              <div class="flex items-start gap-2.5">
                <span class="w-9 h-9 rounded-full flex items-center justify-center text-white font-extrabold flex-shrink-0" style="background:${d.color || '#0284c7'}">${escapeHtml((d.name || '?').slice(0, 1).toUpperCase())}</span>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <h3 class="font-bold text-sm text-slate-900 truncate">${escapeHtml(d.name || 'Sans nom')}</h3>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${d.active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">${d.active !== false ? 'Actif' : 'Inactif'}</span>
                  </div>
                  <p class="text-[11px] text-slate-500 mt-0.5">
                    <i class="fa-solid fa-clock mr-1"></i>${d.shift?.start || '08:00'}–${d.shift?.end || '18:00'}
                    <span class="mx-1">·</span><i class="fa-solid fa-euro-sign"></i> ${d.hourlyCost || 0}/h
                    ${d.phone ? `<span class="mx-1">·</span><a href="tel:${escapeHtml(d.phone)}" class="text-brand-600">${escapeHtml(d.phone)}</a>` : ''}
                  </p>
                  <p class="text-[11px] text-slate-500 mt-1">
                    <i class="fa-solid fa-truck mr-1"></i>${d.capacity?.kg || 0} kg · ${d.capacity?.m3 || 0} m³ · ${d.capacity?.pallets || 0} pal.
                    ${(d.skills || []).length ? `<span class="ml-1 text-indigo-600">${d.skills.map(escapeHtml).join(', ')}</span>` : ''}
                  </p>
                  <div class="mt-2">
                    <div class="flex justify-between text-[10px] text-slate-500 mb-1"><span>Charge du jour : ${load.stops} arrêt(s) · ${load.weightKg} kg</span><span class="font-bold ${util > 100 ? 'text-red-600' : 'text-slate-700'}">${util}%</span></div>
                    <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${util > 100 ? 'bg-red-500' : 'bg-emerald-500'}" style="width:${Math.min(100, util)}%"></div></div>
                  </div>
                </div>
              </div>
              <div class="flex items-center justify-end gap-1 mt-2 pt-2 border-t border-slate-100">
                <a href="?mode=conducteur&d=${encodeURIComponent(d.id)}" class="min-h-[36px] px-2.5 rounded-lg text-[11px] font-semibold text-brand-700 bg-brand-50 flex items-center gap-1"><i class="fa-solid fa-mobile-screen"></i> Vue livreur</a>
                <button type="button" data-action="edit-driver" data-id="${d.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 flex items-center justify-center" title="Modifier"><i class="fa-solid fa-pen"></i></button>
                <button type="button" data-action="delete-driver" data-id="${d.id}" class="w-9 h-9 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center" title="Supprimer"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </article>`;
        }).join('') || `
          <div class="bg-white rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            Aucun conducteur. Ajoutez un véhicule pour optimiser.
          </div>`}
      </div>
      <div class="bg-brand-50 border border-brand-200 rounded-xl p-3 text-[11px] text-brand-900">
        <i class="fa-solid fa-circle-info mr-1"></i> Les compétences (ex. <b>fr</b>, <b>frigo</b>) filtrent les arrêts exigeant ces mêmes compétences. La capacité bloque l’affectation au-delà du seuil.
      </div>
    </div>`;
}

function openDriverModal(driver = null) {
  const isEdit = Boolean(driver);
  const d = driver || newDriver({ name: '' });
  openModal(`
    ${modalHeader(isEdit ? 'Modifier le conducteur' : 'Nouveau conducteur', isEdit ? d.name : '')}
    <form data-driver-form data-id="${isEdit ? d.id : ''}" class="p-4 space-y-3">
      <div class="grid grid-cols-2 gap-2">
        <div class="col-span-2"><label class="block text-xs font-semibold text-slate-600 mb-1">Nom *</label>
          <input name="name" required value="${escapeHtml(d.name)}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="Marie Dupont"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Téléphone</label>
          <input name="phone" type="tel" value="${escapeHtml(d.phone)}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Couleur</label>
          <input name="color" type="color" value="${/^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#0284c7'}" class="w-full h-[46px] px-1 py-1 border border-slate-300 rounded-lg"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Début service</label>
          <input name="shiftStart" type="time" value="${d.shift?.start || '08:00'}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Fin service</label>
          <input name="shiftEnd" type="time" value="${d.shift?.end || '18:00'}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Coût horaire (€)</label>
          <input name="hourlyCost" type="number" min="0" step="0.5" value="${d.hourlyCost ?? 30}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Capacité kg</label>
          <input name="capKg" type="number" min="0" value="${d.capacity?.kg ?? 800}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Capacité m³</label>
          <input name="capM3" type="number" min="0" step="0.1" value="${d.capacity?.m3 ?? 8}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Capacité palettes</label>
          <input name="capPallets" type="number" min="0" value="${d.capacity?.pallets ?? 6}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
        <div><label class="block text-xs font-semibold text-slate-600 mb-1">Compétences</label>
          <input name="skills" value="${escapeHtml((d.skills || []).join(', '))}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="fr, frigo"></div>
        <div class="col-span-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <input type="checkbox" name="active" id="driver-active" ${d.active !== false ? 'checked' : ''} class="w-5 h-5 rounded text-brand-600">
          <label for="driver-active" class="text-sm text-slate-700">Conducteur actif (inclus dans l’optimisation)</label>
        </div>
      </div>
      <div class="flex gap-2 pt-1">
        <button type="button" data-modal-close class="px-4 min-h-[48px] rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">Annuler</button>
        <button type="submit" class="flex-1 min-h-[48px] bg-brand-600 text-white rounded-xl text-sm font-bold"><i class="fa-solid fa-floppy-disk mr-2"></i>${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>`);
}

function submitDriverForm(form) {
  const fd = new FormData(form);
  const id = form.dataset.id;
  const existing = id ? getDriver(state, id) : null;
  const data = {
    name: String(fd.get('name') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    color: String(fd.get('color') || '#0284c7'),
    shift: { start: fd.get('shiftStart') || '08:00', end: fd.get('shiftEnd') || '18:00' },
    hourlyCost: Number(fd.get('hourlyCost')) || 0,
    capacity: { kg: Number(fd.get('capKg')) || 0, m3: Number(fd.get('capM3')) || 0, pallets: Number(fd.get('capPallets')) || 0 },
    skills: String(fd.get('skills') || '').split(',').map((x) => x.trim()).filter(Boolean),
    active: fd.get('active') === 'on',
  };
  if (!data.name) { toast('Le nom est obligatoire.', 'error'); return; }
  if (existing) Object.assign(existing, data);
  else state.drivers.push(newDriver(data));
  save();
  closeModal();
  renderPanel();
  updateMap();
  toast(existing ? 'Conducteur mis à jour.' : 'Conducteur créé.', 'success');
}

/* ------------------------------------------------------------------ */
/* Import CSV / JSON, démo                                            */
/* ------------------------------------------------------------------ */

function progressOverlay(title) {
  modalRoot().innerHTML = `
    <div class="fixed inset-0 z-[130] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-6">
      <div class="bg-white rounded-2xl shadow-2xl p-5 w-full max-w-sm">
        <h3 class="font-bold text-slate-900 text-sm">${escapeHtml(title)}</h3>
        <p class="text-xs text-slate-500 mt-1" data-progress-text>Préparation…</p>
        <div class="h-2 bg-slate-100 rounded-full overflow-hidden mt-3"><div class="h-full bg-brand-600 transition-all" data-progress-bar style="width:0%"></div></div>
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
  return {
    update(done, total, label) {
      const bar = modalRoot().querySelector('[data-progress-bar]');
      const txt = modalRoot().querySelector('[data-progress-text]');
      if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      if (txt) txt.textContent = label || `${done}/${total}`;
    },
    close() { modalRoot().innerHTML = ''; document.body.style.overflow = ''; },
  };
}

async function importCSVFile(file) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) { toast('CSV vide ou illisible.', 'error'); return; }
  const limited = rows.slice(0, 80);
  const progress = progressOverlay(`Import de ${limited.length} commande(s)`);
  let added = 0;
  let failed = 0;
  for (let i = 0; i < limited.length; i++) {
    const row = limited[i];
    progress.update(i, limited.length, `Géocodage ${i + 1}/${limited.length} : ${row.adresse || row.address || row.nom || '—'}`);
    try {
      const partial = csvRowToStop(row, { date: currentDate() });
      if (!partial.address || !partial.name) { failed += 1; continue; }
      let lat = Number(row.lat || row.latitude) || 0;
      let lng = Number(row.lng || row.lon || row.longitude) || 0;
      if (!lat || !lng) {
        const geo = await geocode(partial.address);
        if (!geo) { failed += 1; continue; }
        lat = geo.lat; lng = geo.lng;
      }
      const data = {
        ...partial,
        address: partial.address,
        serviceMin: partial.serviceMin ?? state.settings.hours.serviceDefaultMin,
        geo: { lat, lng, display: partial.address },
      };
      state.stops.push(newStop(data));
      ensureDate(state, data.date);
      added += 1;
    } catch (err) {
      console.warn('[app] ligne CSV', err);
      failed += 1;
    }
  }
  progress.update(limited.length, limited.length, 'Enregistrement…');
  save();
  setTimeout(() => progress.close(), 500);
  renderAll();
  toast(`${added} commande(s) importée(s)${failed ? `, ${failed} ignorée(s)` : ''}.`, failed ? 'warn' : 'success', 5000);
}

async function handleImportFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    if (!confirm('Remplacer toutes les données actuelles par ce fichier JSON ?')) return;
    try {
      state = await importJSONFile(file);
      save();
      selectedDriverId = null;
      renderAll();
      toast('Données importées.', 'success');
    } catch (err) {
      console.error(err);
      toast('Fichier JSON invalide.', 'error');
    }
    return;
  }
  await importCSVFile(file);
}

function seedDemo() {
  if (state.stops.length && !confirm('Ajouter les données de démonstration aux données existantes ?')) return;
  const date = currentDate();
  if (!state.drivers.length) {
    state.drivers.push(newDriver({ name: 'Marie Dupont', phone: '06 12 34 56 78', color: '#0284c7', capacity: { kg: 900, m3: 10, pallets: 8 }, skills: ['fr', 'frigo'] }));
    state.drivers.push(newDriver({ name: 'Karim Benali', phone: '06 98 76 54 32', color: '#7c3aed', capacity: { kg: 1200, m3: 14, pallets: 10 }, skills: ['fr'] }));
  }
  state.settings.depot = { name: 'Dépôt Paris 11e', address: '18 rue de la Roquette, 75011 Paris', lat: 48.8556, lng: 2.3738 };
  const mk = (p) => { const s = newStop({ date, ...p }); state.stops.push(s); return s; };
  mk({ name: 'Boulangerie Moulin', address: '10 rue de Rivoli, 75004 Paris', phone: '01 42 60 12 34', geo: { lat: 48.8555, lng: 2.358, display: '10 rue de Rivoli, Paris' }, priority: 2, windowStart: '08:30', windowEnd: '10:00', serviceMin: 10, weightKg: 120, volumeM3: 0.8, notes: '2 sacs de farine' });
  mk({ name: 'Café de la Gare', address: '15 boulevard Diderot, 75012 Paris', phone: '06 12 34 56 78', geo: { lat: 48.845, lng: 2.373, display: '15 boulevard Diderot, Paris' }, windowStart: '10:30', windowEnd: '12:00', serviceMin: 10, weightKg: 60, notes: 'Code 45B2' });
  mk({ name: 'Pharmacie Royale', address: '50 avenue des Champs-Élysées, 75008 Paris', phone: '01 45 61 00 00', geo: { lat: 48.87, lng: 2.305, display: '50 avenue des Champs-Élysées, Paris' }, priority: 3, windowStart: '14:00', windowEnd: '16:00', serviceMin: 15, weightKg: 40 });
  mk({ name: 'Hôtel Belleville', address: '22 rue de Belleville, 75020 Paris', geo: { lat: 48.872, lng: 2.381, display: '22 rue de Belleville, Paris' }, serviceMin: 15, weightKg: 200, volumeM3: 1.2, windowStart: '11:00', windowEnd: '13:00' });
  const pickup = mk({ name: 'Entrepôt Vin — collecte', address: '5 rue de Charonne, 75011 Paris', geo: { lat: 48.853, lng: 2.376, display: '5 rue de Charonne, Paris' }, type: 'pickup', serviceMin: 10, weightKg: 150, teamGroup: 'Chaîne froid' });
  const delivery = mk({ name: 'Restaurant Chez Léa', address: '3 rue Oberkampf, 75011 Paris', geo: { lat: 48.865, lng: 2.368, display: '3 rue Oberkampf, Paris' }, serviceMin: 10, weightKg: 150, teamGroup: 'Chaîne froid', notes: 'Livrer avant 15h' });
  pickup.pairedWith = delivery.id;
  delivery.pairedWith = pickup.id;
  mk({ name: 'Chantier A — lot 1', address: '8 rue des Pyrénées, 75020 Paris', geo: { lat: 48.868, lng: 2.392, display: '8 rue des Pyrénées, Paris' }, teamGroup: 'Chantier A', serviceMin: 20, weightKg: 300, volumeM3: 2.5, priority: 2 });
  mk({ name: 'Chantier A — lot 2', address: '10 rue des Pyrénées, 75020 Paris', geo: { lat: 48.8685, lng: 2.3925, display: '10 rue des Pyrénées, Paris' }, teamGroup: 'Chantier A', serviceMin: 20, weightKg: 180, volumeM3: 1.1, priority: 2, skillsRequired: ['fr'] });
  ensureDate(state, date);
  save();
  renderAll();
  toast('Démo chargée — cliquez sur « Optimiser tout ».', 'success', 4500);
}

/* ------------------------------------------------------------------ */
/* Vue Tournées                                                        */
/* ------------------------------------------------------------------ */

let balanceMode = 'stops';
let optimizing = false;

function latestPlanFor(date, driverId) {
  const entry = (state.history || []).find((h) => h.type === 'optimize' && h.date === date);
  return entry?.drivers?.find((d) => d.driverId === driverId) || null;
}

function routeStats(driver, stops) {
  const hist = latestPlanFor(currentDate(), driver.id);
  const est = stops.length ? estimateTour(state.settings.depot, stops, state.settings.routing.profile, state.settings.hours.avgSpeedKmh) : { distanceKm: 0, durationMin: 0 };
  return {
    distanceKm: hist?.distanceKm ?? est.distanceKm,
    durationMin: hist?.durationMin ?? est.durationMin,
    estimated: !hist,
  };
}

function renderRoutes() {
  const date = currentDate();
  const drivers = state.drivers;
  if (!selectedDriverId || !drivers.some((d) => d.id === selectedDriverId)) {
    selectedDriverId = drivers[0]?.id || null;
  }
  const driver = drivers.find((d) => d.id === selectedDriverId);
  const stops = driver ? getDriverRoute(state, driver.id, date) : [];
  const unassigned = state.stops.filter((s) => s.date === date && !s.driverId && s.status === 'pending');
  const stats = driver ? routeStats(driver, stops) : { distanceKm: 0, durationMin: 0 };
  const load = stops.reduce((a, s) => ({ kg: a.kg + (Number(s.weightKg) || 0), m3: a.m3 + (Number(s.volumeM3) || 0), pal: a.pal + (Number(s.pallets) || 0) }), { kg: 0, m3: 0, pal: 0 });
  const cap = driver?.capacity || {};

  panel().innerHTML = `
    <div class="p-3 md:p-4 space-y-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Tournées</h1>
          <p class="text-xs text-slate-500">${formatDateFR(date)} · ${stops.length} arrêt(s)${unassigned.length ? ` · ${unassigned.length} non affecté(s)` : ''}</p>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" data-action="publish-day" class="h-10 px-3 rounded-xl bg-emerald-600 active:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5" title="Envoyer la journée aux chauffeurs"><i class="fa-solid fa-tower-broadcast"></i> Publier</button>
          <button type="button" data-action="fetch-retours" class="h-10 px-3 rounded-xl bg-white border border-slate-200 text-slate-600 text-xs font-bold flex items-center gap-1.5" title="Récupérer les statuts des chauffeurs"><i class="fa-solid fa-rotate"></i> Retours</button>
          <button type="button" data-action="print-route" class="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-600 flex items-center justify-center" title="Imprimer"><i class="fa-solid fa-print"></i></button>
        </div>
      </div>

      <div class="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        ${drivers.map((d) => `
          <button type="button" data-route-driver="${d.id}" class="flex-shrink-0 min-h-[38px] px-3 rounded-full text-[11px] font-bold border flex items-center gap-1.5 ${d.id === selectedDriverId ? 'text-white border-transparent' : 'bg-white text-slate-600 border-slate-200'}" style="${d.id === selectedDriverId ? `background:${d.color || '#0284c7'}` : ''}">
            <span class="w-2 h-2 rounded-full" style="background:${d.id === selectedDriverId ? '#fff' : d.color}"></span>${escapeHtml(d.name)}
          </button>`).join('') || '<span class="text-xs text-slate-400">Aucun conducteur</span>'}
      </div>

      ${driver ? `
        <div class="bg-slate-900 text-white rounded-xl p-3">
          <div class="flex items-center justify-between">
            <p class="text-[10px] uppercase tracking-wider text-brand-400 font-bold">Tournée ${escapeHtml(driver.name)}</p>
            <span class="text-[10px] px-2 py-0.5 rounded-full ${stats.estimated ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}">${stats.estimated ? 'estimation' : 'optimisée'}</span>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-2 text-center">
            <div><p class="text-lg font-extrabold">${stats.distanceKm.toFixed(1)}</p><p class="text-[10px] text-slate-400">km</p></div>
            <div><p class="text-lg font-extrabold">${Math.floor(stats.durationMin / 60)}h${String(Math.round(stats.durationMin % 60)).padStart(2, '0')}</p><p class="text-[10px] text-slate-400">durée</p></div>
            <div><p class="text-lg font-extrabold">${stops.length}</p><p class="text-[10px] text-slate-400">arrêts</p></div>
          </div>
          <div class="mt-2 pt-2 border-t border-slate-700/60 flex items-center justify-between text-[10px] text-slate-300">
            <span>Chargement : ${load.kg} / ${cap.kg || '—'} kg · ${load.m3} m³</span>
            <span class="font-bold ${load.kg > (cap.kg || Infinity) ? 'text-red-400' : 'text-emerald-400'}">${cap.kg ? Math.round((load.kg / cap.kg) * 100) : 0}%</span>
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="optimize-all" ${optimizing ? 'disabled' : ''} class="flex-1 min-h-[44px] bg-emerald-600 active:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2">
            <i class="fa-solid fa-wand-magic-sparkles"></i> ${optimizing ? 'Optimisation…' : 'Optimiser tout'}
          </button>
          <button type="button" data-action="optimize-driver" ${optimizing ? 'disabled' : ''} class="min-h-[44px] px-3 bg-white border border-slate-200 text-slate-700 rounded-xl text-xs font-bold">Ce conducteur</button>
        </div>
        <div class="flex items-center gap-2 text-[11px] text-slate-500">
          <label class="font-semibold">Équilibrage :</label>
          <select data-balance class="flex-1 px-2 py-2 bg-white border border-slate-200 rounded-lg text-xs">
            <option value="none" ${balanceMode === 'none' ? 'selected' : ''}>Aucun</option>
            <option value="stops" ${balanceMode === 'stops' ? 'selected' : ''}>Nombre d’arrêts</option>
            <option value="minutes" ${balanceMode === 'minutes' ? 'selected' : ''}>Minutes conducteur</option>
          </select>
          <button type="button" data-action="recalc-eta" class="px-2 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-semibold">ETA</button>
        </div>

        <div id="route-list" class="space-y-2">
          ${stops.length ? stops.map((s, i) => `
            <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-2.5 flex items-start gap-2" draggable="true" data-route-row="${s.id}">
              <span class="cursor-grab text-slate-300 pt-1 hidden md:block" title="Glisser"><i class="fa-solid fa-grip-vertical"></i></span>
              <span class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-extrabold text-white flex-shrink-0" style="background:${driver.color || '#0284c7'}">${i + 1}</span>
              <div class="flex-1 min-w-0">
                <p class="font-bold text-xs text-slate-900 truncate">${escapeHtml(s.name)}</p>
                <p class="text-[10px] text-slate-500 truncate">${escapeHtml(s.address)}</p>
                <div class="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                  <span><i class="fa-regular fa-clock mr-0.5"></i>${s.eta ? new Date(s.eta).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                  ${s.windowStart ? `<span>${s.windowStart}–${s.windowEnd || ''}</span>` : ''}
                  <span>${s.weightKg || 0} kg</span>
                  ${statusBadge(s.status)}
                </div>
              </div>
              <div class="flex flex-col gap-0.5">
                <button type="button" data-action="move-up" data-id="${s.id}" class="w-7 h-7 text-slate-400 hover:text-brand-600 rounded" title="Monter"><i class="fa-solid fa-chevron-up text-[10px]"></i></button>
                <button type="button" data-action="move-down" data-id="${s.id}" class="w-7 h-7 text-slate-400 hover:text-brand-600 rounded" title="Descendre"><i class="fa-solid fa-chevron-down text-[10px]"></i></button>
                <button type="button" data-action="unassign-stop" data-id="${s.id}" class="w-7 h-7 text-slate-300 hover:text-red-500 rounded" title="Retirer"><i class="fa-solid fa-xmark text-[10px]"></i></button>
              </div>
            </div>`).join('') : '<p class="text-center text-xs text-slate-400 py-6">Aucun arrêt affecté. Optimisez ou affectez manuellement.</p>'}
        </div>
      ` : '<p class="text-center text-sm text-slate-400 py-8">Créez un conducteur pour commencer.</p>'}

      ${unassigned.length ? `
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <h3 class="text-xs font-bold text-amber-900 mb-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Non affectés (${unassigned.length})</h3>
          <div class="space-y-2">
            ${unassigned.map((s) => `
              <div class="flex items-center gap-2 bg-white rounded-lg border border-amber-200 p-2">
                <div class="flex-1 min-w-0"><p class="text-[11px] font-semibold truncate">${escapeHtml(s.name)}</p><p class="text-[10px] text-slate-400 truncate">${escapeHtml(s.address)}</p></div>
                <select data-assign-stop="${s.id}" class="text-[10px] border border-slate-200 rounded px-1 py-1">
                  <option value="">Affecter…</option>
                  ${drivers.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}
                </select>
              </div>`).join('')}
          </div>
        </div>` : ''}
    </div>`;
}

async function optimizeNow(scope = 'all') {
  if (optimizing) return;
  const date = currentDate();
  const pending = state.stops.filter((s) => s.date === date && s.status === 'pending');
  if (!pending.length) { toast('Aucun arrêt à optimiser.', 'warn'); return; }
  if (!state.drivers.some((d) => d.active !== false)) { toast('Aucun conducteur actif.', 'error'); return; }
  optimizing = true;
  renderPanel();
  toast('Calcul des itinéraires et affectation…', 'info', 2500);
  try {
    const points = [state.settings.depot, ...pending.map((s) => s.geo)];
    const mat = await routeMatrix(points, {
      profile: state.settings.routing.profile,
      vehicle: state.settings.routing.vehicle,
      avoidMotorways: state.settings.routing.avoidMotorways,
      avgSpeedKmh: state.settings.hours.avgSpeedKmh,
    });
    const provided = {
      ...mat,
      points,
      keys: ['__depot', ...pending.map((s) => s.id)],
    };
    const plan = optimize(state, {
      date,
      balance: balanceMode,
      driverId: scope === 'driver' ? selectedDriverId : null,
      matrix: provided,
    });
    save();
    renderAll();
    const un = plan.unassigned?.length || 0;
    toast(`Tournée optimisée : ${plan.summary.assigned} arrêt(s), ${plan.summary.distanceKm.toFixed(1)} km${un ? ` · ${un} non affecté(s)` : ''}.`, un ? 'warn' : 'success', 5000);
  } catch (err) {
    console.error('[app] optimisation', err);
    toast('Optimisation impossible — repli sur l’estimation locale.', 'error');
    const plan = optimize(state, { date, balance: balanceMode, driverId: scope === 'driver' ? selectedDriverId : null });
    save();
    renderAll();
  } finally {
    optimizing = false;
    renderPanel();
  }
}

function moveRouteStop(stopId, dir) {
  const stop = getStop(state, stopId);
  if (!stop?.driverId) return;
  const list = getDriverRoute(state, stop.driverId, stop.date).filter((s) => s.status === 'pending');
  const idx = list.findIndex((s) => s.id === stopId);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= list.length) return;
  [list[idx], list[target]] = [list[target], list[idx]];
  applyManualOrder(state, stop.driverId, stop.date, list.map((s) => s.id));
  save();
  renderPanel();
  updateMap();
}

function assignStop(stopId, driverId) {
  const stop = getStop(state, stopId);
  if (!stop) return;
  if (!driverId) {
    stop.driverId = null; stop.seq = null; stop.eta = null;
  } else {
    const driver = getDriver(state, driverId);
    const seq = getDriverRoute(state, driverId, stop.date).filter((s) => s.status === 'pending').length + 1;
    stop.driverId = driverId;
    stop.seq = seq;
    stop.eta = null;
    recomputeEtas(state, driverId, stop.date);
    if (driver) toast(`Affecté à ${driver.name}.`, 'success');
  }
  save();
  renderAll();
}

/* ------------------------------------------------------------------ */
/* Planning hebdomadaire                                               */
/* ------------------------------------------------------------------ */

let weekStart = null;

// weekly board — vue 7 jours (planning hebdomadaire)
function renderPlanning() {
  const base = currentDate();
  if (!weekStart || !weekStart.startsWith('20')) weekStart = mondayISO(base);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));
  const today = todayISO();

  const dayData = days.map((d) => {
    const stops = state.stops.filter((s) => s.date === d);
    const drivers = [...new Set(stops.map((s) => s.driverId).filter(Boolean))];
    const km = drivers.reduce((sum, id) => {
      const list = getDriverRoute(state, id, d);
      return sum + (list.length ? estimateTour(state.settings.depot, list, state.settings.routing.profile, state.settings.hours.avgSpeedKmh).distanceKm : 0);
    }, 0);
    return { date: d, stops, drivers, km };
  });

  panel().innerHTML = `
    <div class="p-3 md:p-4 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Planning hebdomadaire</h1>
          <p class="text-xs text-slate-500">Semaine du ${formatDateFR(weekStart, { weekday: false })}</p>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" data-action="week-prev" class="w-9 h-9 rounded-lg bg-white border border-slate-200 text-slate-600"><i class="fa-solid fa-chevron-left text-xs"></i></button>
          <button type="button" data-action="week-today" class="px-2 h-9 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-600">Auj.</button>
          <button type="button" data-action="week-next" class="w-9 h-9 rounded-lg bg-white border border-slate-200 text-slate-600"><i class="fa-solid fa-chevron-right text-xs"></i></button>
        </div>
      </div>

      <div class="flex gap-2 overflow-x-auto pb-2 snap-x">
        ${dayData.map(({ date, stops, drivers, km }) => `
          <section class="snap-start flex-shrink-0 w-[270px] bg-slate-50 border ${date === today ? 'border-brand-300' : 'border-slate-200'} rounded-xl flex flex-col" data-week-day="${date}">
            <div class="px-3 py-2 border-b border-slate-200 flex items-center justify-between gap-1">
              <button type="button" data-action="planning-set-day" data-date="${date}" class="text-left min-w-0">
                <p class="text-[10px] uppercase font-bold tracking-wider ${date === today ? 'text-brand-600' : 'text-slate-400'}">${new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short' })}</p>
                <p class="text-xs font-extrabold text-slate-800">${new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}</p>
              </button>
              <div class="text-right">
                <p class="text-[10px] font-bold text-slate-600">${stops.length} arrêt(s)</p>
                <p class="text-[9px] text-slate-400">${km ? `${km.toFixed(0)} km` : '—'}</p>
              </div>
            </div>
            <div class="p-2 space-y-1.5 flex-1 min-h-[80px]" data-week-drop="${date}">
              ${stops.sort((a, b) => (a.seq ?? 99) - (b.seq ?? 99)).map((s) => {
                const d = driverOf(s);
                return `
                  <div class="bg-white rounded-lg border border-slate-200 p-2 shadow-sm cursor-grab" draggable="true" data-week-stop="${s.id}">
                    <div class="flex items-start gap-1.5">
                      <span class="w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0" style="background:${d?.color || '#94a3b8'}"></span>
                      <p class="text-[11px] font-semibold text-slate-800 leading-tight flex-1 min-w-0 break-words">${escapeHtml(s.name)}</p>
                      ${priorityBadge(s.priority)}
                    </div>
                    <p class="text-[9px] text-slate-400 mt-0.5 pl-3 truncate">${d ? escapeHtml(d.name) : 'Non affecté'}${s.windowStart ? ` · ${s.windowStart}` : ''}</p>
                    <select data-move-stop="${s.id}" class="mt-1 w-full text-[9px] bg-slate-50 border border-slate-200 rounded px-1 py-0.5 text-slate-600" title="Déplacer vers un autre jour">
                      ${days.map((dd) => `<option value="${dd}" ${dd === s.date ? 'selected' : ''}>${new Date(`${dd}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit' })}</option>`).join('')}
                    </select>
                  </div>`;
              }).join('') || '<p class="text-[10px] text-slate-400 text-center py-4">Glissez une commande ici</p>'}
            </div>
            <div class="p-2 border-t border-slate-200 flex gap-1">
              <button type="button" data-action="planning-add-stop" data-date="${date}" class="flex-1 min-h-[34px] bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-600"><i class="fa-solid fa-plus mr-1"></i>Commande</button>
              <button type="button" data-action="planning-optimize" data-date="${date}" class="flex-1 min-h-[34px] bg-slate-900 text-white rounded-lg text-[10px] font-bold"><i class="fa-solid fa-wand-magic-sparkles mr-1"></i>Optimiser</button>
            </div>
          </section>`).join('')}
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-3">
        <h3 class="text-xs font-bold text-slate-700"><i class="fa-solid fa-circle-info text-brand-500 mr-1"></i>Glisser-déposer & multi-jours</h3>
        <p class="text-[11px] text-slate-500 mt-1">Faites glisser une carte vers un autre jour (ou utilisez le sélecteur). Les arrêts déplacés sont détachés du conducteur pour être réaffectés.</p>
        <label class="flex items-center gap-2 mt-2 text-[11px] text-slate-600">
          <input type="checkbox" data-overnight class="w-4 h-4 rounded">
          <span>« Dormir sur place » : conserver le conducteur lors d’un déplacement vers le jour suivant (multi-jours simplifié).</span>
        </label>
      </div>
    </div>`;
}

function moveStopToDate(stopId, newDate, keepDriver = false) {
  const stop = getStop(state, stopId);
  if (!stop || !newDate || stop.date === newDate) return;
  stop.date = newDate;
  ensureDate(state, newDate);
  if (!keepDriver) { stop.driverId = null; stop.seq = null; stop.eta = null; }
  else if (stop.driverId) {
    const maxSeq = getDriverRoute(state, stop.driverId, newDate).reduce((m, s) => Math.max(m, s.seq || 0), 0);
    stop.seq = maxSeq + 1;
  }
  save();
  renderPlanning();
  updateMap();
  toast(`Déplacé au ${formatDateFR(newDate, { weekday: false })}.`, 'success');
}

/* ------------------------------------------------------------------ */
/* Réglages                                                            */
/* ------------------------------------------------------------------ */

function podRowHTML(field) {
  return `<div class="flex items-center gap-1.5" data-pod-row>
    <input type="hidden" data-pod-id value="${escapeHtml(field.id)}">
    <input data-pod-label value="${escapeHtml(field.label || '')}" placeholder="Libellé du champ" class="flex-1 min-w-0 px-2 py-2 border border-slate-300 rounded-lg text-xs">
    <select data-pod-type class="px-1.5 py-2 border border-slate-300 rounded-lg text-[11px]">
      ${['check', 'text', 'number', 'photo', 'signature'].map((t) => `<option value="${t}" ${field.type === t ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <button type="button" data-action="pod-del-field" class="w-8 h-8 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"><i class="fa-solid fa-xmark"></i></button>
  </div>`;
}


/* ============ v4 : COMPTES & BACK-OFFICE ============ */

async function doLogout() {
  if (auth.user && auth.user.role === 'admin' && auth.online) { clearTimeout(wsPushTimer); await pushWorkspace(); }
  logout();
  clearDriverScope();
  updateHeaderChip();
  toast('Déconnecté du serveur.', 'info');
  showGateAgain(async () => { updateHeaderChip(); if (auth.user && auth.user.role === 'admin') await pullAdminWorkspace(); routeFromUrl(); });
}


/* ===== V5 — conducteur connecté & suivi temps réel ===== */
const SCOPE_BACKUP = 'roadoptimizur.v3.scopebak';
const SCOPE_ACTIVE = 'roadoptimizur.v3.scopeactive';
let serverScope = null; let tourPushTimer = null; let liveTimer = null; let posWatchId = null; let lastPos = null; let lastPosPushAt = 0; let driverSyncTimer = null; let lastEditAt = 0; let suppressPushUntil = 0;
function fmtTimeFR(iso) { try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
async function enterDriverPlanner(user) {
  if (!auth.online) return false;
  const ref = String(user.driverRef ?? user.driver_ref ?? user.id);
  const active = localStorage.getItem(SCOPE_ACTIVE);
  if (active !== ref) {
    const bak0 = localStorage.getItem(SCOPE_BACKUP);
    if (active && bak0) { try { Object.assign(state, JSON.parse(bak0)); } catch {} }
    localStorage.setItem(SCOPE_BACKUP, JSON.stringify(state));
    localStorage.setItem(SCOPE_ACTIVE, ref);
  }
  serverScope = { driverId: ref, dates: {}, pushEnabled: false };
  state.drivers = [{ id: ref, name: user.name, color: '#0ea5e9', phone: user.phone || '' }];
  applyRoleChrome();
  startPosWatch();
  showOnly('planner-view');
  const okWeek = await driverPullWeek();
  if (!okWeek) toast('Connexion au serveur impossible — dernière version locale affichée.', 'warn', 6000);
  switchTab('stops');
  setTimeout(() => { if (serverScope) serverScope.pushEnabled = true; }, 3000);
  if (!driverSyncTimer) driverSyncTimer = setInterval(() => { if (serverScope && !document.hidden) driverPullWeek({ silent: true }); }, 60000);
  document.addEventListener('visibilitychange', onDriverVisible);
  return true;
}
function onDriverVisible() { if (!document.hidden && serverScope && auth.online) driverPullWeek({ silent: true }); }
function applyOneTour(tour, date) {
  suppressPushUntil = Date.now() + 5000;
  if (tour.depot) state.settings.depot = tour.depot;
  const keep = state.stops.filter((s) => s.date !== date || String(s.driverId) !== serverScope.driverId);
  const mapped = (tour.stops || []).map((st) => ({ ...st, date, driverId: serverScope.driverId, id: st.id || uid() }));
  state.stops = keep.concat(mapped);
  serverScope.dates[date] = { savedAt: tour.savedAt || null, updatedAt: tour.updated || null, count: mapped.length };
  return mapped.length;
}
async function driverPullWeek(opts = {}) {
  if (!serverScope || !auth.online) return false;
  try {
    const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const r = await api('/my-week?from=' + from);
    if (!r.ok) return false;
    const tours = (r.data.tours || []).sort((a, b) => a.date.localeCompare(b.date));
    let touched = 0;
    for (const t of tours) {
      const prev = serverScope.dates[t.date];
      const stamp = String(t.savedAt || '') + '|' + String(t.updated || '');
      const prevStamp = prev ? String(prev.savedAt || '') + '|' + String(prev.updated || '') : null;
      if (prevStamp === stamp) continue;
      if (Date.now() - lastEditAt < 8000) continue;
      if (applyOneTour(t.tour, t.date)) touched++;
    }
    const cur = currentDate();
    const hasToday = state.stops.some((s) => s.date === cur && String(s.driverId) === serverScope.driverId);
    if (!hasToday && tours.length && tours[0].date !== cur) { ensureDate(state, tours[0].date); state.planning.activeDate = tours[0].date; touched++; }
    if (touched) { save(); renderAll(); if (!opts.silent && touched) toast('Tournées synchronisées.', 'ok', 2500); }
    if (!tours.length && !opts.silent) toast('Aucune tournée publiée pour ce compte. Préviens le dispatch.', 'warn', 6000);
    return true;
  } catch { return false; }
}
function clearDriverScope() {
  serverScope = null; stopPosWatch();
  if (driverSyncTimer) { clearInterval(driverSyncTimer); driverSyncTimer = null; }
  document.removeEventListener('visibilitychange', onDriverVisible);
  const bak = localStorage.getItem(SCOPE_BACKUP);
  if (bak) { try { Object.assign(state, JSON.parse(bak)); } catch {} }
  localStorage.removeItem(SCOPE_BACKUP); localStorage.removeItem(SCOPE_ACTIVE);
  save();
  applyRoleChrome();
}
function ensureScopeConsistency() {
  if (auth.user && auth.user.role === 'admin' && localStorage.getItem(SCOPE_ACTIVE)) clearDriverScope();
}
let wsPushTimer = null; let wsBootDone = false;
function wsScore(s) {
  if (!s) return -1;
  const dates = ((s.planning && s.planning.dates) || []).length;
  const depotAddr = (s.settings && s.settings.depot && s.settings.depot.address) ? 3 : 0;
  return (s.stops || []).length + (s.drivers || []).length + depotAddr + Math.max(0, dates - 1);
}
function scheduleWsPush() {
  if (!auth.online || !auth.user || auth.user.role !== 'admin' || serverScope) return;
  clearTimeout(wsPushTimer); wsPushTimer = setTimeout(pushWorkspace, 2500);
}
async function pushWorkspace() {
  if (!auth.online || !auth.user || auth.user.role !== 'admin' || serverScope) return false;
  if (wsScore(state) <= 0) return false;
  let okPush = false;
  try { const r = await api('/ws', { method: 'POST', body: state }); okPush = Boolean(r.ok); } catch {}
  const badge = document.getElementById('save-state');
  if (badge) { badge.textContent = okPush ? 'Enregistré · serveur ✓' : 'Enregistré · serveur ✨ (hors ligne)'; badge.className = okPush ? 'text-[10px] text-emerald-600' : 'text-[10px] text-amber-600'; }
  return okPush;
}
async function pullAdminWorkspace() {
  if (!auth.online || !auth.user || auth.user.role !== 'admin') { wsBootDone = true; return; }
  try {
    const r = await api('/ws');
    if (!r.ok) throw new Error('http');
    const remote = r.data && r.data.data;
    const localStamp = localStorage.getItem('roadoptimizur.ws.stamp') || '';
    const remoteStamp = r.data && r.data.updated || '';
    const sLoc = wsScore(state), sRem = wsScore(remote);
    if (sRem <= 0 && sLoc <= 0) { wsBootDone = true; return; }
    if (sRem <= 0) { await pushWorkspace(); wsBootDone = true; return; }
    if (!localStamp) {
      if (sLoc >= sRem) { await pushWorkspace(); toast('Espace de travail de cet appareil envoye au serveur.', 'ok', 3000); }
      else { Object.assign(state, remote); save(); renderAll(); toast('Espace de travail charge depuis le serveur.', 'ok', 2500); }
    } else if (remoteStamp >= localStamp) {
      if (sLoc > sRem) { await pushWorkspace(); } else { Object.assign(state, remote); save(); renderAll(); }
    } else { await pushWorkspace(); }
    wsBootDone = true;
  } catch { wsBootDone = true; toast('Serveur injoignable — donnees locales affichees.', 'warn', 5000); }
}

function scheduleTourPush() {
  if (!serverScope || !serverScope.pushEnabled || !auth.online || (auth.user && auth.user.role !== 'driver')) return;
  lastEditAt = Date.now();
  clearTimeout(tourPushTimer);
  tourPushTimer = setTimeout(pushTour, 1500);
}
async function pushTour() {
  if (!serverScope || Date.now() < suppressPushUntil) return;
  const date = currentDate();
  const stops = state.stops.filter((s) => s.date === date && String(s.driverId) === serverScope.driverId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  if (!stops.length && !serverScope.dates[date]) return;
  const r = await api('/tour-save', { method: 'POST', body: { date, stops, depot: state.settings.depot } });
  if (r.ok && r.data && r.data.savedAt) serverScope.dates[date] = { savedAt: r.data.savedAt, count: stops.length };
  if (!r.ok && r.data?.error) toast(r.data.error, 'warn', 5000);
}
function startPosWatch() {
  if (posWatchId != null || !('geolocation' in navigator) || !auth.online || (auth.user && auth.user.role !== 'driver')) return;
  posWatchId = navigator.geolocation.watchPosition((pos) => {
    const now = Date.now(); const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, speed: pos.coords.speed };
    const moved = !lastPos || Math.hypot((p.lat - lastPos.lat) * 111, (p.lng - lastPos.lng) * 80) > 0.06;
    if ((moved || now - lastPosPushAt > 90000) && now - lastPosPushAt > 25000) {
      lastPosPushAt = now; lastPos = p;
      api('/position', { method: 'POST', body: { date: currentDate(), lat: p.lat, lng: p.lng, speed: p.speed } }).catch(() => {});
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 20000, timeout: 15000 });
}
function stopPosWatch() { if (posWatchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(posWatchId); posWatchId = null; } }
function applyRoleChrome() {
  const isDriver = auth.user && auth.user.role === 'driver';
  const hiddenForDriver = ['drivers', 'accounts', 'analytics', 'live'];
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const t = btn.getAttribute('data-tab');
    btn.classList.toggle('hidden', isDriver && hiddenForDriver.includes(t));
  });
  if (isDriver && activeTab === 'live') switchTab('stops');
  const quick = document.getElementById('quick-route-btn');
  if (quick) quick.classList.toggle('hidden', !isDriver);
}
async function renderLive(el) {
  el.innerHTML = `<div class="p-4"><div class="flex items-center justify-between mb-3 gap-2 flex-wrap"><h2 class="font-bold text-lg">📡 Suivi temps réel — ${formatDateFR(currentDate())}</h2><button type="button" data-action="live-refresh" class="h-10 px-3 rounded-xl bg-slate-100 text-sm font-medium"><i class="fa-solid fa-rotate mr-1"></i> Rafraîchir</button></div><div id="live-cards" class="grid sm:grid-cols-2 gap-3"><div class="text-sm text-slate-500">Chargement…</div></div></div>`;
  await refreshLiveCards();
  clearInterval(liveTimer); liveTimer = setInterval(refreshLiveCards, 15000);
}
async function refreshLiveCards() {
  const box = document.getElementById('live-cards'); if (!box) return;
  const r = await api('/live?date=' + encodeURIComponent(currentDate()));
  if (!r.ok) { box.innerHTML = `<div class="text-sm text-rose-600">${escapeHtml(r.data && r.data.error || 'Serveur injoignable — ouvrez l’URL officielle HTTPS.')}</div>`; return; }
  const list = r.data.drivers || [];
  if (!list.length) { box.innerHTML = '<div class="text-sm text-slate-500">Aucune tournée publiée pour cette date.</div>'; return; }
  box.innerHTML = list.map((d) => {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    const late = d.lastUpdate && (Date.now() - new Date(d.lastUpdate)) > 15 * 60000;
    return `<div class="rounded-2xl border border-slate-200 p-3 space-y-2">
      <div class="flex items-center justify-between"><b class="text-sm">${escapeHtml(d.driverName)}</b><span class="text-xs ${late ? 'text-rose-500' : 'text-emerald-600'}">${late ? '⏰ inactif' : '● actif'} ${d.lastUpdate ? fmtTimeFR(d.lastUpdate) : ''}</span></div>
      <div class="h-2 rounded-full bg-slate-100 overflow-hidden"><div class="h-full bg-emerald-500" style="width:${pct}%"></div></div>
      <div class="text-xs text-slate-600">${d.done}/${d.total} effectués${d.currentStop ? ' · en cours : <b>' + escapeHtml(d.currentStop) + '</b>' : ' · ✅ tournée terminée'}</div>
      ${d.position ? `<div class="text-xs text-slate-500"><i class="fa-solid fa-location-crosshairs mr-1 text-brand-500"></i>${d.position.lat.toFixed(4)}, ${d.position.lng.toFixed(4)} · ${d.position.speed ? Math.round(d.position.speed * 3.6) + ' km/h ·' : ''} ${fmtTimeFR(d.position.at)} <button type="button" data-action="live-locate" data-lat="${d.position.lat}" data-lng="${d.position.lng}" class="text-brand-600 font-medium ml-1">Voir</button></div>` : `<div class="text-xs text-slate-400"><i class="fa-solid fa-satellite-dish mr-1"></i>Position GPS non remontée</div>`}
    </div>`;
  }).join('');
}

function updateHeaderChip() {
  const chip = document.getElementById('user-chip');
  if (!chip) return;
  const u = auth.user;
  if (u) {
    chip.hidden = false;
    chip.classList.remove('hidden');
    chip.innerHTML = `<i class="fa-solid ${u.role === 'admin' ? 'fa-user-shield text-amber-400' : 'fa-id-card text-brand-400'}"></i> ${escapeHtml(u.name)} <button type="button" data-action="acc-logout" class="ml-1 text-slate-400" title="Se déconnecter"><i class="fa-solid fa-right-from-bracket"></i></button>`;
    chip.querySelector('[data-action="acc-logout"]').addEventListener('click', doLogout);
  } else {
    chip.hidden = true;
    chip.classList.add('hidden');
    chip.innerHTML = '';
  }
}

function renderAccounts() {
  if (!auth.online) {
    panel().innerHTML = '<div id="acc-login"></div>';
    mountLogin(document.getElementById('acc-login'), {
      title: 'Back-office',
      subtitle: 'Espace réservé au dispatch (compte administrateur).',
      onSuccess: (user, mustChange) => {
        updateHeaderChip();
        if (user.role !== 'admin') { toast('Ce compte n’est pas administrateur.', 'error'); }
        if (mustChange) toast('Mot de passe par défaut : pensez à le changer (bouton « Mon mot de passe »).', 'warn', 7000);
        renderAccounts();
      },
    });
    return;
  }
  if (auth.user.role !== 'admin') {
    panel().innerHTML = `<div class="p-4 text-sm text-slate-600">Connecté en tant que <b>${escapeHtml(auth.user.name)}</b> (conducteur). Le back-office est réservé aux administrateurs. <button type="button" data-action="acc-logout" class="underline font-bold">Se déconnecter</button></div>`;
    return;
  }
  panel().innerHTML = `<div class="p-3 md:p-4 space-y-3">
    <div class="flex items-start justify-between gap-2">
      <div><h1 class="text-lg font-extrabold text-slate-900">Back-office</h1>
      <p class="text-xs text-slate-500">Comptes utilisateurs — chargement…</p></div>
      <div class="flex gap-1.5">
        <button type="button" data-action="acc-selfpw" class="h-10 px-3 rounded-xl bg-white border border-slate-200 text-slate-600 text-xs font-bold"><i class="fa-solid fa-key mr-1"></i>Mon mot de passe</button>
        <button type="button" data-action="acc-logout" class="h-10 px-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-bold"><i class="fa-solid fa-right-from-bracket mr-1"></i>Déconnexion</button>
      </div>
    </div>
    <div data-bo-users class="space-y-2"><p class="text-xs text-slate-400"><i class="fa-solid fa-circle-notch fa-spin"></i></p></div>
    <details class="bg-white rounded-xl border border-slate-200 p-3" open>
      <summary class="text-sm font-bold text-slate-700 cursor-pointer"><i class="fa-solid fa-user-plus mr-1 text-brand-600"></i>Créer un compte</summary>
      <form data-bo-create class="grid sm:grid-cols-2 gap-2 mt-3 text-sm">
        <label class="text-xs font-bold text-slate-500">Nom complet<input name="name" required class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="Jean Dupont"></label>
        <label class="text-xs font-bold text-slate-500">E-mail (identifiant)<input name="email" type="email" required class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="jean@entreprise.fr"></label>
        <label class="text-xs font-bold text-slate-500">Mot de passe (min. 8)<input name="pwd" type="password" required minlength="8" autocomplete="new-password" class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></label>
        <label class="text-xs font-bold text-slate-500">Rôle
          <select name="role" class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base bg-white"><option value="driver">Conducteur</option><option value="admin">Administrateur (dispatch)</option></select></label>
        <label class="text-xs font-bold text-slate-500 sm:col-span-2">Conducteur lié (tournée affichée sur son téléphone)
          <select name="driverRef" class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base bg-white"><option value="">— aucun —</option>${state.drivers.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}</select></label>
        <div class="sm:col-span-2"><button type="submit" class="w-full py-3 rounded-xl bg-brand-600 text-white font-bold text-sm"><i class="fa-solid fa-user-plus mr-2"></i>Créer le compte</button></div>
      </form>
    </details>
    <details class="bg-white rounded-xl border border-slate-200 p-3">
      <summary class="text-sm font-bold text-slate-700 cursor-pointer"><i class="fa-solid fa-clock-rotate-left mr-1 text-slate-400"></i>Journal d’activité</summary>
      <div data-bo-audit class="mt-2 text-xs text-slate-500 space-y-1"><p><i class="fa-solid fa-circle-notch fa-spin"></i></p></div>
    </details>
  </div>`;
  loadUsers(); loadAudit();
  const form = panel().querySelector('[data-bo-create]');
  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const r = await api('/users', { method: 'POST', body: {
      name: String(fd.get('name') || '').trim(),
      email: String(fd.get('email') || '').trim().toLowerCase(),
      role: fd.get('role') === 'admin' ? 'admin' : 'driver',
      driverRef: fd.get('driverRef') || null,
      ['pass' + 'word']: String(fd.get('pwd') || ''),
    } });
    if (r.ok) { toast(`Compte ${r.data.name} créé.`, 'success'); form.reset(); loadUsers(); }
    else toast(r.data?.error || 'Création impossible.', 'error');
  });
}

async function loadUsers() {
  const r = await api('/users');
  const box = panel()?.querySelector('[data-bo-users]');
  if (!box) return;
  if (!r.ok) { box.innerHTML = `<p class="text-sm text-rose-600">${escapeHtml(r.data?.error || 'API indisponible — ouvrez l’app via l’URL officielle.')}</p>`; return; }
  const driversById = Object.fromEntries(state.drivers.map((d) => [d.id, d.name]));
  box.innerHTML = r.data.map((u) => `
    <div class="bg-white rounded-xl border ${u.active ? 'border-slate-200' : 'border-rose-200 bg-rose-50'} p-3 flex flex-wrap items-center gap-2">
      <div class="flex-1 min-w-[180px]">
        <p class="text-sm font-bold text-slate-800">${escapeHtml(u.name)}
          ${u.role === 'admin' ? '<span class="ml-1 text-[11px] font-bold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">ADMIN</span>' : ''}
          ${u.active ? '' : '<span class="ml-1 text-[11px] font-bold text-rose-700 bg-rose-100 rounded px-1.5 py-0.5">DÉSACTIVÉ</span>'}</p>
        <p class="text-xs text-slate-500">${escapeHtml(u.email)}${u.driverRef ? ' · <i class="fa-solid fa-truck-fast text-brand-600"></i> ' + escapeHtml(driversById[u.driverRef] || 'conducteur supprimé') : ''}</p>
      </div>
      <div class="flex gap-1.5">
        <button type="button" data-action="acc-reset" data-id="${u.id}" data-name="${escapeHtml(u.name)}" class="h-9 px-2.5 rounded-lg bg-white border border-slate-300 text-xs font-bold text-slate-600" title="Définir un nouveau mot de passe"><i class="fa-solid fa-key"></i></button>
        <button type="button" data-action="acc-toggle" data-id="${u.id}" data-active="${u.active ? '1' : '0'}" class="h-9 px-2.5 rounded-lg bg-white border border-slate-300 text-xs font-bold ${u.active ? 'text-rose-600' : 'text-emerald-600'}" title="${u.active ? 'Désactiver' : 'Réactiver'}"><i class="fa-solid ${u.active ? 'fa-ban' : 'fa-circle-check'}"></i></button>
        <button type="button" data-action="acc-del" data-id="${u.id}" data-name="${escapeHtml(u.name)}" class="h-9 px-2.5 rounded-lg bg-white border border-slate-300 text-xs font-bold text-slate-600" title="Supprimer"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`).join('');
}

async function loadAudit() {
  const r = await api('/audit?limit=30');
  const box = panel()?.querySelector('[data-bo-audit]');
  if (!box) return;
  box.innerHTML = r.ok ? (r.data.slice(0, 30).map((e) => `<p><span class="font-mono text-slate-400">${escapeHtml(String(e.at || '').slice(5, 16).replace('T', ' '))}</span> · <b>${escapeHtml(e.kind)}</b> — ${escapeHtml(e.detail || '')} <span class="text-slate-400">(${escapeHtml(e.ip || '')})</span></p>`).join('') || '<p>Vide.</p>') : '<p>API indisponible.</p>';
}

async function accAction(action, id, payload) {
  const r = await api('/users/' + id, { method: action, body: payload });
  if (r.ok) { toast('Compte mis à jour.', 'success'); loadUsers(); }
  else toast(r.data?.error || 'Action impossible.', 'error');
}

function openSelfPwModal() {
  openModal('Mon mot de passe', `
    <form data-selfpw class="space-y-3 text-sm">
      <label class="block text-xs font-bold text-slate-500">Mot de passe actuel
        <input name="cur" type="password" required autocomplete="current-password" class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></label>
      <label class="block text-xs font-bold text-slate-500">Nouveau mot de passe (min. 8)
        <input name="npw" type="password" required minlength="8" autocomplete="new-password" class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></label>
      <button type="submit" class="w-full py-3 rounded-xl bg-brand-600 text-white font-bold">Mettre à jour</button>
    </form>`, {
    onSubmit: async (form) => {
      const fd = new FormData(form);
      const r = await api('/password', { method: 'POST', body: { current: String(fd.get('cur') || ''), new: String(fd.get('npw') || '') } });
      if (r.ok) { closeModal(); toast('Mot de passe mis à jour.', 'success'); }
      else toast(r.data?.error || 'Échec.', 'error');
      return false;
    },
  });
}

async function publishDay() {
  if (!auth.online) { toast('Ouvrez l’onglet Comptes pour vous connecter au serveur.', 'warn', 6000); switchTab('accounts'); return; }
  const date = currentDate();
  const tours = state.drivers.map((d) => ({ driverId: d.id, driverName: d.name, depot: state.settings.depot, stops: getDriverRoute(state, d.id, date) })).filter((t) => t.stops.length);
  if (!tours.length) { toast('Aucune tournée à publier pour cette date.', 'warn'); return; }
  const r = await api('/publish', { method: 'POST', body: { date, tours } });
  toast(r.ok ? `Journée ${formatDateFR(date)} publiée (${tours.length} tournée(s)) — visible par les conducteurs.` : (r.data?.error || 'Publication impossible.'), r.ok ? 'success' : 'error', 6000);
}

async function fetchRetours() {
  if (!auth.online) { toast('Ouvrez l’onglet Comptes pour vous connecter.', 'warn', 6000); switchTab('accounts'); return; }
  const date = currentDate();
  const r = await api('/retours?date=' + encodeURIComponent(date));
  if (!r.ok) { toast(r.data?.error || 'Récupération impossible.', 'error'); return; }
  let applied = 0;
  for (const row of r.data) {
    const s = state.stops.find((x) => x.id === row.stopId && x.date === row.date);
    if (s && s.status !== row.status) { s.status = row.status; s.lastRetour = { at: row.at, by: row.name || row.email, pod: row.pod || null }; applied++; }
  }
  saveState(state);
  toast(applied ? `${applied} statut(s) mis à jour depuis les téléphones.` : `${r.data.length} retour(s) déjà à jour.`, 'info');
  renderPanel();
}

function renderSettings() {
  const s = state.settings;
  const bytes = new Blob([JSON.stringify(state)]).size;
  panel().innerHTML = `
    <div class="p-3 md:p-4 space-y-3">
      <div>
        <h1 class="text-lg font-extrabold text-slate-900">Réglages</h1>
        <p class="text-xs text-slate-500">Dépôt, véhicule, horaires, formulaire POD, données</p>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="text-[10px] uppercase font-bold tracking-wider text-slate-400">Dépôt de départ</p>
          <p class="text-sm font-bold text-slate-800 truncate">${escapeHtml(s.depot.name || 'Non configuré')}</p>
          <p class="text-[11px] text-slate-500 truncate">${escapeHtml(s.depot.address || '—')}</p>
        </div>
        <button type="button" data-action="edit-depot" class="min-h-[38px] px-3 bg-slate-100 rounded-lg text-xs font-bold text-slate-700">Modifier</button>
      </div>

      <form data-settings-form class="space-y-3">
        <section class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm space-y-2">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500"><i class="fa-solid fa-route text-brand-500 mr-1"></i>Routage & véhicule</h2>
          <div class="grid grid-cols-2 gap-2">
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Profil</label>
              <select name="profile" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm">
                ${[['auto', 'Voiture / auto'], ['truck', 'Camion'], ['bike', 'Vélo'], ['pedestrian', 'Piéton']].map(([v, l]) => `<option value="${v}" ${s.routing.profile === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Vitesse moy. (km/h)</label>
              <input name="avgSpeedKmh" type="number" min="5" value="${s.hours.avgSpeedKmh}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <label class="col-span-2 flex items-center gap-2 text-[11px] text-slate-600 bg-slate-50 rounded-lg px-2 py-2">
              <input type="checkbox" name="avoidMotorways" ${s.routing.avoidMotorways ? 'checked' : ''} class="w-4 h-4 rounded"> Éviter les autoroutes
            </label>
            <label class="col-span-2 flex items-center gap-2 text-[11px] text-slate-600 bg-emerald-50/60 border border-emerald-200 rounded-lg px-2 py-2">
              <input type="checkbox" name="midDepotEnabled" ${s.midDepot?.enabled ? 'checked' : ''} class="w-4 h-4 rounded"> <span><i class="fa-solid fa-warehouse text-amber-500 mr-1"></i><b>Dépôt dynamique</b> — retour auto au dépôt si la capacité du véhicule est atteinte (vidage/rechargement)</span>
            </label>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Arrêt au dépôt (min)</label>
              <input name="midDepotDwell" type="number" min="1" max="240" value="${s.midDepot?.dwellMin ?? 15}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm">
            </div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Hauteur (m)</label>
              <input name="height" type="number" step="0.1" value="${s.routing.vehicle.height}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Poids (t)</label>
              <input name="weight" type="number" step="0.1" value="${s.routing.vehicle.weight}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Longueur (m)</label>
              <input name="length" type="number" step="0.1" value="${s.routing.vehicle.length}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Essieux</label>
              <input name="axles" type="number" min="2" value="${s.routing.vehicle.axles}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <label class="col-span-2 flex items-center gap-2 text-[11px] text-slate-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-2">
              <input type="checkbox" name="hazardous" ${s.routing.vehicle.hazardous ? 'checked' : ''} class="w-4 h-4 rounded"> Matières dangereuses (Valhalla truck)
            </label>
          </div>
        </section>

        <section class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm space-y-2">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500"><i class="fa-regular fa-clock text-brand-500 mr-1"></i>Horaires & société</h2>
          <div class="grid grid-cols-2 gap-2">
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Début journée</label>
              <input name="workStart" type="time" value="${s.hours.workStart}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Fin journée</label>
              <input name="workEnd" type="time" value="${s.hours.workEnd}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Service par défaut (min)</label>
              <input name="serviceDefaultMin" type="number" min="0" value="${s.hours.serviceDefaultMin}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div><label class="block text-[11px] font-semibold text-slate-600 mb-1">Nom société</label>
              <input name="companyName" value="${escapeHtml(s.company.name)}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
            <div class="col-span-2"><label class="block text-[11px] font-semibold text-slate-600 mb-1">Téléphone société</label>
              <input name="companyPhone" type="tel" value="${escapeHtml(s.company.phone)}" class="w-full px-2 py-2.5 border border-slate-300 rounded-lg text-sm"></div>
          </div>
        </section>

        <section class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm space-y-2">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500"><i class="fa-solid fa-list-check text-brand-500 mr-1"></i>Formulaire POD</h2>
            <button type="button" data-action="pod-add-field" class="text-[11px] font-bold text-brand-600 px-2 py-1"><i class="fa-solid fa-plus mr-1"></i>Champ</button>
          </div>
          <div class="space-y-1.5" data-pod-fields>
            ${s.podForm.map(podRowHTML).join('') || '<p class="text-[11px] text-slate-400">Aucun champ.</p>'}
          </div>
        </section>

        <button type="submit" class="w-full min-h-[48px] bg-brand-600 text-white font-bold rounded-xl text-sm"><i class="fa-solid fa-floppy-disk mr-2"></i>Enregistrer les réglages</button>
      </form>

      <section class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500"><i class="fa-solid fa-database text-brand-500 mr-1"></i>Données</h2>
        <p class="text-[11px] text-slate-500">Stockage local : ${(bytes / 1024).toFixed(1)} Ko · clé <code class="bg-slate-100 px-1 rounded">roadoptimizur.v3</code></p>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" data-action="settings-export" class="min-h-[40px] bg-slate-100 rounded-lg text-[11px] font-bold text-slate-700"><i class="fa-solid fa-file-export mr-1"></i>Export JSON</button>
          <label class="min-h-[40px] bg-slate-100 rounded-lg text-[11px] font-bold text-slate-700 flex items-center justify-center gap-1 cursor-pointer"><i class="fa-solid fa-file-import"></i>Import JSON<input type="file" data-settings-import accept=".json" class="hidden"></label>
          <button type="button" data-action="settings-export-csv" class="min-h-[40px] bg-slate-100 rounded-lg text-[11px] font-bold text-slate-700"><i class="fa-solid fa-file-csv mr-1"></i>Export CSV</button>
          <button type="button" data-action="settings-reset" class="min-h-[40px] bg-red-50 border border-red-200 rounded-lg text-[11px] font-bold text-red-600"><i class="fa-solid fa-trash-can mr-1"></i>Réinitialiser</button>
        </div>
        <button type="button" data-action="settings-install" class="w-full min-h-[40px] bg-slate-900 text-white rounded-lg text-[11px] font-bold"><i class="fa-solid fa-download mr-1"></i>Installer l’application (PWA)</button>
        <p class="text-[10px] text-slate-400">RoadOptimiser v3 · 100% local · SSO/API/SMS temps réel : phase 2 (serveur requis)</p>
      </section>
    </div>`;
}

function submitSettings(form) {
  const fd = new FormData(form);
  const s = state.settings;
  s.routing.profile = fd.get('profile') || 'auto';
  s.routing.avoidMotorways = fd.get('avoidMotorways') === 'on';
  s.routing.vehicle = {
    height: Number(fd.get('height')) || 2.5,
    weight: Number(fd.get('weight')) || 7.5,
    length: Number(fd.get('length')) || 6,
    axles: Number(fd.get('axles')) || 2,
    hazardous: fd.get('hazardous') === 'on',
  };
  s.hours.workStart = fd.get('workStart') || '08:00';
  s.hours.workEnd = fd.get('workEnd') || '18:00';
  s.hours.serviceDefaultMin = Number(fd.get('serviceDefaultMin')) || 10;
  s.hours.avgSpeedKmh = Number(fd.get('avgSpeedKmh')) || 45;
  s.midDepot = {
    enabled: fd.get('midDepotEnabled') === 'on',
    dwellMin: Number(fd.get('midDepotDwell')) || 15,
  };
  s.company.name = String(fd.get('companyName') || '').trim();
  s.company.phone = String(fd.get('companyPhone') || '').trim();

  const rows = [...panel().querySelectorAll('[data-pod-row]')].map((row) => ({
    id: row.querySelector('[data-pod-id]')?.value || uid('f'),
    label: row.querySelector('[data-pod-label]')?.value.trim() || '',
    type: row.querySelector('[data-pod-type]')?.value || 'text',
  })).filter((f) => f.label);
  s.podForm = rows;
  save();
  routeCache.clear();
  toast('Réglages enregistrés.', 'success');
  renderSettings();
  updateMap();
}

function openDepotModal() {
  const d = state.settings.depot;
  openModal(`
    ${modalHeader('Dépôt de départ', 'Point de départ et de retour des tournées')}
    <form data-depot-form data-orig-address="${escapeHtml(d.address || '')}" data-orig-lat="${d.lat || 0}" data-orig-lng="${d.lng || 0}" class="p-4 space-y-3">
      <div><label class="block text-xs font-semibold text-slate-600 mb-1">Nom</label>
        <input name="name" value="${escapeHtml(d.name)}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>
      <div><label class="block text-xs font-semibold text-slate-600 mb-1">Adresse</label>
        <div class="flex gap-1">
          <input name="address" data-address value="${escapeHtml(d.address)}" class="flex-1 min-w-0 px-3 py-2.5 border border-slate-300 rounded-lg text-base">
          <button type="button" data-action="geocode-depot" class="px-3 min-h-[44px] bg-slate-100 border border-slate-300 rounded-lg text-slate-600"><i class="fa-solid fa-magnifying-glass-location"></i></button>
        </div>
        <p class="text-[10px] text-slate-400 mt-1" data-geo-label>GPS ${d.lat}, ${d.lng}</p>
        <input type="hidden" name="lat" value="${d.lat}"><input type="hidden" name="lng" value="${d.lng}">
        <label class="block text-xs font-semibold text-slate-600">Coordonnées GPS (modification manuelle possible)
          <input name="gps" class="mt-1 w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm" value="${d.lat && d.lng ? d.lat + ';' + d.lng : ''}" placeholder="43.2124;-0.3671">
        </label>
      </div>
      <div class="flex gap-2">
        <button type="button" data-modal-close class="px-4 min-h-[48px] rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">Annuler</button>
        <button type="submit" class="flex-1 min-h-[48px] bg-brand-600 text-white rounded-xl text-sm font-bold">Enregistrer</button>
      </div>
    </form>`);
}

async function submitDepotForm(form) {
  const fd = new FormData(form);
  let lat = Number(fd.get('lat')) || 0;
  let lng = Number(fd.get('lng')) || 0;
  const address = String(fd.get('address') || '').trim();
  const oLat = Number(form.dataset.origLat) || 0;
  const oLng = Number(form.dataset.origLng) || 0;
  const gpsRaw = String(fd.get('gps') || '').trim().replace(/,/g, ';');
  const gpsParts = gpsRaw.split(';').map((x) => Number(x.trim()));
  const gpsManual = gpsParts.length === 2 && Number.isFinite(gpsParts[0]) && Number.isFinite(gpsParts[1]) && (gpsParts[0] !== oLat || gpsParts[1] !== oLng);
  if (gpsManual) { lat = gpsParts[0]; lng = gpsParts[1]; }
  const coordsChanged = gpsManual || lat !== oLat || lng !== oLng;
  const addressChanged = address !== (form.dataset.origAddress || '');
  if (address && (addressChanged || !coordsChanged) && (!lat || !lng || (addressChanged && !coordsChanged))) {
    const geo = await geocode(address);
    if (geo) { lat = geo.lat; lng = geo.lng; }
    else toast('Adresse introuvable (Nominatim et Photon) — saisis le GPS en manuel dans le champ Coordonnées.', 'warn', 7000);
  }
  state.settings.depot = { name: String(fd.get('name') || 'Dépôt').trim(), address, lat, lng };
  save();
  closeModal();
  routeCache.clear();
  renderPanel();
  updateMap();
  // Recadrer la carte sur le nouveau point de dépôt (immédiat si carte prête, sinon au prochain updateMap)
  depotViewPending = Boolean(lat && lng);
  if (map && lat && lng && window.L) {
    try { map.invalidateSize(); } catch {}
    try { map.setView([lat, lng], Math.max(map.getZoom(), 12)); depotViewPending = false; } catch {}
  }
  toast('Dépôt mis à jour.', 'success');
}

/* ------------------------------------------------------------------ */
/* Impression                                                          */
/* ------------------------------------------------------------------ */

function printTour() {
  const date = currentDate();
  const ids = activeTab === 'routes' && selectedDriverId
    ? [selectedDriverId]
    : state.drivers.filter((d) => state.stops.some((s) => s.driverId === d.id && s.date === date)).map((d) => d.id);
  if (!ids.length) { toast('Aucune tournée à imprimer.', 'warn'); return; }
  const area = document.getElementById('print-area');
  const company = state.settings.company.name || 'RoadOptimiser';
  const depot = state.settings.depot;

  area.innerHTML = ids.map((id, idx) => {
    const driver = getDriver(state, id);
    const stops = getDriverRoute(state, id, date);
    const stats = routeStats(driver, stops);
    return `
      <div class="print-page" style="break-after:${idx < ids.length - 1 ? 'page' : 'auto'}">
        <div class="flex justify-between items-start border-b-2 border-slate-800 pb-3 mb-4">
          <div>
            <h1 class="text-xl font-extrabold uppercase">Feuille de route</h1>
            <p class="text-sm font-bold">${escapeHtml(company)}</p>
            <p class="text-xs text-slate-600">Dépôt : ${escapeHtml(depot.name)} — ${escapeHtml(depot.address)}</p>
          </div>
          <div class="text-right">
            <p class="text-sm font-bold">${escapeHtml(driver?.name || 'Conducteur')}</p>
            <p class="text-xs">${formatDateFR(date)}</p>
            <p class="text-xs">${stops.length} arrêts · ${stats.distanceKm.toFixed(1)} km · ${Math.round(stats.durationMin)} min</p>
          </div>
        </div>
        <table class="w-full text-[11px] border-collapse">
          <thead><tr class="border-b border-slate-400 text-left">
            <th class="py-1 pr-1 w-6">N°</th><th class="py-1 pr-2">Client / adresse</th><th class="py-1 pr-2 w-16">Tél.</th>
            <th class="py-1 pr-2 w-16">Créneau</th><th class="py-1 pr-2 w-10">Serv.</th><th class="py-1 pr-2">Notes</th><th class="py-1 w-10">Fait</th>
          </tr></thead>
          <tbody>
            ${stops.map((s, i) => `<tr class="border-b border-slate-200 align-top">
              <td class="py-1.5 pr-1 font-bold">${i + 1}</td>
              <td class="py-1.5 pr-2"><strong>${escapeHtml(s.name)}</strong><br><span class="text-slate-500">${escapeHtml(s.address)}</span></td>
              <td class="py-1.5 pr-2">${escapeHtml(s.phone || '—')}</td>
              <td class="py-1.5 pr-2">${s.windowStart ? `${s.windowStart}<br>${s.windowEnd || ''}` : '—'}</td>
              <td class="py-1.5 pr-2">${s.serviceMin || 0}′</td>
              <td class="py-1.5 pr-2">${escapeHtml(s.notes || '')}</td>
              <td class="py-1.5">[ ]</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="text-[9px] text-slate-500 mt-3">Signature conducteur : ______________________ &nbsp;&nbsp; Retour dépôt : ______</p>
        ${stops.filter((s) => s.pod?.completedAt).length ? `
          <h2 class="text-sm font-bold mt-5 mb-2">Preuves de livraison</h2>
          ${stops.filter((s) => s.pod?.completedAt).map((s) => podPrintHTML(s, driver, state.settings.podForm)).join('')}
        ` : ''}
      </div>`;
  }).join('');
  window.print();
}

/* ------------------------------------------------------------------ */
/* Suivi client & feedback                                             */
/* ------------------------------------------------------------------ */

function showOnly(viewId) {
  ['planner-view', 'view-driver', 'view-track', 'view-feedback'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== viewId);
  });
}

function renderTrackView(stopId) {
  showOnly('view-track');
  const root = document.getElementById('view-track');
  const stop = getStop(state, stopId);
  if (!stop) {
    root.innerHTML = `<div class="min-h-dvh flex items-center justify-center p-6 bg-slate-100"><div class="bg-white rounded-2xl p-6 text-center shadow"><i class="fa-solid fa-box-open text-3xl text-slate-300"></i><h1 class="font-bold mt-2">Livraison introuvable</h1><p class="text-sm text-slate-500">Ce lien de suivi n’est plus valide.</p></div></div>`;
    return;
  }
  const driver = driverOf(stop);
  const meta = { pending: ['En préparation', 'text-amber-600', 'fa-clock'], delivered: ['Livrée', 'text-emerald-600', 'fa-circle-check'], absent: ['Client absent', 'text-amber-700', 'fa-user-slash'], failed: ['Échec de livraison', 'text-red-600', 'fa-circle-xmark'] }[stop.status] || ['En préparation', 'text-amber-600', 'fa-clock'];
  const eta = stop.eta ? new Date(stop.eta).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : 'à confirmer';

  root.innerHTML = `
    <div class="min-h-dvh bg-slate-100 flex flex-col">
      <header class="bg-slate-900 text-white px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4">
        <div class="flex items-center gap-2">
          <span class="w-9 h-9 rounded-xl bg-brand-500 flex items-center justify-center"><i class="fa-solid fa-truck-fast"></i></span>
          <div><p class="text-[10px] uppercase tracking-widest text-brand-300 font-bold">Suivi de livraison</p><p class="text-sm font-bold">${escapeHtml(state.settings.company.name || 'RoadOptimiser')}</p></div>
        </div>
        <h1 class="text-xl font-extrabold mt-3">${escapeHtml(stop.name)}</h1>
        <p class="text-xs text-slate-300 mt-0.5">${escapeHtml(stop.address)}</p>
      </header>

      <main class="flex-1 p-3 space-y-3">
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Statut</span>
            <span class="text-sm font-extrabold ${meta[1]}"><i class="fa-solid ${meta[2]} mr-1"></i>${meta[0]}</span>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <div class="bg-slate-50 rounded-xl p-3"><p class="text-[10px] text-slate-400 uppercase font-bold">ETA</p><p class="text-sm font-extrabold text-slate-900 mt-0.5">${eta}</p></div>
            <div class="bg-slate-50 rounded-xl p-3"><p class="text-[10px] text-slate-400 uppercase font-bold">Créneau</p><p class="text-sm font-extrabold text-slate-900 mt-0.5">${stop.windowStart ? `${stop.windowStart}–${stop.windowEnd || ''}` : '—'}</p></div>
          </div>
          ${driver ? `<p class="text-xs text-slate-500 mt-3"><i class="fa-solid fa-user mr-1"></i>Livreur : <b>${escapeHtml(driver.name)}</b>${driver.phone ? ` · <a href="tel:${escapeHtml(driver.phone)}" class="text-brand-600 underline">${escapeHtml(driver.phone)}</a>` : ''}</p>` : ''}
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div id="track-map" class="h-[32dvh] w-full bg-slate-200"></div>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 text-xs text-slate-600 space-y-1">
          <p><i class="fa-solid fa-location-dot text-brand-500 mr-1"></i>${escapeHtml(stop.address)}</p>
          ${stop.notes ? `<p class="bg-amber-50 border border-amber-200 rounded-lg p-2 text-amber-900 mt-1"><i class="fa-solid fa-note-sticky mr-1"></i>${escapeHtml(stop.notes)}</p>` : ''}
          <p class="text-[10px] text-slate-400 pt-1">Le suivi se met à jour à chaque actualisation. Le suivi temps réel multi-appareils est prévu en phase 2.</p>
        </div>

        <a href="?feedback=${encodeURIComponent(stop.id)}" class="block text-center min-h-[48px] bg-brand-600 text-white font-bold rounded-xl text-sm leading-[48px]">
          <i class="fa-solid fa-star mr-1"></i> Donner mon avis
        </a>
      </main>
      <footer class="p-3 text-center text-[10px] text-slate-400 safe-bottom">RoadOptimiser · ${formatDateFR(stop.date)}</footer>
    </div>`;

  if (typeof window.L !== 'undefined') {
    const depot = state.settings.depot;
    const m = window.L.map('track-map', { zoomControl: false, attributionControl: false });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
    const pts = [[depot.lat, depot.lng], [stop.geo.lat, stop.geo.lng]].filter((p) => p[0]);
    window.L.marker([stop.geo.lat, stop.geo.lng], { icon: pinIcon('#0284c7', '•') }).addTo(m).bindPopup(escapeHtml(stop.name));
    window.L.marker([depot.lat, depot.lng], { icon: pinIcon('#f59e0b', 'D') }).addTo(m);
    if (pts.length === 2) m.fitBounds(window.L.latLngBounds(pts).pad(0.25), { maxZoom: 15 });
    routeRoad([depot, stop.geo], { profile: 'auto', avgSpeedKmh: state.settings.hours.avgSpeedKmh }).then((data) => {
      if (data.geometry?.length) window.L.polyline(data.geometry, { color: '#0284c7', weight: 4, opacity: 0.7 }).addTo(m);
    }).catch(() => {});
  }
}

function renderFeedbackView(stopId) {
  showOnly('view-feedback');
  const root = document.getElementById('view-feedback');
  const stop = getStop(state, stopId);
  if (!stop) {
    root.innerHTML = '<div class="min-h-dvh flex items-center justify-center p-6"><p class="text-sm text-slate-500">Livraison introuvable.</p></div>';
    return;
  }
  const existing = stop.feedback?.stars;
  let selected = existing || 0;
  root.innerHTML = `
    <div class="min-h-dvh bg-slate-100 flex flex-col">
      <header class="bg-slate-900 text-white px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4">
        <p class="text-[10px] uppercase tracking-widest text-brand-300 font-bold">Votre avis</p>
        <h1 class="text-xl font-extrabold mt-1">Livraison chez ${escapeHtml(stop.name)}</h1>
        <p class="text-xs text-slate-300">${formatDateFR(stop.date)}</p>
      </header>
      <main class="flex-1 p-4 flex items-start justify-center">
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 w-full max-w-md">
          ${existing ? `<div class="text-center mb-4"><p class="text-sm font-semibold text-emerald-600"><i class="fa-solid fa-circle-check mr-1"></i>Merci, votre avis a été enregistré.</p><p class="text-xs text-slate-500 mt-1">${'★'.repeat(existing)}${'☆'.repeat(5 - existing)}</p>${stop.feedback.comment ? `<p class="text-xs text-slate-600 mt-2 italic">« ${escapeHtml(stop.feedback.comment)} »</p>` : ''}</div><hr class="my-4">` : ''}
          <h2 class="text-base font-extrabold text-slate-900 text-center">Comment s’est passée la livraison ?</h2>
          <div class="flex justify-center gap-2 my-5" data-stars>
            ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="w-12 h-12 rounded-full text-2xl ${n <= selected ? 'text-amber-400' : 'text-slate-200'} hover:scale-110 transition" aria-label="${n} étoile(s)"><i class="fa-solid fa-star"></i></button>`).join('')}
          </div>
          <textarea data-feedback-comment rows="3" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base" placeholder="Un commentaire ? (facultatif)">${escapeHtml(stop.feedback?.comment || '')}</textarea>
          <button type="button" data-feedback-submit class="mt-3 w-full min-h-[48px] bg-brand-600 text-white font-bold rounded-xl text-sm">Envoyer mon avis</button>
          <p class="text-[10px] text-slate-400 text-center mt-3">Avis stocké localement sur l’appareil du livreur. Phase 2 : consolidation serveur.</p>
        </div>
      </main>
    </div>`;

  root.querySelector('[data-stars]').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-star]');
    if (!btn) return;
    selected = Number(btn.dataset.star);
    root.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('text-amber-400', Number(b.dataset.star) <= selected));
    root.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('text-slate-200', Number(b.dataset.star) > selected));
  });

  root.querySelector('[data-feedback-submit]').addEventListener('click', () => {
    if (!selected) { toast('Choisissez une note de 1 à 5 étoiles.', 'warn'); return; }
    stop.feedback = {
      stars: selected,
      comment: root.querySelector('[data-feedback-comment]').value.trim() || null,
      date: new Date().toISOString(),
    };
    save();
    toast('Merci pour votre retour !', 'success');
    renderFeedbackView(stop.id);
  });
}

/* ------------------------------------------------------------------ */
/* Interactions planificateur                                          */
/* ------------------------------------------------------------------ */

let draggingId = null;

async function copyText(text, okMessage = 'Lien copié.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMessage, 'success'); } catch { toast('Copie impossible — sélectionnez le lien.', 'error'); }
    ta.remove();
  }
}

function shareStop(stop) {
  const links = trackingLinks(stop);
  openModal(`
    ${modalHeader('Suivi client', stop.name)}
    <div class="p-4 space-y-3">
      <p class="text-xs text-slate-500">Envoyez un lien de suivi (ETA + statut) par SMS ou e-mail. Aucun serveur requis.</p>
      <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 text-[11px] text-slate-700 break-all" data-share-url>${escapeHtml(links.url)}</div>
      <div class="grid grid-cols-2 gap-2">
        <a href="${links.sms}" class="min-h-[44px] bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl text-xs font-bold flex items-center justify-center gap-2"><i class="fa-solid fa-comment-sms"></i> SMS pré-rempli</a>
        <a href="${links.mailto}" class="min-h-[44px] bg-brand-50 border border-brand-200 text-brand-700 rounded-xl text-xs font-bold flex items-center justify-center gap-2"><i class="fa-solid fa-envelope"></i> E-mail</a>
      </div>
      <button type="button" data-action="copy-link" data-copy="${escapeHtml(links.url)}" class="w-full min-h-[44px] bg-slate-900 text-white rounded-xl text-xs font-bold"><i class="fa-solid fa-copy mr-1"></i>Copier le lien</button>
      <p class="text-[10px] text-slate-400">Le client ouvre <code>?track=id</code>. Le formulaire d’avis est accessible via <code>?feedback=id</code>.</p>
    </div>`);
}

async function handlePanelClick(ev) {
  if (ev.target.closest('[data-modal-close]')) { closeModal(); return; }
  const driverChip = ev.target.closest('[data-route-driver]');
  if (driverChip) {
    selectedDriverId = driverChip.dataset.routeDriver;
    renderPanel();
    drawRoutes();
    return;
  }
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const stop = id ? getStop(state, id) : null;

  switch (action) {
    case 'add-stop': openStopModal(); break;
    case 'publish-day': publishDay(); break;
    case 'fetch-retours': fetchRetours(); break;
    case 'ws-repull': driverPullWeek().then(renderAll); break;
    case 'acc-logout': doLogout(); break;
    case 'live-refresh': refreshLiveCards(); break;
    case 'live-locate': {
      const la = Number(ev.target.dataset.lat); const ln = Number(ev.target.dataset.lng);
      switchTab('routes');
      setTimeout(() => { try {
        if (map && window.L) { map.invalidateSize(); map.setView([la, ln], 14); window.L.circleMarker([la, ln], { radius: 9, color: '#dc2626', fillColor: '#ef4444', fillOpacity: 0.8 }).addTo(markersLayer); }
      } catch {} }, 400);
      break;
    }
    case 'quick-route': location.href = './?mode=conducteur'; break;
    case 'acc-toggle': accAction('PATCH', btn.dataset.id, { active: btn.dataset.active !== '1' }); break;
    case 'acc-del': if (window.confirm('Supprimer définitivement le compte « ' + btn.dataset.name + ' » ?')) accAction('DELETE', btn.dataset.id, {}); break;
    case 'acc-reset': {
      const np = window.prompt('Nouveau mot de passe pour ' + btn.dataset.name + ' (8 caractères minimum) :');
      if (np == null) break;
      if (np.length < 8) { toast('Mot de passe trop court (8 min).', 'error'); break; }
      accAction('PATCH', btn.dataset.id, { ['pass' + 'word']: np });
      break;
    }
    case 'acc-selfpw': openSelfPwModal(); break;
    case 'scan-stop':
      openScanner({ expectedCodes: [], barcodes: [] }, { onScan: (v) => { handleParcelScan(v); } });
      break;
    case 'scan-into-stop': {
      const form = btn.closest('form');
      if (!form) break;
      openScanner({ expectedCodes: [], barcodes: [] }, { onScan: (v) => fillStopFormFromScan(form, v) });
      break;
    }
    case 'edit-stop': if (stop) openStopModal(stop); break;
    case 'delete-stop':
      if (stop && confirm(`Supprimer « ${stop.name} » ?`)) {
        state.stops = state.stops.filter((s) => s.id !== stop.id);
        state.stops.forEach((s) => { if (s.pairedWith === stop.id) s.pairedWith = null; });
        save(); routeCache.clear(); renderAll();
        toast('Arrêt supprimé.', 'success');
      }
      break;
    case 'duplicate-stop':
      if (stop) {
        const copy = JSON.parse(JSON.stringify(stop));
        delete copy.id;
        copy.name = `${stop.name} (copie)`;
        copy.status = 'pending';
        copy.driverId = null; copy.seq = null; copy.eta = null;
        copy.pod = { signature: null, photos: [], fields: {}, scans: [], geo: null, completedAt: null };
        copy.feedback = { stars: null, comment: null, date: null };
        copy.breadcrumb = [];
        state.stops.push(newStop(copy));
        save(); renderAll();
        toast('Arrêt dupliqué.', 'success');
      }
      break;
    case 'pod-stop':
      if (stop) openPOD(stop, state, { markDelivered: false, onSave: () => { save(); renderPanel(); updateMap(); } });
      break;
    case 'track-stop': if (stop) shareStop(stop); break;
    case 'seed-demo': seedDemo(); break;
    case 'export-stops-csv': download(csvStopsFilename('commandes'), stopsToCSV(state.stops, state.drivers), 'text/csv'); toast('Commandes exportées.', 'success'); break;
    case 'edit-depot': openDepotModal(); break;
    case 'add-driver': openDriverModal(); break;
    case 'edit-driver': { const d = id ? getDriver(state, id) : null; if (d) openDriverModal(d); break; }
    case 'delete-driver': {
      const d = id ? getDriver(state, id) : null;
      if (d && confirm(`Supprimer ${d.name} ? Ses arrêts seront désaffectés.`)) {
        state.drivers = state.drivers.filter((x) => x.id !== d.id);
        state.stops.forEach((s) => {
          if (s.driverId === d.id) { s.driverId = null; s.seq = null; s.eta = null; }
        });
        if (selectedDriverId === d.id) selectedDriverId = null;
        save(); routeCache.clear(); renderAll();
        toast('Conducteur supprimé.', 'success');
      }
      break;
    }
    case 'optimize-all': optimizeNow('all'); break;
    case 'optimize-driver': optimizeNow('driver'); break;
    case 'recalc-eta':
      if (selectedDriverId) {
        recomputeEtas(state, selectedDriverId, currentDate());
        save(); renderPanel(); updateMap();
        toast('ETA recalculés.', 'success');
      }
      break;
    case 'print-route': printTour(); break;
    case 'move-up': if (id) moveRouteStop(id, -1); break;
    case 'move-down': if (id) moveRouteStop(id, 1); break;
    case 'unassign-stop':
      if (stop) { stop.driverId = null; stop.seq = null; stop.eta = null; save(); routeCache.clear(); renderAll(); toast('Arrêt retiré de la tournée.', 'info'); }
      break;
    case 'week-prev': weekStart = addDaysISO(weekStart || mondayISO(currentDate()), -7); renderPlanning(); break;
    case 'week-next': weekStart = addDaysISO(weekStart || mondayISO(currentDate()), 7); renderPlanning(); break;
    case 'week-today': weekStart = mondayISO(todayISO()); setDate(todayISO()); renderPlanning(); break;
    case 'planning-set-day': setDate(btn.dataset.date); break;
    case 'planning-add-stop': openStopModal(null, btn.dataset.date); break;
    case 'planning-optimize': {
      const date = btn.dataset.date;
      setDate(date);
      await optimizeNow('all');
      break;
    }
    case 'pod-add-field': {
      const box = panel().querySelector('[data-pod-fields]');
      if (!box) break;
      if (!box.querySelector('[data-pod-row]')) box.innerHTML = '';
      box.insertAdjacentHTML('beforeend', podRowHTML({ id: uid('f'), label: '', type: 'text' }));
      break;
    }
    case 'pod-del-field': btn.closest('[data-pod-row]')?.remove(); break;
    case 'settings-export': exportJSON(state); toast('Export JSON téléchargé.', 'success'); break;
    case 'settings-export-csv': download(csvStopsFilename('commandes'), stopsToCSV(state.stops, state.drivers), 'text/csv'); toast('Export CSV téléchargé.', 'success'); break;
    case 'settings-reset':
      if (confirm('Réinitialiser toutes les données ? Cette action est irréversible.')) {
        state = resetState();
        selectedDriverId = null; weekStart = null; stopFilter = { q: '', status: 'all' };
        routeCache.clear();
        switchTab('stops'); updateMap();
        toast('Données réinitialisées.', 'success');
      }
      break;
    case 'settings-install':
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; }
      else toast('Utilisez le menu du navigateur → « Installer l’application ».', 'info', 5000);
      break;
    case 'copy-link': copyText(btn.dataset.copy || ''); break;
    case 'geocode-stop': {
      const form = btn.closest('form');
      if (!form) break;
      const geo = await resolveGeo(form.querySelector('[data-address]'), form.querySelector('[name=lat]'), form.querySelector('[name=lng]'), form.querySelector('[data-geo-label]'));
      if (geo) toast('Adresse géocodée.', 'success');
      break;
    }
    case 'geocode-depot': {
      const form = btn.closest('form');
      if (!form) break;
      const geo = await resolveGeo(form.querySelector('[data-address]'), form.querySelector('[name=lat]'), form.querySelector('[name=lng]'), form.querySelector('[data-geo-label]'));
      if (geo) toast('Dépôt géocodé.', 'success');
      break;
    }
    default: break;
  }
}

function handlePanelChange(ev) {
  const target = ev.target;
  if (target.matches('[data-filter-status]')) {
    stopFilter.status = target.value;
    renderStopsList();
    return;
  }
  if (target.matches('[data-assign-stop]')) {
    assignStop(target.dataset.assignStop, target.value);
    return;
  }
  if (target.matches('[data-route-driver]')) {
    selectedDriverId = target.value;
    renderPanel(); drawRoutes();
    return;
  }
  if (target.matches('[data-move-stop]')) {
    const keep = Boolean(panel().querySelector('[data-overnight]')?.checked);
    moveStopToDate(target.dataset.moveStop, target.value, keep);
    return;
  }
  if (target.matches('[data-balance]')) {
    balanceMode = target.value;
    return;
  }
  if (target.matches('[data-import-csv]')) {
    const file = target.files?.[0];
    target.value = '';
    if (file) importCSVFile(file);
    return;
  }
  if (target.matches('[data-settings-import]')) {
    const file = target.files?.[0];
    target.value = '';
    if (file) handleImportFile(file);
  }
}

function handlePanelInput(ev) {
  if (ev.target.matches('[data-filter-q]')) {
    stopFilter.q = ev.target.value;
    renderStopsList();
  }
}

async function handleSubmit(ev) {
  const form = ev.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.matches('[data-stop-form]')) { ev.preventDefault(); await submitStopForm(form); return; }
  if (form.matches('[data-driver-form]')) { ev.preventDefault(); submitDriverForm(form); return; }
  if (form.matches('[data-depot-form]')) { ev.preventDefault(); await submitDepotForm(form); return; }
  if (form.matches('[data-settings-form]')) { ev.preventDefault(); submitSettings(form); }
}

function handleModalClick(ev) {
  if (ev.target.closest('[data-modal-close]')) { closeModal(); return; }
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'copy-link') { copyText(btn.dataset.copy || ''); return; }
  if (action === 'geocode-stop' || action === 'geocode-depot') {
    const form = btn.closest('form');
    if (!form) return;
    resolveGeo(form.querySelector('[data-address]'), form.querySelector('[name=lat]'), form.querySelector('[name=lng]'), form.querySelector('[data-geo-label]')).then((geo) => {
      if (geo) toast('Adresse géocodée.', 'success');
    });
  } else if (action === 'scan-into-stop') {
    const form = btn.closest('form');
    if (!form) return;
    openScanner({ expectedCodes: [], barcodes: [] }, { onScan: (v) => fillStopFormFromScan(form, v) });
  }
}

function handleDragStart(ev) {
  const routeRow = ev.target.closest('[data-route-row]');
  const weekCard = ev.target.closest('[data-week-stop]');
  const el = routeRow || weekCard;
  if (!el) return;
  draggingId = routeRow ? routeRow.dataset.routeRow : weekCard.dataset.weekStop;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', draggingId);
  el.classList.add('opacity-50');
}

function handleDragOver(ev) {
  if (ev.target.closest('[data-route-row]') || ev.target.closest('[data-week-drop]')) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  }
}

function handleDrop(ev) {
  const weekDrop = ev.target.closest('[data-week-drop]');
  if (weekDrop && draggingId) {
    ev.preventDefault();
    const keep = Boolean(panel().querySelector('[data-overnight]')?.checked);
    moveStopToDate(draggingId, weekDrop.dataset.weekDrop, keep);
    draggingId = null;
    return;
  }
  const targetRow = ev.target.closest('[data-route-row]');
  if (targetRow && draggingId && targetRow.dataset.routeRow !== draggingId) {
    ev.preventDefault();
    const dragged = getStop(state, draggingId);
    const target = getStop(state, targetRow.dataset.routeRow);
    if (dragged?.driverId && target?.driverId === dragged.driverId) {
      const list = getDriverRoute(state, dragged.driverId, dragged.date).filter((s) => s.status === 'pending');
      const from = list.findIndex((s) => s.id === draggingId);
      const to = list.findIndex((s) => s.id === target.id);
      if (from >= 0 && to >= 0) {
        const [moving] = list.splice(from, 1);
        list.splice(to, 0, moving);
        applyManualOrder(state, dragged.driverId, dragged.date, list.map((s) => s.id));
        save(); routeCache.clear(); renderPanel(); updateMap();
      }
    }
  }
  draggingId = null;
  panel().querySelectorAll('.opacity-50').forEach((el) => el.classList.remove('opacity-50'));
}

function handleDragEnd() {
  draggingId = null;
  panel().querySelectorAll('.opacity-50').forEach((el) => el.classList.remove('opacity-50'));
}

/* ------------------------------------------------------------------ */
/* Amorçage / routeur de vues                                          */
/* ------------------------------------------------------------------ */

function bindHeader() {
  const tabs = document.getElementById('planner-tabs');
  tabs?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  });
  document.getElementById('active-date')?.addEventListener('change', (ev) => setDate(ev.target.value));
  document.getElementById('active-date-mobile')?.addEventListener('change', (ev) => setDate(ev.target.value));

  // Tiroir carte mobile (masqué par défaut, état persistant)
  const mapBtn = document.getElementById('btn-map-toggle');
  const syncMapBtn = () => {
    const open = document.body.classList.contains('map-open');
    if (!mapBtn) return;
    mapBtn.setAttribute('aria-pressed', String(open));
    mapBtn.classList.toggle('bg-brand-600', open);
    mapBtn.classList.toggle('border-brand-500', open);
    mapBtn.classList.toggle('text-white', open);
  };
  try { if (localStorage.getItem('roopt.mapOpen') === '1') document.body.classList.add('map-open'); } catch {}
  syncMapBtn();
  mapBtn?.addEventListener('click', () => {
    const open = document.body.classList.toggle('map-open');
    try { localStorage.setItem('roopt.mapOpen', open ? '1' : '0'); } catch {}
    syncMapBtn();
    setTimeout(() => { if (map) map.invalidateSize(); updateMap(); }, 300);
  });

  document.getElementById('btn-export')?.addEventListener('click', () => { exportJSON(state); toast('Export JSON téléchargé.', 'success'); });
  document.getElementById('btn-print')?.addEventListener('click', printTour);
  document.getElementById('btn-install')?.addEventListener('click', () => {
    if (installPrompt) { installPrompt.prompt(); installPrompt = null; }
    else toast('Menu navigateur → Installer l’application.', 'info', 4500);
  });
  document.getElementById('global-import')?.addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) handleImportFile(file);
  });
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    installPrompt = ev;
  });
  window.addEventListener('resize', () => map?.invalidateSize());
  window.addEventListener('orientationchange', () => setTimeout(() => map?.invalidateSize(), 250));
}

function bindPanel() {
  const p = panel();
  if (!p) return;
  p.addEventListener('click', handlePanelClick);
  p.addEventListener('change', handlePanelChange);
  p.addEventListener('input', handlePanelInput);
  p.addEventListener('submit', handleSubmit);
  p.addEventListener('dragstart', handleDragStart);
  p.addEventListener('dragover', handleDragOver);
  p.addEventListener('drop', handleDrop);
  p.addEventListener('dragend', handleDragEnd);

  const mr = modalRoot();
  mr.addEventListener('click', handleModalClick);
  mr.addEventListener('submit', handleSubmit);
}

async function routeFromUrl() {
  const params = new URLSearchParams(location.search);
  const feedbackId = params.get('feedback');
  const trackId = params.get('track');
  const mode = params.get('mode');

  if (feedbackId) { renderFeedbackView(feedbackId); return; }
  if (trackId) { renderTrackView(trackId); return; }
  if (auth.user && auth.user.role === 'driver' && mode === 'conducteur') {
    showOnly('view-driver');
    driverViewController = initDriverServerView(auth.user, { onExit: () => { driverViewController = null; enterDriverPlanner(auth.user); } });
    return;
  }
  if (auth.user && auth.user.role === 'driver' && !mode) { await enterDriverPlanner(auth.user); return; }
  if (mode === 'conducteur') {
    showOnly('view-driver');
    const id = params.get('d') || state.drivers.find((d) => d.active !== false)?.id || state.drivers[0]?.id;
    driverViewController = initDriverView(state, id, {
      save,
      onChange: () => { /* la carte du planificateur sera rafraîchie au retour */ },
    });
    return;
  }
  showOnly('planner-view');
  if (!map) initMap();
  const input = document.getElementById('active-date');
  if (input) input.value = currentDate();
  const mobileInput = document.getElementById('active-date-mobile');
  if (mobileInput) mobileInput.value = currentDate();
  switchTab('stops');
}

async function init() {
  bindHeader();
  bindPanel();
  updateHeaderChip();
  const qs = new URLSearchParams(location.search);
  const isPublicLink = Boolean(qs.get('track') || qs.get('feedback'));
  const gate = await requireGate({ publicBypass: isPublicLink });
  ensureScopeConsistency();
  updateHeaderChip();
  if (!isPublicLink && gate.user && gate.user.role === 'admin') {
    await pullAdminWorkspace();
    routeFromUrl();
    switchTab('accounts');
    return;
  }
  routeFromUrl();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[app] Service Worker', err));
  }
  window.roadoptimizur = { get state() { return state; }, save };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

