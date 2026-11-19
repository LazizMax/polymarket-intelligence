# RN1 — Signatures Maker et flux d'exécution observé avant la décision (H11)
**19 novembre 2026 — recherche effectivement exécutée sur Supabase, panel novembre 2026**

## Objectif et impossibilité de jointure naïve
La première étape devait relier le prix signé, la taille, l'inventaire et les événements de match **avant** l'ordre. Audit live :
- **1 361 vrais ordres signés** EIP-712, création déclarée **6–15 novembre 2026**, sur **663 événements**.
- `pi.rn1_quote_probe_runs` : **3 189 captures de carnet/positions**, du 15 novembre **14:03 UTC** au 17 novembre 21:32 UTC : ces captures sont **postérieures à tous les 1 361 timestamps de signature** ; elles ne sont pas des inputs causalement recevables pour le groupe historique.
- `pi.rn1_nba_espn_plays` : 22 611 actions sur 46 événements, collectées à partir du 15 novembre 22:50 UTC ; toute référence historique `play_at` antérieure à `recorded_at` ne prouve pas la connaissance live avant `recorded_at`. Aucune attribution rétrospective de score ou bookmaker à RN1.
- `pi.rn1_maker_historical_fills` : **80 000 BUY fills**, dont **68 445 Maker**, **11 555 Taker**, du 6 au 15 novembre. Historique partiel : ni SELL, ni inventaire d'ouverture, ni trades/fills manquants, ni ordres Maker jamais exécutés. **Ne pas appeler les cumuls une position de wallet.**

## Nouvelle reconstruction strictement pré-décision
Migration effectivement exécutée : `sql/090_rn1_maker_signed_precreation_observed_flow_v1.sql`.
Table `pi.rn1_maker_signed_precreation_flow_v1` : **1 361 lignes exactement**, chaque `order_hash` unique, jamais de fill `trade_at >= declared_created_at`. Pour chaque ordre, sans futur et sans extrapoler une position :
- nombre de BUY fills Maker 5m/30m, BUY Taker 5m ;
- parts Maker précédemment achetées sur le même token et sur les tokens opposés 5m/30m ;
- dernière transaction Maker 30s/30m et dernier fill Maker **même token** 5m ;
- classification déterministe `no_observed_maker_5m | same_side_dominant | opposite_side_dominant | balanced_observed_flow`.
- prix signé et prix historique strictement antérieur à la création (âge ≤90 s) si valide.
Couverture vérifiée : **552/1 361** ordres avec un précédent fill Maker du même marché en 5m, **888/1 361** en 30m, **448** avec Maker sur le même token, **211** avec Maker sur token opposé en 5m, **1 244** références historiques validées selon les filtres conservateurs.
Zéro fill futur utilisé ; RLS et REVOKE anon/authenticated. Les 809 ordres sans Maker vu en 5m n'impliquent PAS zéro ordre ni zéro inventaire.

## Hypothèse pré-définie H11
**Hypothèse :** conditionner la remise de l'ordre signé au déséquilibre des BUY Maker observés dans les cinq minutes précédentes pourrait mieux prédire le prix limite que le simple décalage constant de **−0,005**.

Définition des modèles et séparation :
- `M1` : `price_before + median(signed_price - price_before)`, médiane entraînée uniquement sur les autres événements (baseline antérieure).
- `H11` : remplace la médiane globale par la médiane du régime 5m calculé **avant création** ; groupe ignoré si moins de 30 ordres d'entraînement, repli sur M1.
- Entraînement : cohorte `random_tx`, **781 ordres / 503 événements** ; validation croisée avec cinq folds séparés par `event_slug`.
- Test additionnel inédit par **événement** : `multi_level` et `persistent_order`, seulement les événements qui n'existent **nulle part dans la cohorte random_tx**. **242 ordres / 117 événements** (195 ordres de grilles sur 74 événements + 47 ordres persistants sur 47 événements). Aucun chevauchement événementiel avec l'apprentissage ; ces deux cohortes sont ciblées, pas représentatives.
- Migration exécutée : `sql/091_rn1_maker_prior_flow_policy_event_holdout_v1.sql`, **1 023 prédictions** avec métriques et provenance, stockage privé `pi.rn1_maker_flow_policy_validation_v1`.

### Résultats observés
| Échantillon | Modèle fixe MAE | Régime flux Maker MAE | Gain H11 (plus haut = mieux) |
|---|---:|---:|---:|
| CV interne, 781 ordres / 503 événements | **0,031836** | 0,031936 | **−0,000100** |
| 242 ordres / 117 événements jamais vus à l'entraînement | 0,029907 | 0,029907 | **0,000000** |

Sur la CV interne, M1 est légèrement meilleur (écart moyen **−0,000090** au niveau événement, SE ≈0,000045). Dans le holdout ciblé, le régime Maker **ne change aucun prix prédit** : tous les décalages par groupe entraînés ont médiane **−0,005**. L'égalité de scores n'est pas une preuve que H11 fonctionne. **Verdict H11 simple : non validée, aucune plus-value observée.**

### Contrôles et limites
- 0 duplicat `order_hash` dans le test, 0 événement entre train et holdout ciblé, 0 fill futur, 0 erreur d'assignation aux 5 folds.
- 2 tables RLS privées, aucun droit `SELECT` pour `anon` ou `authenticated`.
- La création `declared_created_at` reste **un timestamp déclaré dans les données de l'ordre**, pas une preuve d'entrée au carnet.
- L'analyse ne voit **que des ordres ayant fini exécutés**, pas les décisions de ne rien placer, les ordres annulés/partiellement quotés sans exécution, ni la queue du carnet.
- Ce résultat ne rejette PAS une règle dépendant du véritable inventaire, du spread, de la profondeur, du score ou d'un signal externe.
- **Le modèle prédit le prix limite signé, pas l'EV ou le ROI**.

## Blocage de l'étude causale prospective
`pi.rn1_quote_probe_state` indique `status='paused_quota'`, dernier succès **17 novembre 2026 21:32 UTC**, raison explicite : plafond partagé stockage/base. Vérification du 19 novembre :
- Base totale : **1 249 506 995 bytes**, soit ≈1 192 MiB.
- Plafond de sécurité du collecteur : **1 073 741 824 bytes**, 1 024 MiB.
- Le `pg_cron` du collecteur est toujours `active=true`, mais ses exécutions sans data retournent **0 rows** tant que l'état est en pause.
- La table `pi.closed_position_roi` occupe ≈**614 MiB**, dont ≈**312 MiB d'index**. C'est une observation de capacité, PAS une autorisation de supprimer la table ou de drop ses indexes.
- **Aucune limite n'a été relevée, aucun fichier supprimé, aucune donnée historique perdue.** Reprise du collector exigera d'abord un plan de capacité sûr ou du stockage additionnel avec consentement.

## Déploiements et exposition
- `supabase/functions/pi-dashboard/rn1-decision-policy.ts` : endpoint privé `rn1_maker_precreation_flow_report` + état quota ; toutes les requêtes ont été testées directement sur Postgres.
- `supabase/functions/pi-dashboard/index.ts` : routage authentifié inchangé sur le contrôle d'accès ; fonction `pi-dashboard` **v57 ACTIVE**.
- `web/index.html` : nouveau panneau sous **RN1 · Moteur**, affiche test, covariables et blocage de collecte. JS validé par V8. Publication GitHub Pages côté client non attestée.

## Prochaines étapes utiles
1. **Plan de capacité non destructif** pour réactiver prospectivement carnets, positions et événements avec timestamp de réception fiables. Préserver les données existantes ; examiner les indexes et stockage via métadonnées et possibilité de cold storage, sans intervention irréversible sans accord.
2. Lors de nouvelles données : joindre uniquement book/position/score **reçus avant l'heure de signature effective**. Protéger contre lookup futur et négatifs incomplets.
3. Tester des règles **jointes** de prix, quantité et exposition avec un nouvel échantillon d'ordres et de moments sans exécution, puis PnL après frais/rebates. Garder séparés les résultats bruts septembre et le maker novembre.
