# RoadOptimiser

Planificateur de tournées de livraison **mobile-first, PWA, multi-comptes synchronisés**, hébergé sur Synology (NAS), sans framework ni npm côté front ni backend.

- **URL officielle (HTTPS, recommandée — caméra/scan, GPS, PWA installable)** : `https://oxyde-syno.tail86cd2f.ts.net/roadoptimizur/`
- **LAN** : `http://192.168.1.120/roadoptimizur/` (miroir Web Station) — identique au conteneur `http://192.168.1.120:8080/roadoptimizur/` (le front résout l'API `:8080` tout seul)
- **API** : même origine que l'app — santé : `/api/health`

Le HTTPS est fourni par le **Tailscale Funnel** du NAS (certificat Let's Encrypt géré par Tailscale). ⚠️ Le funnel est public : l'URL est accessible d'Internet — l'authentification protège les données, l'API reste exposée (anti brute-force : 6 échecs/min/IP, les succès ne comptent pas).

## Rôles et parcours (authentification obligatoire)

### Admin
Connexion → **Comptes** (back-office). Onglets, de gauche à droite : **Commandes · Tournées · Conducteurs · Planning · Analytics · Comptes · Suivi · Réglages**.
- Gère les comptes chauffeurs (création, rôles, mot de passe, **liaison compte↔conducteur**, désactivation, audit)
- Saisit/importe les commandes, planifie la semaine, optimise, publie chaque journée avec **📡 Publier**
- **Suivi temps réel** (onglet Suivi) : une carte par conducteur — progression X/Y, arrêt en cours, position GPS + vitesse, inactivité > 15 min, bouton « Voir » → recentrage carte ; rafraîchi toutes les 15 s. Fonctionne aussi pour les tournées créées par le chauffeur lui-même
- Retours clients (`/?feedback=`), suivi public (`/?track=`), journal d'audit complet

### Chauffeur
Connexion → **Commandes** de son jour. Accès : Commandes · Tournées · Planning · Réglages (les autres onglets sont masqués). Bouton **Route** → vue terrain rapide : gros boutons Livré/Absent/Échec, navigation Maps/Waze, POD, scan, hors-ligne.
- **Autonome (v5.6)** : si rien n'est publié pour le jour, un bandeau l'invite à **créer sa tournée lui-même** (« Ajouter une livraison ») ; il optimise, statutie, et tout est synchronisé automatiquement. Si l'admin publie la même date, sa version prime au prochain refresh.
- Ses tournées publiées (ou auto-créées) se rechargent sur **n'importe quel appareil** avec le même compte.

## Synchronisation — toutes les données vivent sur le serveur

**Règles : un appareil actif à la fois par compte ; dernier qui enregistre gagne ; un appareil vierge ne peut jamais écraser des données riches ; un espace de travail vide n'est jamais uploadé.**

### Chauffeur
- `GET /api/my-week` : au login, **toutes** ses tournées (veille + 15 jours) ; saut automatique sur le prochain jour publié si aujourd'hui est vide
- `POST /api/tour-save` : **chaque** édition poussée ~1,5 s après la dernière action (statuts, ordre, ajouts, optimisation) — **upsert** : un chauffeur peut créer une journée jamais publiée (payload marqué `source: driver`, dépôt inclus)
- `POST /api/position` : GPS throttlé (minimum 25 s, ou mouvement > 600 m) → Suivi admin
- Re-pull automatique **toutes les 60 s** + au retour dans l'onglet (`visibilitychange`) ; anti-écho : pas d'application serveur pendant une édition récente (8 s), pas de re-push des données fraîchement reçues (5 s)

### Admin — espace de travail centralisé
- Snapshot complet du poste (commandes, conducteurs, settings, planning) : `GET/POST /api/ws`, table SQLite `ws_snapshots`
- Au login/démarrage, décision par **score de richesse** (`arrêts + conducteurs + adresse dépôt + jours planifiés`) : appareil inconnu riche → il **upload d'abord** son contenu ; appareil vierge → il **charge** le serveur ; appareil connu → dernier-qui-enregistre-gagne (stamp localStorage `roadoptimizur.ws.stamp`) ; état vide → push refusé. Snapshot dégradé se auto-répare au prochain passage d'un poste riche.
- Push debouncé 2,5 s à chaque `save()`, push final **avant déconnexion** ; badge visible « Enregistré · serveur ✓ » (ou ⚠ hors ligne)
- `doLogout` admin : synchronise puis retourne au gate

### Backup local
- `localStorage` = cache hors-ligne + sécurité. Le passage en scope chauffeur sauvegarde l'état du poste (`scopebak`) et le restaure à la déconnexion, au changement de compte, ou **automatiquement au démarrage** si un résidu de scope traîne (crash, batterie à plat) — marqueur `scopeactive`
- Réglages → Exporter/Importer JSON pour migrer entre origines (HTTP LAN et HTTPS funnel = deux localStorage distincts)

## Dépôt principal
Réglages → « Dépôt de départ » : adresse géocodée via **Nominatim avec repli automatique Photon** (quota OSM plus souple), plus **champ GPS manuel** (`lat;lng`, prioritaire, pré-rempli) si les géocodeurs refusent. Changement d'adresse → re-géocodage forcé même si d'anciens GPS sont stockés, cache routes vidé, carte recadrée (différé si carte fermée). Le dépôt est embarqué dans chaque tournée publiée et appliqué au poste du chauffeur.

## Backend (`server/roopt-server.js`)
Node.js 24 **zéro dépendance npm** : `node:http`, `node:sqlite`, `node:crypto` (scrypt + HMAC JWT).
- Routes : `POST /api/login` · `GET /api/me` · `POST /api/password` · `GET|POST /api/users` · `PATCH|DELETE /api/users/:id` (admin) · `POST /api/publish` (admin) · `POST /api/tour-save` · `POST /api/position` · `GET /api/my-tour` · `GET /api/my-week` · `GET /api/next-tour` · `GET /api/live` (admin) · `POST /api/stop-status` · `GET /api/retours` · `GET /api/audit` (admin) · `GET|POST /api/ws` (admin) · `GET /api/health` · statiques `./`
- SQLite : `users`, `tours(date, driver_id, payload, updated)` (upsert), `ws_snapshots(key='admin')`, `positions`, `updates`, `events` (audit)
- **`data/secret`** : clé HMAC des jetons — ne jamais supprimer. Sauvegarde = dossier `data/`
- Sécurité : scrypt sel unique, jetons 30 j signés, sélecteurs paramétrés, anti brute-force, taille snapshot plafonnée (1,5 Mo)

## Déploiement Synology
1. Front : copier les fichiers web dans `/volume1/web/roadoptimizur/` (propriétaire `http` → sudo), **bumper `VERSION` dans `sw.js`**, vérifier MD5 servi
2. Backend : remplacer `/volume1/docker/roopt-api/roopt-server.js` puis `docker restart roopt-api` (PATH docker via SSH : `/var/packages/ContainerManager/target/usr/bin`)
3. Conteneur **`roopt-api`** : image `node:24-alpine`, port hôte 8080, restart `unless-stopped` ; volumes `roopt-api:/volume1/docker/roopt-api` + `/volume1/web` (statiques). Interface : DSM → Container Manager
4. Funnel : `tailscale funnel --yes --bg http://127.0.0.1:8080`

## Fichiers
| Fichier | Rôle |
|---|---|
| `index.html` | Coquille, 8 onglets, styles mobile-first (`pointer:coarse`) |
| `app.js` | Planificateur, routeur post-login, scopes chauffeur, sync ws/tour-save/live, bandeau, impression |
| `auth.js` | Gate obligatoire, login/logout, résolution auto de l'API (relatif puis `hostname:8080`) |
| `driver-server.js` | Vue terrain rapide chauffeur connectée (statuts, navigation, hors-ligne) |
| `storage.js` | Contrat `localStorage` `roadoptimizur.v3` (version, settings, drivers, stops, planning, history), JSON/CSV, utilitaires dates/CP |
| `routing.js` | Géocodage Nominatim→Photon (cache + 1 req/s), OSRM auto, Valhalla truck/bike/pedestrian, matrices, repli haversine |
| `optimize.js` | NN + 2-opt, capacité, fenêtres, compétences, précédence, teamGroup, équilibrage, dépôt dynamique (retour auto si capacité atteinte) |
| `driver.js` | Vue livreur legacy (mode local) |
| `pod.js` | Signature canvas, photos compressées, formulaire POD, scan, impression |
| `analytics.js` | KPIs jour/conducteur, Chart.js, export CSV |
| `sw.js` | Service Worker **réseau-d'abord** (repli cache), précache — bump de version à chaque deploy |
| `manifest.json` | PWA installable (icônes PNG + maskable) |
| `icons/` | Logo vectoriel (anneau+fente+barre), favicon, 192/512/maskable/apple-touch |

CDN uniquement : Tailwind, FontAwesome 6.4, Leaflet 1.9.4, Chart.js 4.4, html5-qrcode 2.3.8.

## Optimisation
1. Regroupement en unités indivisibles : `teamGroup`, paires `pickup`↔`pairedWith`, arrêts simples.
2. Affectation par insertion au meilleur coût, conducteurs filtrés (compétences, capacité kg/m³/palettes).
3. Ordonnancement par conducteur, départ flexible, ETA = trajet + service + attente fenêtre.
4. **2-opt** sur les unités (précédence et équipes intactes).
5. Équilibrage optionnel (arrêts ou minutes).
6. Ré-optimisation ciblée, glisser-déposer, monter/descendre.
7. **Dépôt dynamique** : arrêt « Recharge/vidage au dépôt » inséré si la capacité kg est dépassée.

Matrice routière OSRM/Valhalla si disponibles, sinon estimation haversine × facteur route ; fenêtres pénalisées, capacités/compétences bloquantes.

## POD & scan
Signature tactile (canvas), photos compressées (max 6), formulaire POD configurable (check/texte/nombre/photo/signature), notes, horodatage, GPS. Scan : caméra HTTPS (`html5-qrcode` ou `BarcodeDetector`) ou saisie manuelle ; **lecture Code 128 → extraction du code postal** (`0064 260X…` → 64260) → géocodage → création de commande pré-remplie (nom Colis, n° de suivi en notes, codes vérifiés à la livraison). Feuille POD imprimable.

## Impression
Feuille de route A4 par conducteur (arrêts, créneaux, téléphone, notes, cases « fait »), puis POD des arrêts terminés. Bouton Imprimer dans l'en-tête et Tournées.

## Limites assumées
- Suivi client `?track=` = instantané actualisable (pas de push WebSocket) ; liens `?track=`/`?feedback=` publics
- Pas de découpage automatique d'une tournée sur plusieurs jours (« dormir sur place » conserve le conducteur)
- Édition simultanée sur deux appareils du même jour : last-write-wins (choix assumé : un téléphone par chauffeur)
- SSO LDAP (#23), notifications SMS/e-mail automatiques (#25) : non implémentés

## Historique des versions
v3 statique complet (scan, dépôt dynamique, PWA, mobile) · v4 comptes + backend API Docker · v4.1 gate obligatoire (admin→back-office, chauffeur→commandes) · v4.2 dépôt/geocodage carte · renommage **RoadOptimiser** + logo vectoriel · v5 planificateur chauffeur scopé + Suivi temps réel · v5.1 ordre des onglets, backup scope fiable, GPS manuel + Photon · v5.2 centralisation comptes chauffeur multi-appareils (semaine, saut auto, re-pull 60 s) · v5.3 espace de travail admin centralisé (`/api/ws`) · v5.4 autodéfense par score de richesse · v5.5 bandeau + badge de sync · v5.6 chauffeur autonome (upsert, sync à chaque édition).

L'URL technique `/roadoptimizur/` et les clés `roadoptimizur.*` sont conservées volontairement (préserve PWA installées et données locales) ; le nom visible est RoadOptimiser.

## Tests
Suites jsdom (55 assertions : gate, scopes, multi-appareils chauffeur et admin, workspace richesse, autonome, dépôt) rejouées sur serveur isolé avant chaque déploiement. Harnais hors dépôt (machine de dev, `/tmp/roopt-test/gate/`).
