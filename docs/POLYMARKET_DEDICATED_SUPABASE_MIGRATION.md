# Plan de migration vers un projet Supabase dédié — Polymarket Intelligence

Statut : **migration et basculement terminés et vérifiés le 15 novembre 2026**. Source conservée pour rollback, tous les collecteurs Polymarket actifs uniquement sur le projet dédié. La connexion utilisateur reste volontairement assurée par l'Auth de l'ancien projet pendant la transition.

## Inventaire source vérifié

- Organisation unique : `LazizMax` (plan Pro), identifiant `hbhqzvbvwowtthjfitow`.
- Projet actuel : `Fit Tracker`, `bxfvgywfiifnsbjgudzj`, région `us-east-1`. Le schéma de Polymarket `pi` est partagé avec l'application de fitness.
- Projet distinct `LGS Poker` : `kcxzjtmwgbhkbbvbcbaf`; **ne pas l'utiliser** pour l'isolation de Polymarket.
- Supabase a annoncé un coût additionnel de **10 USD/mois** pour un nouveau projet dans cette organisation lors du contrôle du 15/11/2026. La création doit attendre un accord explicite sur le coût.
- Source : 40 tables `pi` ; les données SQL volumineuses comprennent `pi.closed_position_roi`, `pi.rn1_full_market_metrics`, `pi.rn1_full_activity_metrics` et `pi.wallet_pnl_daily`.
- Storage source : bucket privé `pi-rn1-research-private`, **1 851 objets**, total métadonnées ~**177 746 262 octets** au contrôle. Ce total évolue avec la collecte.
- RN1 `trades_all` et `activity_all` : **834 000 lignes historiques valides chacun**, dont 760 000 matérialisées en SQL par flux. Les deux flux continuent à archiver des pages plus anciennes.
- Checkpoints de traitement à migrer *intacts* :
  - Chronologie `rn1_full_chronology_v1` : `paused_quota`, 211 000 fills, source checkpoint `replay-v1/checkpoints/page-00000546-81fe08c3b7269897.json.gz`.
  - Prix indépendants `rn1_independent_price_v1` : `paused_quota`, 107 000 fills sources, checkpoint `independent-prices-v1/state/page-00000650-c5ec2505ad70efac.json.gz`.
- La sonde de carnets peut rester sur l'ancien projet durant la migration **uniquement tant que la base n'est pas saturée**. Le basculement final exige un seul propriétaire par cron.

## Règle de sécurité avant toute écriture dans la destination

1. Créer un **nouveau projet Supabase** dans l'organisation explicitement confirmée, idéalement `us-east-1` pour cohérence régionale et migration du stockage. Conserver l'ancien projet en production jusqu'à validation.
2. Exporter les schémas et contraintes de toutes les tables `pi`, index, politiques RLS, grants, relations, extensions utiles, cron, secrets Vault et configurations de fonctions Edge. **Ne jamais exporter les valeurs secrètes en clair dans GitHub ou les réponses.**
3. Créer et vérifier le bucket privé `pi-rn1-research-private` sur la destination, avec politiques privées et aucune permission anonyme.
4. Copier chaque objet de Storage par **téléchargement privé + upload privé** (listes paginées), en comparant nombre d'objets, taille et empreinte SHA-256 des bytes gzip et en consignant les échecs reprenables. Ne pas supprimer les objets source. Les objets checkpoints sont nécessaires à la reprise sans recommencer.
5. Migrer toutes les tables `pi` requises par le dashboard, le calcul automatique du ROI des wallets, les archives RN1, les quote probes et les deux replayers. Pour les données volumineuses, batcher avec curseur stable et checksum ; **ne jamais tronquer ou supprimer** les tables source.
6. Vérifier pour chaque table compte total, plage de dates, clés uniques et échantillons SHA, les jonctions de positions et les compteurs sources. Vérifier explicitement les curseurs de collecte et `next_page` des replayers.
7. Déployer toutes les fonctions Edge `pi-*` et injecter les secrets **via le gestionnaire sécurisé de la destination**, pas dans le frontend ou un commit. Provisionner des secrets propres au nouveau projet ; les empreintes du token scheduler doivent correspondre.
8. Installer les cron côté destination **désactivés**, effectuer des essais en lecture seule, comparer les résultats des endpoints `pi-dashboard` et des pages archivées, puis reprendre un batch contrôlé des deux replayers avec le checkpoint migré.
9. Couper les cron et écritures de Polymarket sur l'ancien projet au moment du cutover (sans toucher Fit Tracker), capturer et copier un **delta final** SQL + Storage, valider, puis activer les cron sur la destination. Ne jamais exécuter deux collecteurs simultanés pour un même flux.
10. Basculer les URLs publiques des appels Edge vers le nouveau projet, sans exposer de clé service role, vérifier les tableaux de bord, ROI wallet et collecte RN1. Maintenir la source en lecture seule pour rollback jusqu'à réception du contrôle de qualité complet.

## Contrôles post-migration

- 40 tables `pi` recensées (le nombre peut évoluer; prendre l'inventaire final avant cutover) avec RLS/grants conformes.
- Tous les buckets privés et objets complets, y compris le replay checkpoint présent dans `pi.rn1_replay_jobs.snapshot_key` et dans `pi.rn1_independent_price_jobs.checkpoint_key`.
- Pages `rn1_full_archive_pages` : même source_SHA256, `page_no`, `storage_key`, `role_status` ; pas de trou ni de doublon.
- ROI par wallet : mêmes totaux et statut de rafraîchissement, avec de nouveaux trades correctement incrémentés sans double comptage.
- Les curseurs historiques restent gelés sur les 756 pages déjà définies ; en particulier, **ne pas réinitialiser les jobs RN1**, ni les écraser en appliquant les migrations initiales.
- Headroom SQL conservatrice après migration ; maintenance de la base indépendante de Fit Tracker.
- Vérifier dashboard Cloud, accès en lecture, propagation GitHub Pages et métriques de suivi avant de supprimer une dépendance à l'ancien projet.

## État réel du chantier

Le compte a été vérifié ; l'utilisateur a ensuite **confirmé explicitement le coût de 10 USD/mois et l'organisation LazizMax**. Le projet destination `qamdvfakwclkuswrdckp` a été créé. Le basculement attend les contrôles de copie et de réconciliation.

Une fois ces autorisations obtenues, créer la destination, provisionner les secrets sans les exposer, copier le Storage et les tables, puis effectuer un basculement vérifié. Si les outils disponibles ne permettent pas de transférer intégralement les objets privés ou les secrets, arrêter avant le cutover et signaler précisément le blocage plutôt que d'affirmer la migration terminée.

---

## Exécution effective — 15 novembre 2026 (projet dédié créé)

**Autorisation utilisateur :** l'utilisateur a accepté explicitement le coût supplémentaire indiqué par Supabase de **10 USD par mois**, hors usage additionnel. Le projet a été créé et apparaît `ACTIVE_HEALTHY`.

| Environnement | Supabase project ref | Traitement |
|---|---|---|
| Ancien projet partagé Fit Tracker | `bxfvgywfiifnsbjgudzj` | Source intacte, collecte existante maintenue jusqu'au cutover |
| Nouveau Polymarket Intelligence | `qamdvfakwclkuswrdckp` | Destination dédiée, région `us-east-1` |
| LGS Poker | `kcxzjtmwgbhkbbvbcbaf` | Aucune modification |

### État matériel de la migration

1. **Schéma SQL destination créé :** 40 tables `pi` historiques / 509 colonnes, 167 contraintes (PK/UNIQUE/CHECK/FK), 38 index supplémentaires. Les grants anonymes sur les tables de recherche privées sont révoqués et RLS activé. Tables opérationnelles de migration supplémentaires : `pi.migration_auth`, `pi.migration_objects`, `pi.migration_batches`, `pi.external_dashboard_access`.
2. **Bucket privé** `pi-rn1-research-private` créé sur la destination, `public=false`, plafond d'objet 20 MB.
3. **Canal de copie chiffré HTTPS, authentifié :**
   - `pi-migration-receiver` (destination) exige un token de migration aléatoire, dont seul le SHA-256 est dans `pi.migration_auth` ; le secret est conservé dans le Vault source. Vérifie l'empreinte SHA-256 de chaque objet avant upload et journalise les transferts.
   - `pi-migration-export` (source) transfère les objets du Storage privé par curseur lexicographique; `pi.migration_export_state` permet reprise sans supprimer les sources.
   - `pi-migration-sql-export` (source) copie les tables par tranches ordonnées sur leurs vraies clés primaires, valide les réponses, et utilise les upserts transactionnels du récepteur. `pi.migration_table_export_state` retient les curseurs et `pi.migration_batches` dédoublonne sur la destination.
   - Jobs existants : `pi-private-storage-migration-1min` (maximum 25 objets par exécution), `pi-sql-migration-1min` (12 lots de 120 lignes au maximum par exécution). Retries réseau limités à cinq tentatives puis arrêt sur erreur persistante.
4. **Checkpoints indispensables sauvegardés en priorité et validés SHA-256** :
   - `replay-v1/checkpoints/page-00000546-81fe08c3b7269897.json.gz` : 1 184 820 octets.
   - `independent-prices-v1/state/page-00000650-c5ec2505ad70efac.json.gz` : 538 018 octets.
   Les deux pointeurs des tables de jobs de relecture sont copiés à l'identique ; le moteur ne doit **pas** redémarrer depuis la première transaction après le cutover.
5. **Contrôle des tables déjà figées :** mêmes nombres de lignes ET même empreinte de contenu sur `rn1_replay_jobs`, `rn1_independent_price_jobs`, `rn1_replay_pages` (211 lignes), `rn1_independent_price_pages` (107 lignes). Les 100 wallets existent de chaque côté, mais leurs valeurs ne sont pas encore identiques du fait de l'activité de la source ; mise à jour finale obligatoire.
6. **Authentification séparée :** un token de cron neuf a été généré directement côté destination dans Vault + empreinte dans `pi.scheduler_auth`; le token privé n'a pas été ajouté à GitHub. L'unique droit d'accès au dashboard ancien a été copié vers `pi.external_dashboard_access` (RLS ON), sans copier les credentials ni les mots de passe d'Auth de Fit Tracker.
7. **Backend destination préparé, sans collecte active :** Edge Functions `pi-ingest` (avec dépendances), `pi-rn1-quote-probe`, `pi-rn1-replay`, `pi-rn1-independent-price`, `pi-rn1-history-audit` déployées. `pi-dashboard-dedicated-preview` est déployée et valide les sessions auprès de l'ancien serveur Auth, mais lit les données destination. La prévisualisation et les cinq endpoints refusent les requêtes sans autorisation ; test direct 401/403 confirmé. Aucun cron historique RN1 n'a été activé sur la destination.
8. **Site GitHub Pages de production inchangé** jusqu'à la réconciliation finale, et aucun cutover n'a encore eu lieu.

**Dernier contrôle documenté au cours de cette exécution :** stockage privé >600 objets / ~68 MB vers la destination ; les deux pipelines actifs et sans erreur ; plus de 23 000 lignes SQL transférées. Ces valeurs évoluent à chaque exécution des cron et **ne signifient pas une migration complète**.

### Vérification obligatoire avant mise en production

- Les 38 tables de données attendues sont toutes `done` au premier passage, sans erreur ; le schéma conserve aussi `dashboard_access` et `scheduler_auth` mais leurs données source ne sont **pas** recopiées car Auth/scheduler sont reconfigurés.
- Object store destination : comparer le nombre total d'objets, la taille, chaque nom et l'empreinte SHA256 avec la source, après **dernier delta**. Le parcours lexicographique initial peut manquer les nouveaux objets insérés dans un préfixe déjà traversé; un **deuxième parcours de synchronisation** est nécessaire après arrêt contrôlé des écritures source.
- Table SQL : source et destination contiennent la même population par PK et même contenu après delta, en particulier `closed_position_roi`, `wallet_metrics_daily`, `wallet_pnl_daily`, `rn1_full_archive_pages` et les états de collecte. Attention à ne pas supposer qu'une table `done` au premier passage est identique tant que la source est active.
- Avant tout basculement, suspendre **uniquement** les crons `pi-*` de Polymarket sur Fit Tracker et préserver tous ses crons propres. Réconcilier le dernier delta et valider la nouvelle URL authentifiée du dashboard avec la session actuelle. **Ne pas utiliser le secret de migration pour accéder à l'API analytique.**
- Ajouter ensuite les crons Polymarket sur le nouveau projet avec son propre token Vault, reprendre les replayers depuis les checkpoints recopiés, confirmer deux cycles de collecte sans doublons, puis publier la nouvelle URL dans le frontend GitHub Pages (CSP et endpoints Auth/API).
- Garder l'ancien projet dans un état permettant le rollback ; n'effacer aucune table ni aucun bucket source avant validation explicite de toute la chaîne.
- Après cutover, révoquer le secret de migration, retirer le droit du récepteur et arrêter les deux crons de transfert, qui n'ont plus lieu d'exister.

**Ce document est un inventaire d'une migration en cours, pas une attestation de migration terminée.**

### Sécurisation supplémentaire après reprise

- Transfert SQL accéléré à **500 lignes maximum par lot**, 12 lots par appel toutes les 30 secondes ; stockage 25 objets maximum toutes les 30 secondes. Signature SHA-256, limites d'octets, verrou de progression et seuil de cinq erreurs conservés. Une exécution sur 500 lignes a été vérifiée réellement.
- La clé d'idempotence des **lots SQL** inclut désormais le contenu de chaque lot, afin qu'un **second passage** puisse corriger les lignes modifiées pendant la première copie, au lieu de rejeter les mises à jour comme un conflit.
- Garde-fou de quota des replayers séparé : **1 Gio** sur le projet dédié, anciens plafonds inchangés sur l'installation partagée. Fonctions RN1 actualisées sur le projet dédié mais **non programmées à s'exécuter**.
- `pg_cron` / `pg_net` installés sur la destination. **10 cron Polymarket** configurés et vérifiés `active=false`, tous pointant vers la nouvelle URL Supabase, sans référence à l'ancien domaine.
- Procédures de cutover enregistrées dans `sql/pi_source_stop_polymarket_jobs.sql`, `sql/pi_final_delta_guarded_cutover.sql`, `sql/pi_dedicated_post_cutover_activation.sql`. Elles ont des garde-fous explicites et **n'ont PAS été exécutées**.
- `pi.migration_cutover_readiness` créé avec `verified=false`, vérifié ; la procédure d'activation refuse de démarrer sans vérification explicite du contenu.
- Les 3 colonnes `IDENTITY` historiques sont inventoriées et leurs séquences seront recalées sur MAX(id) à l'activation, afin d'éviter des collisions.

## Résultat final — basculement PROD confirmé le 15 novembre 2026

- Organisation LazizMax / projet dédié **`qamdvfakwclkuswrdckp`** : projet actif, coût supplémentaire validé **10 USD/mois** (hors consommations éventuelles). Ancien projet Fit Tracker **`bxfvgywfiifnsbjgudzj`** préservé ; aucun effacement de données source.
- **Synchronisation complète à source figée :** 38/38 tables métier `pi` ont les mêmes comptes et la même empreinte de contenu déterministe dans les deux projets avant réactivation (contrôle `pi.migration_fingerprint_tables`, classement par clé primaire). Le transfert de 5 tables initialement altérées par l'arrondi implicite des nombres JSON en JavaScript a été corrigé en préservant la représentation JSON brute entre PostgreSQL et PostgreSQL. Toutes les 5 ont finalement été recopiées et revérifiées. Cette correction était essentielle pour les chiffres financiers.
- **Storage :** 2 054 / 2 054 objets privés synchronisés, mêmes noms et tailles, aucun objet supplémentaire/manquant. Le protocole a calculé et contrôlé SHA-256 pendant le transfert. De plus, les **deux checkpoints RN1 ont été physiquement relus sur le stockage cible** puis re-hachés SHA-256, tous deux `verified=true` (1 184 820 octets et 538 018 octets).
- **Contrôles d'accès :** les 45 tables `pi` présentes au cutover sont protégées par RLS, sans droit `SELECT` pour `anon`. Bucket de recherche `public=false`. Une autorisation de dashboard pour le même utilisateur a été conservée dans `pi.external_dashboard_access`, sans reprendre les mots de passe Fit Tracker. Le dashboard cible utilise temporairement le service Auth historique (configuration HTTP 200) et refuse un appel sans session (401).
- **Exécution des jobs :** les 12 crons `pi-*` de la source, y compris les deux jobs temporaires de migration, sont tous `active=false`. Les 10 crons métiers ont été activés sur la destination après passage du garde-fou `pi.migration_cutover_readiness.verified=true`. Aucune tâche de collecte ne tourne en double.
- **Reprise réellement prouvée :** la relecture chronologique RN1 est passée de 211 000 à **231 000 fills**, 205 373 Maker, 25 627 Taker, 0 inconnu, sans erreur ; l'analyse des prix indépendants de 107 000 à **122 000 fills sources**, 0 inconnu. Les flux historiques `activity_all` et `trades_all` ont dépassé **932 000 lignes valides chacun**, avec relance de la matérialisation SQL (766 000 lignes). La sonde de carnet est passée de 200 à 205 sessions. Les tâches de ROI et de collecte présentent plusieurs exécutions cron `succeeded`, zéro `failed` au dernier contrôle.
- **Capacités spécifiques à la destination :** garde-fou des replayers à 1 Gio de SQL, limites `rn1_full_streams.max_db_bytes` et `rn1_quote_probe_state.max_db_bytes` alignées avec la base dédiée. La contrainte SQL du quota quote-probe a été corrigée **uniquement sur la destination**.
- **Cloud web :** `web/index.html` appelle désormais `https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-dashboard`. Le navigateur peut joindre le nouveau backend et l'ancien Auth via un CSP explicite à deux origines. GitHub Pages workflow `Deploy Polymarket Cloud frontend` run **43754388898** (`success`) et une requête HTTP GET externe de la page publique renvoie 200 avec **nouvelle URL d'API et CSP vérifiés**. URL du site : https://lazizmax.github.io/polymarket-intelligence/.
- **Couverture de la vérification utilisateur :** les endpoints backend ont été testés en configuration publique et en refus de session absente ; une authentification réelle dans le navigateur de l'utilisateur n'a pas été rejouée sans ses identifiants, qui n'ont pas été demandés ni accessibles. Tester manuellement la connexion existante après actualisation si nécessaire.
- Les secrets et Edge Functions de pont de migration doivent être **révoqués/désactivés après la mise en production**, sans supprimer les journaux et sauvegardes conservés pour rollback.

Le présent document inclut volontairement les états intermédiaires précédents pour la traçabilité. Les sections antérieures disant « pas encore créée » / « pas encore basculé » décrivent uniquement les étapes historiques ; **la présente section finale fait foi**.

### Vérification post-basculement et fermeture des ponts (15 novembre 2026)

Après la publication du frontend : **12/12** tâches cron héritées de l'ancien projet désactivées, **10/10** tâches métier du nouveau projet actives. Les dernières sondes ont confirmé **247 000 fills chronologiques** (219 860 Maker, 27 140 Taker, zéro inconnu), **134 000 transactions sources** parcourues pour les prix indépendants (5 585 achats Maker échantillonnés, zéro inconnu), **936 000 lignes d'archives par flux** et **209 sessions de cotation**, tous traitements concernés sans erreur. Les 100 wallets et leurs ~190 700 positions ROI sont disponibles sur la destination.

La page Github Pages sert effectivement la nouvelle API dédiée (HTTP 200) et les deux domaines nécessaires pour l'authentification historique. La connexion réelle de l'utilisateur doit être confirmée dans son navigateur ; aucun mot de passe n'a été utilisé. Le workflow GitHub Pages de migration est **terminé avec succès**.

Le jeton de migration n'est plus accepté par la destination (empreinte d'autorisation remplacée). Les trois fonctions Edge temporaires `pi-migration-export`, `pi-migration-sql-export` et `pi-migration-receiver` sont fermées et renvoient **HTTP 410**, vérifié pour chacune. Leur code reste versionné dans GitHub pour pouvoir organiser une éventuelle récupération, et aucune table ni archive source n'a été supprimée.

La source SQL/Storage dans Fit Tracker constitue une copie de rollback **figée au moment du cutover** ; elle ne doit plus être présentée comme une base alimentée en direct. Seul le projet dédié poursuit désormais la recherche RN1 et les actualisations de ROI.
