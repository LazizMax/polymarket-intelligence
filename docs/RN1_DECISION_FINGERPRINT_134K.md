# RN1 — Rétro-ingénierie des exécutions (échantillon figé de 134 000)

**Source :** archives privées `trades_all` /v2/trades?user=<RN1>&start=1&limit=1000&taker_only=false, pages 1 à 134, du 30 octobre au 15 novembre 2026 UTC. Pages parcourues **de la plus ancienne à la plus récente**, SHA vérifié, 134 000 / 134 000 lignes validées, 19 997 conditions distinctes. À cette date, l'historique accessible n'est **pas encore totalement parcouru** par le collecteur général.

## Résultats mesurés

| Comportement des transactions exécutées | Résultat |
|---|---:|
| Total achats / ventes | 134 000 / 0 |
| Maker / taker d'après la comparaison au flux taker-only | 119 156 (88,92 %) / 14 844 (11,08 %) |
| Maker, moitié ancienne / plus récente | 94,02 % / 83,82 % |
| Marchés avec achats sur les deux issues | 8 759 / 19 997 |
| Marchés dont les shares achetées sont déséquilibrées de ≥2×, parmi les deux issues achetées | 5 791 |
| Achats comparables à un déséquilibre déjà observé | 114 003 |
| Achats de l'issue sous-accumulée | 45 952 (40,38 % des choix à déséquilibre non nul) |
| Achats de l'issue sur-accumulée | 67 858 (59,62 %) |
| Achats qui réduisent effectivement l'écart absolu de shares | 36,33 % des achats comparables |
| Achats qui augmentent l'écart absolu | 63,67 % |
| Même prix sur le même outcome quand deux fills sont à ≤5 min | 39 002 / 73 145 = 53,32 % |
| Première issue opposée observée (dans la fenêtre) | 8 759 marchés ; le groupe de délai le plus fréquent est 15–60 min |

La fraction d'achats *réduisant* l'écart est quasi identique en scindant les archives chronologiquement en deux moitiés indépendantes de pages : **36,31 % / 36,34 %**.

## Élément discriminant : comportement conditionnel au déséquilibre

Pour une transaction BUY, définir le `flux0 = somme BUY0 − somme SELL0` et symétriquement `flux1`, accumulés *uniquement* depuis le début de l'échantillon visible. Le déséquilibre relatif précédent vaut `|flux0−flux1|/(flux0+flux1)`, dans les cas où les flux observés sont non négatifs.

| Déséquilibre avant exécution | Fills comparables | BUY de l'issue minoritaire | Ratio sous-accumulée | Ratio ancien / récent |
|---|---:|---:|---:|---:|
| <10 % | 9 886 (dont 193 sans côté minoritaire) | 4 962 | 51,19 % | 50,20 % / 52,03 % |
| 10–50 % | 31 093 | 16 674 | 53,63 % | 53,55 % / 53,70 % |
| ≥50 % | 73 024 | 24 316 | **33,30 %** | **33,56 % / 33,03 %** |

**Interprétation descriptive :** lorsque les shares précédemment acquises sont fortement déséquilibrées, les exécutions renforcent le côté majoritaire environ deux fois plus souvent qu'elles ne couvrent le côté minoritaire. Cette différence est remarquablement stable entre les deux demi-échantillons. Elle est incompatible avec une règle simple qui chercherait à neutraliser chaque déséquilibre aussitôt qu'il apparaît.

**Limite fondamentale :** il s'agit d'une distribution d'**exécutions conditionnelles** et non de la distribution des ordres placés. Un bot peut proposer des offres des deux côtés et recevoir davantage d'exécutions sur le côté qui devient sous-évalué par les autres acteurs (*sélection adverse*). On ne peut donc pas déduire directement la formule de cotation, `p_fair` ni les coefficients de pénalisation d'inventaire sans les ordres non remplis et les carnets au même moment.

## Hypothèse d'algorithme désormais la mieux soutenue

1. **Apport de liquidité côté achat, pas market making classique bid/ask à achat/revente :** 88,9 % maker sur l'échantillon et aucun SELL dans le flux.
2. **Accumulation passive des deux issues lorsque des vendeurs exécutent les offres :** plus de 8 700 marchés affichent des deux côtés achetés, et environ la moitié des fills successifs sur une issue sont au même prix sur 5 min.
3. **Exposition directionnelle tolérée :** rééquilibrage non prioritaire à fort déséquilibre (33,3 % d'achats minoritaires, 66,7 % majoritaires), stable ancien/récent. Peut refléter les prix, l'information sportive, le carnet ou la sélection des fills.
4. **Règlement / récompenses comme sorties possibles :** `REDEEM` et `MAKER_REBATE` effectivement présents dans le flux d'activité, mais les coûts unitaires, merges/transfers et les périodes n'ont pas été rapprochés économiquement. **Aucun PnL net n'en est inféré.**

## Ce que l'étude ne prouve pas

- L'historique accessible complet (la collecte automatique continue, avec limites de stockage et état de progression visibles).
- Les ordres proposés **sans exécution**, les annulations, le temps en file, les tailles d'ordre initiales, ou la réponse exacte aux mouvements de carnet.
- Un modèle de probabilités sportives supérieur, une EV positive ou la formule privée du bot.
- Les positions token réelles après merges/redeems/transferts et achats antérieurs. L'écart de shares calculé est **une métrique de flux observé**, pas l'inventaire détenu.

## Contrôles d'intégrité et de reproductibilité

- Analyse `pi.rn1_sequence_jobs` : statut `complete`, 134/134 pages, 134 000/134 000 fills valides et zéro erreur.
- `pi.rn1_sequence_market_state` : 19 997 lignes.
- `pi.rn1_sequence_page_stats` : 134 lignes et hashes de pages originales.
- Chaque page passe une vérification de cohérence : la somme des bins `underweight`, `overweight` et `neutral` est égale aux statistiques globales. **134/134 conformes** après correction de la classification outcome 1.
- Les mêmes chiffres sont accessibles au tableau synthétique RN1 · Algorithme via `pi-dashboard` après authentification, sans publier les archives privées.

## Test décisif suivant

Obtenir des snapshots d'ordres historiques synchronisés avec les fills et un historique économique complet de positions/règlements, afin de tester des règles candidates par *événements sportifs indépendants* puis sur des périodes jamais vues.

Une règle de décision plausible à **tester** (non prouvée) : sélectionner pour chaque outcome un prix limite à partir d'une probabilité de référence, d'une marge minimale, du risque d'exposition et du risque de sélection adverse, puis fournir passivement les bids et réévaluer après les mouvements du marché. **Aucune valeur des paramètres n'est identifiée à partir de cette analyse.**
