# RN1 — Priorité aux grandes cohortes historiques (15 novembre 2026)

## Pourquoi ce pivot
Les relevés CLOB récents ne représentent que quelques dizaines de fills appariés, majoritairement sur une même journée. Il serait méthodologiquement incorrect d'en déduire la stratégie générale de RN1. La source de référence pour l'analyse structurelle reste la série historique complète **déjà matérialisée**, avec des contrôles explicites de couverture et la prudence sur les archives non encore épuisées.

## Couverture effectivement vérifiée (requêtes SQL en lecture seule)
- `trades_all` : **732 000 lignes valides**, 732 pages; état `collecting`, historique **pas encore épuisé**.
- `activity_all` : **732 000 lignes valides**, 732 pages, mais ces lignes d'activité ne sont pas des transactions supplémentaires.
- `pi.rn1_full_market_metrics` : **77 352 marchés**, **732 000 exécutions BUY**, **0 SELL** dans ces agrégats. Ce point doit faire l'objet d'un audit de schéma/sources avant tout calcul de profit net.
- Audit maker/taker : **730 pages vérifiées / 732**, dont **650 880 maker** et **79 120 taker**; 2 pages, soit 2 000 fills, encore en attente de vérification. Le taux maker de 89,16 % environ porte sur les **730 000 fills vérifiés**, et non les 732 000.
- Analyse de flux chronologique plus ancienne : 134 000 fills, complète pour sa cohorte mais non équivalente au flux désormais plus large.
- Cotations live : la sonde a terminé 99 cycles puis atteint l'état `paused_quota` (base partagée au-dessus du plafond de sécurité); elle ne doit **pas** être relancée par hausse arbitraire du quota. Voir issue #30.

## Analyse sur tous les 732 000 BUY agrégés
- Marchés où deux issues ont été achetées : **36 205** (639 527 fills associés).
- Marchés avec coût moyen YES + coût moyen NO inférieur à 1 $ : **20 988**.
- Coût apparié moyen pondéré par le nombre de paires : **0,98248 $**.
- Quantité algébriquement appariable : ~**115,72 millions** de paires.
- Écart algébrique de coût d'acquisition sur la partie appariée : ~**+2,027 M$ bruts théoriques**.
- 24 526 marchés appariés ont un ratio supérieur ou égal à 2 entre les volumes YES et NO : risque résiduel très important.

**Interprétation stricte :** cet écart est une **décomposition ex post des prix d'achat déjà exécutés**. Ce n'est ni du revenu réalisé, ni du profit verrouillé garanti au moment des décisions, ni un PnL net. Il ne considère pas les ventes, merges/redeems, frais, inventaires non appariés et données hors couverture. Les résultats du sous-ensemble historiquement réconcilié par paiements officiels, calculés précédemment, ne doivent pas être remplacés par ces marges théoriques.

## Stabilité temporelle des coûts d'achat
Regroupement de marchés par **semaine de leur dernier trade enregistré** (et non une répartition temporelle de chaque fill individuel) :

| Semaine | Fills | Marchés achetés des deux côtés | Coût moyen pondéré des paires |
|---|---:|---:|---:|
| 24 août | 18 411 | 1 067 | 0,98300 |
| 31 août | 70 737 | 3 476 | 0,99121 |
| 7 septembre | 90 022 | 3 605 | 0,98223 |
| 14 septembre | 89 752 | 3 789 | 0,98449 |
| 21 septembre | 63 431 | 2 332 | **1,00363** |
| 28 septembre | 51 369 | 2 088 | 0,98056 |
| 5 octobre | 49 463 | 2 828 | 0,99040 |
| 12 octobre | 59 437 | 3 385 | 0,96158 |
| 19 octobre | 63 923 | 3 191 | 0,97380 |
| 26 octobre | 68 370 | 3 365 | 0,97782 |
| 2 novembre | 61 627 | 3 965 | 0,97084 |
| 9 novembre | 45 458 | 3 114 | 0,98745 |

La semaine du 21 septembre est **défavorable même avant coûts** au niveau moyen de paires. L'hypothèse d'une marge positive sur chaque période est donc fausse dans cette cohorte.

## Prochaine validation indispensable
1. Réconcilier les archives maker/taker (incluant les deux pages restantes), vérifier le caractère exclusivement BUY de l'agrégation de marchés, et distinguer les événements de clôture/merge/redeem.
2. Faire la **décomposition du cashflow réellement réconcilié** sur le plus grand ensemble possible, en conservant les cohortes strictement admissibles et la classification des événements corrélés.
3. Reconstituer le portefeuille séquentiel sur une **grande fraction des 732 000 fills**, à partir des pages d'archives en lecture, avec reprise incrémentale sans doublons, et mesurer la variation de déséquilibre à chaque achat plutôt qu'à partir de 17 snapshots.
4. Mesurer les règles observables (prix, tailles, séquences, délais YES/NO) sur des périodes distinctes, sans prétendre voir les bids historiques absents.
5. Après rétablissement sûr de la capacité stockage, reprendre les sondes de carnet comme **instrument de validation indépendante**, sans qu'elles définissent artificiellement la population principale.

Requêtes reproductibles : [`sql/rn1_large_sample_pair_edge.sql`](../sql/rn1_large_sample_pair_edge.sql). Aucun changement de données ni suppression de table dans cet audit.
