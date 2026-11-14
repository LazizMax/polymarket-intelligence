# Polymarket Intelligence v1.9 — version permanente

Cette application est installée une seule fois via `INSTALLER_UNE_FOIS.bat`.
Lancer ensuite le raccourci du Bureau ou `%LOCALAPPDATA%\PolymarketIntelligence\POLYMARKET.bat`.

## Données conservées

- Base historique : `%LOCALAPPDATA%\PolymarketIntelligence\historique.sqlite`
- Collectes : `%LOCALAPPDATA%\PolymarketIntelligence\runs`
- Surveillances : `%LOCALAPPDATA%\PolymarketIntelligence\live_sessions`
- Paramètres et mises à jour : `%LOCALAPPDATA%\PolymarketIntelligence`
- Bibliothèques Python réutilisées : `%LOCALAPPDATA%\PolymarketIntelligence\.venv`

Depuis le tableau de bord, ouvrir **Mises à jour** pour recevoir un correctif ou renseigner une source HTTPS de mises à jour automatiques. L'URL de publication n'est pas configurée à la livraison.

Les anciennes collectes sauvegardées dans un dossier `runs` de V1.8.x peuvent être importées une fois depuis le dashboard. Le programme reste en lecture seule et ne déclenche aucun ordre de trading réel.
