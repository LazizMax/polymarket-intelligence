# RN1 — Validation indépendante des règles de market making

**Date de clôture : 17 novembre 2026.** Étude réellement exécutée sur la cohorte normalisée de **80 000 fills**, dont **68 445 Maker**. Ce rapport sépare strictement les règles de *construction des ordres* des règles de *placement et rentabilité*.

## Protocole de validation

- **Échantillon de découverte** déjà étudié : 1 361 order hashes décodés depuis 1 177 transactions, dont 150 transactions multi-prix ciblées (355 ordres signés), 150 transactions persistantes, 877 transactions ordinaires.
- **Holdout des grilles** : toutes les **531 transactions Maker multi-prix encore inédites** du lot de 80k, après exclusion de *toutes* les transactions de l'échantillon de découverte et de *toute transaction contenant un orderHash déjà décodé*. Un lot de 8 transactions est décodé via `eth_getTransactionByHash` ; le hash EIP-712 de chaque ordre signé est recalculé et comparé aux vrais `maker_order_hash` existants, et les prix sont contrôlés. **531/531 transactions, 1 289 ordres, 0 erreur**.
- **Holdout de prix** : 392 transactions **à un seul ordre Maker**, sélectionnées indépendamment parmi les transactions et order hashes jamais décodés. Chaque ordre est ré-identifié cryptographiquement, puis l'API `prices-history` est interrogée sur une fenêtre bornée autour de son timestamp déclaré. Seuls les prix **strictement antérieurs ou égaux** au timestamp déclaré et datant d'au plus 90 secondes sont retenus. **376/392** prix utilisables, **16 manquants**, **363** avec momentum cinq minutes, **0 erreur de décodage**.
- **Pas de double ingestion** : l'étude a réutilisé les fills et order hashes déjà archivés. Les calldata et fenêtres de prix nouvelles n'ont pas été copiées dans les tables de données volumineuses. Seules **3 lignes de synthèse sur les grilles, 15 lignes de prix et 1 ligne de contrôles** sont conservées durablement dans le schéma privé `pi`.
- **Biais de sélection connus** : la validation des grilles est exhaustive parmi les transactions déjà *exécutées à plusieurs prix*, pas parmi tous les ordres jamais soumis. Le test des prix sélectionne délibérément des transactions à **un seul ordre Maker**, pas toutes les stratégies de quotation.

## 1. Grilles : découverte versus validation hors échantillon

| Mesure | Découverte ciblée | Holdout indépendant |
| --- | ---: | ---: |
| Transactions multi-prix étudiées | 150 | **531** |
| Ordres signés cryptographiquement vérifiés | 355 | **1 289** |
| Parts signées initiales entières | 100 % | **1 289/1 289 (100 %)** |
| Notionnels signés entiers USDC | ~5,9 % | **81/1 289 (6,3 %)** |
| Espacement adjacents de 0,01 | **74/78 (94,87 %)** | **278/299 (92,98 %)** |
| Grilles même timestamp et quantité égale sur les niveaux | **60/71 (84,51 %)** | **196/281 (69,75 %)** |
| Paires d'ordres même timestamp, quantités égales | **78/89 (87,64 %)** | **261/352 (74,15 %)** |
| Paires timestamps différents, quantités égales | **42/150 (28,0 %)** | **136/509 (26,72 %)** |

**Réplication temporelle du holdout**
- Ancienne cohorte : **278 transactions**, 681 ordres. Pas de 0,01 sur **147/157 = 93,63 %** des niveaux ; tailles égales sur **98/143 = 68,53 %** des grilles.
- Récente : **253 transactions**, 608 ordres. Pas de 0,01 sur **131/142 = 92,25 %** ; tailles égales sur **98/138 = 71,01 %** des grilles.

**Conclusion vérifiée :**
1. Le **pas de 0,01** entre plusieurs niveaux signés à la même milliseconde est une **signature de cotation robuste** dans les transactions Maker multi-prix exécutées.
2. Le sizing sur un **nombre entier de parts** est confirmé sur tous les ordres originaux décodés de cette nouvelle cohorte.
3. Le **sizing égal sur tous les niveaux** est une tendance, **pas** une règle universelle ; la fréquence recule nettement par rapport à la découverte (84,5 → 69,8 %).
4. Même timestamp **ne signifie pas** que les ordres étaient simultanément affichés au carnet ; les ordres jamais exécutés et les annulations restent invisibles.

## 2. Prix signés : la règle générale résiste, l'effet momentum non

**Découverte (groupe général) :** 811 ordres avec prix antérieur valide ; 796 avec momentum cinq minutes. Écart `prix limite signé - dernier indicateur historique précédent`, médiane **−0,005**. Après baisse de plus d'un point : médiane **−0,010** ; après hausse de plus d'un point : **−0,005**. Mais seulement 13 événements avec 2 observations de chaque régime.

**Holdout indépendant (transactions à un ordre Maker) :**

| Régime des 5 minutes avant signature | Ordres holdout | Écart signé médian | Pct au moins 0,5 point sous référence |
| --- | ---: | ---: | ---: |
| Baisse supérieure à 1 point | **129** | **−0,0055** | 58,14 % |
| Stable entre −1 et +1 point | **72** | **−0,00225** | 37,50 % |
| Hausse supérieure à 1 point | **162** | **−0,0050** | 50,00 % |
| Prix valide mais momentum absent | **13** | 0,0000 | 38,46 % |

- Écart **global** holdout : médiane **−0,0050** sur **376 ordres**, 10e percentile **−0,05** et 90e **+0,03**, forte dispersion.
- Ancien et récent : **198** et **178** ordres avec prix valide, **−0,0050** de médiane dans les deux périodes.
- **Contrôle qualité référence fraîche ≤30 s** : après baisse 65 ordres, médiane **−0,0035**, après hausse 82 ordres, médiane **−0,0050**. Il ne subsiste **pas** d'écart plus négatif après baisse sur ce sous-échantillon frais.
- **Contrôle par événement** : 295 événements ont des observations avec momentum. Seulement **22** ont même une observation dans chaque régime baisse/hausse ; **11** favorisent un écart plus négatif après baisse, **10** après hausse, **1** égalité. **1 seul** événement a au moins deux observations dans les deux régimes. Différence moyenne par événement **+0,00234** (signe opposé à l'hypothèse de découverte).

**Conclusion :** le prix limite signé légèrement sous l'indicateur historique récent est une **tendance globale répliquée** dans les transactions choisies. **L'ajustement systématique de profondeur après chute de cote n'est PAS validé hors échantillon**. Ne pas l'introduire comme une règle du futur algorithme.

**Limite temporelle majeure :** l'indicateur de prix est extrait rétrospectivement d'une API historique. Son timestamp antérieur à celui de la signature ne prouve pas que ce prix était publiquement disponible au trader à cet instant. Il ne constitue pas un bid/ask, un spread ou une profondeur de carnet. L'absence de biais temporel dans le filtrage n'est pas une preuve d'exécution reproductible.

## 3. Gestion du risque de stockage

Avant le holdout, la base Supabase était déjà à **~957 Mo** (contre ~832 Mo à la fin de la phase précédente). Après étude, ~959 Mo. Les plus gros objets inspectés étaient `pi.closed_position_roi` (~415 Mo), `pi.rn1_full_activity_metrics` (~109 Mo), `pi.rn1_full_market_metrics` (~93 Mo) et `pi.rn1_maker_historical_fills` (~91 Mo).

**Aucune suppression**, aucune recomputation de l'archive et aucune interruption des processus existants de suivi des trades n'ont été effectuées. Avant de normaliser de nouveaux millions de fills, il faudra étudier les tables et index volumineux, politiques de rétention et alternatives compactes. Toute suppression des données déjà collectées nécessite une analyse de dépendances et de conservation.

## 4. Infrastructure livrée et contrôles

- Fonction `pi-rn1-onchain-orders` v20 : routes privées scheduler `rn1_holdout_ladder_probe` et `rn1_holdout_signed_price_probe`, décodage et validation **sans écrire les fills dans des tables supplémentaires**.
- API `pi-dashboard` v45 initialement : `rn1_holdout_ladder_validation` ; route `rn1_holdout_signed_price_validation` ajoutée ensuite.
- Frontend `web/index.html`, onglet **RN1 · Moteur** : tableau de comparaison des règles, couverture par période et avertissement explicite du **non-replication** de l'hypothèse momentum.
- Tables privées durables `pi.rn1_holdout_ladder_validation` (3 lignes), `pi.rn1_holdout_price_validation` (15 lignes) et `pi.rn1_holdout_price_controls` (1 ligne), avec RLS et droits `anon/authenticated` révoqués.
- Migrations/snapshots en GitHub `sql/078_rn1_disjoint_holdout_validation.sql`.
- Les tâches terminées ne sont pas programmées pour se relancer.

## 5. Feuille de route actualisée

1. **Conserver dans le modèle RN1** : sizing entier de parts, grille signée à 0,01 fréquente, écart signé médian d'environ −0,005 par rapport à une référence historique (proxy, pas ordre exécutable).
2. **Rétrograder en hypothèse non validée** : même taille sur tous les niveaux comme règle stricte, et baisse préalable ⇒ remise supplémentaire systématique.
3. **Prochain problème économique** : reconstruire achats et ventes, exposition nette par issue, clôtures, remboursements et P&L après frais. La base `closed_position_roi` est grande et doit être auditée avant davantage d'ingestion.
4. **Validation prospective** : capter bid/ask, carnet et fills au moment exact pour estimer les possibilités réelles d'exécution passive et le coût de queue.
5. **Pas de copy trading en réel** sur la seule base de ces observations : aucune EV après frais ni profitabilité reproductible n'est encore démontrée.
