/**
 * RoadOptimizur v3 — analytics.js
 * Analytique par jour/conducteur : km, durée, arrêts, statuts, coût,
 * taux d'utilisation, graphiques Chart.js, export CSV.
 */

import { formatDateFR, download, todayISO, addDaysISO } from './storage.js';
import { estimateTour } from './routing.js';
import { escapeHtml, toast } from './pod.js';

let charts = [];

function destroyCharts() {
  charts.forEach((c) => { try { c.destroy(); } catch {} });
  charts = [];
}

function fmt(n, digits = 0) {
  return Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function driverHistory(state, date, driverId) {
  const entry = (state.history || []).find((h) => h.date === date && h.type === 'optimize' && Array.isArray(h.drivers));
  if (!entry) return null;
  return entry.drivers.find((d) => d.driverId === driverId) || null;
}

export function computeAnalytics(state, date = todayISO()) {
  const stops = state.stops.filter((s) => s.date === date);
  const drivers = state.drivers;
  const rows = [];

  for (const driver of drivers) {
    const own = stops.filter((s) => s.driverId === driver.id).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const hist = driverHistory(state, date, driver.id);
    const estimate = own.length ? estimateTour(state.settings.depot, own, state.settings.routing.profile, state.settings.hours.avgSpeedKmh) : { distanceKm: 0, durationMin: 0 };
    const distanceKm = hist?.distanceKm ?? estimate.distanceKm;
    const durationMin = hist?.durationMin ?? estimate.durationMin;
    const delivered = own.filter((s) => s.status === 'delivered').length;
    const absent = own.filter((s) => s.status === 'absent').length;
    const failed = own.filter((s) => s.status === 'failed').length;
    const pending = own.filter((s) => s.status === 'pending').length;
    const weight = own.reduce((a, s) => a + (Number(s.weightKg) || 0), 0);
    const volume = own.reduce((a, s) => a + (Number(s.volumeM3) || 0), 0);
    const pallets = own.reduce((a, s) => a + (Number(s.pallets) || 0), 0);
    const cap = driver.capacity || {};
    const ratios = [];
    if (cap.kg > 0) ratios.push((weight / cap.kg) * 100);
    if (cap.m3 > 0) ratios.push((volume / cap.m3) * 100);
    if (cap.pallets > 0 && pallets > 0) ratios.push((pallets / cap.pallets) * 100);
    const utilization = ratios.length ? Math.max(...ratios) : 0;
    const cost = (durationMin / 60) * (Number(driver.hourlyCost) || 0);
    const completion = own.length ? Math.round(((delivered + absent + failed) / own.length) * 100) : 0;

    rows.push({
      driverId: driver.id,
      driverName: driver.name,
      color: driver.color || '#0284c7',
      stops: own.length,
      delivered,
      absent,
      failed,
      pending,
      distanceKm,
      durationMin,
      cost,
      weight,
      volume,
      pallets,
      utilization,
      completion,
      estimated: !hist,
    });
  }

  // Conducteurs sans arrêt : conservés pour le tableau mais compacts.
  const totals = rows.reduce((acc, r) => ({
    stops: acc.stops + r.stops,
    delivered: acc.delivered + r.delivered,
    absent: acc.absent + r.absent,
    failed: acc.failed + r.failed,
    pending: acc.pending + r.pending,
    distanceKm: acc.distanceKm + r.distanceKm,
    durationMin: acc.durationMin + r.durationMin,
    cost: acc.cost + r.cost,
    utilization: acc.utilization + r.utilization,
  }), { stops: 0, delivered: 0, absent: 0, failed: 0, pending: 0, distanceKm: 0, durationMin: 0, cost: 0, utilization: 0 });
  totals.avgUtilization = rows.length ? totals.utilization / rows.length : 0;
  totals.completion = totals.stops ? Math.round(((totals.delivered + totals.absent + totals.failed) / totals.stops) * 100) : 0;

  return { date, rows, totals, stops };
}

function weekSeries(state, date) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDaysISO(date, -i);
    const s = state.stops.filter((x) => x.date === d);
    days.push({
      date: d,
      label: new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit' }),
      stops: s.length,
      delivered: s.filter((x) => x.status === 'delivered').length,
    });
  }
  return days;
}

export function analyticsCSV(state, date) {
  const { rows, totals } = computeAnalytics(state, date);
  const head = ['date', 'conducteur', 'arrets', 'livres', 'absents', 'echecs', 'en_attente', 'km', 'duree_min', 'cout_eur', 'poids_kg', 'volume_m3', 'palettes', 'utilisation_pct', 'completion_pct'];
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([
      date, r.driverName, r.stops, r.delivered, r.absent, r.failed, r.pending,
      r.distanceKm.toFixed(1), Math.round(r.durationMin), r.cost.toFixed(2),
      r.weight, r.volume, r.pallets, r.utilization.toFixed(0), r.completion,
    ].map((v) => String(v).replace(/;/g, ',')).join(';'));
  }
  lines.push(['TOTAL', '', totals.stops, totals.delivered, totals.absent, totals.failed, totals.pending,
    totals.distanceKm.toFixed(1), Math.round(totals.durationMin), totals.cost.toFixed(2), '', '', '', '', ''].join(';'));
  return `\uFEFF${lines.join('\n')}`;
}

export function exportAnalyticsCSV(state, date) {
  download(`analytique-${date}.csv`, analyticsCSV(state, date), 'text/csv');
  toast('Rapport CSV téléchargé.', 'success');
}

export function renderAnalytics(panel, state, date) {
  destroyCharts();
  const { rows, totals } = computeAnalytics(state, date);
  const week = weekSeries(state, date);

  const kpi = (label, value, sub, icon, color) => `
    <div class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm">
      <div class="flex items-center justify-between">
        <span class="text-[10px] uppercase tracking-wider font-bold text-slate-500">${label}</span>
        <i class="fa-solid ${icon} ${color}"></i>
      </div>
      <p class="text-xl font-extrabold text-slate-900 mt-1">${value}</p>
      <p class="text-[11px] text-slate-400">${sub}</p>
    </div>`;

  panel.innerHTML = `
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-extrabold text-slate-900">Analytique</h2>
          <p class="text-xs text-slate-500">${formatDateFR(date)} · ${totals.stops} arrêts planifiés</p>
        </div>
        <button type="button" data-analytics-export class="min-h-[44px] px-3 bg-slate-900 text-white rounded-lg text-xs font-bold flex items-center gap-2">
          <i class="fa-solid fa-file-csv"></i> Export CSV
        </button>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
        ${kpi('Distance', `${fmt(totals.distanceKm, 1)} km`, 'toutes tournées', 'fa-route', 'text-brand-500')}
        ${kpi('Durée', `${Math.floor(totals.durationMin / 60)} h ${Math.round(totals.durationMin % 60)}`, 'trajet + service', 'fa-clock', 'text-indigo-500')}
        ${kpi('Coût main-d’œuvre', `${fmt(totals.cost, 2)} €`, 'coût horaire conducteurs', 'fa-euro-sign', 'text-emerald-600')}
        ${kpi('Réalisation', `${totals.completion}%`, `${totals.delivered} livrés / ${totals.stops}`, 'fa-circle-check', 'text-amber-500')}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Distance par conducteur (km)</h3>
          <div class="h-52"><canvas id="chart-dist"></canvas></div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Statuts des arrêts</h3>
          <div class="h-52"><canvas id="chart-status"></canvas></div>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-3 shadow-sm">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">7 derniers jours</h3>
        <div class="h-48"><canvas id="chart-week"></canvas></div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">Détail par conducteur</h3>
          <span class="text-[10px] text-slate-400">${rows.filter((r) => r.estimated && r.stops).length ? 'estimations haversine *' : 'issu de l’optimisation'}</span>
        </div>
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-500">
              <tr>
                <th class="text-left px-3 py-2 font-semibold">Conducteur</th>
                <th class="text-right px-2 py-2 font-semibold">Arrêts</th>
                <th class="text-right px-2 py-2 font-semibold">Livrés</th>
                <th class="text-right px-2 py-2 font-semibold">Échecs</th>
                <th class="text-right px-2 py-2 font-semibold">km</th>
                <th class="text-right px-2 py-2 font-semibold">Durée</th>
                <th class="text-right px-2 py-2 font-semibold">Coût</th>
                <th class="text-right px-3 py-2 font-semibold">Utilisation</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${rows.map((r) => `
                <tr class="hover:bg-slate-50">
                  <td class="px-3 py-2">
                    <span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:${r.color}"></span>
                    <span class="font-semibold text-slate-800">${escapeHtml(r.driverName)}</span>
                  </td>
                  <td class="text-right px-2 py-2">${r.stops}</td>
                  <td class="text-right px-2 py-2 text-emerald-600 font-semibold">${r.delivered}</td>
                  <td class="text-right px-2 py-2 text-red-500">${r.failed + r.absent}</td>
                  <td class="text-right px-2 py-2">${fmt(r.distanceKm, 1)}</td>
                  <td class="text-right px-2 py-2">${Math.round(r.durationMin)} min</td>
                  <td class="text-right px-2 py-2">${fmt(r.cost, 2)} €</td>
                  <td class="text-right px-3 py-2">
                    <span class="font-bold ${r.utilization > 100 ? 'text-red-600' : r.utilization > 80 ? 'text-amber-600' : 'text-slate-700'}">${Math.round(r.utilization)}%</span>
                  </td>
                </tr>`).join('') || '<tr><td colspan="8" class="text-center py-8 text-slate-400">Aucune donnée.</td></tr>'}
            </tbody>
            <tfoot class="bg-slate-50 font-bold text-slate-800">
              <tr>
                <td class="px-3 py-2">Total</td>
                <td class="text-right px-2 py-2">${totals.stops}</td>
                <td class="text-right px-2 py-2">${totals.delivered}</td>
                <td class="text-right px-2 py-2">${totals.failed + totals.absent}</td>
                <td class="text-right px-2 py-2">${fmt(totals.distanceKm, 1)}</td>
                <td class="text-right px-2 py-2">${Math.round(totals.durationMin)} min</td>
                <td class="text-right px-2 py-2">${fmt(totals.cost, 2)} €</td>
                <td class="text-right px-3 py-2">${Math.round(totals.avgUtilization)}%</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="md:hidden divide-y divide-slate-100">
          ${rows.filter((r) => r.stops).map((r) => `
            <div class="p-3">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm"><span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:${r.color}"></span>${escapeHtml(r.driverName)}</span>
                <span class="text-xs font-bold ${r.utilization > 100 ? 'text-red-600' : 'text-slate-600'}">${Math.round(r.utilization)}%</span>
              </div>
              <div class="grid grid-cols-3 gap-2 mt-2 text-[11px] text-slate-500">
                <span><strong class="text-slate-800">${r.stops}</strong> arrêts</span>
                <span><strong class="text-slate-800">${fmt(r.distanceKm, 1)}</strong> km</span>
                <span><strong class="text-slate-800">${Math.round(r.durationMin)}</strong> min</span>
                <span><strong class="text-emerald-600">${r.delivered}</strong> livrés</span>
                <span><strong class="text-red-500">${r.failed + r.absent}</strong> échecs</span>
                <span><strong class="text-slate-800">${fmt(r.cost, 2)} €</strong></span>
              </div>
            </div>`).join('') || '<p class="p-6 text-center text-sm text-slate-400">Aucune donnée.</p>'}
        </div>
      </div>
      <p class="text-[10px] text-slate-400">* Distance estimée par vol d’oiseau corrigé lorsque la tournée n’a pas encore été optimisée.</p>
    </div>
  `;

  panel.querySelector('[data-analytics-export]')?.addEventListener('click', () => exportAnalyticsCSV(state, date));

  if (typeof window.Chart === 'undefined') {
    panel.querySelectorAll('canvas').forEach((c) => {
      const p = document.createElement('p');
      p.className = 'text-xs text-slate-400 text-center pt-12';
      p.textContent = 'Graphiques indisponibles hors-ligne (Chart.js non chargé).';
      c.replaceWith(p);
    });
    return;
  }

  const grid = { color: 'rgba(148,163,184,.18)' };
  const distCanvas = panel.querySelector('#chart-dist');
  if (distCanvas) {
    charts.push(new window.Chart(distCanvas, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.driverName || '—'),
        datasets: [{ label: 'km', data: rows.map((r) => Number(r.distanceKm.toFixed(1))), backgroundColor: rows.map((r) => r.color), borderRadius: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid, ticks: { font: { size: 10 } } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      },
    }));
  }

  const statusCanvas = panel.querySelector('#chart-status');
  if (statusCanvas) {
    charts.push(new window.Chart(statusCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Livrés', 'Absents', 'Échecs', 'En attente'],
        datasets: [{
          data: [totals.delivered, totals.absent, totals.failed, totals.pending],
          backgroundColor: ['#059669', '#f59e0b', '#dc2626', '#cbd5e1'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      },
    }));
  }

  const weekCanvas = panel.querySelector('#chart-week');
  if (weekCanvas) {
    charts.push(new window.Chart(weekCanvas, {
      type: 'line',
      data: {
        labels: week.map((d) => d.label),
        datasets: [
          { label: 'Planifiés', data: week.map((d) => d.stops), borderColor: '#0284c7', backgroundColor: 'rgba(2,132,199,.12)', fill: true, tension: 0.35, pointRadius: 3 },
          { label: 'Livrés', data: week.map((d) => d.delivered), borderColor: '#059669', backgroundColor: 'transparent', tension: 0.35, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
        scales: { y: { beginAtZero: true, grid, ticks: { precision: 0, font: { size: 10 } } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      },
    }));
  }
}

export function analyticsSummaryText(state, date) {
  const { totals } = computeAnalytics(state, date);
  return `${totals.stops} arrêts · ${fmt(totals.distanceKm, 1)} km · ${fmt(totals.cost, 2)} €`;
}
