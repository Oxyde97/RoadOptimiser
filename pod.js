/**
 * RoadOptimiser v3 — pod.js
 * Preuve de livraison : signature canvas, photos caméra, formulaire personnalisé,
 * scan code-barres, géolocalisation, horodatage. Feuille POD imprimable.
 */

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function toast(message, type = 'info', duration = 3200) {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'fixed inset-x-0 bottom-24 md:bottom-6 z-[200] flex flex-col items-center gap-2 px-4 pointer-events-none';
    document.body.appendChild(root);
  }
  const colors = {
    info: 'bg-slate-900 text-white',
    success: 'bg-emerald-600 text-white',
    error: 'bg-red-600 text-white',
    warn: 'bg-amber-500 text-slate-900',
  };
  const icons = {
    info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation',
  };
  const el = document.createElement('div');
  el.className = `${colors[type] || colors.info} px-4 py-3 rounded-xl shadow-xl text-sm font-medium flex items-center gap-2 max-w-md pointer-events-auto`;
  el.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, duration);
}

function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
    );
  });
}

/* ------------------------------------------------------------------ */
/* Compression photos                                                  */
/* ------------------------------------------------------------------ */

async function compressImage(file, maxSide = 1000, quality = 0.62) {
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = dataUrl;
  });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/* ------------------------------------------------------------------ */
/* Signature                                                           */
/* ------------------------------------------------------------------ */

function setupSignature(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let dirty = false;

  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const snapshot = dirty ? canvas.toDataURL('image/png') : null;
    canvas.width = Math.max(300, Math.floor(rect.width * ratio));
    canvas.height = Math.floor(170 * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (snapshot) {
      const im = new Image();
      im.onload = () => ctx.drawImage(im, 0, 0, canvas.width / ratio, canvas.height / ratio);
      im.src = snapshot;
    }
  };
  requestAnimationFrame(resize);

  const point = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const start = (ev) => {
    drawing = true;
    dirty = true;
    const p = point(ev);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    canvas.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  };
  const move = (ev) => {
    if (!drawing) return;
    const p = point(ev);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ev.preventDefault();
  };
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);

  return {
    clear() {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      dirty = false;
    },
    dataUrl() { return dirty ? canvas.toDataURL('image/png') : null; },
    load(dataUrl) {
      if (!dataUrl) return;
      const im = new Image();
      im.onload = () => {
        const r = canvas.getBoundingClientRect();
        ctx.drawImage(im, 0, 0, r.width || canvas.width, 170);
        dirty = true;
      };
      im.src = dataUrl;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Champs POD personnalisés                                            */
/* ------------------------------------------------------------------ */

function podFieldHTML(def, value) {
  const id = escapeHtml(def.id);
  const label = escapeHtml(def.label || 'Champ');
  if (def.type === 'check') {
    return `<label class="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-3 min-h-[44px] cursor-pointer">
      <input type="checkbox" data-field="${id}" ${value ? 'checked' : ''} class="w-5 h-5 rounded text-brand-600">
      <span class="text-sm text-slate-700">${label}</span>
    </label>`;
  }
  if (def.type === 'number') {
    return `<div><label class="block text-xs font-medium text-slate-600 mb-1">${label}</label>
      <input type="number" inputmode="decimal" data-field="${id}" value="${value ?? ''}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>`;
  }
  if (def.type === 'photo') {
    return `<div><label class="block text-xs font-medium text-slate-600 mb-1">${label}</label>
      <div class="flex items-center gap-2">
        <span data-field-preview="${id}">${value ? `<img src="${value}" class="w-16 h-16 object-cover rounded-lg border border-slate-200">` : ''}</span>
        <label class="min-h-[44px] px-3 bg-slate-100 rounded-lg text-xs font-semibold text-slate-700 flex items-center gap-2 cursor-pointer">
          <i class="fa-solid fa-camera"></i> Ajouter
          <input type="file" accept="image/*" capture="environment" data-field-photo="${id}" class="hidden">
        </label>
      </div></div>`;
  }
  if (def.type === 'signature') {
    return `<div class="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
      <i class="fa-solid fa-signature mr-1"></i> ${label} : la signature principale sera utilisée.</div>`;
  }
  return `<div><label class="block text-xs font-medium text-slate-600 mb-1">${label}</label>
    <input type="text" data-field="${id}" value="${escapeHtml(value || '')}" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base"></div>`;
}

/* ------------------------------------------------------------------ */
/* Modale POD                                                          */
/* ------------------------------------------------------------------ */

export function openPOD(stop, state, opts = {}) {
  document.getElementById('pod-modal')?.remove();

  const pod = stop.pod || {};
  const photos = Array.isArray(pod.photos) ? [...pod.photos] : [];
  const scans = Array.isArray(pod.scans) ? [...pod.scans] : [];
  const fields = { ...(pod.fields || {}) };
  const formDefs = Array.isArray(state.settings.podForm) ? state.settings.podForm : [];
  const markDelivered = opts.markDelivered !== false;

  const overlay = document.createElement('div');
  overlay.id = 'pod-modal';
  overlay.className = 'fixed inset-0 z-[150] bg-slate-900/60 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-6';
  overlay.innerHTML = `
    <div class="bg-white w-full md:max-w-2xl max-h-[94dvh] rounded-t-2xl md:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0 bg-slate-50">
        <div class="min-w-0">
          <p class="text-[10px] uppercase font-bold tracking-wider text-brand-600">Preuve de livraison</p>
          <h2 class="font-bold text-slate-900 truncate">${escapeHtml(stop.name || 'Client')}</h2>
        </div>
        <button type="button" data-pod-close class="w-11 h-11 rounded-full hover:bg-slate-200 active:bg-slate-300 flex items-center justify-center text-slate-500">
          <i class="fa-solid fa-xmark text-lg"></i>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-4 space-y-5">
        <div class="text-xs text-slate-500 flex items-start gap-2">
          <i class="fa-solid fa-location-dot mt-0.5"></i>
          <span class="break-words">${escapeHtml(stop.address || '')}</span>
        </div>

        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-slate-800"><i class="fa-solid fa-signature text-brand-500 mr-1"></i> Signature du client</h3>
            <button type="button" data-sign-clear class="text-xs text-slate-500 hover:text-red-600 px-2 py-1">Effacer</button>
          </div>
          <canvas data-sign-pad class="w-full h-[170px] rounded-xl border-2 border-dashed border-slate-300 bg-white touch-none"></canvas>
          <p class="text-[11px] text-slate-400 mt-1">Signez avec le doigt ou la souris.</p>
        </section>

        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-slate-800"><i class="fa-solid fa-camera text-brand-500 mr-1"></i> Photos</h3>
            <span class="text-xs text-slate-400" data-photo-count>${photos.length}/6</span>
          </div>
          <div class="flex flex-wrap gap-2" data-photo-list></div>
          <div class="flex gap-2 mt-2">
            <label class="flex-1 min-h-[44px] bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold text-slate-700 flex items-center justify-center gap-2 cursor-pointer">
              <i class="fa-solid fa-camera"></i> Prendre une photo
              <input type="file" accept="image/*" capture="environment" data-photo-input class="hidden">
            </label>
            <label class="flex-1 min-h-[44px] bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold text-slate-700 flex items-center justify-center gap-2 cursor-pointer">
              <i class="fa-regular fa-image"></i> Galerie
              <input type="file" accept="image/*" data-photo-input class="hidden">
            </label>
          </div>
        </section>

        <section>
          <h3 class="text-sm font-bold text-slate-800 mb-2"><i class="fa-solid fa-list-check text-brand-500 mr-1"></i> Formulaire</h3>
          <div class="space-y-3">
            ${formDefs.map((f) => podFieldHTML(f, fields[f.id])).join('') || '<p class="text-xs text-slate-400">Aucun champ configuré (Réglages → Formulaire POD).</p>'}
          </div>
        </section>

        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-slate-800"><i class="fa-solid fa-barcode text-brand-500 mr-1"></i> Codes-barres scannés</h3>
            <button type="button" data-scan-open class="text-xs font-semibold text-brand-600 hover:underline px-2 py-1">
              <i class="fa-solid fa-camera"></i> Scanner
            </button>
          </div>
          <div data-scan-list class="text-xs text-slate-500"></div>
        </section>

        <section>
          <label class="block text-sm font-bold text-slate-800 mb-1">Notes de livraison</label>
          <textarea data-pod-notes rows="2" class="w-full px-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-brand-500 outline-none text-base" placeholder="Ex: remis au gardien, colis endommagé…">${escapeHtml(stop.notes || '')}</textarea>
        </section>

        <p class="text-[11px] text-slate-400 flex items-center gap-1">
          <i class="fa-solid fa-location-crosshairs"></i> Position et horodatage enregistrés à la validation.
        </p>
      </div>

      <div class="p-3 border-t border-slate-200 bg-slate-50 flex gap-2 safe-bottom flex-shrink-0">
        <button type="button" data-pod-close class="px-4 min-h-[48px] rounded-xl border border-slate-300 text-slate-600 font-semibold text-sm">Annuler</button>
        <button type="button" data-pod-save class="flex-1 min-h-[48px] bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold rounded-xl text-sm flex items-center justify-center gap-2">
          <i class="fa-solid fa-circle-check"></i> Valider la preuve
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const canvas = overlay.querySelector('[data-sign-pad]');
  const signature = setupSignature(canvas);
  if (pod.signature) {
    // Attendre le calage haute densité du canvas avant de restaurer.
    setTimeout(() => signature.load(pod.signature), 60);
  }

  const photoList = overlay.querySelector('[data-photo-list]');
  const photoCount = overlay.querySelector('[data-photo-count]');
  const scanBox = overlay.querySelector('[data-scan-list]');
  const renderScans = () => {
    scanBox.innerHTML = scans.length
      ? scans.map((s) => `<span class="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-1 mr-1 mb-1"><i class="fa-solid fa-check"></i>${escapeHtml(s)}</span>`).join('')
      : 'Aucun scan.';
  };
  const renderPhotos = () => {
    photoList.innerHTML = photos.map((src, i) => `
      <div class="relative w-20 h-20 rounded-lg overflow-hidden border border-slate-200">
        <img src="${src}" alt="Photo ${i + 1}" class="w-full h-full object-cover">
        <button type="button" data-photo-remove="${i}" class="absolute top-0.5 right-0.5 w-6 h-6 bg-slate-900/70 text-white rounded-full text-[10px] flex items-center justify-center">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `).join('');
    photoCount.textContent = `${photos.length}/6`;
  };
  renderPhotos();
  renderScans();

  overlay.querySelectorAll('[data-photo-input]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      if (photos.length >= 6) { toast('6 photos maximum.', 'warn'); return; }
      try { photos.push(await compressImage(file)); renderPhotos(); }
      catch { toast('Photo illisible.', 'error'); }
    });
  });

  overlay.querySelectorAll('[data-field-photo]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      const key = input.dataset.fieldPhoto;
      input.value = '';
      if (!file) return;
      try {
        fields[key] = await compressImage(file, 900, 0.55);
        const preview = overlay.querySelector(`[data-field-preview="${key}"]`);
        if (preview) preview.innerHTML = `<img src="${fields[key]}" class="w-16 h-16 object-cover rounded-lg border border-slate-200">`;
      } catch { toast('Photo illisible.', 'error'); }
    });
  });

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
    opts.onClose?.();
  };

  const save = async () => {
    overlay.querySelectorAll('[data-field]').forEach((el) => {
      const key = el.dataset.field;
      const def = formDefs.find((f) => f.id === key);
      if (!def) return;
      if (def.type === 'check') fields[key] = el.checked;
      else if (def.type === 'number') fields[key] = el.value === '' ? null : Number(el.value);
      else if (def.type === 'signature') fields[key] = signature.dataUrl() || true;
      else if (def.type !== 'photo') fields[key] = el.value;
    });

    const geo = await currentPosition().catch(() => null);
    const completedAt = new Date().toISOString();
    stop.pod = {
      signature: signature.dataUrl() || pod.signature || null,
      photos,
      fields,
      scans,
      geo: geo || pod.geo || null,
      completedAt,
    };
    stop.notes = overlay.querySelector('[data-pod-notes]').value.trim();
    if (markDelivered) {
      stop.status = 'delivered';
      stop.completedAt = completedAt;
      if (!stop.arrivedAt) stop.arrivedAt = completedAt;
    }
    if (geo) {
      stop.breadcrumb = Array.isArray(stop.breadcrumb) ? stop.breadcrumb : [];
      stop.breadcrumb.push({ lat: geo.lat, lng: geo.lng, t: Date.now() });
    }
    opts.onSave?.(stop);
    toast('Preuve de livraison enregistrée.', 'success');
    close();
  };

  overlay.addEventListener('click', async (ev) => {
    const removePhoto = ev.target.closest('[data-photo-remove]');
    if (removePhoto) {
      photos.splice(Number(removePhoto.dataset.photoRemove), 1);
      renderPhotos();
      return;
    }
    if (ev.target.closest('[data-sign-clear]')) { signature.clear(); return; }
    if (ev.target.closest('[data-scan-open]')) {
      openScanner(stop, {
        onScan: (code) => {
          if (code && !scans.includes(code)) scans.push(code);
          renderScans();
        },
      });
      return;
    }
    if (ev.target.closest('[data-pod-close]')) { close(); return; }
    if (ev.target.closest('[data-pod-save]')) await save();
  });

  return { close };
}

/** Classification d'un code scanné : 'label' (GEPIR étiquette), 'tracking'
 *  (n° de suivi brut), 'other'. Exportée pour les tests (harness-v59). */
export function classifyScanCode(value) {
  const v = String(value || '');
  if (v.includes('[)>') && (/[\x1d\x1e\u241d\u241e]/.test(v) || /(GEOP|S010|G03)/.test(v))) return 'label';
  if (/^[0-9A-Z]{8,}$/.test(v.replace(/[\s.\-\/%]/g, ''))) return 'tracking';
  return 'other';
}

/* ------------------------------------------------------------------ */
/* Scanner code-barres                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Décodage « difficile » : tuiles 1:1 → agrandissement cubique Keys   */
/* → zxing-wasm, avec variante seuillage adaptatif (3× box blur).      */
/* Les étiquettes Chronofresh récentes ont un Aztec petit au centre    */
/* que AUCUN pipeline canvas (resize drawImage) ne rend décodable :    */
/* il faut recadrer sans rééchantillonnage puis upscaler soi-même      */
/* (noyau cubique Keys a=-0.75, comme cv2.INTER_CUBIC — vérifié en     */
/* navigateur réel sur étiquettes 2026 ; le flou du filtre canvas      */
/* « high quality » empêche zxing de verrouiller l'Aztec).             */
/* ------------------------------------------------------------------ */

/* Tuiles dans l'ordre de probabilité de l'Aztec (centre-droite d'abord),
 * pleine image en dernier (repli Code128/suivi). */
const HARD_TILES = [
  [0.45, 0.4, 0.9, 0.8],
  [0.4, 0.35, 1.0, 0.85],
  [0.1, 0.1, 0.9, 0.9],
  [0.0, 0.3, 0.6, 0.8],
  [0.4, 0.55, 0.95, 1.0],
  [0, 0, 1, 1],
];

/* zxing-wasm (zxing-cpp compilé WASM, v3.1.6 MIT) : SEUL moteur capable de
 * lire l'Aztec petit des étiquettes Chronofresh récentes. Le vieux zxing-js
 * (zxing.umd.js, API 0.x) échoue sur ces photos — vérifié en navigateur.
 * Chargé paresseusement à la première passe difficile. */
const ZXWASM_FORMATS = ['Aztec', 'QRCode', 'DataMatrix', 'Code128', 'Code39', 'Code93', 'EAN13', 'EAN8', 'PDF417', 'ITF'];
let zxWasmPromise = null;
function loadZxingWasm() {
  if (!zxWasmPromise) {
    zxWasmPromise = new Promise((resolve) => {
      if (window.ZXingWASM?.readBarcodesFromImageData) { resolve(window.ZXingWASM); return; }
      const tag = document.createElement('script');
      tag.src = 'zxing-wasm.iife.js';
      tag.onload = () => resolve(window.ZXingWASM || null);
      tag.onerror = () => resolve(null);
      (document.head || document.body).appendChild(tag);
    });
  }
  return zxWasmPromise;
}

let zxWasmReady = null;
function wasmDecodeImageData(imageData) {
  if (!zxWasmReady) {
    zxWasmReady = loadZxingWasm().then((ZW) => {
      if (!ZW?.readBarcodesFromImageData) return null;
      try { ZW.setZXingModuleOverrides({ locateFile: (name) => name }); } catch {}
      return ZW;
    }).catch(() => null);
  }
  return zxWasmReady.then((ZW) => {
    if (!ZW) return null;
    return ZW.readBarcodesFromImageData(imageData, { tryHarder: true, formats: ZXWASM_FORMATS })
      .then((codes) => (codes && codes.length ? codes.map((c) => String(c.text)) : null))
      .catch(() => null);
  });
}

/* ---------- pipeline pixel (remplace tout resize canvas) ---------- */

let hardCanvas = null;
function hardCtx(w, h) {
  if (!hardCanvas) {
    hardCanvas = document.createElement('canvas');
    hardCanvas.width = w; hardCanvas.height = h;
  } else if (hardCanvas.width !== w || hardCanvas.height !== h) {
    hardCanvas.width = w; hardCanvas.height = h;
  }
  const ctx = hardCanvas.getContext('2d', { willReadFrequently: true });
  if (ctx) { ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, w, h); }
  return ctx;
}

/** Copie 1:1 (aucun rééchantillonnage) d'une tuile de `source` en ImageData. */
function cropImageData1to1(source, sw, sh, tile) {
  const [a, b, c, d] = tile;
  const sx = Math.round(sw * a), sy = Math.round(sh * b);
  const w = Math.round(sw * (c - a)), h = Math.round(sh * (d - b));
  if (w < 16 || h < 16) return null;
  try {
    const ctx = hardCtx(w, h);
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch { return null; }
}

function keysCubic(x) {
  x = Math.abs(x);
  if (x <= 1) return (1.25 * x - 2.25) * x * x + 1;      // a=-0.75 branche centrale
  if (x < 2) return ((-0.75 * x + 3.75) * x - 6) * x + 3; // a=-0.75 branche externe
  return 0;
}
function reflectIdx(i, n) { if (i < 0) i = -i - 1; if (i >= n) i = 2 * n - i - 1; return i; }
function axisCoeffs(n, outn) {
  const idx = new Int32Array(outn * 4), ws = new Float32Array(outn * 4);
  for (let o = 0; o < outn; o++) {
    const cc = (o + 0.5) * n / outn - 0.5, i0 = Math.floor(cc);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const ii = i0 + k - 1;
      idx[o * 4 + k] = reflectIdx(ii, n);
      ws[o * 4 + k] = keysCubic(cc - ii);
      sum += ws[o * 4 + k];
    }
    for (let k = 0; k < 4; k++) ws[o * 4 + k] /= sum;
  }
  return { idx, ws };
}

/** Agrandissement cubique Keys (identique cv2.INTER_CUBIC) — LA clé qui fait
 *  basculer le décodage Aztec là où le resize canvas échoue. */
function keysCubicResize(im, scale) {
  const { width: w, height: h, data: src } = im;
  const W = w * scale, H = h * scale;
  if (W > 2600 || H > 2600) return null;
  const cx = axisCoeffs(w, W), cy = axisCoeffs(h, H);
  const tmp = new Float32Array(W * h * 3);
  for (let y = 0; y < h; y++) {
    for (let X = 0; X < W; X++) {
      const b0 = (y * w + cx.idx[X * 4]) * 4, b1 = (y * w + cx.idx[X * 4 + 1]) * 4;
      const b2 = (y * w + cx.idx[X * 4 + 2]) * 4, b3 = (y * w + cx.idx[X * 4 + 3]) * 4;
      const c0 = cx.ws[X * 4], c1 = cx.ws[X * 4 + 1], c2 = cx.ws[X * 4 + 2], c3 = cx.ws[X * 4 + 3];
      const o = (y * W + X) * 3;
      tmp[o] = src[b0] * c0 + src[b1] * c1 + src[b2] * c2 + src[b3] * c3;
      tmp[o + 1] = src[b0 + 1] * c0 + src[b1 + 1] * c1 + src[b2 + 1] * c2 + src[b3 + 1] * c3;
      tmp[o + 2] = src[b0 + 2] * c0 + src[b1 + 2] * c1 + src[b2 + 2] * c2 + src[b3 + 2] * c3;
    }
  }
  const dst = new Uint8ClampedArray(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const r0 = cy.idx[Y * 4] * W * 3, r1 = cy.idx[Y * 4 + 1] * W * 3;
    const r2 = cy.idx[Y * 4 + 2] * W * 3, r3 = cy.idx[Y * 4 + 3] * W * 3;
    const w0 = cy.ws[Y * 4], w1 = cy.ws[Y * 4 + 1], w2 = cy.ws[Y * 4 + 2], w3 = cy.ws[Y * 4 + 3];
    const base = Y * W * 4;
    for (let x = 0; x < W * 3; x++) {
      dst[base + ((x / 3) | 0) * 4 + (x % 3)] =
        tmp[r0 + x] * w0 + tmp[r1 + x] * w1 + tmp[r2 + x] * w2 + tmp[r3 + x] * w3;
    }
    for (let X = 0; X < W; X++) dst[base + X * 4 + 3] = 255;
  }
  const res = new ImageData(W, H);
  res.data.set(dst);
  return res;
}

/** Seuil adaptatif fidèle à OpenCV ADAPTIVE_THRESH_GAUSSIAN_C block=31 C=5 :
 *  noyau gaussien séparable 31 taps (sigma=5), bord REFLECT_101, seuillage
 *  local b > flou(b) - 5. Approx box 3× échouait (bruit JPEG, vérifié). */
function adaptiveBinImageData(im) {
  const { width: w, height: h, data: src } = im;
  const n = w * h;
  const g = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) g[p] = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114;
  const K = 31, R = 15, sigma = 0.3 * ((K - 1) * 0.5 - 1) + 0.8;
  const kern = new Float32Array(K);
  let ksum = 0;
  for (let i = 0; i < K; i++) {
    const x = i - R;
    kern[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    ksum += kern[i];
  }
  for (let i = 0; i < K; i++) kern[i] /= ksum;
  const tmp = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -R; k <= R; k++) {
        let xx = x + k;
        if (xx < 0) xx = -xx - 1; else if (xx >= w) xx = 2 * w - xx - 1;
        acc += kern[k + R] * g[row + xx];
      }
      tmp[row + x] = acc;
    }
  }
  const blur = new Float32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -R; k <= R; k++) {
        let yy = y + k;
        if (yy < 0) yy = -yy - 1; else if (yy >= h) yy = 2 * h - yy - 1;
        acc += kern[k + R] * tmp[yy * w + x];
      }
      blur[y * w + x] = acc;
    }
  }
  const out = new ImageData(w, h);
  const o = out.data;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = g[p] > blur[p] - 5 ? 255 : 0;
    o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
  }
  return out;
}

/** Décodeur legacy zxing-js sur canvas (repli si WASM indisponible). */
function drawLegacyVariant(source, sw, sh, tile, scale) {
  const [a, b, c, d] = tile;
  const sx = Math.round(sw * a), sy = Math.round(sh * b);
  const w = Math.round(sw * (c - a)), h = Math.round(sh * (d - b));
  if (w < 16 || h < 16) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(2600, Math.round(w * scale));
  canvas.height = Math.min(2600, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, w, h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Renvoie (canvas) => Promise<{text}|null> compatible multi-versions du
 *  bundle zxing-js vendored (API 0.x : pas de decodeFromCanvas !). */
function makeCanvasDecoder() {
  const Z = window.ZXing;
  if (!Z) return null;
  let reader = null, hints = null;
  try {
    hints = new Map([
      [Z.DecodeHintType.POSSIBLE_FORMATS, [
        Z.BarcodeFormat.AZTEC, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX,
        Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
        Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.ITF,
      ]],
      [Z.DecodeHintType.TRY_HARDER, true],
    ]);
    reader = new Z.BrowserMultiFormatReader(hints);
  } catch { return null; }
  if (!reader) return null;
  if (typeof reader.decodeFromCanvas === 'function') {
    return async (canvas) => {
      const r = await reader.decodeFromCanvas(canvas);
      return r?.text ? { text: String(r.text) } : null;
    };
  }
  if (Z.HTMLCanvasElementLuminanceSource && Z.MultiFormatReader && Z.BinaryBitmap && Z.HybridBinarizer) {
    return async (canvas) => {
      try {
        const src = new Z.HTMLCanvasElementLuminanceSource(canvas);
        const bb = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
        const r = new Z.MultiFormatReader().decode(bb, hints);
        return r?.text ? { text: String(r.text) } : null;
      } catch { return null; }
    };
  }
  return async (canvas) => {
    try {
      const r = await reader.decodeFromImageUrl(canvas.toDataURL('image/png'));
      return r?.text ? { text: String(r.text) } : null;
    } catch { return null; }
  };
}

/** Passe difficile : pleine-image 1:1 puis tuiles × {×2, ×3} × {brut,
 *  seuillage adaptatif} via zxing-wasm ; repli legacy zxing-js si absent.
 *  Renvoie { text, label:true } dès qu'un GEPIR est validé par `isLabel`,
 *  sinon { text, label:false } (repli suivi) ou null. Exporté pour tests. */
export async function hardDecodeSource(source, { isLabel, budgetMs = 6500 } = {}) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  if (!sw || !sh) return null;
  loadZxingWasm();
  const legacyDecode = makeCanvasDecoder();
  const deadline = Date.now() + budgetMs;
  let tracking = null;
  const eat = (texts) => {
    for (const raw of texts || []) {
      const text = String(raw).trim();
      if (!text) continue;
      if (isLabel?.(text)) return text;
      if (!tracking && /^%?[0-9A-Za-z][0-9A-Za-z.\-/% ]{5,}$/.test(text)) tracking = text;
    }
    return null;
  };
  // 1) pleine image 1:1 (gros codes, et suivi Code128)
  const full = cropImageData1to1(source, sw, sh, [0, 0, 1, 1]);
  if (full) {
    const hit = eat(await wasmDecodeImageData(full).catch(() => null));
    if (hit) return { text: hit, label: true };
    if (legacyDecode) {
      const canvas = drawLegacyVariant(source, sw, sh, [0, 0, 1, 1], 1);
      const res = canvas && await legacyDecode(canvas).catch(() => null);
      const hit2 = res ? eat([res.text]) : null;
      if (hit2) return { text: hit2, label: true };
    }
  }
  // 2) tuiles × échelles × variantes (WASM uniquement — le legacy ne sait pas)
  for (const tile of HARD_TILES) {
    for (const scale of [2, 3]) {
      const crop = cropImageData1to1(source, sw, sh, tile);
      const big = crop && keysCubicResize(crop, scale);
      if (!big) continue;
      let hit = eat(await wasmDecodeImageData(big).catch(() => null));
      if (hit) return { text: hit, label: true };
      hit = eat(await wasmDecodeImageData(adaptiveBinImageData(big)).catch(() => null));
      if (hit) return { text: hit, label: true };
      if (Date.now() > deadline) break;
    }
    if (Date.now() > deadline) break;
  }
  return tracking ? { text: tracking, label: false } : null;
}

export function openScanner(stop, opts = {}) {
  const expected = [
    ...(Array.isArray(stop.expectedCodes) ? stop.expectedCodes : []),
    ...(Array.isArray(stop.barcodes) ? stop.barcodes : []),
  ].map(String);
  const preferLabel = Boolean(opts.preferLabel);
  const LABEL_WAIT_MS = Number(opts.labelWaitMs || 6000);

  document.getElementById('scan-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'scan-modal';
  overlay.className = 'fixed inset-0 z-[170] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
      <div class="px-4 py-3 flex items-center justify-between border-b border-slate-200">
        <h3 class="font-bold text-slate-900"><i class="fa-solid fa-barcode text-brand-500 mr-1"></i> Scanner</h3>
        <div class="flex items-center">
          <button type="button" data-torch class="hidden w-10 h-10 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500" title="Flash"><i class="fa-solid fa-lightbulb"></i></button>
          <button type="button" data-scan-close class="w-10 h-10 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      <div class="p-4 space-y-3">
        <div id="scan-reader" class="w-full min-h-[220px] bg-slate-900 rounded-xl overflow-hidden flex items-center justify-center text-slate-400 text-xs">
          <span><i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Initialisation caméra…</span>
        </div>
        <p class="text-xs text-slate-500" data-scan-hint>${preferLabel ? 'Cadre le <b>grand QR</b> de l’étiquette (à droite de l’adresse client) — le code-barres du bas sert de repli.' : 'Placez le code-barres dans le cadre. La saisie manuelle reste disponible.'}</p>
        <div class="flex gap-2">
          <input data-manual-code type="text" placeholder="Saisir le code…" class="flex-1 min-w-0 px-3 py-2.5 border border-slate-300 rounded-lg text-base">
          <button type="button" data-manual-ok class="px-4 min-h-[44px] bg-brand-600 text-white font-semibold rounded-lg text-sm">OK</button>
        </div>
        <label class="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-dashed border-slate-300 rounded-lg text-xs text-slate-500 cursor-pointer">
          <i class="fa-solid fa-camera"></i> Utiliser une photo de l’étiquette
          <input type="file" accept="image/*" capture="environment" class="hidden" data-scan-photo>
        </label>
        <div data-scan-status class="text-xs"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const reader = overlay.querySelector('#scan-reader');
  const status = overlay.querySelector('[data-scan-status]');
  const manual = overlay.querySelector('[data-manual-code]');
  let scanner = null;
  let zxingReader = null;
  let stream = null;
  let raf = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    if (scanner) { scanner.stop().then(() => scanner.clear()).catch(() => {}); scanner = null; }
    if (zxingReader) { try { zxingReader.stopContinuousDecode(); } catch {} zxingReader = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  };

  const classify = classifyScanCode;

  const handle = (code, format) => {
    const value = String(code || '').trim();
    if (!value || closed) return;
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    const isGepir = classify(value) === 'label';
    const clean = isGepir ? value.replace(/[\x1e\x1d]/g, ' ').slice(0, 120) : value;
    const match2 = expected.length ? expected.some((e) => clean.includes(e) || e.includes(clean)) : null;
    status.innerHTML = match2 === null
      ? `<span class="text-emerald-600"><i class="fa-solid fa-check"></i> ${isGepir ? 'Étiquette complète lue' : 'Code lu'} : ${escapeHtml(clean).slice(0, 80)}</span>`
      : match2
        ? `<span class="text-emerald-600"><i class="fa-solid fa-circle-check"></i> Code attendu confirmé : ${escapeHtml(clean).slice(0, 80)}</span>`
        : `<span class="text-amber-600"><i class="fa-solid fa-triangle-exclamation"></i> Code inattendu : ${escapeHtml(clean).slice(0, 80)}</span>`;
    opts.onScan?.(value, match2, format);
    cleanup();
    setTimeout(() => overlay.remove(), 550);
  };

  let fallback = null;
  let fallbackTimer = null;
  let lastHint = 0;
  let activeVideo = null;
  let hardHunting = false;
  let lastHardHunt = 0;
  /* L'étiquette est dans le champ (suivi Code128 lu) mais l'Aztec n'est pas
   * décodable en pleine frame → on relance une passe « difficile » (tuiles
   * recadrées + upscale + binarisation) sur l'image vidéo courante. */
  const huntLabelHard = () => {
    if (hardHunting || !activeVideo || closed) return;
    if (Date.now() - lastHardHunt < 3000) return;
    lastHardHunt = Date.now();
    hardHunting = true;
    hardDecodeSource(activeVideo, { isLabel: (t) => classify(t) === 'label', budgetMs: 4000 })
      .then((r) => { if (r?.label && !closed) handle(r.text, 'aztec'); })
      .catch(() => {})
      .finally(() => { hardHunting = false; });
  };
  const onCode = (value, format) => {
    if (closed) return;
    const kind = classify(value);
    if (!preferLabel || kind === 'label') { handle(value, format); return; }
    if (kind === 'tracking') {
      fallback = { value, format };
      huntLabelHard();
      status.innerHTML = '<span class="text-brand-600"><i class="fa-solid fa-magnifying-glass mr-1"></i> N° de suivi lu — je cherche encore le QR d’adresse, sinon je l’utiliserai dans quelques secondes.</span>';
      if (!fallbackTimer) fallbackTimer = setTimeout(() => { if (fallback) handle(fallback.value, fallback.format); }, LABEL_WAIT_MS);
      return;
    }
    const now = Date.now();
    if (now - lastHint > 1500) {
      lastHint = now;
      status.innerHTML = '<span class="text-slate-500"><i class="fa-solid fa-qrcode mr-1"></i> Code non reconnu — cadre le QR à droite de l’adresse client.</span>';
    }
  };

  overlay.querySelectorAll('[data-scan-close]').forEach((b) => b.addEventListener('click', () => { cleanup(); overlay.remove(); }));
  overlay.querySelector('[data-manual-ok]').addEventListener('click', () => handle(manual.value));
  manual.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') handle(manual.value); });
  manual.focus();

  const pickBest = (codes) => codes.find((c) => classify(c.rawValue || c.text) === 'label') || codes[0];

  const getCam = async () => {
    const tries = [
      { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } },
      { video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 } } },
      { video: { facingMode: 'environment' } },
      { video: true },
    ];
    let lastErr;
    for (const c of tries) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch (err) { lastErr = err; }
    }
    throw lastErr;
  };

  const setupTorch = (s) => {
    try {
      const track = s.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() || {};
      if (!caps.torch) return;
      const btn = overlay.querySelector('[data-torch]');
      btn.classList.remove('hidden');
      let on = false;
      btn.addEventListener('click', () => {
        on = !on;
        btn.classList.toggle('bg-amber-200', on);
        track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
      });
    } catch {}
  };

  const mountVideo = (s) => {
    const video = document.createElement('video');
    video.className = 'w-full h-[220px] object-cover';
    video.setAttribute('playsinline', '');
    reader.innerHTML = '';
    reader.appendChild(video);
    video.srcObject = s;
    activeVideo = video;
    setupTorch(s);
    return video;
  };

  (async () => {
    const canCamera = !!navigator.mediaDevices?.getUserMedia;

    /* Chaîne de décodage : natif si l'Aztec est supporté (rapide), sinon zxing
       (seul à lire l'Aztec des étiquettes sur les anciens Chrome/WebView/Firefox). */
    if (canCamera) {
      const supported = 'BarcodeDetector' in window ? ((await window.BarcodeDetector.getSupportedFormats?.().catch(() => [])) || []) : null;
      const nativeAztec = supported !== null && (supported.length === 0 || supported.includes('aztec'));
      const order = [];
      if (nativeAztec) order.push('native');
      if (window.ZXing?.BrowserMultiFormatReader) order.push('zxing');
      if (supported !== null && !order.includes('native')) order.push('native');
      if (window.Html5Qrcode) order.push('html5');

      for (const engine of order) {
        if (closed) return;
        try {
          if (engine === 'native') {
            const supported = (await window.BarcodeDetector.getSupportedFormats?.()) || [];
            const wanted = ['aztec', 'qr_code', 'data_matrix', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'pdf_417', 'itf', 'codabar']
              .filter((f) => !supported.length || supported.includes(f));
            stream = await getCam();
            const video = mountVideo(stream);
            await video.play();
            const detector = new window.BarcodeDetector({ formats: wanted });
            const loop = async () => {
              if (closed) return;
              try {
                const codes = await detector.detect(video);
                if (codes.length) {
                  const best = pickBest(codes);
                  if (classify(best.rawValue) === 'label') { handle(best.rawValue, best.format); return; }
                  onCode(best.rawValue, best.format);
                  if (closed) return;
                }
              } catch {}
              raf = requestAnimationFrame(loop);
            };
            loop();
            return;
          }
          if (engine === 'zxing') {
            const Z = window.ZXing;
            const hints = new Map([
              [Z.DecodeHintType.POSSIBLE_FORMATS, [
                Z.BarcodeFormat.AZTEC, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX,
                Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
                Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.ITF,
              ]],
              [Z.DecodeHintType.TRY_HARDER, true],
            ]);
            reader.innerHTML = '<span class="text-slate-400 text-xs"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Ouverture caméra…</span>';
            stream = await getCam();
            const video = mountVideo(stream);
            await video.play();
            zxingReader = new Z.BrowserMultiFormatReader(hints, { delayBetweenScanAttempt: 200 });
            zxingReader.decodeFromVideoElement(video, (result) => {
              if (!result || closed || !result.text) return;
              const fmt = Object.keys(Z.BarcodeFormat).find((k) => Z.BarcodeFormat[k] === result.format) || null;
              onCode(result.text, fmt);
            });
            return;
          }
          if (engine === 'html5') {
            scanner = new window.Html5Qrcode('scan-reader', { verbose: false });
            await scanner.start(
              { facingMode: 'environment' },
              { fps: 10, qrbox: { width: 260, height: 200 } },
              (text) => { if (!closed) onCode(text, null); },
              () => {}
            );
            return;
          }
        } catch (err) {
          console.warn(`[scan] moteur ${engine} indisponible`, err);
          try { if (engine === 'zxing') zxingReader?.stopContinuousDecode(); } catch {}
          zxingReader = null;
          if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
          reader.innerHTML = '<span class="text-slate-400 text-xs"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Nouvelle tentative…</span>';
        }
      }
    }

    reader.innerHTML = '<span class="text-slate-400 text-xs p-6 text-center"><i class="fa-solid fa-keyboard mr-1"></i> Caméra indisponible — saisissez le code ou utilisez une photo.</span>';
    manual.focus();
  })();

  /* Photo de l'étiquette → décodage hors-live, tous les codes de l'image. */
  overlay.querySelector('[data-scan-photo]')?.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    if (!window.ZXing?.BrowserMultiFormatReader) {
      status.innerHTML = '<span class="text-amber-600">Décodeur photo non chargé — vérifiez la connexion (le script zxing manque).</span>';
      return;
    }
    status.innerHTML = '<span class="text-brand-600"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Analyse de la photo…</span>';
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
      /* Passe difficile : pleine-image puis tuiles recadrées × upscale ×
       * binarisation — les Aztec petits des étiquettes Chronofresh ne sont
       * jamais lus en pleine frame par zxing-js. */
      const r = await hardDecodeSource(img, { isLabel: (t) => classify(t) === 'label', budgetMs: 12000 });
      URL.revokeObjectURL(url);
      if (r) handle(r.text);
      else status.innerHTML = '<span class="text-amber-600">Aucun code lisible sur la photo — recadrez sur le QR de l’étiquette.</span>';
    } catch {
      URL.revokeObjectURL(url);
      status.innerHTML = '<span class="text-amber-600">Photo non décodée — recadrez sur le QR de l’étiquette.</span>';
    }
  });

  return { close: () => { cleanup(); overlay.remove(); } };
}

/* ------------------------------------------------------------------ */
/* Impression POD                                                      */
/* ------------------------------------------------------------------ */

export function podPrintHTML(stop, driver, podForm = []) {
  const fields = stop.pod?.fields || {};
  const rows = Object.entries(fields).map(([k, v]) => {
    const def = podForm.find((f) => f.id === k);
    const label = def?.label || k;
    const val = typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : String(v || '').startsWith('data:image') ? '[photo]' : v;
    return `<tr><td class="py-1 pr-3 text-slate-500">${escapeHtml(label)}</td><td class="py-1 font-medium">${escapeHtml(val ?? '')}</td></tr>`;
  }).join('');

  return `
    <div class="border border-slate-300 rounded-lg p-4 mb-4 break-inside-avoid">
      <div class="flex justify-between items-start gap-3">
        <div>
          <h3 class="font-bold text-sm">${escapeHtml(stop.name)}</h3>
          <p class="text-xs text-slate-600">${escapeHtml(stop.address)}</p>
          <p class="text-xs text-slate-500">${escapeHtml(driver?.name || '')} · ${stop.completedAt ? new Date(stop.completedAt).toLocaleString('fr-FR') : ''}</p>
        </div>
        <span class="text-xs font-bold px-2 py-1 rounded ${stop.status === 'delivered' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">
          ${stop.status === 'delivered' ? 'LIVRÉ' : escapeHtml(stop.status)}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-3 mt-3">
        <div>
          ${rows ? `<table class="text-xs">${rows}</table>` : '<p class="text-xs text-slate-400">Aucun champ POD.</p>'}
          <p class="text-xs mt-2 text-slate-600">Scans : ${(stop.pod?.scans || []).map(escapeHtml).join(', ') || '—'}</p>
          <p class="text-xs text-slate-600">Photos : ${(stop.pod?.photos || []).length}</p>
        </div>
        <div class="text-center">
          ${stop.pod?.signature ? `<img src="${stop.pod.signature}" alt="Signature" class="max-h-24 mx-auto border border-slate-200 rounded">` : '<p class="text-xs text-slate-400">Pas de signature</p>'}
          <p class="text-[9px] text-slate-400 mt-1">Signature client</p>
        </div>
      </div>
    </div>
  `;
}
