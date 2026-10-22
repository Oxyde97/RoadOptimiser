/**
 * RoadOptimiser v3 — routing.js
 * Géocodage Nominatim (cache + limite 1 req/s), itinéraires OSRM / Valhalla,
 * matrices de distances et repli haversine.
 */

import { GEO_CACHE_KEY } from './storage.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';
const VALHALLA = 'https://valhalla1.openstreetmap.de';

const PROFILE_SPEED = { auto: 45, truck: 38, bike: 16, pedestrian: 5 };

/* ------------------------------------------------------------------ */
/* Cache géocodage                                                     */
/* ------------------------------------------------------------------ */

function readGeoCache() {
  try {
    const raw = localStorage.getItem(GEO_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeGeoCache(cache) {
  try {
    // On borne le cache à 500 entrées les plus récentes.
    const entries = Object.entries(cache);
    if (entries.length > 500) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      cache = Object.fromEntries(entries.slice(0, 500));
    }
    localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn('[routing] cache géocodage non sauvegardé', err);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let geocodeChain = Promise.resolve();
let lastGeocodeAt = 0;

/**
 * Géocode une adresse via Nominatim. Respecte 1 requête/seconde.
 * @returns {Promise<{lat:number,lng:number,display:string}|null>}
 */
export function geocode(query) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve(null);

  geocodeChain = geocodeChain.then(async () => {
    const cache = readGeoCache();
    const key = q.toLowerCase();
    const hit = cache[key];
    if (hit && hit.lat && hit.lng) {
      return { lat: hit.lat, lng: hit.lng, display: hit.display || q, cached: true };
    }

    const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
    if (wait) await sleep(wait);

    try {
      const url = `${NOMINATIM}/search?format=jsonv2&limit=1&accept-language=fr&q=${encodeURIComponent(q)}`;
      lastGeocodeAt = Date.now();
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        const item = data[0];
        const result = {
          lat: Number(item.lat),
          lng: Number(item.lon),
          display: item.display_name || q,
        };
        cache[key] = { ...result, ts: Date.now() };
        writeGeoCache(cache);
        return result;
      }
    } catch (err) {
      console.warn('[routing] Nominatim échoué', q, err);
    }
    // repli Photon (mêmes données OSM, quota plus souple)
    try {
      const pr = await fetch(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(q)}`);
      if (pr.ok) {
        const gj = await pr.json();
        const f = gj.features && gj.features[0];
        if (f && f.geometry && f.geometry.coordinates) {
          const lon = Number(f.geometry.coordinates[0]); const lat = Number(f.geometry.coordinates[1]);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const p = f.properties || {};
            const result = { lat, lng: lon, display: [p.name, p.city, p.state].filter(Boolean).join(', ') || q };
            cache[key] = { ...result, ts: Date.now() };
            writeGeoCache(cache);
            return result;
          }
        }
      }
    } catch (e2) {
      console.warn('[routing] Photon échoué aussi', q, e2);
    }
    return null;
  });

  return geocodeChain;
}

/** Géocodage inverse léger (affichage seulement, jamais bloquant). */
export async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=fr`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.display_name || '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Haversine / repli                                                   */
/* ------------------------------------------------------------------ */

export function haversine(a, b) {
  if (!a || !b) return 0;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function roadEstimate(a, b, profile = 'auto', avgSpeedKmh) {
  const direct = haversine(a, b);
  const factor = profile === 'pedestrian' ? 1.15 : profile === 'bike' ? 1.25 : 1.32;
  const speed = avgSpeedKmh || PROFILE_SPEED[profile] || 45;
  const distanceKm = direct * factor;
  return { distanceKm, durationMin: (distanceKm / speed) * 60 };
}

function fallbackRoute(points, profile, avgSpeedKmh) {
  const legs = [];
  let distanceKm = 0;
  let durationMin = 0;
  for (let i = 1; i < points.length; i++) {
    const leg = roadEstimate(points[i - 1], points[i], profile, avgSpeedKmh);
    legs.push(leg);
    distanceKm += leg.distanceKm;
    durationMin += leg.durationMin;
  }
  return {
    distanceKm,
    durationMin,
    geometry: points.map((p) => [p.lat, p.lng]),
    legs,
    source: 'haversine',
  };
}

/* ------------------------------------------------------------------ */
/* Polylines Valhalla (precision 6)                                    */
/* ------------------------------------------------------------------ */

export function decodePolyline6(str, precision = 6) {
  if (!str) return [];
  const factor = Math.pow(10, precision);
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < str.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < str.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

/* ------------------------------------------------------------------ */
/* Valhalla                                                            */
/* ------------------------------------------------------------------ */

function valhallaCosting(profile, vehicle = {}, avoidMotorways = false) {
  const costing = profile === 'truck' ? 'truck' : profile === 'bike' ? 'bicycle' : profile === 'pedestrian' ? 'pedestrian' : 'auto';
  const options = {};
  if (costing === 'truck') {
    options.truck = {
      height: Number(vehicle.height) || 2.5,
      weight: Number(vehicle.weight) || 7.5,
      length: Number(vehicle.length) || 6,
      axle_count: Number(vehicle.axles) || 2,
      hazmat: Boolean(vehicle.hazardous),
    };
  }
  if (avoidMotorways) {
    if (costing === 'truck' || costing === 'auto') {
      options[costing] = { ...(options[costing] || {}), use_highways: 0.15, use_tolls: 0.5 };
    }
  }
  return { costing, costing_options: options };
}

async function valhallaRoute(points, profile, vehicle, avoidMotorways) {
  const { costing, costing_options } = valhallaCosting(profile, vehicle, avoidMotorways);
  const body = {
    locations: points.map((p) => ({ lat: p.lat, lon: p.lng, type: 'break' })),
    costing,
    costing_options,
    directions_options: { units: 'kilometers', language: 'fr-FR' },
  };
  const res = await fetch(`${VALHALLA}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Valhalla route ${res.status}`);
  const data = await res.json();
  const trip = data.trip;
  if (!trip || !Array.isArray(trip.legs)) throw new Error('Valhalla: réponse invalide');

  const legs = trip.legs.map((leg) => ({
    distanceKm: (leg.summary?.length ?? 0),
    durationMin: (leg.summary?.time ?? 0) / 60,
  }));
  const geometry = [];
  for (const leg of trip.legs) {
    const pts = decodePolyline6(leg.shape);
    if (geometry.length && pts.length) pts.shift();
    geometry.push(...pts);
  }
  return {
    distanceKm: legs.reduce((a, l) => a + l.distanceKm, 0),
    durationMin: legs.reduce((a, l) => a + l.durationMin, 0),
    geometry,
    legs,
    source: 'valhalla',
    profile,
  };
}

async function osrmRoute(points, avoidMotorways) {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const exclude = avoidMotorways ? '&exclude=motorway' : '';
  const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false${exclude}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM route ${res.status}`);
  const data = await res.json();
  if (!data.routes || !data.routes.length) throw new Error('OSRM: aucun itinéraire');
  const r = data.routes[0];
  return {
    distanceKm: r.distance / 1000,
    durationMin: r.duration / 60,
    geometry: (r.geometry?.coordinates || []).map((c) => [c[1], c[0]]),
    legs: (r.legs || []).map((l) => ({ distanceKm: l.distance / 1000, durationMin: l.duration / 60 })),
    source: 'osrm',
    profile: 'auto',
  };
}

/**
 * Calcule un itinéraire passant par tous les points.
 * @param {Array<{lat:number,lng:number}>} points
 * @param {{profile?:string, vehicle?:object, avoidMotorways?:boolean, avgSpeedKmh?:number}} opts
 */
export async function route(points, opts = {}) {
  const clean = (points || []).filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  if (clean.length < 2) {
    return { distanceKm: 0, durationMin: 0, geometry: clean.map((p) => [p.lat, p.lng]), legs: [], source: 'empty' };
  }
  const profile = opts.profile || 'auto';
  const avgSpeedKmh = opts.avgSpeedKmh;
  try {
    if (profile === 'auto') {
      return await osrmRoute(clean, Boolean(opts.avoidMotorways));
    }
    return await valhallaRoute(clean, profile, opts.vehicle || {}, Boolean(opts.avoidMotorways));
  } catch (err) {
    console.warn('[routing] repli haversine', err);
    return fallbackRoute(clean, profile, avgSpeedKmh);
  }
}

/**
 * Matrice de distances/durées (n×n).
 * @returns {Promise<{distances:number[][], durations:number[][], source:string}>}
 */
export async function matrix(points, opts = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(Number(p.lat)));
  const n = pts.length;
  if (!n) return { distances: [], durations: [], source: 'empty' };
  const profile = opts.profile || 'auto';

  const fallback = () => {
    const distances = [];
    const durations = [];
    for (let i = 0; i < n; i++) {
      distances[i] = [];
      durations[i] = [];
      for (let j = 0; j < n; j++) {
        const e = i === j ? { distanceKm: 0, durationMin: 0 } : roadEstimate(pts[i], pts[j], profile, opts.avgSpeedKmh);
        distances[i][j] = e.distanceKm;
        durations[i][j] = e.durationMin;
      }
    }
    return { distances, durations, source: 'haversine' };
  };

  try {
    if (profile === 'auto') {
      const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';');
      const url = `${OSRM}/table/v1/driving/${coords}?annotations=distance,duration`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM table ${res.status}`);
      const data = await res.json();
      if (!data.distances || !data.durations) throw new Error('OSRM: matrice vide');
      return {
        distances: data.distances.map((row) => row.map((v) => (v ?? 0) / 1000)),
        durations: data.durations.map((row) => row.map((v) => (v ?? 0) / 60)),
        source: 'osrm',
      };
    }

    const { costing, costing_options } = valhallaCosting(profile, opts.vehicle || {}, Boolean(opts.avoidMotorways));
    const res = await fetch(`${VALHALLA}/sources_to_targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: pts.map((p) => ({ lat: p.lat, lon: p.lng })),
        targets: pts.map((p) => ({ lat: p.lat, lon: p.lng })),
        costing,
        costing_options,
      }),
    });
    if (!res.ok) throw new Error(`Valhalla matrix ${res.status}`);
    const data = await res.json();
    const rows = data.sources_to_targets || data.matrix;
    if (!Array.isArray(rows)) throw new Error('Valhalla: matrice vide');
    return {
      distances: rows.map((row) => row.map((c) => Number(c.distance) || 0)),
      durations: rows.map((row) => row.map((c) => (Number(c.time) || 0) / 60)),
      source: 'valhalla',
    };
  } catch (err) {
    console.warn('[routing] matrice: repli haversine', err);
    return fallback();
  }
}

/** Lien de navigation universel. */
export function navigationLinks(stop) {
  const label = stop?.address || stop?.name || '';
  const lat = stop?.geo?.lat;
  const lng = stop?.geo?.lng;
  const dest = Number.isFinite(lat) && lat !== 0 ? `${lat},${lng}` : label;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`,
    waze: `https://waze.com/ul?${Number.isFinite(lat) && lat !== 0 ? `ll=${lat},${lng}` : `q=${encodeURIComponent(label)}`}&navigate=yes`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`,
  };
}

/** Distance totale estimée d'une liste ordonnée (dépôt → stops → dépôt). */
export function estimateTour(depot, stops, profile = 'auto', avgSpeedKmh) {
  const pts = [depot, ...stops.map((s) => s.geo || s), depot];
  let distanceKm = 0;
  let durationMin = 0;
  for (let i = 1; i < pts.length; i++) {
    const e = roadEstimate(pts[i - 1], pts[i], profile, avgSpeedKmh);
    distanceKm += e.distanceKm;
    durationMin += e.durationMin;
  }
  return { distanceKm, durationMin };
}
