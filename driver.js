/**
 * RoadOptimizur v3 — driver.js
 * Vue livreur mobile-first : tournée du jour, statuts, navigation, POD, scan,
 * GPS + fil d'Ariane, mode hors-ligne.
 */

import {
  formatDateFR,
  formatDateTimeFR,
  getDriver,
  getDriverRoute,
  todayISO,
  isoAt,
  minutesFromHHMM,
} from './storage.js';
import { navigationLinks } from './routing.js';
import { openPOD, openScanner, toast, escapeHtml } from './pod.js';

let watchId = null;
let lastBreadcrumbAt = 0;
let onlineHandler = null;

const STATUS_META = {
  pending: { label: 'À livrer', cls: 'bg-slate-100 text-slate-600', icon: 'fa-clock' },
  delivered: { label: 'Livré', cls: 'bg-emerald-100 text-emerald-700', icon: 'fa-circle-check' },
  absent: { label: 'Absent', cls: 'bg-amber-100 text-amber-800', icon: 'fa-user-slash' },
  failed: { label: 'Échoué', cls: 'bg-red-100 text-red-700', icon: 'fa-circle-xmark' },
};

function statusBadge(status) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full ${m.cls}"><i class="fa-solid ${m.icon}"></i>${m.label}</span>`;
}

function etaLabel(stop) {
  if (!stop.eta) return '—';
  const d = new Date(stop.eta);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function stopCard(stop, index, isNext, driver) {
  // Visite de dépôt dynamique (synthétique) : simple repère, aucune action client.
  if (stop.type === 'depotReload') {
    return `
      <article class="bg-amber-50 rounded-2xl border border-amber-200 shadow-sm p-4" data-stop-card="${stop.id}">
        <div class="flex items-start gap-3">
          <div class="w-9 h-9 rounded-full bg-amber-400 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-warehouse"></i></div>
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-amber-900 text-[15px] leading-tight"><i class="fa-solid fa-arrows-rotate mr-1"></i>Recharge / vidage au dépôt</h3>
            <p class="text-xs text-amber-700 mt-1 break-words"><i class="fa-solid fa-location-dot mr-1"></i>${escapeHtml(stop.address || '')}</p>
            <div class="flex flex-wrap items-center gap-x-3 mt-2 text-xs text-amber-800">
              <span class="font-semibold"><i class="fa-regular fa-clock mr-1"></i>ETA ${etaLabel(stop)}</span>
              <span><i class="fa-solid fa-gear mr-1"></i>${stop.serviceMin || 15} min</span>
            </div>
          </div>
        </div>
      </article>
    `;
  }
  const nav = navigationLinks(stop);
  const done = stop.status !== 'pending';
  const podDone = Boolean(stop.pod?.completedAt);
  const windowTxt = stop.windowStart || stop.windowEnd
    ? `${stop.windowStart || '…'} – ${stop.windowEnd || '…'}`
    : '';
  return `
    <article class="bg-white rounded-2xl border ${isNext ? 'border-brand-400 ring-2 ring-brand-100' : 'border-slate-200'} shadow-sm overflow-hidden" data-stop="${stop.id}">
      <div class="p-4">
        <div class="flex items-start gap-3">
          <div class="w-9 h-9 rounded-full ${done ? 'bg-slate-200 text-slate-600' : 'bg-brand-600 text-white'} flex items-center justify-center font-extrabold text-sm flex-shrink-0">${index + 1}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-bold text-slate-900 text-[15px] leading-tight break-words">${escapeHtml(stop.name || 'Client')}</h3>
              ${statusBadge(stop.status)}
            </div>
            <p class="text-xs text-slate-500 mt-1 break-words"><i class="fa-solid fa-location-dot mr-1"></i>${escapeHtml(stop.address || '')}</p>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs">
              <span class="font-semibold ${isNext ? 'text-brand-700' : 'text-slate-600'}"><i class="fa-regular fa-clock mr-1"></i>ETA ${etaLabel(stop)}</span>
              ${windowTxt ? `<span class="text-slate-500"><i class="fa-solid fa-hourglass-half mr-1"></i>${windowTxt}</span>` : ''}
              ${stop.type === 'pickup' ? '<span class="text-purple-700 font-semibold"><i class="fa-solid fa-box-open mr-1"></i>Collecte</span>' : ''}
              ${stop.teamGroup ? `<span class="text-slate-500"><i class="fa-solid fa-people-group mr-1"></i>${escapeHtml(stop.teamGroup)}</span>` : ''}
            </div>
            ${stop.notes ? `<p class="text-xs mt-2 bg-amber-50 border border-amber-200/70 text-amber-900 rounded-lg px-2 py-1.5 break-words">${escapeHtml(stop.notes)}</p>` : ''}
            ${podDone ? `<p class="text-[11px] text-emerald-600 mt-2"><i class="fa-solid fa-shield-halved mr-1"></i>POD signé ${stop.pod.photos?.length ? `· ${stop.pod.photos.length} photo(s)` : ''}</p>` : ''}
          </div>
        </div>

        <div class="flex flex-wrap gap-2 mt-3">
          <a href="${nav.google}" target="_blank" rel="noopener" class="min-h-[44px] px-3 bg-slate-100 active:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl flex items-center gap-1.5">
            <i class="fa-solid fa-map-location-dot text-red-500"></i> Maps
          </a>
          <a href="${nav.waze}" target="_blank" rel="noopener" class="min-h-[44px] px-3 bg-slate-100 active:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl flex items-center gap-1.5">
            <i class="fa-solid fa-location-arrow text-sky-500"></i> Waze
          </a>
          ${stop.phone ? `<a href="tel:${escapeHtml(stop.phone)}" class="min-h-[44px] px-3 bg-slate-100 active:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl flex items-center gap-1.5"><i class="fa-solid fa-phone text-emerald-600"></i> Appeler</a>` : ''}
          <button type="button" data-action="scan" data-id="${stop.id}" class="min-h-[44px] w-11 bg-slate-100 active:bg-slate-200 text-slate-700 rounded-xl flex items-center justify-center" title="Scanner un code-barres">
            <i class="fa-solid fa-barcode"></i>
          </button>
          <button type="button" data-action="arrived" data-id="${stop.id}" class="min-h-[44px] w-11 bg-slate-100 active:bg-slate-200 ${stop.arrivedAt ? 'text-emerald-600' : 'text-slate-500'} rounded-xl flex items-center justify-center" title="Marquer arrivée">
            <i class="fa-solid fa-location-crosshairs"></i>
          </button>
        </div>

        <div class="grid grid-cols-3 gap-2 mt-2">
          <button type="button" data-action="deliver" data-id="${stop.id}" class="min-h-[48px] col-span-1 rounded-xl text-xs font-bold ${stop.status === 'delivered' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'} flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-check"></i> Livré
          </button>
          <button type="button" data-action="absent" data-id="${stop.id}" class="min-h-[48px] rounded-xl text-xs font-bold ${stop.status === 'absent' ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 border border-amber-200'} flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-user-slash"></i> Absent
          </button>
          <button type="button" data-action="failed" data-id="${stop.id}" class="min-h-[48px] rounded-xl text-xs font-bold ${stop.status === 'failed' ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 border border-red-200'} flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-xmark"></i> Échec
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderShell(state, driver, date, stops, online) {
  const clientStops = stops.filter((s) => s.type !== 'depotReload');
  const total = clientStops.length;
  const done = clientStops.filter((s) => s.status !== 'pending').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const next = clientStops.find((s) => s.status === 'pending');
  const depot = state.settings.depot;

  return `
    <div class="min-h-dvh bg-slate-100 flex flex-col">
      <header class="bg-slate-900 text-white sticky top-0 z-30 shadow-lg">
        <div class="px-4 pt-[max(.75rem,env(safe-area-inset-top))] pb-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-[10px] uppercase tracking-widest text-brand-400 font-bold">Tournée du jour</p>
              <h1 class="text-lg font-extrabold truncate">${escapeHtml(driver.name)}</h1>
              <p class="text-xs text-slate-400">${formatDateFR(date)}</p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <span id="net-badge" class="text-[10px] font-bold px-2 py-1 rounded-full ${online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">
                <i class="fa-solid ${online ? 'fa-wifi' : 'fa-plug-circle-xmark'}"></i> ${online ? 'En ligne' : 'Hors-ligne'}
              </span>
              <a href="./" class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-300" title="Planificateur">
                <i class="fa-solid fa-gauge-high"></i>
              </a>
            </div>
          </div>

          <div class="mt-3 bg-slate-800 rounded-xl p-3">
            <div class="flex items-center justify-between text-xs mb-1.5">
              <span class="text-slate-300">${done}/${total} arrêts traités</span>
              <span class="font-bold text-white">${pct}%</span>
            </div>
            <div class="h-2 rounded-full bg-slate-700 overflow-hidden">
              <div class="h-full bg-emerald-500 transition-all" style="width:${pct}%"></div>
            </div>
            <div class="flex items-center justify-between mt-2 text-[11px] text-slate-400">
              <span><i class="fa-solid fa-warehouse mr-1"></i>${escapeHtml(depot.name || 'Dépôt')}</span>
              <span id="gps-status"><i class="fa-solid fa-location-dot mr-1"></i>GPS inactif</span>
            </div>
          </div>
        </div>
      </header>

      <main class="flex-1 px-3 py-3 space-y-3 pb-28">
        ${next ? `
          <div class="bg-brand-600 text-white rounded-2xl p-4 shadow-md">
            <p class="text-[10px] uppercase font-bold tracking-widest text-brand-100">Prochaine étape</p>
            <h2 class="font-extrabold text-base mt-0.5">${escapeHtml(next.name)}</h2>
            <p class="text-xs text-brand-50/90 mt-0.5 break-words">${escapeHtml(next.address)}</p>
            <div class="flex items-center justify-between mt-2">
              <span class="text-sm font-bold"><i class="fa-regular fa-clock mr-1"></i>${etaLabel(next)}</span>
              <a href="${navigationLinks(next).google}" target="_blank" rel="noopener" class="min-h-[40px] px-3 bg-white text-brand-700 rounded-lg text-xs font-bold flex items-center gap-1">
                <i class="fa-solid fa-diamond-turn-right"></i> Naviguer
              </a>
            </div>
          </div>
        ` : `
          <div class="bg-emerald-600 text-white rounded-2xl p-5 text-center shadow-md">
            <i class="fa-solid fa-champagne-glasses text-2xl"></i>
            <p class="font-bold mt-2">Tournée terminée !</p>
            <p class="text-xs text-emerald-100">Tous les arrêts ont été traités.</p>
          </div>
        `}

        <div class="flex items-center justify-between">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500">Arrêts (${total})</h2>
          <button type="button" data-action="gps" class="text-xs font-semibold text-brand-700 px-2 py-1">
            <i class="fa-solid fa-satellite-dish mr-1"></i> Démarrer le suivi GPS
          </button>
        </div>

        <div class="space-y-3">
          ${stops.length ? stops.map((s, i) => stopCard(s, i, s.id === next?.id, driver)).join('') : `
            <div class="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-400">
              Aucun arrêt planifié pour cette date.
            </div>`}
        </div>

        <p class="text-[11px] text-slate-400 text-center pt-2">
          RoadOptimizur v3 · données enregistrées sur cet appareil
        </p>
      </main>

      <nav class="fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 z-30 safe-bottom">
        <div class="grid grid-cols-3">
          <button type="button" data-action="call-depot" class="py-2.5 min-h-[56px] flex flex-col items-center justify-center text-[10px] font-semibold text-slate-600 gap-0.5">
            <i class="fa-solid fa-warehouse text-base"></i> Dépôt
          </button>
          <button type="button" data-action="gps" class="py-2.5 min-h-[56px] flex flex-col items-center justify-center text-[10px] font-semibold text-brand-700 gap-0.5">
            <i class="fa-solid fa-location-crosshairs text-base"></i> GPS
          </button>
          <button type="button" data-action="summary" class="py-2.5 min-h-[56px] flex flex-col items-center justify-center text-[10px] font-semibold text-slate-600 gap-0.5">
            <i class="fa-solid fa-chart-simple text-base"></i> Résumé
          </button>
        </div>
      </nav>
    </div>
  `;
}

/**
 * Monte la vue conducteur.
 * @param {object} state
 * @param {string} driverId
 * @param {{save?:Function, onChange?:Function}} opts
 */
export function initDriverView(state, driverId, opts = {}) {
  const root = document.getElementById('view-driver');
  if (!root) return null;
  const driver = getDriver(state, driverId);
  if (!driver) {
    root.innerHTML = `
      <div class="min-h-dvh flex items-center justify-center p-6 bg-slate-100">
        <div class="bg-white rounded-2xl shadow p-6 text-center max-w-sm">
          <i class="fa-solid fa-user-xmark text-3xl text-red-500"></i>
          <h1 class="font-bold mt-3">Conducteur introuvable</h1>
          <p class="text-sm text-slate-500 mt-1">Le lien est incomplet ou le conducteur a été supprimé.</p>
          <a href="./" class="inline-block mt-4 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-semibold">Retour au planificateur</a>
        </div>
      </div>`;
    return null;
  }

  const date = state.planning.activeDate || todayISO();
  let stops = getDriverRoute(state, driverId, date);
  const save = () => { opts.save?.(); };
  const refresh = () => {
    stops = getDriverRoute(state, driverId, date);
    root.innerHTML = renderShell(state, driver, date, stops, navigator.onLine);
    bind();
  };

  const mark = (stop, status) => {
    stop.status = status;
    stop.completedAt = status === 'pending' ? null : new Date().toISOString();
    if (status !== 'pending' && !stop.arrivedAt) stop.arrivedAt = stop.completedAt;
    save();
    refresh();
    if (status === 'absent') toast('Client absent enregistré.', 'warn');
    if (status === 'failed') toast('Échec de livraison enregistré.', 'error');
    if (status === 'delivered') toast('Livraison confirmée.', 'success');
    opts.onChange?.();
  };

  function bind() {
    const handleAction = (action, id) => {
      const stop = id ? state.stops.find((s) => s.id === id) : null;
      if (action === 'deliver' && stop) {
        openPOD(stop, state, {
          markDelivered: true,
          onSave: () => { save(); refresh(); opts.onChange?.(); },
        });
        return;
      }
      if ((action === 'absent' || action === 'failed') && stop) {
        const same = stop.status === action;
        mark(stop, same ? 'pending' : action);
        return;
      }
      if (action === 'arrived' && stop) {
        stop.arrivedAt = new Date().toISOString();
        save();
        toast('Arrivée horodatée.', 'success');
        refresh();
        return;
      }
      if (action === 'scan' && stop) {
        openScanner(stop, {
          onScan: (code, match) => {
            stop.pod = stop.pod || { signature: null, photos: [], fields: {}, scans: [], geo: null, completedAt: null };
            stop.pod.scans = Array.isArray(stop.pod.scans) ? stop.pod.scans : [];
            if (code && !stop.pod.scans.includes(code)) stop.pod.scans.push(code);
            save();
            toast(match === false ? `Code inattendu : ${code}` : `Code scanné : ${code}`, match === false ? 'warn' : 'success');
            refresh();
          },
        });
        return;
      }
      if (action === 'gps') { startGps(); return; }
      if (action === 'call-depot') {
        const phone = state.settings.company?.phone || state.settings.depot?.phone || '';
        if (phone) window.location.href = `tel:${phone}`;
        else toast('Aucun numéro de dépôt configuré.', 'warn');
        return;
      }
      if (action === 'summary') {
        const delivered = stops.filter((s) => s.status === 'delivered').length;
        const absent = stops.filter((s) => s.status === 'absent').length;
        const failed = stops.filter((s) => s.status === 'failed').length;
        const km = stops.reduce((a, s) => a + (Number(s.distanceKm) || 0), 0);
        alert(`Résumé de la tournée\n\n${stops.length} arrêts\n${delivered} livrés\n${absent} absents\n${failed} échecs\n\nDépart : ${driver.shift?.start || '—'}\nFin prévue : ${stops.length ? etaLabel(stops[stops.length - 1]) : '—'}`);
        return;
      }
    };

    root.onclick = (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      handleAction(btn.dataset.action, btn.dataset.id);
    };
  }

  function startGps() {
    if (!navigator.geolocation) { toast('Géolocalisation non supportée.', 'error'); return; }
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      toast('Suivi GPS arrêté.', 'info');
      const el = document.getElementById('gps-status');
      if (el) el.innerHTML = '<i class="fa-solid fa-location-dot mr-1"></i>GPS inactif';
      return;
    }
    const gpsEl = document.getElementById('gps-status');
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const now = Date.now();
        const activeStop = stops.find((s) => s.status === 'pending');
        if (activeStop && now - lastBreadcrumbAt > 15000) {
          lastBreadcrumbAt = now;
          activeStop.breadcrumb = Array.isArray(activeStop.breadcrumb) ? activeStop.breadcrumb : [];
          activeStop.breadcrumb.push({ lat, lng, t: now });
          if (activeStop.breadcrumb.length > 500) activeStop.breadcrumb.shift();
          save();
        }
        if (gpsEl) gpsEl.innerHTML = `<i class="fa-solid fa-location-dot mr-1 text-emerald-400"></i>${lat.toFixed(4)}, ${lng.toFixed(4)} · ±${Math.round(accuracy)} m`;
      },
      (err) => {
        console.warn('[driver] GPS', err);
        toast('GPS refusé ou indisponible.', 'error');
        if (gpsEl) gpsEl.innerHTML = '<i class="fa-solid fa-location-dot mr-1"></i>GPS indisponible';
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    toast('Suivi GPS démarré — fil d’Ariane actif.', 'success');
  }

  root.innerHTML = renderShell(state, driver, date, stops, navigator.onLine);
  bind();

  document.getElementById('view-driver')?.classList.remove('hidden');

  onlineHandler = () => {
    const badge = document.getElementById('net-badge');
    if (!badge) return;
    const on = navigator.onLine;
    badge.className = `text-[10px] font-bold px-2 py-1 rounded-full ${on ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`;
    badge.innerHTML = `<i class="fa-solid ${on ? 'fa-wifi' : 'fa-plug-circle-xmark'}"></i> ${on ? 'En ligne' : 'Hors-ligne'}`;
  };
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', onlineHandler);

  return {
    refresh,
    destroy() {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', onlineHandler);
      onlineHandler = null;
    },
  };
}

/** Lien de partage de suivi client (SMS / e-mail pré-remplis). */
export function trackingLinks(stop) {
  const url = `${location.origin}${location.pathname}?track=${encodeURIComponent(stop.id)}`;
  const eta = stop.eta ? new Date(stop.eta).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const msg = `Bonjour ${stop.name || ''}, votre livraison est prévue vers ${eta}. Suivez-la ici : ${url}`;
  return {
    url,
    sms: `sms:${encodeURIComponent(stop.phone || '')}?body=${encodeURIComponent(msg)}`,
    mailto: `mailto:${encodeURIComponent(stop.email || '')}?subject=${encodeURIComponent('Suivi de votre livraison')}&body=${encodeURIComponent(msg)}`,
    message: msg,
  };
}
