# RN1 — Audit des tailles et de l'inventaire avant fill (16 novembre 2026)

## Objectif et périmètre
Tester comment RN1 choisit ses tailles de **BUY exécutés** sans confondre : taille d'un fill, taille de l'ordre limite sous-jacent, volume cumulé, inventaire détenu sur un marché et bankroll totale (cette dernière est **non observable**).

Deux univers distincts :
1. **Lot gelé exhaustif de 756 000 BUY fills** avec histogrammes par montant construits lors du replay original de 756 pages. Aucune nouvelle relecture des archives, pas de filtre sur le rôle dans les histogrammes. Les 756 pages de rôle auditées indiquent **674 459 Maker / 81 541 Taker**.
2. **Sondes CLOB live** associant fill à carnet et positions publiques observées AVANT le carnet puis AVANT le fill. Le rôle est Maker inféré / Taker vérifié ; ce sous-échantillon n'est ni représentatif ni tiré au hasard.

## 1. Distribution des montants des 756 000 fills
Montant = `fill_price × shares` USDC. **Tous les 756 000 trades dans l'archive de trades sont des BUY** : l'absence de SELL dans ce feed ne veut pas dire que RN1 ne réduit jamais ses expositions, car l'activité comporte des opérations telles que MERGE/REDEEM.

| Montant par fill | Fills | % des fills | Notionnel cumulé (USDC) | % du volume |
|---|---:|---:|---:|---:|
| <5 $ | 199 031 | 26,33 % | 381 902,55 | 0,20 % |
| 5–20 $ | 138 684 | 18,34 % | 1 506 220,68 | 0,77 % |
| 20–50 $ | 93 825 | 12,41 % | 3 083 066,92 | 1,58 % |
| 50–100 $ | 72 406 | 9,58 % | 5 232 496,12 | 2,69 % |
| 100–250 $ | 90 676 | 11,99 % | 14 630 725,87 | 7,52 % |
| 250–500 $ | 59 923 | 7,93 % | 21 603 524,12 | 11,10 % |
| 500–1 000 $ | 48 408 | 6,40 % | 34 225 502,65 | 17,59 % |
| 1 000–5 000 $ | 51 031 | 6,75 % | 98 996 050,41 | 50,86 % |
| ≥5 000 $ | 2 016 | 0,27 % | 14 966 257,57 | 7,69 % |

**Total brut : 194 625 746,90 USDC d'achats exécutés**. Ce montant est du turnover, **pas de la trésorerie**, pas un solde, pas de la valeur liquidative et pas des profits. Seulement **7,02 % des fills** (≥1 000 $) représentent **58,55 % du volume**. À l'autre extrême, **44,67 % des fills** (<20 $) ne représentent que **0,97 % du volume**. Une grosse exécution n'est pas nécessairement un gros ordre unique ; un même ordre peut produire plusieurs fills.

Ce tableau toutes-issues et tous-rôles **ne permet pas de déduire la distribution des tailles Maker seules**. Les 89,2 % Maker viennent d'un audit de rôles distinct.

## 2. Inventaire public juste avant des exécutions live
Filtrage strict :
- `pi.rn1_quote_probe_runs.position_status='complete'` et inventaire par deux outcomes validé ;
- `position_observed_at <= received_at < fill.trade_at`, donc **pas d'inventaire post-fill** ;
- deux entrées de token correspondant exactement au marché du fill ;
- coût d'entrée des seules **positions encore ouvertes** sur ce marché, jamais la bankroll.

Au contrôle de ce rapport :
| Rôle live | Fills rapprochés avec inventaire | Marchés | Notionnel médian | P90 | P99 | Taille médiane / coût d'inventaire ouvert | Réduit l'écart de parts | Augmente l'écart |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Maker inféré | 386 | 66 | 24,67 $ | 998,25 $ | 1 910,68 $ | 0,764 % | 174 | 212 |
| Taker vérifié | 13 | 7 | 47,52 $ | 228,13 $ | 615,81 $ | 1,981 % | 8 | 5 |

Les valeurs évoluent tant que la sonde continue. Les proportions `fill / coût d'inventaire` sont définies **uniquement lorsque l'inventaire observé a un coût >0**. Le montant relatif peut être élevé au début d'un marché, avec une position préalable petite ; il ne s'agit pas d'un % de capital utilisateur.

Le déséquilibre de parts est `|shares_issue_0 - shares_issue_1|`. La catégorie « réduit » / « augmente » est calculée en ajoutant **hypothétiquement** uniquement le fill connu au snapshot précédent, sans prétendre voir les autres transactions survenues entre capture et fill. Aucun ratio ne prouve une politique de couverture automatique.

## 3. Début de recherche des facteurs de taille Maker
Sur le même petit échantillon Maker live, selon la cote du fill :

| Cote au fill | Fills | Notionnel médian |
|---|---:|---:|
| <20 % | 130 | 5,09 $ |
| 20–40 % | 47 | 20,25 $ |
| 40–60 % | 91 | 29,54 $ |
| 60–80 % | 63 | 56,92 $ |
| ≥80 % | 55 | 230,98 $ |

Le fait que les montants médians croissent avec la cote est **descriptif**, et peut venir à la fois du prix par part, du sport, du marché ciblé, de la quantité de parts et du régime d'inventaire ; impossible de conclure à un sizing précis de RN1 en pourcentage de capital.

Sur ces 386 Maker avec inventaire, 194 fills commencent sur l'issue sous-pondérée en parts, 181 sur la surpondérée et 11 sur égalité. Cela n'établit pas une règle de rééquilibrage : le trading sur l'issue déjà dominante existe.

## 4. Interface et architecture
- Backend privé existant `pi-dashboard` : action authentifiée `rn1_sizing_forensics`, lecture seule, aucune nouvelle table ni reprise du replay.
- Frontend GitHub Pages : nouvel onglet **RN1 · Money management**, histogramme fills/volume des 756k, statistiques Maker/Taker live et exploration des cohortes par cote, inventaire ou coût déjà ouvert.
- Ne pas présenter comme ratio de bankroll les positions du marché, ni un fill comme un ordre unique.
- Accumulation et comparaisons restent des recherches exploratoires, pas un modèle de gestion du risque actionnable.

## 5. Hypothèses suivantes à falsifier
1. **Taille fixe en parts** : tester si la quantité varie peu quand la cote change sur un même marché, hors fragmentation des fills.
2. **Taille fixe en USDC** : tester si `shares × price` reste constant par type de marché, par tranche de temps et par position.
3. **Quota de risque par événement** : reconstituer à chaque instant l'inventaire estimé des outcomes et l'exposition nette aux résultats, sans connaître le cash libre.
4. **Rééquilibrage dynamique** : conditionner la taille Maker sur l'écart de parts, coût complémentaire `avg_YES + avg_NO`, spread, tick et durée restante.
5. **Validation prospective** : comparer les tailles prédites de fills à de nouvelles périodes, mais ne jamais prétendre prédire les ordres privés annulés/non remplis ni rentabiliser une stratégie via des fills observés seulement.
