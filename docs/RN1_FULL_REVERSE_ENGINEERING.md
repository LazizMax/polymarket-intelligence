# RN1 reverse engineering — capture intégrale accessible, non-échantillonnée

## Objectif

Explorer **tout l'historique PUBLIC accessible** du wallet RN1 `0x2005d16a84ceefa912d4e380cd32e7ff827875ea` et identifier les règles de l'algorithme : direction/valorisation, choix des limites, taille des ordres, temporalité de couverture, risque d'inventaire, récompenses et liquidité.

Il s'agit d'une étude des données publiques, pas de la capacité à voir le code privé ou les ordres refusés/annulés.

## Découverte importante : historique initial incomplet

`GET /v2/trades?user=...` est **taker-only par défaut**. Les études RN1 antérieures portant sur 4 000 lignes ont utilisé ce mode implicite ; elles sont biaisées et doivent être retraitées.

Le nouveau flux `trades_all` demande explicitement
`/v2/trades?user=<wallet>&start=1&limit=1000&taker_only=false`.

Le flux `activity_all` demande
`/v2/activity?user=<wallet>&start=1&limit=1000`.

Chaque requête renvoie un curseur signé, opaque, à utiliser sans modifier les filtres. Ces paramètres demeurent constants pendant une pagination, conformément aux documentations officielles.

## Architecture de conservation

- `storage.buckets['pi-rn1-research-private']` : bucket Supabase **PRIVÉ**, MIME `application/gzip`. Chaque réponse JSON originale (enveloppe `source_response` inchangée) est conservée au format gzip avec les filtres et le curseur de requête.
- `pi.rn1_full_streams` : curseurs, nombre de pages/lignes valides, dates extrêmes et fin de source détectée quand `has_more=false`. **Aucune barre de progression inventée** : l'API n'annonce pas de total absolu.
- `pi.rn1_full_archive_pages` : provenance immuable de chaque page, SHA-256, clé d'objet, tailles, nombre de lignes, curseurs et dates. Écrit en même transaction que les métriques et l'avancement du curseur. Réessayer le même objet compressé après une panne est idempotent.
- `pi.rn1_full_market_metrics` : données agrégées par marché et outcome : achats, ventes, quantités et coûts/proceeds bruts, taille des inventaires observés, marchés ayant deux issues achetées, déséquilibres et frais/non-fills inconnus.
- `pi.rn1_full_activity_metrics` : activités publiques par type et marché, inclut REDEEM, MERGE et autres types effectivement observés. Un USDC rapporté par REDEEM n'est pas un PnL.
- Les anciens `pi.trades`, `pi.wallet_activity`, calculs ROI et relevés de carnets restent intacts ; l'ancien échantillon taker-only est conservé uniquement pour audit, sans l'afficher comme 'toutes transactions RN1'.

**Limite de sécurité** : lorsque la base globale du projet dépasse 320 MiB ou que les archives dépassent 700 MiB au total, les collecteurs s'arrêtent en état `paused_quota`. Il ne faut ni augmenter automatiquement la facture ni saturer la base qui sert aussi Fit Tracker. Le quota disponible dépend du plan Supabase et doit être revérifié avant toute extension. La logique ne promet pas que 5 millions d'enregistrements tiennent dans cette enveloppe.

## Algorithme d'ingestion

1. Sélectionner atomiquement un flux `collecting` non verrouillé pour 90 s.
2. Contrôler les budgets globaux et charger au plus 2 pages de 1 000 lignes par déclenchement.
3. Préserver le JSON complet et le contexte de requête ; le compresser, calculer son SHA et le sauvegarder en Storage privé sous chemin déterministe.
4. Valider la provenance wallet des lignes, agréger les mesures par marché / type.
5. Dans **une transaction SQL**, consigner la page + les statistiques + le curseur. En cas d'échec, ne pas avancer ; le fichier compressé peut être rechargé à la tentative suivante.
6. Arrêter quand `has_more=false`. En cas de quota, signaler l'arrêt de sécurité sans prétendre avoir tout récupéré.
7. Programmer un passage toutes les 2 min pour chaque flux depuis Vault, sans exposer les secrets.

## Analyse reverse engineering (à renforcer une fois la collecte suffisamment étendue)

1. Analyser les profils de taille et prix des BUY/SELL, par marché et issue.
2. Reconstruire les séquences chronologiques exactes à partir des pages brutes, *du plus ancien au plus récent*, en distinguant ventes, merges, redemptions et transferts.
3. Établir la part possible d'exécution maker par rapprochement avec le sous-flux `taker_only=true` ; l'API principale n'étiquette pas chaque transaction maker/taker.
4. Coupler les fills à des prix historiques de carnet contemporains, pas à des moyennes horaires périmées.
5. Tester plusieurs règles candidates (seuil d'edge, inventaire, rééquilibrage) hors échantillon, avec validation par événements sportifs indépendants.
6. Estimer les profits économiques par type (paires, direction, rebates), en admettant les coûts inconnus et les opérations non visibles, **sans inventer de PnL**.

L'application n'affiche qu'un résumé clair des hypothèses et de la couverture d'import ; les preuves brutes restent disponibles dans le stockage privé.

## Vérifications

- `select stream,status,rows_seen,pages_fetched,first_seen_at,last_seen_at,last_error from pi.rn1_full_streams`
- `select count(*),sum(compressed_bytes) from pi.rn1_full_archive_pages`
- `select count(*) from pi.rn1_full_market_metrics`
- `select count(*) from storage.objects where bucket_id='pi-rn1-research-private'`
- RLS du schéma pi, bucket privé ; aucune permission de lecture aux roles publics.
- Toujours distinguer `source_exhausted` d'un arrêt quota/erreur.
