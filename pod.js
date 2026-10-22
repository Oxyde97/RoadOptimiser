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

/* ------------------------------------------------------------------ */
/* Scanner code-barres                                                 */
/* ------------------------------------------------------------------ */

export function openScanner(stop, opts = {}) {
  const expected = [
    ...(Array.isArray(stop.expectedCodes) ? stop.expectedCodes : []),
    ...(Array.isArray(stop.barcodes) ? stop.barcodes : []),
  ].map(String);

  document.getElementById('scan-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'scan-modal';
  overlay.className = 'fixed inset-0 z-[170] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
      <div class="px-4 py-3 flex items-center justify-between border-b border-slate-200">
        <h3 class="font-bold text-slate-900"><i class="fa-solid fa-barcode text-brand-500 mr-1"></i> Scanner</h3>
        <button type="button" data-scan-close class="w-10 h-10 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="p-4 space-y-3">
        <div id="scan-reader" class="w-full min-h-[220px] bg-slate-900 rounded-xl overflow-hidden flex items-center justify-center text-slate-400 text-xs">
          <span><i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Initialisation caméra…</span>
        </div>
        <p class="text-xs text-slate-500">Placez le code-barres dans le cadre. La saisie manuelle reste disponible.</p>
        <div class="flex gap-2">
          <input data-manual-code type="text" placeholder="Saisir le code…" class="flex-1 min-w-0 px-3 py-2.5 border border-slate-300 rounded-lg text-base">
          <button type="button" data-manual-ok class="px-4 min-h-[44px] bg-brand-600 text-white font-semibold rounded-lg text-sm">OK</button>
        </div>
        <div data-scan-status class="text-xs"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const reader = overlay.querySelector('#scan-reader');
  const status = overlay.querySelector('[data-scan-status]');
  const manual = overlay.querySelector('[data-manual-code]');
  let scanner = null;
  let stream = null;
  let raf = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    if (scanner) { scanner.stop().then(() => scanner.clear()).catch(() => {}); scanner = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  };

  const handle = (code) => {
    const value = String(code || '').trim();
    if (!value) return;
    const match = expected.length ? expected.some((e) => value.includes(e) || e.includes(value)) : null;
    status.innerHTML = match === null
      ? `<span class="text-emerald-600"><i class="fa-solid fa-check"></i> Code lu : ${escapeHtml(value)}</span>`
      : match
        ? `<span class="text-emerald-600"><i class="fa-solid fa-circle-check"></i> Code attendu confirmé : ${escapeHtml(value)}</span>`
        : `<span class="text-amber-600"><i class="fa-solid fa-triangle-exclamation"></i> Code inattendu : ${escapeHtml(value)}</span>`;
    opts.onScan?.(value, match);
    cleanup();
    setTimeout(() => overlay.remove(), 550);
  };

  overlay.querySelectorAll('[data-scan-close]').forEach((b) => b.addEventListener('click', () => { cleanup(); overlay.remove(); }));
  overlay.querySelector('[data-manual-ok]').addEventListener('click', () => handle(manual.value));
  manual.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') handle(manual.value); });
  manual.focus();

  (async () => {
    if (window.Html5Qrcode) {
      try {
        scanner = new window.Html5Qrcode('scan-reader', { verbose: false });
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 180 } },
          (text) => { if (!closed) handle(text); },
          () => {}
        );
        return;
      } catch (err) {
        console.warn('[scan] html5-qrcode indisponible', err);
        try { await scanner?.clear(); } catch {}
        scanner = null;
        reader.innerHTML = '';
      }
    }

    if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
      try {
        const video = document.createElement('video');
        video.className = 'w-full h-[220px] object-cover';
        video.setAttribute('playsinline', '');
        reader.innerHTML = '';
        reader.appendChild(video);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await video.play();
        const detector = new window.BarcodeDetector();
        const loop = async () => {
          if (closed) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length) { handle(codes[0].rawValue); return; }
          } catch {}
          raf = requestAnimationFrame(loop);
        };
        loop();
        return;
      } catch (err) {
        console.warn('[scan] BarcodeDetector indisponible', err);
        if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      }
    }

    reader.innerHTML = '<span class="text-slate-400 text-xs p-6 text-center"><i class="fa-solid fa-keyboard mr-1"></i> Caméra indisponible — saisissez le code ci-dessous.</span>';
    manual.focus();
  })();

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
