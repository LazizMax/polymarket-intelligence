# RN1 — Audit définitif du lot gelé de 756 000 exécutions
**15 novembre 2026, après convergence des deux moteurs.** Cette note supplante explicitement les chiffres provisoires à 104/152/177/548 pages. Le verdict économique global est présenté dans [RN1_STRATEGY_VERDICT_2026-11-15.md](./RN1_STRATEGY_VERDICT_2026-11-15.md).

## 1. Intégrité et couverture : complet et audité

| Contrôle | Résultat final |
|---|---:|
| Lot gelé | 756 pages de 1 000 fills = **756 000** |
| Replay chronologique `pi.rn1_replay_jobs` | **complete**, 756/756, `next_page=0`, aucune erreur |
| Replay par page `pi.rn1_replay_pages` | 756/756 pages, 756/756 SHA256 identiques à `rn1_full_archive_pages`, 756/756 décomptes de rôles et de transactions identiques |
| Rôle validé dans l'archive immuable | 756/756 pages `role_status=verified` |
| Exécutions Maker | **674 459 (89,214 %)** |
| Exécutions Taker | **81 541 (10,786 %)** |
| Rôle inconnu | **0** |
| Prix indépendants `pi.rn1_independent_price_jobs` | **complete**, 756/756 pages, 756 000 exécutions sources, aucune erreur |
| SHA256 prix / source | 756/756 pages correspondent |
| Échantillonnage prix | 8 tokens/page × 756 = **6 048 tokens sélectionnés**, 6 042 appels d'historique réussis, 6 erreurs enregistrées |
| Achats des tokens échantillonnés | **33 237** = 29 731 Maker + 3 506 Taker |
| Rôles inconnus prix | **0** |

Les poids des analyses de prix corrigent la sélection de 8 tokens **au niveau de chaque page** par `source_tokens/sampled_tokens`, puis les changements de prix sont pondérés par le nombre de parts achetées. Une page avec beaucoup de transactions d'un token n'est donc pas simplement un échantillon aléatoire de 1 000 fills. Les 6 requêtes historiques sans résultat réussi ne doivent pas être assimilées à zéro markout.

**Périmètre causal :** le flux est inversé pour retrouver la chronologie approximative, mais les opérations au même timestamp ne révèlent pas la priorité du matching engine. L'inventaire est reconstitué à partir des fills observés, pas du portefeuille exact après toutes les conversions/transferts/règlements.

## 2. Suivi de prix public après achat, étude indépendante

Moyenne pondérée quantités × correction de probabilité de sélection, en **centimes USDC par part achetée**, à partir de `pi.rn1_independent_price_pages.summary.market_price`:

| Horizon après BUY | Maker (fills avec prix futur) | Maker, ¢/part | Taker (fills) | Taker, ¢/part |
|---|---:|---:|---:|---:|
| 1 minute | 29 442 | +0,9670 | 3 483 | +0,9105 |
| 5 minutes | 29 497 | +0,8417 | 3 496 | +0,9245 |
| 15 minutes | 29 469 | +0,8833 | 3 500 | +0,3979 |
| 30 minutes | 28 914 | +0,8622 | 3 407 | −0,8009 |
| 60 minutes | 23 609 | +1,2916 | 2 756 | −1,5312 |

Ces colonnes regroupent des **cohortes différentes**, y compris des prix/horaires/sports différents ; aucun écart Maker–Taker non apparié n'est une mesure du profit marginal du mode Maker. Ces prix CLOB publics ne sont **pas des bids/asks historiques exécutables**. L'évolution n'est pas un prix de sortie disponible, ni un PnL, ni un ROI.

### Intervalles approximatifs regroupés par événement sportif pour Maker

L'agrégation par événement a été conservée uniquement à partir de la **page source 677** : elle couvre donc moins de fills que le tableau pondéré ci-dessus. Chaque événement indépendant dans la construction est une unité de variance (erreur-type empirique, intervalle normal ±1,96 SE), mais les événements restent susceptibles de corrélations sport/date.

| Horizon | Événements regroupés | Moyenne Maker, ¢/part | Intervalle indicatif à 95 %, ¢/part |
|---|---:|---:|---:|
| 1 min | 3 865 | +1,0354 | [+0,3179 ; +1,7529] |
| 5 min | 3 872 | +0,7690 | [+0,0325 ; +1,5055] |
| **15 min** | **3 860** | **+0,8515** | **[−0,4281 ; +2,1312]** |
| 30 min | 3 840 | +0,8033 | [−1,0353 ; +2,6418] |
| 60 min | 3 567 | +0,7857 | [−1,7383 ; +3,3096] |

La moyenne à 1 minute est statistiquement positive sous les hypothèses simplifiées de ce calcul. Mais horizons multiples, saisonnalité des matchs, prix publics observés et sélection d'ordres exécutés interdisent d'interpréter cela comme un alpha causal ou des gains liquidables. À 15 min l'intervalle englobe zéro.

## 3. Reconstitution de la politique d'inventaire — replay exhaustif du lot

| Observation chronologique | Maker |
|---|---:|
| Achats avec déséquilibre mesurable | 604 843 |
| Réduisent le déséquilibre YES/NO | **239 811 (39,65 %)** |
| Augmentent le déséquilibre | **365 017 (60,35 %)** |
| Sans changement | 15 |
| Parts appariées supplémentaires attribuées au BUY Maker | 101 526 796,31 |
| Proxy brut de coûts appariés Maker | **+1 482 783,65 USDC** |
| Proxy brut par nouvelle part appariée Maker | **+1,4605 centime** |

Les 30 038 nouvelles créations de paires attribuées aux achats Taker donnent environ **+32 072,57 USDC** de proxy de coûts, soit **+0,1864 centime** par part appariée Taker. Les sommes du replay ne sont **PAS** additionnables au PnL de la cohorte réglée : les périmètres, règles et attributions sont différents.

La proposition « RN1 achète toujours le côté le moins détenu pour maintenir 50/50 » est **contredite** par 60 % d'achats Maker aggravant l'écart. RN1 peut accepter le risque directionnel pour obtenir de la liquidité passive à des prix favorables.

## 4. Comparaisons à l'intérieur d'un même événement

Ces analyses réduisent la confusion « matchs différents », **sans** contrôler les prix exacts, horaires, risque de sélection adverse, probabilités de fill ni ordres annulés. Intervalles exploratoires, cinq horizons multiples.

| Comparaison appariée | Horizon | Événements | Différence, ¢/part | IC indicatif à 95 % |
|---|---|---:|---:|---:|
| Maker − Taker | 1 min | 826 | **−1,0932** | [−1,7056 ; −0,4807] |
| Maker − Taker | **15 min** | **831** | **−0,8678** | **[−2,2230 ; +0,4874]** |
| Maker − Taker | 60 min | 690 | −2,0176 | [−3,8647 ; −0,1704] |
| Maker sous-pondéré − Maker surpondéré | 1 min | 909 | +0,0611 | [−0,4751 ; +0,5973] |
| Maker sous-pondéré − Maker surpondéré | **15 min** | **912** | **−0,2168** | **[−1,6724 ; +1,2388]** |
| Maker sous-pondéré − Maker surpondéré | 60 min | 757 | −3,1193 | [−5,3231 ; −0,9154] |

Les écarts Maker–Taker à 1/60 min et inventaire à 60 min ne doivent pas être interprétés comme des effets causaux ; les risques de confusion temporelle/sportive demeurent et 5 horizons × plusieurs contrastes ont été examinés. À l'horizon principal de 15 minutes, tous les contrastes appariés pertinents sont **compatibles avec zéro**.

## 5. Stabilité par période — conclusion mise à jour

Les 12 semaines ont des moyennes Maker pondérées à 15 min très différentes (de **−4,1147** à **+4,4757** centimes/part). Avec toutes les 756 pages, la moyenne Maker de +0,8833 centime à 15 minutes **reste positive lorsque l'on omet n'importe laquelle des douze semaines** : extrêmes du leave-one-week-out **+0,3454 à +1,4168** centimes/part.

**Correction importante par rapport aux notes intermédiaires :** à 152 pages, enlever la semaine du 7/09 inversait le signe. Ce n'est **plus vrai** sur le lot complet. Le résultat agrégé est positif mais l'incertitude entre événements à 15 minutes englobe toujours zéro, et des semaines individuelles sont négatives. Un leave-one-week-out n'est pas une validation sur de nouvelles dates inconnues.

## 6. Verdict après clôture du lot

**Établi :** RN1 a réalisé un profit historique positif selon l'historique du PnL économique natif. 22 185 marchés avec deux issues et remboursement réconcilié présentent **+1,049 M USDC brut** (avant frais/rebates). La décomposition ex post des paires est positive de **+1,326 M**, tandis que les expositions directionnelles résiduelles sont négatives de **−0,277 M**. Les données réelles de carnets suggèrent qu'il faut obtenir les prix Maker pour profiter des marges.

**Exclu :** un arbitrage instantané répétable en achetant simplement YES et NO au meilleur ask ; aucune des 1 891 cotations de paires observées ne le permettait sous 1 USDC.

**Non établi :** des ordres Maker copiables après le trade publié, une probabilité de remplissage suffisamment forte sur les deux jambes, le rendement net d'un copieur, la capacité nécessaire ou les règles de placement et d'annulation exactes. **La décision sur une réplication à risque réel reste négative tant qu'aucun test prospectif horodaté n'a démontré l'avantage après les frictions.**

## 7. Tables et audit reproductible

`pi.rn1_replay_jobs`/`pi.rn1_replay_pages` (SHA, inventaire et Maker/Taker), `pi.rn1_independent_price_jobs`/`pi.rn1_independent_price_pages` (prix indépendants, moyennes pondérées et événements), `pi.rn1_full_archive_pages` (sources immuables), `pi.rn1_full_market_metrics`/`pi.rn1_full_activity_metrics` (achats et remboursements), `pi.rn1_official_pnl_points` (PnL natif), `pi.rn1_quote_probe_runs` (livres d'ordres réels).

Les deux workers ont le statut SQL `complete`, leur dernier curseur est `next_page=0`, et les 756 pages sont préservées avec un SHA identique aux sources. Aucun reset/réimport n'a été nécessaire.
