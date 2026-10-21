/**
 * RoadOptimizur v4 — vue conducteur connectée au serveur.
 * Affiche la tournée publiée pour le compte (my-tour), remonte les statuts en temps réel.
 */
import { auth, api, logout } from './auth.js';

const META = {
  pending: ['À faire', 'fa-circle', 'text-slate-400'],
  delivered: ['Livré', 'fa-circle-check', 'text-emerald-600'],
  absent: ['Absent', 'fa-triangle-exclamation', 'text-amber-500'],
  failed: ['Échec', 'fa-circle-xmark', 'text-rose-600'],
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initDriverServerView(user, opts = {}) {
  const root = document.getElementById('view-driver');
  let stops = [];
  let tour = null;
  let destroyed = false;
  let poll = null;

  const render = (msg = '') => {
    const done = stops.filter((s) => s.status && s.status !== 'pending').length;
    root.innerHTML = `
      <div class="min-h-dvh bg-slate-100 pb-24">
        <header class="bg-slate-900 text-white px-4 py-3 flex items-center justify-between gap-2 sticky top-0 z-10">
          <div class="min-w-0">
            <p class="text-[11px] text-slate-400 truncate">${esc(tour ? tour.updatedBy || '' : '')}Tournée du ${esc(new Date().toLocaleDateString('fr-FR'))}</p>
            <h1 class="font-black text-lg truncate">${esc(user.name)}</h1>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button type="button" data-dsv="reload" class="w-11 h-11 rounded-xl bg-slate-800 active:bg-slate-700 flex items-center justify-center" title="Actualiser"><i class="fa-solid fa-rotate"></i></button>
            <button type="button" data-dsv="logout" class="w-11 h-11 rounded-xl bg-rose-600/90 active:bg-rose-700 flex items-center justify-center" title="Se déconnecter"><i class="fa-solid fa-right-from-bracket"></i></button>
          </div>
        </header>
        <div class="px-4 pt-3">
          <div class="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3">
            <div class="flex-1"><div class="h-2.5 bg-slate-200 rounded-full overflow-hidden"><div class="h-full bg-emerald-500 transition-all" style="width:${stops.length ? Math.round(done / stops.length * 100) : 0}%"></div></div></div>
            <p class="text-xs font-bold text-slate-600">${done}/${stops.length}</p>
          </div>
          ${!navigator.onLine ? '<p class="mt-2 text-xs font-bold text-amber-700 bg-amber-100 rounded-lg p-2"><i class="fa-solid fa-wifi mr-1"></i> Hors-ligne — les statuts seront renvoyés à la reconnexion.</p>' : ''}
          ${msg ? `<p class="mt-2 text-xs font-bold text-rose-700 bg-rose-50 rounded-lg p-2">${esc(msg)}</p>` : ''}
        </div>
        <div class="px-4 mt-3 space-y-2.5">
          ${stops.length ? stops.map((s, i) => {
            const st = META[s.status || 'pending'];
            const tel = s.phone ? `tel:${esc(String(s.phone).replace(/[^\d+]/g, ''))}` : null;
            const addr = `${s.address || ''}${s.city ? ', ' + s.city : ''}`;
            const nav = s.geo && s.geo.lat ? `https://www.google.com/maps/dir/?api=1&destination=${s.geo.lat},${s.geo.lng}` : (addr ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr) : null);
            return `
            <article class="bg-white rounded-xl border border-slate-200 p-3.5 ${s.status === 'delivered' ? 'opacity-60' : ''}">
              <div class="flex items-start gap-2">
                <span class="w-7 h-7 rounded-full bg-slate-900 text-white text-xs font-black flex items-center justify-center flex-shrink-0">${i + 1}</span>
                <div class="flex-1 min-w-0">
                  <p class="font-bold text-[15px] text-slate-800 truncate">${esc(s.name)}</p>
                  <p class="text-[13px] text-slate-500 mt-0.5">${esc(addr || 'adresse non renseignée')}</p>
                  <p class="text-[13px] mt-1"><i class="fa-solid ${st[1]} ${st[2]}"></i> <b class="${st[2]}">${st[0]}</b>${s.eta ? ` · ETA ${esc(String(s.eta).includes('T') ? new Date(s.eta).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : s.eta)}` : ''}</p>
                  ${s.notes ? `<p class="text-[13px] text-slate-600 mt-1 bg-slate-50 rounded-lg p-2"><i class="fa-solid fa-note-sticky mr-1 text-slate-400"></i>${esc(s.notes)}</p>` : ''}
                </div>
                ${nav ? `<a href="${nav}" target="_blank" rel="noopener" class="w-11 h-11 rounded-xl bg-brand-600 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-diamond-turn-right"></i></a>` : ''}
                ${tel ? `<a href="${tel}" class="w-11 h-11 rounded-xl bg-white border border-slate-300 text-slate-600 flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-phone"></i></a>` : ''}
              </div>
              ${s.status === 'pending' ? `
              <div class="grid grid-cols-3 gap-2 mt-3">
                <button type="button" data-dsv="status" data-id="${esc(s.id)}" data-status="delivered" class="py-3 rounded-xl bg-emerald-600 text-white text-[13px] font-bold active:bg-emerald-700"><i class="fa-solid fa-box mr-1"></i>Livré</button>
                <button type="button" data-dsv="status" data-id="${esc(s.id)}" data-status="absent" class="py-3 rounded-xl bg-amber-500 text-white text-[13px] font-bold active:bg-amber-600"><i class="fa-solid fa-user-clock mr-1"></i>Absent</button>
                <button type="button" data-dsv="status" data-id="${esc(s.id)}" data-status="failed" class="py-3 rounded-xl bg-rose-600 text-white text-[13px] font-bold active:bg-rose-700"><i class="fa-solid fa-ban mr-1"></i>Échec</button>
              </div>` : `
              <button type="button" data-dsv="undo" data-id="${esc(s.id)}" class="mt-2.5 w-full py-2.5 rounded-xl bg-white border border-slate-300 text-slate-500 text-[13px] font-bold"><i class="fa-solid fa-rotate-left mr-1"></i>Repasser à faire</button>`}
            </article>`;
          }).join('') : `<div class="bg-white rounded-xl border border-slate-200 p-6 text-center">
            <i class="fa-solid fa-box-open text-3xl text-slate-300"></i>
            <p class="font-bold text-slate-600 mt-2">Aucune tournée publiée aujourd’hui</p>
            <p class="text-[13px] text-slate-500 mt-1">Préviens le dispatch : il doit cliquer « Publier » sur la journée en cours. Tu peux recharger avec la bouton ↻.</p></div>`}
        </div>
      </div>`;
    root.querySelectorAll('[data-dsv]').forEach((btn) => btn.addEventListener('click', onBtn));
  };

  async function onBtn(ev) {
    const kind = ev.currentTarget.dataset.dsv;
    if (kind === 'logout') {
      logout();
      if (opts.onExit) opts.onExit(); else location.href = './';
      return;
    }
    if (kind === 'reload') { await load(); return; }
    if (kind === 'undo') { await sendStatus(ev.currentTarget.dataset.id, 'pending', true); return; }
    if (kind === 'status') {
      const b = ev.currentTarget;
      b.disabled = true;
      await sendStatus(b.dataset.id, b.dataset.status, false);
    }
  }

  async function sendStatus(stopId, status, undo) {
    const r = await api('/stop-status', { method: 'POST', body: { stopId, date: today(), status } });
    if (r.ok || (undo && r.status === 400)) {
      const s = stops.find((x) => x.id === stopId);
      if (s) s.status = status;
      render();
    } else {
      render('Envoi impossible : ' + (r.data?.error || 'serveur injoignable'));
    }
  }

  const today = () => new Date().toISOString().slice(0, 10);

  async function load() {
    const r = await api('/my-tour?date=' + today());
    if (destroyed) return;
    if (r.ok && r.data) {
      tour = r.data.tour;
      stops = (r.data.tour && r.data.tour.stops) || [];
      render(r.data.reason && !r.data.tour ? ('Compte : ' + r.data.reason) : '');
    } else {
      render((r.data && r.data.error) || 'Connexion au serveur impossible.');
    }
  }

  const vis = () => { if (!document.hidden) load(); };
  document.addEventListener('visibilitychange', vis);
  poll = setInterval(load, 60000);
  load();
  return {
    destroy() { destroyed = true; clearInterval(poll); document.removeEventListener('visibilitychange', vis); },
    refresh: load,
  };
}
