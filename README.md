# RoadOptimizur

Application d'optimisation de tournées de livraison (100% client, hébergée sur Xpenology via Web Station).

- URL locale : http://192.168.1.120/roadoptimizur/
- Fichiers : /volume1/web/roadoptimizur/ sur le NAS Xpenology (VM 102)
- Dépendances : connexion Internet (CDN Tailwind/FontAwesome, Leaflet OSM tuiles, Nominatim geocoding, OSRM routing)

## Déploiement
Copier `index.html` dans `/volume1/web/roadoptimizur/` sur DSM (propriétaire `http:http`, perms 755/644). Web Station (Apache2.4 + nginx DSM) sert le dossier web par défaut sur le port 80.
