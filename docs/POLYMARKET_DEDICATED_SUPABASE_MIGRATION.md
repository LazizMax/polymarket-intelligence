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
