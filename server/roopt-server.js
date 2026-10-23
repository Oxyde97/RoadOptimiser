#!/usr/bin/env node
/**
 * RoadOptimizur v4 — API comptes & synchronisation
 * Zéro dépendance npm : node:http + node:sqlite + node:crypto. Image node:24-alpine.
 * Env : PORT, DATA_DIR, STATIC_DIR, ADMIN_EMAIL, ADMIN_PASS, ALLOWED_ORIGINS
 */
'use strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || '/data';
const STATIC = process.env.STATIC_DIR || '/srv';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@roadoptimizur.local';
const ADMIN_PASS = process.env.ADMIN_PASS || 'RoadOpt#2026';
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'roopt.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','driver')),
    pass TEXT NOT NULL, driver_ref TEXT, active INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tours(
    date TEXT NOT NULL, driver_id TEXT NOT NULL, payload TEXT NOT NULL,
    updated TEXT NOT NULL, PRIMARY KEY(date, driver_id));
  CREATE TABLE IF NOT EXISTS updates(
    stop_id TEXT NOT NULL, date TEXT NOT NULL, user_id INTEGER NOT NULL,
    status TEXT NOT NULL, pod TEXT, at TEXT NOT NULL,
    PRIMARY KEY(stop_id, date));
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, ip TEXT, kind TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS ws_snapshots(key TEXT PRIMARY KEY, data TEXT, updated TEXT);
  CREATE TABLE IF NOT EXISTS positions(
    driver_id TEXT NOT NULL, date TEXT NOT NULL, lat REAL, lng REAL, speed REAL, at TEXT NOT NULL,
    PRIMARY KEY(driver_id, date));
`);
function log(kind, detail, userId, ip) {
  try { db.prepare('INSERT INTO events(at,user_id,ip,kind,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(), userId || null, ip || '', kind, String(detail).slice(0, 300)); } catch {}
}

const SECRET_FILE = path.join(DATA, 'secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

function hashPass(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + '$' + crypto.pbkdf2Sync(String(pwd), salt, 100000, 64, 'sha256').toString('hex');
}
function checkPass(pwd, stored) {
  try {
    const [salt, hex] = String(stored).split('$');
    if (!salt || !hex) return false;
    const a = Buffer.from(hex, 'hex');
    const b = crypto.pbkdf2Sync(String(pwd), salt, 100000, 64, 'sha256');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function makeToken(user) {
  const payload = { uid: user.id, role: user.role, exp: Date.now() + 30 * 864e5 };
  const body = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
  return body + '.' + b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
}
function readToken(token) {
  try {
    const [h, p, s] = String(token).split('.');
    const body = h + '.' + p;
    const sig = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
    if (sig !== s) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  attempts.set(ip, list);
  return list.length >= 6;
}
function noteFail(ip) { const l = attempts.get(ip) || []; l.push(Date.now()); attempts.set(ip, l); }
function clearFails(ip) { attempts.delete(ip); }
function currentUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const payload = readToken(m[1]);
  if (!payload) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  return u && u.active ? u : null;
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, driverRef: u.driver_ref || null, active: !!u.active });

function seedAdmin() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) return;
  db.prepare('INSERT INTO users(email,name,role,pass,created) VALUES(?,?,?,?,?)').run(ADMIN_EMAIL, 'Administrateur', 'admin', hashPass(ADMIN_PASS), new Date().toISOString());
  console.log('[roopt] compte admin cree :', ADMIN_EMAIL);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 3e6) { reject(new Error('body trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}
function need(user, role) { return user && (!role || user.role === role); }

async function handleApi(req, res, url, user, ip) {
  const p = url.pathname, m = req.method;

  if (p === '/api/health' && m === 'GET')
    return { code: 200, obj: { ok: true, service: 'roopt-api', version: '4.0', users: db.prepare('SELECT COUNT(*) c FROM users').get().c } };

  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    if (rateLimited(ip)) { log('login_ratelimit', b.email, null, ip); return { code: 429, obj: { error: 'Trop de tentatives — reessayez dans une minute.' } }; }
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(b.email || '').trim());
    const okUser = u && u.active && checkPass(b.password || '', u.pass);
    if (!okUser) { noteFail(ip); log('login_fail', b.email, null, ip); return { code: 401, obj: { error: 'Identifiants incorrects.' } }; }
    clearFails(ip);
    log('login_ok', u.email, u.id, ip);
    return { code: 200, obj: { token: makeToken(u), user: publicUser(u), mustChange: u.email.toLowerCase() === 'admin@roadoptimizur.local' && checkPass('RoadOpt#2026', u.pass) } };
  }

  if (p === '/api/me' && m === 'GET')
    return user ? { code: 200, obj: publicUser(user) } : { code: 401, obj: { error: 'Non connecte.' } };

  if (p === '/api/password' && m === 'POST') {
    if (!user) return { code: 401, obj: { error: 'Non connecte.' } };
    const b = await readBody(req);
    const targetId = b.userId && user.role === 'admin' ? Number(b.userId) : user.id;
    if (targetId === user.id && !checkPass(b.current || '', user.pass)) return { code: 400, obj: { error: 'Mot de passe actuel incorrect.' } };
    if (String(b.new || '').length < 8) return { code: 400, obj: { error: 'Nouveau mot de passe trop court (8 caracteres min).' } };
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(b.new), targetId);
    log('password_set', 'user ' + targetId, user.id, ip);
    return { code: 200, obj: { ok: true } };
  }

  if (p === '/api/users' && m === 'GET') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    return { code: 200, obj: db.prepare('SELECT * FROM users ORDER BY role, name').all().map(publicUser) };
  }

  if (p === '/api/users' && m === 'POST') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { code: 400, obj: { error: 'Email invalide.' } };
    if (String(b.password || '').length < 8) return { code: 400, obj: { error: 'Mot de passe trop court (8 caracteres min).' } };
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return { code: 409, obj: { error: 'Email deja utilise.' } };
    const role = b.role === 'admin' ? 'admin' : 'driver';
    const r = db.prepare('INSERT INTO users(email,name,role,pass,driver_ref,created) VALUES(?,?,?,?,?,?)')
      .run(email, String(b.name || email.split('@')[0]).slice(0, 60), role, hashPass(b.password), b.driverRef || null, new Date().toISOString());
    log('user_create', email + ' (' + role + ')', user.id, ip);
    return { code: 201, obj: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid))) };
  }

  const mu = /^\/api\/users\/(\d+)$/.exec(p);
  if (mu && m === 'PATCH') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    const t = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(mu[1]));
    if (!t) return { code: 404, obj: { error: 'Compte inconnu.' } };
    const b = await readBody(req);
    if (typeof b.active === 'boolean') db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, t.id);
    if (b.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).slice(0, 60), t.id);
    if ('driverRef' in b) db.prepare('UPDATE users SET driver_ref = ? WHERE id = ?').run(b.driverRef || null, t.id);
    if (b.role && [ 'admin', 'driver' ].includes(b.role)) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, t.id);
    if (b.password) { if (String(b.password).length < 8) return { code: 400, obj: { error: 'Mot de passe trop court.' } }; db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(b.password), t.id); }
    log('user_update', 'id ' + t.id, user.id, ip);
    return { code: 200, obj: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(t.id)) };
  }
  if (mu && m === 'DELETE') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    if (Number(mu[1]) === user.id) return { code: 400, obj: { error: 'Impossible de supprimer votre propre compte.' } };
    db.prepare('DELETE FROM users WHERE id = ?').run(Number(mu[1]));
    log('user_delete', 'id ' + mu[1], user.id, ip);
    return { code: 200, obj: { ok: true } };
  }

  if (p === '/api/publish' && m === 'POST') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    const b = await readBody(req);
    if (!b.date || !Array.isArray(b.tours)) return { code: 400, obj: { error: 'payload attendu: {date, tours:[{driverId, stops:[…]}]}' } };
    const now = new Date().toISOString();
    const del = db.prepare('DELETE FROM tours WHERE date = ?'); del.run(b.date);
    const ins = db.prepare('INSERT INTO tours(date,driver_id,payload,updated) VALUES(?,?,?,?)');
    for (const t of b.tours) ins.run(b.date, String(t.driverId), JSON.stringify(t), now);
    log('publish', b.date + ' — ' + b.tours.length + ' tournee(s)', user.id, ip);
    return { code: 200, obj: { ok: true, date: b.date, tours: b.tours.length } };
  }

  if (p === '/api/retours' && m === 'GET') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    const date = url.searchParams.get('date');
    if (!date) return { code: 400, obj: { error: 'parametre date requis' } };
    const rows = db.prepare('SELECT u.*, users.email, users.name FROM updates u JOIN users ON users.id = u.user_id WHERE u.date = ? ORDER BY u.at DESC').all(date);
    return { code: 200, obj: rows.map((r) => ({ stopId: r.stop_id, date: r.date, status: r.status, pod: r.pod ? JSON.parse(r.pod) : null, at: r.at, email: r.email, name: r.name })) };
  }

  if (p === '/api/my-tour' && m === 'GET') {
    if (!user) return { code: 401, obj: { error: 'Non connecte.' } };
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const ref = user.driver_ref;
    if (!ref) return { code: 200, obj: { date, tour: null, reason: 'aucun conducteur relie a ce compte' } };
    const row = db.prepare('SELECT payload FROM tours WHERE date = ? AND driver_id = ?').get(date, String(ref));
    return { code: 200, obj: { date, tour: row ? JSON.parse(row.payload) : null } };
  }

  if (p === '/api/stop-status' && m === 'POST') {
    if (!user) return { code: 401, obj: { error: 'Non connecte.' } };
    const b = await readBody(req);
    if (!b.stopId || !b.date || !['delivered', 'absent', 'failed'].includes(b.status)) return { code: 400, obj: { error: 'stopId, date et statut (delivered|absent|failed) requis' } };
    db.prepare('INSERT INTO updates(stop_id,date,user_id,status,pod,at) VALUES(?,?,?,?,?,?) ON CONFLICT(stop_id,date) DO UPDATE SET status=excluded.status, pod=excluded.pod, at=excluded.at')
      .run(String(b.stopId), String(b.date), user.id, b.status, b.pod ? JSON.stringify(b.pod).slice(0, 4000) : null, new Date().toISOString());
    log('stop_status', b.status + ' ' + b.stopId, user.id, ip);
    return { code: 200, obj: { ok: true } };
  }


  if (p === '/api/my-week' && m === 'GET') { // chauffeur : toutes ses tournées à venir
    const user = currentUser(req);
    if (!user) return { code: 401, obj: { error: 'Non connecté.' } };
    if (user.role !== 'driver') return { code: 403, obj: { error: 'Réservé aux conducteurs.' } };
    const ref = String(user.driver_ref ? user.driver_ref : '');
    if (!ref) return { code: 200, obj: { reason: 'no_driver_link', tours: [] } };
    let from = String(url.searchParams.get('from') || new Date().toISOString().slice(0, 10));
    const floor = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    if (from > floor) from = floor; // fenêtre d'au moins 14 jours: une tournée passée du chauffeur doit toujours revenir
    const rows = db.prepare('SELECT date, payload, updated FROM tours WHERE driver_id = ? AND date >= ? ORDER BY date ASC LIMIT 15').all(ref, from);
    return { code: 200, obj: { serverDate: new Date().toISOString().slice(0, 10), tours: rows.map((r) => { const p = JSON.parse(r.payload); return { date: r.date, updated: r.updated, savedAt: p.savedAt || null, tour: p }; }) } };
  }
  if (p === '/api/next-tour' && m === 'GET') { // plus proche tournée publiée >= date
    const user = currentUser(req);
    if (!user) return { code: 401, obj: { error: 'Non connecté.' } };
    if (user.role !== 'driver') return { code: 403, obj: { error: 'Réservé aux conducteurs.' } };
    const ref = String(user.driver_ref ? user.driver_ref : '');
    if (!ref) return { code: 200, obj: { date: null } };
    const r = db.prepare('SELECT date, payload, updated FROM tours WHERE driver_id = ? AND date >= ? ORDER BY date ASC LIMIT 1').get(ref, String(url.searchParams.get('from') || new Date().toISOString().slice(0, 10)));
    if (!r) return { code: 200, obj: { date: null } };
    const p = JSON.parse(r.payload);
    return { code: 200, obj: { date: r.date, savedAt: p.savedAt || null, tour: p } };
  }
  if (p === '/api/ws' && m === 'GET') {
    if (!user) return { code: 401, obj: { error: 'Non connecte.' } };
    if (user.role !== 'admin') return { code: 403, obj: { error: 'Reserve admin.' } };
    const r = db.prepare('SELECT data, updated FROM ws_snapshots WHERE key = ?').get('admin');
    return { code: 200, obj: r ? { updated: r.updated, data: JSON.parse(r.data) } : { updated: null, data: null } };
  }
  if (p === '/api/ws' && m === 'POST') {
    if (!user) return { code: 401, obj: { error: 'Non connecte.' } };
    if (user.role !== 'admin') return { code: 403, obj: { error: 'Reserve admin.' } };
    const b = await readBody(req);
    const s2 = JSON.stringify(b);
    if (s2.length > 1500000) return { code: 413, obj: { error: 'Espace de travail trop volumineux (max 1.5 Mo).' } };
    const now = new Date().toISOString();
    db.prepare('INSERT INTO ws_snapshots(key, data, updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated').run('admin', s2, now);
    log('ws_save', null, user.id, ip);
    return { code: 200, obj: { ok: true, updated: now } };
  }

  if (p === '/api/tour-save' && m === 'POST') {
    if (!need(user, 'driver')) return { code: 403, obj: { error: 'Reserve conducteur.' } };
    const ref = user.driver_ref ? String(user.driver_ref) : null;
    if (!ref) return { code: 400, obj: { error: 'Aucun conducteur relie a ce compte.' } };
    const b = await readBody(req);
    const date = String(b.date || new Date().toISOString().slice(0, 10));
    if (!Array.isArray(b.stops)) return { code: 400, obj: { error: 'payload attendu: {date, stops:[...]}' } };
    const row = db.prepare('SELECT payload FROM tours WHERE date = ? AND driver_id = ?').get(date, ref);
    let prev = {}; if (row) { try { prev = JSON.parse(row.payload); } catch {} }
    const payload = { driverId: prev.driverId ?? ref, driverName: prev.driverName ?? user.name, depot: b.depot || prev.depot || null, stops: b.stops.slice(0, 500), savedAt: new Date().toISOString(), source: row ? (prev.source || 'admin') : 'driver' };
    db.prepare('INSERT INTO tours(date, driver_id, payload, updated) VALUES(?,?,?,?) ON CONFLICT(date, driver_id) DO UPDATE SET payload = excluded.payload, updated = excluded.updated')
      .run(date, ref, JSON.stringify(payload), new Date().toISOString());
    log('tour_save', date + ' — ' + b.stops.length + ' arrets', user.id, ip);
    return { code: 200, obj: { ok: true, savedAt: payload.savedAt } };
  }

  if (p === '/api/position' && m === 'POST') {
    if (!need(user, 'driver')) return { code: 403, obj: { error: 'Reserve conducteur.' } };
    const ref = user.driver_ref ? String(user.driver_ref) : null;
    if (!ref) return { code: 200, obj: { ok: true, ignored: true } };
    const b = await readBody(req);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { code: 400, obj: { error: 'lat/lng requis' } };
    const date = String(b.date || new Date().toISOString().slice(0, 10));
    db.prepare('INSERT INTO positions(driver_id,date,lat,lng,speed,at) VALUES(?,?,?,?,?,?) ON CONFLICT(driver_id,date) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, speed=excluded.speed, at=excluded.at')
      .run(ref, date, lat, lng, Number(b.speed) || null, new Date().toISOString());
    return { code: 200, obj: { ok: true } };
  }

  if (p === '/api/live' && m === 'GET') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const rows = db.prepare('SELECT driver_id, payload, updated FROM tours WHERE date = ?').all(date);
    const upd = db.prepare('SELECT stop_id, status, at FROM updates WHERE date = ?').all(date);
    const byStop = new Map(upd.map((u) => [String(u.stop_id), u]));
    const pos = db.prepare('SELECT * FROM positions WHERE date = ?').all(date);
    const posBy = new Map(pos.map((x) => [String(x.driver_id), x]));
    const out = rows.map((r) => {
      let t = {}; try { t = JSON.parse(r.payload); } catch {}
      const stops = (t.stops || []).map((st, i) => {
        const u = byStop.get(String(st.id));
        return { id: st.id, name: st.name, seq: st.seq ?? i + 1, status: (u && u.status) || st.status || 'pending', at: u && u.at };
      });
      const done = stops.filter((st) => ['delivered', 'absent', 'failed'].includes(st.status)).length;
      const cur = stops.find((st) => !['delivered', 'absent', 'failed'].includes(st.status));
      const lastAt = stops.reduce((mx, st) => (st.at && (!mx || st.at > mx) ? st.at : mx), null);
      const dd = String(r.driver_id); const ddNum = Number(dd);
      const pp = posBy.get(dd) || posBy.get(ddNum) || null;
      return {
        driverId: dd, driverName: t.driverName || ('Conducteur ' + dd),
        total: stops.length, done, currentStop: cur ? cur.name : null,
        stops: stops.slice(0, 80), lastUpdate: lastAt || r.updated,
        position: pp ? { lat: pp.lat, lng: pp.lng, speed: pp.speed, at: pp.at } : null,
      };
    });
    return { code: 200, obj: { date, drivers: out } };
  }

  if (p === '/api/audit' && m === 'GET') {
    if (!need(user, 'admin')) return { code: 403, obj: { error: 'Reserve admin.' } };
    const lim = Math.min(Number(url.searchParams.get('limit') || 200), 500);
    const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(lim);
    return { code: 200, obj: rows };
  }

  return { code: 404, obj: { error: 'Route API inconnue.' } };
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json' };
function serveStatic(req, res, url, corsOrigin) {
  let file = decodeURIComponent(url.pathname);
  if (file === '/' || file.endsWith('/')) file += 'index.html';
  const full = path.normalize(path.join(STATIC, file));
  if (!full.startsWith(STATIC)) { res.writeHead(403); return res.end('403'); }
  try { if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) file += '/index.html'; } catch {}
  const target = path.normalize(path.join(STATIC, file));
  if (!target.startsWith(STATIC)) { res.writeHead(403); return res.end('403'); }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404 — introuvable'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache', ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin } : {}) });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://internal');
  const origin = req.headers.origin || '';
  const corsOrigin = ALLOWED.includes('*') ? (origin || '*') : (ALLOWED.includes(origin) ? origin : null);
  if (origin && !corsOrigin) { res.writeHead(403); return res.end('CORS refusé'); }
  res.setHeader('vary', 'origin');
  if (corsOrigin) { res.setHeader('access-control-allow-origin', corsOrigin); res.setHeader('access-control-allow-headers', 'content-type,authorization'); res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS'); res.setHeader('access-control-max-age', '600'); }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url, corsOrigin);
  try {
    const user = currentUser(req);
    const out = await handleApi(req, res, url, user, ip);
    res.writeHead(out.code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out.obj));
  } catch (e) {
    log('api_error', e.message, null, ip);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Erreur serveur : ' + e.message }));
  }
});
seedAdmin();
server.listen(PORT, '0.0.0.0', () => console.log('[roopt-api] à l\'écoute sur :' + PORT + ' — statique:' + STATIC + ' — data:' + DATA));
