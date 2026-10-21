# RoadOptimizur v3

Planificateur de tournées **100 % statique**, mobile-first, sans build step et sans serveur applicatif. Trois espaces dans la même page :

- **Planificateur** (`/`) : commandes, conducteurs/véhicules, optimisation multi-tournées, planning hebdomadaire, analytique, impression, réglages.
- **Vue livreur** (`/?mode=conducteur&d=<id>`) : tournée du jour, statuts, navigation, POD (signature/photos/formulaire/scan), GPS et fil d’Ariane, hors-ligne.
- **Suivi client** (`/?track=<stopId>`) et **avis** (`/?feedback=<stopId>`) : ETA, statut, carte, notation 1–5 ★.

## Démarrage

Aucune installation, aucune compilation :

```bash
cd roadoptimizur-v3
python3 -m http.server 8080
# http://localhost:8080
```

Un simple hébergement statique suffit (Synology Web Station : `/volume1/web/roadoptimizur/`). Le Service Worker exige HTTPS ou `localhost`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Coquille, vues, styles mobile-first, CDN, `script type="module"` |
| `app.js` | Amorçage, routeur de vues, planificateur, carte, impression |
| `storage.js` | Contrat `localStorage` `roadoptimizur.v3`, CRUD, JSON/CSV, utilitaires dates |
| `routing.js` | Nominatim (cache + 1 req/s), OSRM auto, Valhalla truck/bike/pedestrian, matrices, repli haversine |
| `optimize.js` | Nearest-neighbor + 2-opt, fenêtres, capacité, compétences, précédence, teamGroup, équilibrage, dépôt dynamique (retour dépôt auto si capacité atteinte) |
| `driver.js` | Vue livreur mobile, statuts, GPS/fil d’Ariane, liens Maps/Waze, partage |
| `pod.js` | Signature canvas, photos compressées, formulaire POD, scan, impression POD |
| `analytics.js` | KPIs jour/conducteur, Chart.js, export CSV |
| `sw.js` | Cache applicatif et CDN, navigation hors-ligne |
| `manifest.webmanifest` | PWA installable, icônes SVG data-URL |

CDN uniquement : Tailwind, FontAwesome 6.4, Leaflet 1.9.4, Chart.js 4.4, html5-qrcode 2.3.8. Aucun bundler, aucune dépendance npm.

## Modèle de données

Clé unique : `roadoptimizur.v3`. Contrat respecté à la lettre (`version`, `settings`, `drivers`, `stops`, `planning`, `history`). Les champs POD, feedback et breadcrumb sont portés par chaque arrêt. Le cache de géocodage utilise `roadoptimizur.v3.geoCache`.

Sauvegarde à chaque action. Export/import JSON complet depuis l’en-tête ou Réglages. Import CSV de commandes (colonnes françaises ou anglaises, séparateur `,` ou `;`, géocodage Nominatim avec barre de progression).

## Optimisation

1. Regroupement des arrêts en unités indivisibles : `teamGroup`, paires `type=pickup` ↔ `pairedWith` (collecte avant livraison), arrêts simples.
2. Affectation par insertion au meilleur coût, conducteurs filtrés par compétences et capacité (kg / m³ / palettes).
3. Ordonnancement par conducteur, départ flexible calculé pour minimiser attente et retard, ETA = trajet + service + attente de fenêtre.
4. Amélioration **2-opt** sur les unités (la précédence et les équipes restent intactes).
5. Équilibrage optionnel : nombre d’arrêts ou minutes conducteur.
6. Ré-optimisation ciblée : réinsertion d’un arrêt au meilleur emplacement ; glisser-déposer + boutons monter/descendre.
7. **Dépôt dynamique** (option Réglages) : si une collecte doit faire dépasser la capacité kg du véhicule, un arrêt « Recharge / vidage au dépôt » est inséré automatiquement (durée paramétrable) et les ETA sont recalculés.

La matrice de distances utilise OSRM/Valhalla quand disponible, sinon haversine × facteur route et vitesse moyenne configurée. Les fenêtres sont fortement pénalisées et les dépassements de service signalés ; les capacités et compétences sont bloquantes.

## Routage

- `auto` → OSRM `router.project-osrm.org` (route + table).
- `truck`, `bike`, `pedestrian` → `https://valhalla1.openstreetmap.de` (`/route`, `/sources_to_targets`), avec hauteur/poids/longueur/essieux/matières dangereuses pour le camion.
- Échec réseau/API → repli haversine, tracé en pointillés, aucune erreur bloquante.
- Géocodage Nominatim limité à 1 requête/seconde, résultats mis en cache localement.

## POD & scan

Signature tactile (canvas haute densité), photos caméra/galerie compressées (max 6), formulaire configurable (check / texte / nombre / photo / signature), notes, horodatage et GPS. Scan via `html5-qrcode` si chargé, sinon `BarcodeDetector`, sinon saisie manuelle ; comparaison aux codes attendus (`expectedCodes` / `barcodes`). Feuille POD imprimable avec signature.

## Hors-ligne & PWA

`sw.js` précache la coquille et les modules, sert la navigation en réseau-d’abord avec repli cache, et met en cache les CDN. Les données restent dans `localStorage`, donc disponibles hors-ligne. Les tuiles Leaflet et les appels de routage nécessitent le réseau.

## Impression

Feuille de route A4 par conducteur (arrêts, créneaux, téléphone, notes, cases « fait »), puis preuves de livraison des arrêts terminés. Bouton Imprimer dans l’en-tête et dans Tournées.

## Limites assumées / PHASE 2 (TODO dans le code)

- **#23 SSO / Active Directory** : backend LDAP requis.
- **#24 API REST/JSON** : service Docker sur le NAS.
- **#25 SMS/e-mail automatiques** : passerelle SMS/SMTP.
- **#26 tracking client multi-appareils live** : WebSocket serveur.
- Le suivi client est un instantané actualisable (pas de push temps réel).
- Le multi-jours « dormir sur place » conserve le conducteur lors d’un déplacement au jour suivant ; il ne crée pas de découpage automatique de tournée sur plusieurs jours.
- Les optimisations utilisent une matrice routière si les API répondent, sinon une estimation locale ; les ETA sont recalculés à la demande.

## Déploiement Synology

1. Copier le dossier dans `/volume1/web/roadoptimizur/`.
2. Web Station → site statique, racine du dossier, HTTPS recommandé.
3. Vérifier `manifest.webmanifest` et `sw.js` en HTTP 200.
4. Ouvrir sur mobile → « Ajouter à l’écran d’accueil ».

Dépôt cible : `github.com/Oxyde97/RoadOptimizur` (commit/push à effectuer côté poste de travail).
