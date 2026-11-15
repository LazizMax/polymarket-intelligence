# Plan de migration vers un projet Supabase dédié — Polymarket Intelligence

Statut : **préparation terminée ; création du projet en attente de validation du coût mensuel**. Aucun déplacement de données, coupure de cron ni nouvelle facturation effectués par ce document.

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

Le compte et le montant ont été inspectés. **Le projet destination n'a pas été créé.** Son coût de 10 USD/mois requiert un accord explicite ; l'utilisateur doit également confirmer l'organisation `LazizMax`. Ne pas assimiler un « go » antérieur à un accord sur un prix encore inconnu.

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
