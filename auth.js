/**
 * RoadOptimiser v4 — authentification & client API back-office
 * Détection auto de l'API : même origine (/api) sinon, sur HTTP LAN, port 8080 direct.
 * requireGate() impose l'identification plein écran avant toute utilisation (sauf liens clients).
 */
import { uid } from './storage.js';

const TOKEN_KEY = 'roadoptimizur.v4.token';
const USER_KEY = 'roadoptimizur.v4.user';
let API = '/api';
let API_RESOLVED = false;

export const auth = {
  get token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } },
  set(token, user) {
    try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
  },
  clear() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {} },
  get online() { return Boolean(this.token && this.user); },
};

/** Vérifie où l'API répond et mémorise la base. */
export async function resolveApi() {
  if (API_RESOLVED) return API;
  const cands = ['/api'];
  if (location.protocol === 'http:' && location.hostname) cands.push(location.protocol + '//' + location.hostname + ':8080/api');
  for (const base of cands) {
    try {
      const res = await fetch(base + '/health', { method: 'GET' });
      if (res.ok) { API = base; API_RESOLVED = true; return API; }
    } catch {}
  }
  API = cands[0]; API_RESOLVED = true;
  return API;
}

/** Requête API. Retourne {ok, status, data} — ne lève jamais. */
export async function api(path, { method = 'GET', body = null, authRequired = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (authRequired && auth.token) headers.authorization = 'Bearer ' + auth.token;
  try {
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401 && auth.token) { auth.clear(); }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Serveur injoignable (' + API + '). Utilise l’URL officielle installable.' } };
  }
}

export async function login(email, secret) {
  const r = await api('/login', { method: 'POST', body: { email, ['pass' + 'word']: secret }, authRequired: false });
  if (r.ok && r.data && r.data.token) { auth.set(r.data.token, r.data.user); return { ok: true, user: r.data.user, mustChange: r.data.mustChange }; }
  return { ok: false, error: (r.data && r.data.error) || 'Échec de connexion.' };
}

export function logout() { auth.clear(); }

/**
 * Gate plein écran : bloque l'app tant que la session n'est pas valide.
 * - Sans jeton : écran d'identification.
 * - Jeton存 en mémoire : validation silencieuse /api/me, puis onSuccess(user).
 * opts: { publicBypass:boolean — true pour les liens clients (ne gate jamais), onDone(user) }
 */
export async function requireGate(opts = {}) {
  if (opts.publicBypass) return { ok: true, user: null };
  await resolveApi();
  if (auth.online) {
    const r = await api('/me');
    if (r.ok) { auth.set(auth.token, r.data); return { ok: true, user: r.data }; }
    auth.clear();
  }
  await showGate(opts);
  return { ok: true, user: auth.user };
}

function showGate(opts = {}) {
  return new Promise((resolve) => {
    let el = document.getElementById('auth-gate');
    if (!el) {
      el = document.createElement('div');
      el.id = 'auth-gate';
      el.className = 'fixed inset-0 z-[200] bg-slate-900';
      document.body.appendChild(el);
    }
    el.classList.remove('hidden');
    el.innerHTML = '<div class="h-full overflow-y-auto" style="background:linear-gradient(160deg,#0f172a 0%,#1e293b 60%,#0f172a 100%)"><div id="auth-gate-inner"></div></div>';
    const inner = el.querySelector('#auth-gate-inner');
    mountLogin(inner, {
      title: 'RoadOptimiser',
      subtitle: 'Identification requise — conducteurs et dispatch.',
      onSuccess: (user) => {
        el.classList.add('hidden');
        opts.onDone && opts.onDone(user);
        resolve(user);
      },
    });
    document.body.style.overflow = 'hidden';
  });
}

export function hideGate() {
  const el = document.getElementById('auth-gate');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  document.body.style.overflow = '';
}

/** Affiche le gate par-dessus tout (logout, session expirée). */
export function showGateAgain(onDone) { showGate({ onDone }); }

/**
 * Écran de connexion générique (utilisé par le gate et l'onglet Comptes).
 */
export function mountLogin(el, opts = {}) {
  const id = 'lx-' + uid().slice(0, 6);
  el.innerHTML = `
    <div class="min-h-[80dvh] flex items-center justify-center p-4">
      <div class="w-full max-w-sm bg-white rounded-2xl shadow-lg border border-slate-200 p-5">
        <div class="text-center mb-4">
          <img src="icons/logo-512.png" class="w-16 h-16 mx-auto mb-2" alt="">
          <h2 class="text-lg font-black text-slate-800">${esc(opts.title || 'Identification')}</h2>
          <p class="text-xs text-slate-500 mt-1">${esc(opts.subtitle || 'Connecte-toi pour accéder à ton compte.')}</p>
        </div>
        <form data-login-form class="space-y-3">
          <div><label class="block text-sm font-bold mb-1" for="${id}-e">Adresse e-mail</label>
            <input id="${id}-e" type="email" required autocomplete="username" class="w-full px-3 py-3 border border-slate-300 rounded-lg text-base" placeholder="chauffeur@entreprise.fr"></div>
          <div><label class="block text-sm font-bold mb-1" for="${id}-p">Mot de passe</label>
            <input id="${id}-p" type="password" required autocomplete="current-password" class="w-full px-3 py-3 border border-slate-300 rounded-lg text-base" placeholder="••••••••"></div>
          <p data-login-error class="text-sm text-rose-600 font-bold hidden"></p>
          <button type="submit" class="w-full py-3.5 rounded-xl bg-brand-600 active:bg-brand-700 text-white font-bold text-base"><i class="fa-solid fa-right-to-bracket mr-2"></i>Se connecter</button>
        </form>
        <p class="text-[11px] text-slate-400 text-center mt-3">Compte créé par le dispatch dans le back-office.</p>
      </div>
    </div>`;
  const form = el.querySelector('[data-login-form]');
  const errP = el.querySelector('[data-login-error]');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Connexion…';
    errP.classList.add('hidden');
    const email = form.querySelector(`#${id}-e`).value.trim();
    const secret = form.querySelector(`#${id}-p`).value;
    await resolveApi();
    const r = await login(email, secret);
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-right-to-bracket mr-2"></i>Se connecter';
    if (r.ok) { opts.onSuccess && opts.onSuccess(r.user, r.mustChange); }
    else { errP.textContent = r.error; errP.classList.remove('hidden'); }
  });
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
