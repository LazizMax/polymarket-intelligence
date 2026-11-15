# RN1 — Atlas des setups : stratégie observée, variables et timing (15 novembre 2026)

## Décision rapide

Les **756 000 fills archivés et vérifiés SHA256** ont été profilés (756/756 pages, aucune erreur, statut `complete`). Le tableau RN1 → **Patterns** est publié sur https://lazizmax.github.io/polymarket-intelligence/. Ce nouvel onglet présente les agrégats complets par sport/contrat, les prix et tailles par fill, les entrées par marché, ainsi que deux groupes distincts d'horaires de début de match.

**Profil opérationnel probable :** RN1 fournit majoritairement de la liquidité Maker (674 459 / 756 000, soit 89,2 %), intervient sur plusieurs marchés dérivés d'un même événement, accumule des dizaines de fills sur certains marchés, et achète parfois les deux issues à des horaires séparés. Cela **ne** prouve **pas** les règles privées de cotation, de dépôt, d'annulation, ni les ordres passés sans fill.

## Dénominateurs — à NE PAS mélanger

1. **Lot figé de 756 000 fills, 79 602 marchés distincts :** données vérifiées sur les 756 archives privées, prix/quantités et premier fill, 37 347 marchés avec au moins un BUY sur chacune des deux issues (46,9 %). Aucune page réimportée.
2. **Agrégats de marchés actualisés automatiquement** : dépassaient 890 000 fills lors de l'audit ; les données continuent d'évoluer. Ils servent à la classification par sport, type de marché, ligue et nombre total de fills.
3. **Horaires événementiels Gamma enrichis** : 600 événements parmi les plus actifs, plus 600 événements sélectionnés par hash déterministe hors top 600. Un événement n'est éligible au calcul de l'écart horaire que si une heure Gamma `startTime`/`gameStartTime` ET un fill du lot figé sont observés. Le sous-échantillon effectivement comparable contient respectivement 531 et 536 événements (pas 600 dans chaque régression). `startDate` de création du marché n'est jamais utilisé comme coup d'envoi.

## 1. Marchés et prédictions

Dans la population de marchés en continu (photographie ponctuelle à environ 892 000 fills), par **nombre de fills** : football **44,63 %**, tennis **24,57 %**, esport **11,96 %**, football américain **9,16 %**, basketball **3,61 %**, baseball **3,07 %**, autres/non classés **2,69 %**, hockey **0,32 %**. Le football et le tennis représentent environ 71,5 % de la **somme des montants d'achat** sur cette photographie, proportion différente de celle des fills.

Types de contrat : vainqueur/moneyline **53,91 %** des fills ; Over/Under **21,42 %** ; handicap/spread **6,89 %** ; cartes/manches esport **6,80 %** ; mi-temps **3,68 %** ; nul **3,41 %** ; score exact **3,00 %** ; les deux équipes marquent **0,89 %**. Classement heuristique et explicite du titre du marché ; les catégories « Autres » restent visibles.

**Très forte concentration** : la tranche de marchés avec 50+ fills ne comprend que quelques pour cent des marchés mais une grande fraction des transactions. Cela soutient l'hypothèse d'un mécanisme récurrent d'exécution / marché-making et non d'une unique prise de pari.

## 2. Entrées sur le lot historique gelé

- **79 602 marchés** ont une première transaction BUY observable.
- Première cote d'achat **médiane 0,47**, quartiles **0,2009 et 0,69**. Le premier prix n'est pas cantonné à 0,50 : 12 463 premiers achats sont **sous 0,10** et 6 514 **au-dessus de 0,90**.
- Première **exécution** médiane : **26,32 USDC**, à ne pas confondre avec taille totale de l'ordre initial, ni taille de position finale.
- Les deux issues ont reçu des achats dans **37 347 marchés (46,9 %)**. Délai médian entre les deux premiers fills **21,17 minutes** (Q1 6,72 ; Q3 49,95). Parmi les marchés à deux côtés, 7 812 sont complétés dans les 5 premières minutes, 22 400 dans les 30 premières, 30 008 dans les 60 premières.
- **89,2 %** des fills sont Maker sur le lot complet et **60,35 %** des BUY Maker avec inventaire préexistant comparable augmentent le déséquilibre des parts 0/1. Les indices 0/1 correspondent parfois aux deux équipes, pas aux libellés textuels YES/NO.

### Entrées croisées par sport (lot 756k)

| Sport | Marchés avec deux issues achetées | Premier achat médian USDC | Délai médian entre les premiers fills des deux côtés |
|---|---:|---:|---:|
| Esport | 1 590 / 1 871 = 85,0 % | 73,8 | 11,2 min |
| Tennis | 6 108 / 7 939 = 76,9 % | 24,3 | 20,0 min |
| Football américain | 4 411 / 9 835 = 44,8 % | 110,0 | 21,8 min |
| Football | 20 119 / 46 317 = 43,4 % | 20,4 | 21,9 min |
| Basketball | 2 452 / 4 713 = 52,0 % | 41,9 | 23,0 min |

**Attention :** marchés sur deux issues != paires garanties profitables ni positions simultanément couvertes.

## 3. Timing par rapport au coup d'envoi réel (source Gamma)

| Sélection | Événements observables | Première exécution médiane par rapport au coup d'envoi | Première exécution dans [0,5 min) après début |
|---|---:|---:|---:|
| 600 événements très actifs (531 observables) | 531 | **+0,45 min** | **247 / 531 = 46,5 %** |
| 600 événements hash-aléatoires hors top 600 (536 observables) | 536 | **+14,28 min** | **77 / 536 = 14,4 %** |

Dans les événements très actifs observables : **NFL 88 / 96 = 91,7 %** ont le premier fill [0,5 min) ; esport 81 / 175 = 46,3 % ; football 69 / 186 = 37,1 % ; tennis 4 / 22 = 18,2 %. Ces sous-groupes sont **sélectionnés par nombre de fills** ; la différence n'est ni un effet causal, ni une statistique représentative de tous les événements. Les timestamps Gamma et les premières exécutions archivées ne révèlent pas quand le trader **a posé l'ordre**.

La moyenne brute des minutes n'est pas interprétable, car des événements comportent des exécutions pré-match éloignées ; privilégier médianes, quantiles et tranches. Chaque catégorie d'horaire devrait aussi être rapportée aux opportunités de fills du marché et à la durée du match pour mesurer un véritable effet de timing.

## 4. Attribution économique conditionnelle (étude complémentaire)

Sous-ensemble distinct et très sélectionné : **22 185 marchés à deux issues et remboursement rapproché**, entre le 21 septembre et le 12 novembre. `brut = remboursé/fusionné - achats`. `composante paire = min(q0,q1) × (1 - avg_cost0 - avg_cost1)` ; le reste est une composante directionnelle résiduelle.

| Sport | Marchés de la cohorte | Brut USDC | Paires USDC | Directionnel USDC | Brut / achats (pas ROI capital) |
|---|---:|---:|---:|---:|---:|
| Football | 12 467 | +313 432 | +1 124 775 | −811 342 | +0,813 % |
| Tennis | 2 933 | +89 700 | −322 351 | +412 051 | +0,263 % |
| Football américain | 2 563 | +509 024 | +152 458 | +356 566 | +2,992 % |
| Esport | 960 | +30 476 | +319 356 | −288 880 | +0,270 % |
| Basketball | 1 608 | +19 675 | +1 612 | +18 063 | +1,135 % |

**C'est la raison pour laquelle classifier RN1 simplement « spécialiste des paires » serait trompeur : la contribution paire/directionnelle change de signe suivant le sport.** Attention au biais de sélection de marchés rapprochés : les positions mono-issue et marchés sans REDEEM ne figurent pas dans ce tableau. Ce ne sont pas les ROI nets par sport. Les résultats historiques, même positifs, n'établissent pas une rentabilité exécutable par copy trading.

## Hypothèse falsifiable de stratégie

1. **Sélection** : marchés sportifs actifs, surtout football/tennis/esport/NFL, avec mix gagnant/over-under/spread.
2. **Timing d'entrée** : intensité particulièrement forte autour du début réel de certaines rencontres, **surtout les matchs NFL très actifs**, mais RN1 n'intervient pas toujours à ce moment ; le calendrier de matchs agit comme facteur de confusion.
3. **Cotation** : plutôt maker et répétitions de fills sur les deux issues, avec taille initiale généralement petite à l'échelle de la position finale, acceptant des intervalles de plusieurs minutes sans deuxième jambe.
4. **Payoff** : composante de paires positive dans certaines classes et risques directionnels parfois très grands ; la contribution nette des incentives reste substantielle.
5. **Borne d'identifiabilité** : pas d'historique public complet des ordres envoyés, annulés, non remplis, ni de la priorité de file. Impossible d'inférer un algorithme de placement exact et fiable **à partir des seuls fills**.

## Où consulter et réutiliser les résultats

Cloud : https://lazizmax.github.io/polymarket-intelligence/ → onglet **RN1 · Patterns**. Filtres interactifs sport, type de marché, dénominateur/mesure et sélection événementielle. Distribution des prix par tranche de cinq points, tailles de fills, heures UTC, délais de double-issue. Backend privé : action `rn1_setup_patterns` de `pi-dashboard`.

Traçabilité : `pi.rn1_pattern_jobs` (`complete`, 756 pages, SHA source vérifié), `pi.rn1_pattern_page_stats`, `pi.rn1_pattern_market_entries`, `pi.rn1_event_schedule` (1 200 événements Gamma), fonctions `pi.rn1_sport_group`/`pi.rn1_market_group`. Ces tables sont privées avec RLS et sans droits SELECT pour anonymous/authenticated.

Les deux collecteurs de ce profil ont été arrêtés une fois complets ; le site lit désormais directement les résultats stockés, sans rescanner l'historique.
