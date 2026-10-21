/**
 * RoadOptimizur v3 — optimize.js
 * Affectation multi-conducteurs + ordonnancement : nearest-neighbor, puis 2-opt.
 * Contraintes : fenêtres horaires, capacité véhicule, compétences, précédence
 * pickup → delivery, teamGroup, équilibrage de charge, départ flexible.
 */

import { minutesFromHHMM, isoAt } from './storage.js';
import { roadEstimate } from './routing.js';

const DEPOT_KEY = '__depot';
const MAX_2OPT_PASSES = 40;

const toMin = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'number') return v;
  return minutesFromHHMM(v, fallback ?? 0);
};

const stopPoint = (s) => s.geo || { lat: s.lat || 0, lng: s.lng || 0 };

/* ------------------------------------------------------------------ */
/* Matrice de travail                                                  */
/* ------------------------------------------------------------------ */

export function buildEstimateMatrix(depot, stops, profile = 'auto', avgSpeedKmh) {
  const pts = [depot, ...stops];
  const keys = [DEPOT_KEY, ...stops.map((s) => s.id)];
  const distances = [];
  const durations = [];
  for (let i = 0; i < pts.length; i++) {
    distances[i] = [];
    durations[i] = [];
    for (let j = 0; j < pts.length; j++) {
      if (i === j) { distances[i][j] = 0; durations[i][j] = 0; continue; }
      const e = roadEstimate(stopPoint(pts[i]), stopPoint(pts[j]), profile, avgSpeedKmh);
      distances[i][j] = e.distanceKm;
      durations[i][j] = e.durationMin;
    }
  }
  return { points: pts, keys, distances, durations, source: 'estimation' };
}

function matrixAccessor(matrix) {
  const index = new Map();
  (matrix.keys || []).forEach((k, i) => index.set(k, i));
  return (aKey, bKey) => {
    const i = index.get(aKey);
    const j = index.get(bKey);
    if (i === undefined || j === undefined) {
      const a = matrix.byKey?.[aKey];
      const b = matrix.byKey?.[bKey];
      if (a && b) {
        const e = roadEstimate(a, b);
        return { distanceKm: e.distanceKm, durationMin: e.durationMin };
      }
      return { distanceKm: 0, durationMin: 0 };
    }
    return {
      distanceKm: matrix.distances[i]?.[j] ?? 0,
      durationMin: matrix.durations[i]?.[j] ?? 0,
    };
  };
}

/** Prépare une matrice exploitable par l'optimiseur (fournie ou estimée). */
export function prepareMatrix(state, stops, provided = null) {
  if (provided && provided.distances && provided.keys) return provided;
  const depot = state.settings.depot;
  if (provided && provided.distances && provided.points) {
    // Matrice de routing.matrix() : points = [dépôt, ...stops]
    const keys = [DEPOT_KEY, ...stops.map((s) => s.id)];
    return { ...provided, keys };
  }
  return buildEstimateMatrix(
    depot,
    stops,
    state.settings.routing?.profile || 'auto',
    state.settings.hours?.avgSpeedKmh
  );
}

/* ------------------------------------------------------------------ */
/* Unités indivisibles : teamGroup et paires pickup/delivery           */
/* ------------------------------------------------------------------ */

function buildUnits(stops) {
  const byId = new Map(stops.map((s) => [s.id, s]));
  const used = new Set();
  const units = [];

  const makeUnit = (list) => {
    const ordered = [...list].sort((a, b) => {
      if (a.type === 'pickup' && b.type !== 'pickup') return -1;
      if (b.type === 'pickup' && a.type !== 'pickup') return 1;
      return String(a.id).localeCompare(String(b.id));
    });
    ordered.forEach((s) => used.add(s.id));
    const unit = {
      id: ordered.map((s) => s.id).join('+'),
      stops: ordered,
      weightKg: ordered.reduce((a, s) => a + (Number(s.weightKg) || 0), 0),
      volumeM3: ordered.reduce((a, s) => a + (Number(s.volumeM3) || 0), 0),
      pallets: ordered.reduce((a, s) => a + (Number(s.pallets) || 0), 0),
      skills: [...new Set(ordered.flatMap((s) => s.skillsRequired || []))],
      priority: Math.max(...ordered.map((s) => Number(s.priority) || 1)),
      windowStart: Math.min(...ordered.map((s) => toMin(s.windowStart, 24 * 60))),
      windowEnd: Math.min(...ordered.map((s) => toMin(s.windowEnd, 24 * 60))),
    };
    if (!Number.isFinite(unit.windowStart) || unit.windowStart === 24 * 60) unit.windowStart = null;
    if (!Number.isFinite(unit.windowEnd) || unit.windowEnd === 24 * 60) unit.windowEnd = null;
    units.push(unit);
    return unit;
  };

  // 1) Groups d'équipe (même conducteur, d'affilée)
  const teams = new Map();
  for (const s of stops) {
    if (s.teamGroup !== null && s.teamGroup !== undefined && s.teamGroup !== '') {
      if (!teams.has(s.teamGroup)) teams.set(s.teamGroup, []);
      teams.get(s.teamGroup).push(s);
    }
  }
  for (const list of teams.values()) makeUnit(list.filter((s) => !used.has(s.id)));

  // 2) Paires pickup → delivery
  for (const s of stops) {
    if (used.has(s.id)) continue;
    if (s.pairedWith && byId.has(s.pairedWith) && !used.has(s.pairedWith)) {
      const partner = byId.get(s.pairedWith);
      makeUnit([s, partner]);
    }
  }

  // 3) Arrêts simples
  for (const s of stops) {
    if (!used.has(s.id)) makeUnit([s]);
  }

  return units;
}

/* ------------------------------------------------------------------ */
/* Simulation d'une tournée                                            */
/* ------------------------------------------------------------------ */

function driverShift(driver, settings) {
  const start = Math.max(
    minutesFromHHMM(settings.hours?.workStart, 480),
    minutesFromHHMM(driver.shift?.start, 480)
  );
  const end = Math.min(
    minutesFromHHMM(settings.hours?.workEnd, 1080),
    minutesFromHHMM(driver.shift?.end, 1080)
  );
  return { start, end: Math.max(start + 30, end) };
}

function simulate(stops, driver, settings, travel, startMin) {
  let t = startMin;
  let prevKey = DEPOT_KEY;
  let distanceKm = 0;
  let waitMin = 0;
  let lateMin = 0;
  let lateWindowStops = 0;
  let serviceMin = 0;
  const rows = [];
  const defaultService = Number(settings.hours?.serviceDefaultMin) || 10;

  for (const s of stops) {
    const leg = travel(prevKey, s.id);
    distanceKm += leg.distanceKm;
    let arrival = t + leg.durationMin;
    const ws = toMin(s.windowStart, null);
    const we = toMin(s.windowEnd, null);
    if (ws !== null && arrival < ws) {
      waitMin += ws - arrival;
      arrival = ws;
    }
    if (we !== null && arrival > we) {
      lateMin += arrival - we;
      lateWindowStops += 1;
    }
    const svc = Number(s.serviceMin ?? defaultService) || 0;
    serviceMin += svc;
    rows.push({ stopId: s.id, travelMin: leg.durationMin, distanceKm: leg.distanceKm, etaMin: arrival, waitMin: Math.max(0, arrival - (t + leg.durationMin)) });
    t = arrival + svc;
    prevKey = s.id;
  }

  const back = travel(prevKey, DEPOT_KEY);
  distanceKm += back.distanceKm;
  const endMin = t + back.durationMin;
  return {
    rows,
    distanceKm,
    driveMin: distanceKm ? rows.reduce((a, r) => a + r.travelMin, 0) + back.durationMin : 0,
    workMin: endMin - startMin,
    serviceMin,
    waitMin,
    lateMin,
    lateWindowStops,
    startMin,
    endMin,
    backMin: back.durationMin,
  };
}

export function evaluateRoute(driver, stops, settings, travel) {
  const shift = driverShift(driver, settings);
  const defaultService = Number(settings.hours?.serviceDefaultMin) || 10;

  // Départ flexible : on teste les heures de départ pertinentes (ouverture de fenêtre).
  const baseTravel = [];
  let elapsed = 0;
  let prev = DEPOT_KEY;
  for (const s of stops) {
    const leg = travel(prev, s.id);
    elapsed += leg.durationMin;
    baseTravel.push(elapsed);
    elapsed += Number(s.serviceMin ?? defaultService) || 0;
    prev = s.id;
  }
  const candidates = new Set([shift.start]);
  for (let i = 0; i < stops.length; i++) {
    const ws = toMin(stops[i].windowStart, null);
    if (ws !== null) candidates.add(Math.max(shift.start, Math.min(shift.end, ws - baseTravel[i])));
  }
  const startOptions = [...candidates].sort((a, b) => a - b);

  let best = null;
  for (const start of startOptions) {
    const sim = simulate(stops, driver, settings, travel, start);
    const score = sim.lateMin * 1000 + sim.lateWindowStops * 500 + sim.waitMin * 2 + sim.endMin * 0.05;
    if (!best || score < best.score) best = { ...sim, score };
  }
  if (!best) {
    best = simulate(stops, driver, settings, travel, shift.start);
    best.score = 0;
  }

  const weight = stops.reduce((a, s) => a + (Number(s.weightKg) || 0), 0);
  const volume = stops.reduce((a, s) => a + (Number(s.volumeM3) || 0), 0);
  const pallets = stops.reduce((a, s) => a + (Number(s.pallets) || 0), 0);
  const cap = driver.capacity || {};
  const skillsMissing = [...new Set(stops.flatMap((s) => s.skillsRequired || []))]
    .filter((sk) => !(driver.skills || []).includes(sk));

  const overCapacity =
    (cap.kg > 0 && weight > cap.kg + 1e-6) ||
    (cap.m3 > 0 && volume > cap.m3 + 1e-6) ||
    (cap.pallets > 0 && pallets > cap.pallets + 1e-6);
  const lateShift = Math.max(0, best.endMin - shift.end);
  const breakMinutes = Number(driver.breakMin || settings.hours?.breakMin || 0) || 0;

  return {
    ...best,
    score: best.score + lateShift * 1000,
    stopCount: stops.length,
    load: { weightKg: weight, volumeM3: volume, pallets },
    capacity: cap,
    overCapacity,
    skillsMissing,
    lateShift,
    valid: !overCapacity && skillsMissing.length === 0 && stops.length > 0,
    shift,
  };
}

/* ------------------------------------------------------------------ */
/* 2-opt sur les unités (précédence et équipes préservées)             */
/* ------------------------------------------------------------------ */

function routeCost(ev, balance, balanceValue) {
  return ev.distanceKm
    + ev.lateMin * 2.5
    + ev.lateShift * 3
    + ev.waitMin * 0.12
    + (balance === 'stops' ? ev.stopCount * balanceValue : balance === 'minutes' ? ev.workMin * balanceValue : 0);
}

export function twoOptImprove(units, driver, settings, travel, balance = 'none') {
  if (units.length < 4) return units;
  let best = [...units];
  let bestEv = evaluateRoute(driver, best.flatMap((u) => u.stops), settings, travel);
  let improved = true;
  let passes = 0;

  while (improved && passes < MAX_2OPT_PASSES) {
    improved = false;
    passes += 1;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const ev = evaluateRoute(driver, candidate.flatMap((u) => u.stops), settings, travel);
        if (!ev.valid) continue;
        const cost = routeCost(ev, balance, balance === 'stops' ? 0.6 : 0.03);
        const current = routeCost(bestEv, balance, balance === 'stops' ? 0.6 : 0.03);
        if (cost < current - 1e-9) {
          best = candidate;
          bestEv = ev;
          improved = true;
        }
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Affectation                                                         */
/* ------------------------------------------------------------------ */

export function optimize(state, opts = {}) {
  const date = opts.date || state.planning?.activeDate;
  const settings = state.settings;
  const balance = opts.balance || 'none';
  const requestedDriver = opts.driverId || null;

  state.stops = state.stops.filter((s) => s.type !== 'depotReload');
  const candidates = state.drivers.filter((d) => d.active !== false && (!requestedDriver || d.id === requestedDriver));
  const pendingStops = state.stops.filter(
    (s) => s.date === date && s.status === 'pending' && s.type !== 'depotReload' && (!requestedDriver || !s.driverId || s.driverId === requestedDriver)
  );

  if (!candidates.length) {
    return { date, assignments: [], unassigned: pendingStops.map((s) => ({ stopId: s.id, reason: 'Aucun conducteur actif' })), summary: { stops: pendingStops.length, assigned: 0 } };
  }
  if (!pendingStops.length) {
    return { date, assignments: [], unassigned: [], summary: { stops: 0, assigned: 0 } };
  }

  const matrix = prepareMatrix(state, pendingStops, opts.matrix || null);
  const travel = matrixAccessor(matrix);
  const units = buildUnits(pendingStops);

  // Priorité : priorité décroissante, fenêtre tôt, puis volume.
  units.sort((a, b) => (
    b.priority - a.priority ||
    (a.windowEnd ?? 9999) - (b.windowEnd ?? 9999) ||
    b.weightKg - a.weightKg
  ));

  const routes = new Map(candidates.map((d) => [d.id, []]));
  const evaluations = new Map(candidates.map((d) => [d.id, evaluateRoute(d, [], settings, travel)]));
  const unassigned = [];

  for (const unit of units) {
    let best = null;

    for (const driver of candidates) {
      if (unit.skills.some((sk) => !(driver.skills || []).includes(sk))) continue;
      const current = routes.get(driver.id);
      for (let pos = 0; pos <= current.length; pos++) {
        const candidate = [...current.slice(0, pos), unit, ...current.slice(pos)];
        const ev = evaluateRoute(driver, candidate.flatMap((u) => u.stops), settings, travel);
        if (!ev.valid) continue;

        const balanceValue = balance === 'stops' ? 0.8 : 0.04;
        const cost = routeCost(ev, balance, balanceValue);
        if (!best || cost < best.cost) best = { driverId: driver.id, route: candidate, ev, cost };
      }
    }

    if (best) {
      routes.set(best.driverId, best.route);
      evaluations.set(best.driverId, best.ev);
    } else {
      const missing = unit.skills.length ? `Compétences manquantes : ${unit.skills.join(', ')}` : 'Capacité ou contrainte impossible';
      for (const s of unit.stops) unassigned.push({ stopId: s.id, reason: missing });
    }
  }

  // 2-opt par conducteur
  const assignments = [];
  for (const driver of candidates) {
    let unitsRoute = routes.get(driver.id);
    if (!unitsRoute.length) continue;

    // Nearest-neighbor initial déjà réalisé par insertion ; 2-opt affine.
    unitsRoute = twoOptImprove(unitsRoute, driver, settings, travel, balance);
    let stops = unitsRoute.flatMap((u) => u.stops);
    // Dépôt dynamique : insère les retours au dépôt liés à la capacité.
    stops = withMidDepotReloads(state, stops, driver, date);
    let evTravel = travel;
    if (stops.length !== unitsRoute.flatMap((u) => u.stops).length) {
      for (const s of stops) {
        if (s.synthetic && !state.stops.includes(s)) { s.date = date; state.stops.push(s); }
      }
      evTravel = matrixAccessor(prepareMatrix(state, stops, null));
    }
    const ev = evaluateRoute(driver, stops, settings, evTravel);

    // Écriture dans le contrat de données.
    const completedSeq = state.stops
      .filter((s) => s.driverId === driver.id && s.date === date && s.status !== 'pending')
      .reduce((max, s) => Math.max(max, s.seq || 0), 0);

    stops.forEach((s, idx) => {
      s.driverId = driver.id;
      s.seq = completedSeq + idx + 1;
      const row = ev.rows.find((r) => r.stopId === s.id);
      s.eta = row ? isoAt(date, Math.max(0, Math.min(1439, row.etaMin))) : null;
    });

    const usedIds = new Set(stops.map((s) => s.id));
    for (const s of state.stops) {
      if (s.date === date && s.status === 'pending' && s.driverId === driver.id && !usedIds.has(s.id)) {
        s.driverId = null;
        s.seq = null;
        s.eta = null;
      }
    }

    assignments.push({
      driverId: driver.id,
      driverName: driver.name,
      color: driver.color,
      stopIds: stops.map((s) => s.id),
      stops,
      distanceKm: ev.distanceKm,
      durationMin: ev.workMin,
      startMin: ev.startMin,
      endMin: ev.endMin,
      start: isoAt(date, Math.max(0, Math.min(1439, ev.startMin))),
      end: isoAt(date, Math.max(0, Math.min(1439, ev.endMin))),
      waitMin: ev.waitMin,
      lateMin: ev.lateMin,
      lateShift: ev.lateShift,
      load: ev.load,
      valid: ev.valid,
      matrixSource: matrix.source,
    });
  }

  // Les arrêts non affectés sont explicitement détachés.
  for (const u of unassigned) {
    const s = state.stops.find((x) => x.id === u.stopId);
    if (s) { s.driverId = null; s.seq = null; s.eta = null; }
  }

  const plan = {
    date,
    assignments,
    unassigned,
    summary: {
      stops: pendingStops.length,
      assigned: assignments.reduce((a, x) => a + x.stopIds.length, 0),
      distanceKm: assignments.reduce((a, x) => a + x.distanceKm, 0),
      durationMin: assignments.reduce((a, x) => a + x.durationMin, 0),
      matrixSource: matrix.source,
    },
    at: new Date().toISOString(),
  };

  if (opts.record !== false) {
    state.history = state.history || [];
    state.history.unshift({
      at: plan.at,
      date,
      type: 'optimize',
      summary: plan.summary,
      drivers: assignments.map((a) => ({
        driverId: a.driverId,
        distanceKm: Number(a.distanceKm.toFixed(2)),
        durationMin: Math.round(a.durationMin),
        stops: a.stopIds.length,
      })),
    });
    state.history = state.history.slice(0, 60);
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* Ré-optimisation ciblée / réinsertion                                */
/* ------------------------------------------------------------------ */

/** Réinsère un arrêt (nouveau ou déplacé) au meilleur emplacement. */
export function reoptimize(state, opts = {}) {
  const date = opts.date || state.planning?.activeDate;
  const stop = state.stops.find((s) => s.id === opts.stopId);
  if (!stop) return optimize(state, { date, balance: opts.balance });

  const settings = state.settings;
  const drivers = state.drivers.filter(
    (d) => d.active !== false && (!opts.driverId || d.id === opts.driverId)
  );
  if (!drivers.length) return optimize(state, { date, balance: opts.balance });

  state.stops = state.stops.filter((s) => s.type !== 'depotReload');
  const allStops = state.stops.filter((s) => s.date === date && s.status === 'pending' && s.type !== 'depotReload');
  const matrix = prepareMatrix(state, allStops, opts.matrix || null);
  const travel = matrixAccessor(matrix);

  let best = null;
  for (const driver of drivers) {
    if ((stop.skillsRequired || []).some((sk) => !(driver.skills || []).includes(sk))) continue;
    const current = state.stops
      .filter((s) => s.driverId === driver.id && s.date === date && s.status === 'pending' && s.id !== stop.id)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    for (let pos = 0; pos <= current.length; pos++) {
      const seq = [...current.slice(0, pos), stop, ...current.slice(pos)];
      const ev = evaluateRoute(driver, seq, settings, travel);
      if (!ev.valid) continue;
      const cost = routeCost(ev, 'none', 0);
      if (!best || cost < best.cost) best = { driver, seq, ev, cost };
    }
  }

  if (!best) {
    const fallback = optimize(state, { date, driverId: stop.driverId || undefined, balance: opts.balance });
    return { ...fallback, fallback: true };
  }

  // Dépôt dynamique sur la tournée résultante.
  best.seq = withMidDepotReloads(state, best.seq, best.driver, date);
  for (const s of best.seq) if (s.synthetic && !state.stops.includes(s)) { s.date = date; state.stops.push(s); }
  if (best.seq.some((s) => s.synthetic)) {
    best.ev = evaluateRoute(best.driver, best.seq, settings, matrixAccessor(prepareMatrix(state, best.seq, null)));
  }

  // Retire l'arrêt de son ancienne tournée puis réécrit les séquences.
  for (const s of state.stops) {
    if (s.date === date && s.status === 'pending' && s.driverId === stop.driverId) {
      s.seq = null;
    }
  }
  best.seq.forEach((s, i) => {
    s.driverId = best.driver.id;
    s.seq = i + 1;
    const row = best.ev.rows.find((r) => r.stopId === s.id);
    s.eta = row ? isoAt(date, Math.max(0, Math.min(1439, row.etaMin))) : null;
  });

  state.history = state.history || [];
  state.history.unshift({
    at: new Date().toISOString(),
    date,
    type: 'reinsert',
    stopId: stop.id,
    driverId: best.driver.id,
    summary: { distanceKm: best.ev.distanceKm, durationMin: best.ev.workMin, stops: best.seq.length },
  });
  state.history = state.history.slice(0, 60);

  return {
    date,
    assignments: [{
      driverId: best.driver.id,
      driverName: best.driver.name,
      stopIds: best.seq.map((s) => s.id),
      stops: best.seq,
      distanceKm: best.ev.distanceKm,
      durationMin: best.ev.workMin,
      startMin: best.ev.startMin,
      endMin: best.ev.endMin,
      load: best.ev.load,
      waitMin: best.ev.waitMin,
      lateMin: best.ev.lateMin,
    }],
    unassigned: [],
    summary: { stops: best.seq.length, assigned: best.seq.length, distanceKm: best.ev.distanceKm, durationMin: best.ev.workMin },
  };
}

/**
 * Applique un ordre manuel (glisser-déposer), puis recalcule les ETA.
 */
export function applyManualOrder(state, driverId, date, orderedIds) {
  const settings = state.settings;
  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return null;
  const all = orderedIds.map((id) => state.stops.find((s) => s.id === id)).filter(Boolean).filter((s) => s.type !== 'depotReload');
  const mDate = all[0]?.date || date;
  state.stops = state.stops.filter((s) => !(s.type === 'depotReload' && s.driverId === driverId));
  const seq = withMidDepotReloads(state, all, driver, mDate);
  for (const s of seq) if (s.synthetic) { s.date = mDate; s.driverId = driverId; state.stops.push(s); }
  const matrix = prepareMatrix(state, seq);
  const travel = matrixAccessor(matrix);
  const ev = evaluateRoute(driver, seq, settings, travel);
  seq.forEach((s, i) => {
    s.driverId = driverId;
    s.date = s.date || mDate;
    s.seq = i + 1;
    const row = ev.rows.find((r) => r.stopId === s.id);
    s.eta = row ? isoAt(date, Math.max(0, Math.min(1439, row.etaMin))) : null;
  });
  return ev;
}

/** Recalcule uniquement les ETA d'une tournée existante. */
export function recomputeEtas(state, driverId, date) {
  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return null;
  state.stops = state.stops.filter((s) => !(s.type === 'depotReload' && s.driverId === driverId));
  const stops0 = state.stops
    .filter((s) => s.driverId === driverId && s.date === date && s.status !== 'failed')
    .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999));
  if (!stops0.length) return null;
  const stops = withMidDepotReloads(state, stops0, driver, date);
  for (const s of stops) if (s.synthetic) { s.date = date; s.driverId = driverId; state.stops.push(s); }
  const matrix = prepareMatrix(state, stops);
  const travel = matrixAccessor(matrix);
  const ev = evaluateRoute(driver, stops, state.settings, travel);
  stops.forEach((s) => {
    const row = ev.rows.find((r) => r.stopId === s.id);
    s.eta = row ? isoAt(date, Math.max(0, Math.min(1439, row.etaMin))) : null;
  });
  return ev;
}

/** Visite de dépôt synthétique (recharge/vidage). */
function makeDepotReload(state, date) {
  const d = state.settings.depot || {};
  return {
    id: `reload_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    name: 'Recharge / vidage au dépôt',
    address: d.address || 'Dépôt',
    phone: '', notes: 'Arrêt automatique — capacité véhicule atteinte',
    type: 'depotReload', synthetic: true,
    date: date || null, priority: 2, windowStart: null, windowEnd: null,
    serviceMin: Number(state.settings.midDepot?.dwellMin) || 15,
    weightKg: 0, volumeM3: 0, pallets: 0, skillsRequired: [], teamGroup: null, pairedWith: null,
    status: 'pending', driverId: null, seq: null, eta: null, pod: null,
    geo: { lat: d.lat || 0, lng: d.lng || 0 },
  };
}

/**
 * Dépôt dynamique : insère un retour au dépôt quand une collecte ferait
 * dépasser la capacité kg du véhicule (chargement restant re-vérifié).
 */
export function withMidDepotReloads(state, stops, driver, date = null) {
  const md = state.settings.midDepot || {};
  const capKg = Number(driver?.capacity?.kg) || 0;
  const clean = stops.filter((s) => s.type !== 'depotReload');
  if (!md.enabled || !capKg || clean.length < 2) return clean;
  const remainingDeliveries = (arr) =>
    arr.filter((x) => x.type !== 'pickup').reduce((a, x) => a + (Number(x.weightKg) || 0), 0);
  let load = remainingDeliveries(clean);
  const out = [];
  clean.forEach((s, i) => {
    const w = Number(s.weightKg) || 0;
    if (s.type === 'pickup') {
      if (load + w > capKg) {
        const nextDel = remainingDeliveries(clean.slice(i));
        if (nextDel <= capKg) {
          out.push(makeDepotReload(state, date || s.date));
          load = nextDel;
        }
      }
      load += w;
    } else {
      load -= w;
    }
    out.push(s);
  });
  return out;
}

/** Charges par conducteur (kg / m3 / palettes) pour l'UI. */
export function computeLoads(state, date) {
  const out = new Map();
  for (const d of state.drivers) {
    const stops = state.stops.filter((s) => s.driverId === d.id && s.date === date);
    out.set(d.id, {
      weightKg: stops.reduce((a, s) => a + (Number(s.weightKg) || 0), 0),
      volumeM3: stops.reduce((a, s) => a + (Number(s.volumeM3) || 0), 0),
      pallets: stops.reduce((a, s) => a + (Number(s.pallets) || 0), 0),
      stops: stops.length,
    });
  }
  return out;
}
