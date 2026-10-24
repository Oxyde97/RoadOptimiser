// harness-v59 — passe difficile v2 (crop 1:1 + cubique Keys + zxing-wasm) +
// classification + parse GEPIR (payloads réels Chronofresh 2026)
import fs from 'node:fs';

const payloads = JSON.parse(fs.readFileSync('/tmp/roopt-test/scan_payloads.json', 'utf8'));
const GEPIR = payloads.aztec1;      // séparateurs visibles U+241D…
const CODE128 = payloads.code128_1;

/* ---------- polyfills DOM minimaux ---------- */
globalThis.ImageData = class ImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
};
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      imageSmoothingEnabled: true, imageSmoothingQuality: '',
      clearRect() {},
      drawImage() {},
      getImageData: (x, y, w, h) => new ImageData(w, h),
      putImageData() {},
    }),
  }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
};

/* ---------- faux zxing-wasm : pleine image (720×1280) ne voit que le
 *  Code128 ; la tuile centrale ×3 (972×1536) voit l'Aztec — comportement
 *  MESURÉ en vrai navigateur (probe13/14 sur les 2 photos réelles) -------- */
let wasmCalls = 0;
const FAKE_FULL = (im) => (im.width === 720 && im.height === 1280 ? [{ text: CODE128 }] : []);
const FAKE_LABEL = (im) => (im.width === 972 && im.height === 1536 ? [{ text: GEPIR }] : []);
let behavior = (im) => {
  const a = FAKE_FULL(im); if (a.length) return a;
  return FAKE_LABEL(im);
};
globalThis.window = {
  ZXing: undefined, // pas de legacy : force le chemin WASM
  ZXingWASM: {
    setZXingModuleOverrides() {},
    async readBarcodesFromImageData(im) { wasmCalls++; return behavior(im) || []; },
  },
};

const { classifyScanCode, hardDecodeSource } = await import('/home/oxyde/.hermes/git/RoadOptimiser/pod.js');
const { parseLabelPayload, parseParcelBarcode } = await import('/home/oxyde/.hermes/git/RoadOptimiser/storage.js');

/* ---------- assertions ---------- */
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log('classifyScanCode');
ok('GEPIR séparateurs visibles -> label', classifyScanCode(GEPIR) === 'label');
ok('GEPIR vrais contrôles -> label', classifyScanCode(GEPIR.replace(/\u241d/g, '\x1d').replace(/\u241e/g, '\x1e')) === 'label');
ok('GEPIR compact S010 -> label', classifyScanCode('[)>01020064420901967XU527855863652GEOP...S010...') === 'label');
ok('Code128 neuf -> tracking', classifyScanCode(CODE128) === 'tracking');
ok('Code128 avec espaces -> tracking', classifyScanCode('0064 420X U527 8558 6365 2967 901A') === 'tracking');
ok('bruit -> other', classifyScanCode('bonjour') === 'other');

console.log('parseLabelPayload (payloads réels)');
const l1 = parseLabelPayload(payloads.aztec1);
ok('label1 tracking', l1?.tracking === 'XU527855863652');
ok('label1 zip', l1?.recipient.zip === '64420');
ok('label1 street', l1?.recipient.street === '17 Route de Nay');
ok('label1 city', l1?.recipient.city === 'Lucgarier');
ok('label1 phone', l1?.recipient.phone === '0638409620');
ok('label1 email', l1?.recipient.email === 'duboischristophe@hotmail.fr');
ok('label1 poids 0.3', l1?.weightKg === 0.3);
ok('label1 DLC', l1?.bestBefore === '27102026');
ok('label1 expéditeur', l1?.sender?.name === 'ML ATELIER FONSORBES' && l1?.sender?.zip === '31470');
const l2 = parseLabelPayload(payloads.aztec2);
ok('label2 tracking', l2?.tracking === 'XV037781203652');
ok('label2 zip', l2?.recipient.zip === '64530');
ok('label2 street', l2?.recipient.street === '470 Chemin De Lalia');
ok('label2 city', l2?.recipient.city === 'Ger');
ok('label2 phone +33', l2?.recipient.phone === '33620274543');
ok('label2 poids 8.4', l2?.weightKg === 8.4);
ok('label2 DLC', l2?.bestBefore === '22112026');
ok('label2 fullAddress', l2?.fullAddress === '470 Chemin De Lalia, 64530 Ger');

console.log('parseLabelPayload repli compact (séparateurs arrachés)');
const compact = payloads.aztec1.replace(/[\u241d\u241e\u241f\u2420\x1d\x1e\x1f]/g, '');
const lc = parseLabelPayload(compact);
ok('compact -> tracking récupéré', lc?.tracking === 'XU527855863652');
ok('compact -> zip récupéré', lc?.recipient?.zip === '64420');
ok('non-GEPIR -> null', parseLabelPayload('juste du texte') === null);

console.log('parseParcelBarcode (Code128 nouveaux formats)');
ok('c128_1 cp 64420', parseParcelBarcode(CODE128)?.cp === '64420');
ok('c128_2 cp 64530', parseParcelBarcode('0064530XV037781203652562901M')?.cp === '64530');

console.log('hardDecodeSource (passe difficile v2, faux zxing-wasm)');
const fakeImg = { naturalWidth: 720, naturalHeight: 1280 };
const t0 = Date.now();
const r = await hardDecodeSource(fakeImg, { isLabel: (t) => classifyScanCode(t) === 'label', budgetMs: 8000 });
ok('trouve le GEPIR via tuile ×3', r?.label === true && r.text === GEPIR, JSON.stringify(r && { label: r.label, head: r.text.slice(0, 20) }));
ok('a interrogé le WASM plusieurs fois', wasmCalls >= 2, `calls=${wasmCalls}`);
ok('résultat sous 3 s (faux moteur)', Date.now() - t0 < 3000);

behavior = (im) => FAKE_FULL(im); // plus jamais de label trouvable
const r2 = await hardDecodeSource(fakeImg, { isLabel: (t) => classifyScanCode(t) === 'label', budgetMs: 8000 });
ok('repli tracking quand pas d’Aztec', r2?.label === false && r2?.text === CODE128, JSON.stringify(r2));

console.log(`\n${pass} réussies, ${fail} échouées`);
process.exit(fail ? 1 : 0);
