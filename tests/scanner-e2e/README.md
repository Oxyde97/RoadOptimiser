# Tests scan etiquettes (v5.9)

## harness-v59.mjs - unit (node pur)
node harness-v59.mjs   # attend /tmp/roopt-test/scan_payloads.json (payloads GEPIR reels)
Couvre: classifyScanCode (GEPIR visibles/controles/compact, Code128 avec %...),
parseLabelPayload (payloads Chronofresh reels + repli compact), parseParcelBarcode,
hardDecodeSource avec faux ZXingWASM (pleine image -> Code128, tuile 972x1536 -> Aztec).

PIEGE HISTORIQUE: les faux ZXing des harness injectaient decodeFromCanvas - methode
ABSENTE du bundle vendored (API zxing 0.x) -> le mode photo etait mort en prod sans que
les tests le voient. Toujours verifier l'API REELLE du bundle (grep le fichier) avant
de mocker.

## e2e.html + run_pw.py - vrai navigateur (Playwright chromium, ~/.hermes/venvs/playwright)
Servir le dossier web de l'app (ou une copie avec pod.js, storage.js, zxing*.js,
zxing_reader.wasm) sur http://127.0.0.1:18099 avec photo1.jpg/photo2.jpg
(etiquettes de test NON commitees - PII) puis: python3 run_pw.py
Attendu: P1/P2 label=true + tracking + addr + dest.
C'est LE test bout-en-bout: crop 1:1 -> cubique Keys -> zxing-wasm -> seuil gaussien 31
-> GEPIR -> parseLabelPayload. Ne jamais regresser un maillon: le resize canvas (meme
quality high) floute trop, zxing ne verrouille PAS l'Aztec; l'approx box-blur du seuil
adaptatif echoue sur JPEG bruites.
