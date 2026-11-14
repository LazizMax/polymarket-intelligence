# Polymarket Intelligence — pilote Supabase (14 novembre 2026)

## État réellement vérifié

Un schéma privé `pi` a été créé **dans le projet Supabase Fit Tracker existant** (`bxfvgywfiifnsbjgudzj`), après accord de l'utilisateur. Aucun projet facturable supplémentaire n'a été créé.

| Mesure | Valeur vérifiée |
| --- | ---: |
| Wallets uniques | 100 |
| Observations de PnL quotidiennes | 46 673 |
| Wallets avec au moins 90 jours | 91 |
| Fenêtre observée globale | 2022-01-20 → 2026-11-14 |
| Wallets avec au moins un jour de gain représentant >50% de tous les gains journaliers positifs | 26 |
| Wallets répondant à un filtre provisoire de régularité | 30 |
| Volume PostgreSQL des tables et index `pi` | ~16–17 Mo |
| Taille totale de la base Fit Tracker après import | ~28 Mo |
| Wallets avec ROI du capital audité | 0 |

**Attention :** la taille mesurée concerne des séries de PnL et des métadonnées de 100 wallets. Les transactions complètes, les positions et les archives JSON n'ont pas encore été importées ; extrapoler 17 Mo à 10 000 wallets serait trompeur sans mesurer leur volume de trades.

## Collecte

- 100 wallets distincts ont été sélectionnés à partir de quatre classements publics Polymarket Data API v2 : `all/PNL`, `all/VOLUME`, `month/PNL`, `week/PNL` (50 lignes par board, puis déduplication et plafond 100).
- Les points proviennent de `GET /v2/user-pnl?user=...&interval=all&fidelity=1d`.
- Déduplication par `(wallet, day, source)` ; dernier point de la journée conservé.
- Tous les appels du premier import ont renvoyé HTTP 200.
- Ces classements sont **sujets au biais de survivance** : aucun avantage de trading n'est prouvé.
- L'extension HTTP privée `pi.http_get` a été utilisée pour cet import ponctuel directement depuis PostgreSQL, puis **supprimée** après l'import pour réduire la surface d'accès. Les 100 wallets et 46 673 points ont été recontrôlés après suppression.
- Depuis le 14/11/2026, la fonction `pi-ingest` dispose d'une route dédiée aux tâches planifiées, protégée par un secret chiffré dans Vault et un hash privé. Une tâche Supabase Cron **active** rafraîchit cinq wallets toutes les quinze minutes, par lots incrémentaux (7 jours récents). Première exécution automatique de cinq wallets réussie à 23 h 30 UTC. Les tâches sont consignées dans `pi.ingestion_jobs`.

## Données calculées

- Variation du PnL observé sur la fenêtre réellement téléchargée (USDC).
- Max drawdown **observé du PnL cumulé**, exprimé en USDC — ce n'est pas le drawdown du capital.
- `PnL variation / max DD en USDC` (facteur de récupération, pas ROI/DD).
- Pente du PnL quotidien, R² de tendance, journées où le PnL change, part positive des journées actives et concentration de la meilleure journée de gain.
- Tous ces calculs sont **descriptifs**, jamais une certification de profit ou de copiabilité.
- ROI sur capital, drawdown en % de capital et rendement/drawdown sur capital restent NULL faute de flux complets, valorisations et rapprochement.

Les séries quotidiennes ne comportaient pas de jours manquants à l'intérieur de leurs propres bornes, ce qui ne prouve **pas** l'exhaustivité de l'historique du wallet.

## Première interface de consultation accessible en ligne

Notebook Supabase (accessible aux personnes autorisées sur le projet, non public) :

https://supabase.com/dashboard/project/bxfvgywfiifnsbjgudzj/explorer/notebook/56951856-44d6-402f-8285-61fde0a24502

Cinq sections : notes, métriques de stockage/couverture, 30 candidats selon un filtre provisoire, courbe de PnL et drawdown du même candidat. Les quatre cellules SQL ont été exécutées avec succès et les deux graphiques retournent 1 035 points.

**Ce notebook n'est pas encore le futur dashboard web responsive.**

## Sécurité et non-interférence avec Fit Tracker

- 12 tables du schéma privé `pi`, toutes avec RLS.
- Aucun privilège `USAGE` sur `pi` pour `anon` et `authenticated`.
- `service_role` réservé aux travaux backend, aucune clé privée dans le navigateur ou le dépôt.
- Une ligne préexistante dans `public.user_data` était toujours présente après l'import.
- La taille globale est passée d'environ 11 Mo initialement à 28 Mo ; surveiller les ressources et ne pas exécuter une grosse collecte simultanée à la charge Fit Tracker.

## Prochain jalon technique

1. Authentifier l'accès à un dashboard web spécifique sans exposer l'autre application.
2. Surveiller le déclenchement programmé et les erreurs API dans `pi.ingestion_jobs`. La route de collecte est active, mais ne couvre pas encore trades, positions et cash-flows.
3. Migrer réellement les transactions, activités, positions et métadonnées de marchés vers `pi`; mesurer la taille avant extension massive.
4. Reconstituer un ledger par wallet avec frais, cash-flows et valorisation de toutes les positions avant de publier le ROI du capital et le max DD %.
5. Valider les cohortes prospectivement à prix de copie observables avant tout classement destiné au trading réel.

Cette implantation est un pilote. Les tests CI vérifient le schéma et le moteur d'analyse, mais **n'établissent pas de rentabilité de copy trading**.


## Dashboard web privé opérationnel

Ouvrir https://lazizmax.github.io/polymarket-intelligence/. Connexion avec le compte Supabase Auth existant, autorisé via `pi.dashboard_access`. Trois vues : Classements filtrés, fiches wallets avec PnL et DD USD, Collecte & qualité. La page de connexion répond HTTP 200 et l'API non authentifiée renvoie HTTP 401. La première connexion utilisateur réelle reste à vérifier depuis un navigateur.
