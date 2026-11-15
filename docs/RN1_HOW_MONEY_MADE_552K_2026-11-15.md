# RN1 — Audit économique basé sur 552 000 transactions, 15 novembre 2026

Wallet: `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`.

## Objectif

Identifier la **source observable de l'avantage de RN1** : paires YES/NO à coût combiné inférieur au remboursement, exposition directionnelle résiduelle et cashflows effectivement remboursés. Une décomposition a posteriori ne démontre pas la règle exacte de cotation ni l'espérance future.

## Provenance et périmètre

- Source publique officielle `/v2/trades?user=<RN1>&start=1&limit=1000&taker_only=false`; 552 000 BUY dans 60 699 conditions au point de contrôle. La collecte complète continue en remontant l'historique. Toutes les pages originales sont archivées en gzip privé et vérifiables par hash et curseur.
- Prix et quantités par issue : `pi.rn1_full_market_metrics`.
- Activités et cashflows public `/v2/activity` : `pi.rn1_full_activity_metrics` (TRADE, REDEEM, MERGE, MAKER_REBATE, TAKER_REBATE, REWARD). **Ne pas confondre la somme des activités TRADE avec un second jeu de fills : un trade peut apparaître dans les deux flux**.
- Cohorte de réconciliation économique : conditions avec **les deux issues achetées**, premier trade au plus tôt le 21 septembre UTC, dernier trade avant le 12 novembre UTC, et opération REDEEM présente. Une compensation économique `REDEEM + MERGE` est jugée compatible avec les shares achetées lorsque son écart à **l'une** des quantités d'issue `Q0` ou `Q1` est <= 1 USDC.
- Conditions candidates : **22 323** ; remboursées : **22 189** ; réconciliées : **22 185**, **4 écarts** exclus ; **134** sans REDEEM exclues. La très forte compatibilité est corroborée indépendamment par l'API de résolution officielle.
- Marchés réconciliés : **9 571 événements** `event_slug` distincts (mais les événements ne sont pas statistiquement indépendants par défaut).

## Validation indépendante des résultats officiels

Pour éviter d'inférer arbitrairement l'issue gagnante à partir du remboursement, une cohorte **figée** de **576 marchés**, avec **565 événements distincts**, a été créée dans `pi.rn1_price_edge_cohort` :
8 semaines du 21/09 au 09/11, 2 types d'achats (une ou deux issues), 3 terciles de capital, 12 marchés par strate, maximum un marché par événement dans chaque strate, sélection déterministe via `md5(market_key||'rn1_edge_v2')`.

- **576/576** marchés ont une résolution officielle, mais **551/576** seulement ont un payout binaire vérifiable `[0,1000000]` ou `[1000000,0]`; les **25 payouts absents** sont exclus du test.
- Sur les **551 marchés exploitables**, **550** cashflows REDEEM/MERGE égalent le paiement officiel des shares achetées au centime près, et **551** dans une marge de 1 USDC (écart max 0,88 $).
- Sur ces 551, scénario de conservation brut **+68 111,57 $ sur 1 670 287,97 $** (4,08 %) ; composante paire **+23 024,72 $**, composante résiduelle directionnelle **+45 086,86 $**. **Ce sous-échantillon est volontairement stratifié, avec davantage de petites transactions et de marchés unilatéraux. Ses proportions ne sont PAS extrapolables au wallet entier.** Le résultat positif directionnel n'y est pas stable de semaine en semaine.

## Résultat principal : cashflows réconciliés sur 22 185 marchés à deux issues

| Mesure | Dollars / parts |
|---|---:|
| Achats observés | 104 750 931,23 $ |
| REDEEM + MERGE compatibles avec les shares achetées | 105 800 139,24 $ |
| **Résultat brut économique réconcilié** | **+1 049 208,01 $ (+1,002 % des achats)** |
| Shares complémentaires appariées `min(Q0,Q1)` | 70 544 521,83 |
| Coût attribué aux paires au VWAP par issue | 69 218 096,85 $ |
| Paiement binaire théorique des paires | 70 544 521,83 $ |
| **Contribution mathématique des paires** | **+1 326 424,98 $ (+1,92 % sur coût apparié)** |
| Coût attribué aux shares résiduelles | 35 532 834,38 $ |
| **Contribution des shares résiduelles** | **−277 216,97 $ (−0,78 % sur leur coût)** |

**La contribution paire est supérieure au résultat brut total.** Les quantités résiduelles non appariées ont donc coûté de l'argent dans cette cohorte. Cette observation *inverse* la première hypothèse formulée à partir de 4 000 fills taker-only et nuance le petit échantillon officiel de 551 marchés.

Parmi les 22 185 marchés, **12 919** possèdent une contribution paired mathématiquement positive (58,23 %). Pourtant, **seulement 55,2 % des shares appariées** proviennent de ces marchés : les marchés perdants peuvent porter des quantités plus importantes, et le PnL net de la composante paire reste très dépendant des prix relatifs effectivement obtenus.

### Comment la stratégie semble générer sa marge

Il ne suffit pas de constater `avg_price_YES + avg_price_NO < 1` sur 58 % des marchés pour prouver des ordres simultanés. Il s'agit du **VWAP de TOUS les achats sur chaque issue** ; les exécutions ont pu se produire à des heures différentes, et les fusions/règlements peuvent changer les soldes. La décomposition est une **allocation ex post** par `min(Q0,Q1)`, vérifiée contre le cashflow final.

La distribution du coût combiné observé montre à la fois opportunités et pertes : les 6 234 marchés avec `VWAP_YES + VWAP_NO < 0,90` génèrent une contribution paire de **+3 548 847,83 $**, alors que les 5 911 marchés avec somme `>=1,05` en perdent **−2 928 046,95 $**. Ce sont **des constats en fin de marché**, pas des signaux sélectionnables à l'entrée sans information future.

Le **modèle descriptif** le plus plausible est un algorithme de **fourniture passive de bids YES et NO**, adaptant ses prix aux mouvements des probabilités de marché, accumulant parfois des paires économiques sous 1 $, acceptant un inventaire temporairement directionnel, et récupérant le remboursement après résolution plutôt que revendant régulièrement.

Il ne faut pas inventer ses seuils de bid, ni prétendre qu'il existe un spread fixe de 1,92 %. Le **coût effectif des paires** est d'environ **0,9812 $ par dollar de remboursement**, en moyenne *pondérée par les shares appariées* — pas nécessairement une consigne algorithmique ex ante.

## Robustesse : gain brut toujours positif après contrôles

| Test de robustesse | Marchés | Profit brut | ROI brut |
|---|---:|---:|---:|
| 22 185 marchés réconciliés | 22 185 | +1 049 208 $ | +1,002 % |
| Sans aucun MERGE | 22 042 | +889 440 $ | +0,866 % |
| Sans les 1 % de plus grosses variations absolues de PnL | 21 963 | +761 414 $ | +0,792 % |
| Sans les 1 % de marchés les plus capitalisés | 21 963 | +1 211 746 $ | +1,372 % |
| Sans la semaine récente incomplète | 20 994 | +1 156 585 $ | +1,145 % |

Sur les huit semaines de la cohorte, **sept affichent un PnL brut positif**. La semaine débutant le 9 novembre est volontairement **tronquée au 12 novembre**, elle ne constitue pas une semaine comparable complète. Le total représente **des dollars échangés sur des positions répétées**, pas la bankroll ou le capital immobilisé simultanément.

Un contrôle par événements distingue **9 571 `event_slug`**, mais des marchés d'un même événement peuvent partager du risque. Les 10 événements les plus bénéficiaires représentent environ **527 089 $**, ce qui impose des contrôles de concentration ; le test excluant 1 % des plus gros PnL absolus conserve un résultat positif.

## Ce qui est NON démontré

- **Le profit net total du wallet**. Les marchés avec achats d'une seule issue, ceux sans remboursements et les marchés non réconciliés sont hors du calcul. En particulier, ignorer des marchés unilatéraux perdants créerait un biais positif.
- Les commissions d'exécution, rebates, récompenses attribuables par fill ou la valorisation des stocks encore ouverts.
- Le prix limite affiché lorsque l'ordre n'est **pas exécuté**, la profondeur du carnet et la priorité en file d'attente.
- Un modèle de probabilité sportive supérieur au marché, la formule privée de cotation, ou une stratégie garantissant une EV future positive.

Le flux historique Data API de prix d'une minute n'est **pas** un carnet bid/ask exécutable synchronisé. Pour identifier les paramètres de cotation, instrumenter des snapshots de bid/ask contemporains aux futures exécutions RN1, réconcilier aussi les marchés unilatéraux et tester des règles candidates sans fuite d'information future.

## Reproductibilité et sécurité

Cohorte explicite : `sql/034_rn1_price_edge_cohort.sql` ; résolution officielle archivée : `pi.rn1_resolution_evidence` ; endpoint privé `rn1_reverse_engineering` dans `pi-dashboard`, répond `economics.summary` et `economics.weekly`, recalculables à partir des métriques courantes. RLS sur toutes les tables privées. Supabase est partagé avec Fit Tracker ; aucune transaction réelle n'est effectuée, aucun secret de trading exposé. La collecte générale de pages continues reste séparée.
