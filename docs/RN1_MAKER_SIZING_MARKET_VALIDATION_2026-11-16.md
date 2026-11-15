# RN1 — Validation du sizing Maker hors marchés d'entraînement
**16 novembre 2026 · recherche exploratoire, sans transactions réelles**

## Question
RN1 utilise-t-il un montant fixe en USDC, un nombre fixe de parts, un montant dépendant de la cote, un ajustement de son inventaire YES/NO ou une fraction du capital déjà engagé sur le même marché ?

**Limite essentielle :** une transaction publique est un *fill*, pas la taille initiale de l'ordre Maker. Une limite peut être exécutée par fragments ou rester non exécutée ; les ordres annulés ou privés ne sont pas visibles.

## Sources et provenance
- `pi.rn1_quote_probe_fills` : exécutions Maker **inférées** en rapprochant les données CLOB et les archives publiques.
- `pi.rn1_quote_probe_runs.positions` : les deux positions publiques ouvertes sur un marché, récupérées avant le snapshot de carnet et avant le fill.
- Filtrage strict : `role='maker_inferred'`, `side='BUY'`, `0,005 < price < 0,995`, `shares>0`, deux tokens de position distincts, `cost>0`, **`position_observed_at <= received_at < trade_at`** et âge des positions au fill **≤60 secondes**.
- Résultat au contrôle : **346 fills**, **66 marchés distincts** et environ 90 tokens, selon les sondes live disponibles au moment du calcul.
- Les 756 000 fills du **lot figé historique** servent à la distribution globale de montants, mais ne sont **pas** utilisés comme observations de taille avec inventaire pré-fill. Une collecte supplémentaire est en cours dans les flux `trades_all` et `activity_all` ; ne pas la confondre avec le lot figé.

## Protocole hors marchés
Cinq plis déterministes fondés sur le hachage du **market_key**. Les deux tokens YES et NO du même marché ne peuvent pas être simultanément dans l'entraînement et la validation. Chaque pli teste sur un ensemble de marchés absent de l'entraînement ; il réentraîne tous les paramètres à partir des autres plis.

Comparer neuf règles simples :
- quantité globale fixe en parts ;
- mise globale fixe en USDC ;
- parts ou USDC dépendant de la cote (cinq tranches de 20 centimes) ;
- parts ou USDC dépendant de la cote **et** du côté sous/surpondéré en parts ;
- parts ou USDC dépendant de la cote **et** du coût déjà immobilisé dans des positions ouvertes sur ce marché ;
- fraction constante du coût des positions du marché (ce qui n'est PAS une fraction de bankroll).

Les groupes d'entraînement avec moins de cinq observations retombent sur le modèle de la cote, puis sur le modèle global. Les prédictions sont évaluées **sans ajustement sur le pli test**.

Métrique principale : moyenne des valeurs absolues de `ln(taille_observée / taille_prédite)` sur les fills testés, **plus faible = meilleur**. Le facteur d'erreur médiane est `exp(médiane des erreurs log absolues)` ; un facteur ×5,7 indique un écart d'ordre 5,7 entre taille réalisée et prédite, ou l'inverse, pas une erreur de 5,7 %.

| Règle | Erreur log moyenne | Facteur d'erreur médiane |
|---|---:|---:|
| Parts selon la cote | **1,970** | **×5,67** |
| Parts selon la cote + inventaire | 1,994 | ×6,11 |
| USDC selon la cote | 2,004 | ×5,76 |
| Parts fixes globales | 2,009 | ×7,95 |
| USDC selon la cote + inventaire | 2,037 | ×5,73 |
| USDC selon la cote + coût ouvert | 2,101 | ×6,24 |
| Parts selon la cote + coût ouvert | 2,120 | ×7,04 |
| USDC fixes globaux | 2,229 | ×8,37 |
| Fraction constante du coût ouvert | **2,652** | **×10,70** |

**Conclusion :** parmi ces règles simples et sur cet échantillon de marché, la quantité en parts ajustée grossièrement à la cote minimise l'erreur *moyenne*, mais une erreur médiane ×5,67 n'est pas une précision exploitable. L'ajout d'inventaire ne procure pas ici de gain convaincant. En raison de l'échantillonnage sélectif, des petits effectifs par marché et des fragments d'ordres, ce tableau ne révèle pas l'algorithme privé de placement.

### Analyse chronologique complémentaire
L'autre test (`rn1_sizing_hypotheses`) coupe les observations **dans le temps à l'intérieur de chaque token** (70 % apprentissage / 30 % validation), sur 13 tokens ayant suffisamment de fills et un mouvement de prix ≥3 centimes pendant l'apprentissage. Il couvre environ **54 à 55 fills de test**, un effectif limité. La pente empirique `log(shares)` vs `log(price)` sur fills individuels est autour de −0,25, mais elle passe aux environs de −1,05 après regroupement des fills du même token par seconde. **La pente n'est pas stable face à la fragmentation**.

Ces deux protocoles répondent à des questions différentes :
- *Validation temporelle* : tient-elle lorsque le même token continue de coter plus tard ? Le prix futur n'est pas utilisé pour calibrer le même token.
- *Validation inter-marchés* : tient-elle sur des matchs non présents dans l'entraînement ? Les données d'entraînement des autres marchés peuvent néanmoins être postérieures aux fills de test : ce protocole n'est donc **pas** un backtest chronologique prospectif.

## Interprétation et limites
1. Les snapshots d'inventaire ne sont pas la bankroll libre, et le coût d'achat ouvert n'est pas une mesure complète de valeur du wallet.
2. Les montants des fills reflètent l'arrivée de contreparties, la profondeur et le fractionnement, en plus des décisions potentielles de RN1.
3. Les observations d'un même marché/temps ne sont pas indépendantes. Les modèles n'identifient ni probabilité de remplissage ni taille des ordres non remplis.
4. La sélection des marchés sondés est liée aux marchés récemment actifs de RN1, d'où un fort biais potentiel.
5. Plusieurs modèles ont été comparés a posteriori : l'option gagnante peut refléter le hasard ou les caractéristiques de l'échantillon.
6. Aucune analyse d'edge net copiable, de rendement réel sur capital ou de pertes extrêmes n'est déduite de ces comparaisons.

## Implémentation dans l'application
- Backend déployé `pi-dashboard`, action en lecture seule `rn1_sizing_market_validation`.
- Frontend `web/index.html`, onglet **RN1 · Money management** → **Tester les formules possibles de sizing** → **Validation hors marchés connus**.
- Les scores, effectifs et limites sont recalculés depuis les sondes publiques disponibles à chaque ouverture de la section.
- Tests de contrat `tests/test_rn1_sizing_market_validation.py`, JavaScript vérifié par `node --check` en CI.
- Aucune table volumineuse supplémentaire, aucune reprise des 756 pages initiales et aucune transaction réelle.

## Test discriminant suivant
Pour inférer la **politique de placement** plutôt que la distribution des remplissages, il faut un journal de carnets CLOB public plus fin et des hypothèses prospectives de quotes, avec exposition et non-exécution. Les horodatages de dépôts/annulations privés restent inaccessibles. Pour inférer la politique de risque, reconstruire séparément les plafonds d'exposition simultanée et de pertes par événement, sans jamais présenter le turnover cumulé comme bankroll.
