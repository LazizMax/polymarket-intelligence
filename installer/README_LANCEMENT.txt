POLYMARKET INTELLIGENCE — INSTALLATION UNIQUE (v1.9)

1. Fermer toutes les anciennes fenêtres Polymarket Intelligence.
2. Décompresser ce ZIP dans un dossier temporaire.
3. Double-cliquer une seule fois sur INSTALLER_UNE_FOIS.bat.
4. L'installation crée le dossier permanent :
   %LOCALAPPDATA%\PolymarketIntelligence
   et un raccourci « Polymarket Intelligence » sur le Bureau, si Windows l'autorise.
5. Ensuite : toujours utiliser le raccourci du Bureau (ou POLYMARKET.bat
   du dossier permanent) — NE PLUS utiliser le dossier téléchargé.

Le premier lancement peut installer Python Streamlit, pandas, plotly, requests
(une fois uniquement). Python 3.10+ doit déjà être installé.

CONSERVATION DES DONNEES :
- Base historique existante : %LOCALAPPDATA%\PolymarketIntelligence\historique.sqlite
- Collectes : %LOCALAPPDATA%\PolymarketIntelligence\runs
- Surveillances : %LOCALAPPDATA%\PolymarketIntelligence\live_sessions
- Environnement Python : %LOCALAPPDATA%\PolymarketIntelligence\.venv
- Le code évolue dans %LOCALAPPDATA%\PolymarketIntelligence\app

Les anciennes collectes (runs/live_sessions) qui étaient dans les répertoires
V1.8.x restent dans ces dossiers. Pour les importer une fois, utilise
les fonctions d'import de l'interface comme précédemment.

MISES A JOUR :
- Dans l'application : onglet « Mises à jour ».
- Pour obtenir un vrai bouton de mise à jour automatique, configurer une URL
  HTTPS d'un manifeste (par exemple dans un dépôt public GitHub Releases).
  Nous n'avons PAS encore publié cette URL : le mécanisme est prêt,
  la distribution automatique n'est pas encore activée.
- Alternative : déposer un ZIP correctif dans l'onglet Mises à jour et relancer.
  Le ZIP ne doit contenir que le dossier app/ et son code, pas les données.
- Ne jamais installer une mise à jour téléchargée depuis une source inconnue.

Si une mise à jour échoue, le dossier app_backup permet de revenir au
code précédent. Logs dans %LOCALAPPDATA%\PolymarketIntelligence\logs.

Aucun mot de passe wallet, aucune clé privée, aucune transaction réelle.
