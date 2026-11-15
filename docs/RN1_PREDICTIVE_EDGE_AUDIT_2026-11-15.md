# RN1 — Test direct de la stratégie (15 novembre 2026)

Portefeuille public : `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`.

## Question de recherche

Le trader gagne-t-il par **couverture YES/NO**, par **exécution favorable / récompenses maker**, ou parce qu'il sélectionne les bonnes issues à **des probabilités meilleures que celles du marché** ?

Ne pas confondre : *transactions observées*, *scénarios contre-factuels de conservation*, *retour réalisé par RN1* et *espérance de gain reproductible*.

## Sources et échantillons

- **Trade feed** `/v2/trades?user=...` : 4 000 BUY récents, 840 marchés, du 12 au 15 novembre 2026 UTC. Archive brute : `pi.rn1_trade_pages`. Le pilote à 4 000 lignes n'est PAS la vie entière du trader.
- **Oracle** `/v2/resolutions?condition=...` : **840** marchés interrogés, dont **822** résolus avec une paire de payouts de somme 1 million de micro-USDC; **3 978 BUY** éligibles, tous antérieurs à leur résolution. Archive des payloads : `pi.rn1_resolution_evidence`. 18 marchés sont exclus du résultat chiffré faute de règlement binaire exploitable.
- **Prix** `/v2/prices-history?token_id=...&start=...&end=...` : les **80 marchés ayant les coûts d'achat les plus élevés parmi les marchés d'au moins 5 fills**, 159 tokens, 21 680 prix observés, **1 373 fills**. Requêtes/réponses originales dans `pi.rn1_price_history_evidence`, 21 680 observations dans `pi.rn1_historical_price_points` et 1 373 associations avec transactions dans `pi.rn1_fill_price_benchmark`. Ces 80 marchés représentent **437 971,04 $ / 658 548,61 $ = 66,5 %** des dollars achetés du pilote.
- **Activités économiques** `/v2/activity` : remboursements REDEEM, MAKER_REBATE, TAKER_REBATE et TRADE dans une fenêtre de dates **différente** ; ne pas additionner à un PnL des autres jours sans preuve d'appariement.

## Résultat 1 — hypothèse « acheter les deux issues sous 1 »

Pour chaque marché résolu, agréger les quantités achetées et les coûts observés de chaque issue.

- Cout total des achats admissibles : **656 828,39 $**.
- Valeur finale des parts achetées si **toutes** avaient été conservées : **691 637,69 $**.
- **Résultat brut hypothétique : +34 809,30 $, soit +5,30 %**.
- Paires parfaitement équilibrées : `min(Q0,Q1)` shares ; décomposer leur contribution à prix moyens d'achat par issue : **+1 337,66 $**.
- Quantités résiduelles non appariées, évaluées au règlement selon l'issue gagnante : **+33 471,64 $**.

Ces montants ne sont pas le PnL réel de RN1 : une vente, fusion, transfert, inventaire antérieur, position fermée ou frais change ces nombres. La composante « paires » est une allocation moyenne mathématique des achats, **pas** la preuve d'une paire économique verrouillée.

## Résultat 2 — l'avantage directionnel n'est pas démontré

Pour les 80 plus gros marchés, prendre **le tout premier fill observé par marché**, puis le dernier **bucket terminé** avant ce fill, au plus 120 secondes auparavant, et le payout oracle final :

- **43** premiers choix gagnants contre **39,805** victoires attendues selon les probabilités de référence observées.
- Écart = **3,195** choix gagnants. L'écart divisé par un écart-type binomial naïf (~4,229), en traitant à tort les marchés comme indépendants, vaut **z ≈ 0,76** : insuffisant pour défendre un avantage.
- Les 80 marchés correspondent à seulement **26 événements sportifs distincts**, donc les tests d'indépendance basés sur 80 observations sont trop optimistes.
- Le premier choix de RN1 ne permet **pas** de conclure qu'il prévoit mieux les résultats que le marché.

## Résultat 3 — markout à 15 min et concentration

Prix de référence : `timestamp + resolution_seconds <= fill_timestamp`. Le prix de référence a en moyenne **30,9 secondes de retard**, car il est publié par buckets d'une minute. Ce **n'est pas** un BID/ASK réellement accessible. Prix futur : bucket commençant au moins 15 min après l'achat, **achevé avant la résolution**.

| Sous-échantillon | Marchés | Fills | Coût des achats | Scénario brut au règlement | Markout 15 minutes vs. fill |
|---|---:|---:|---:|---:|---:|
| 20 plus gros | 20 | 677 | 322 815,53 $ | +40 672,20 $ | +29 230,81 $ |
| 60 suivants | 60 | 696 | 115 155,51 $ | −2 428,71 $ | −27,77 $ |
| Total | 80 | 1 373 | 437 971,04 $ | +38 243,49 $ | +29 203,04 $ |

Les achats sont suivis d'une hausse à 15 min dans seulement **49,96 %** des cas. La performance pondérée est concentrée sur les plus gros marchés. Les achats se font souvent au-dessus du prix historique juste avant le fill (le décalage et les fluctuations du live rendent l'identification maker/taker **impossible** depuis cette référence). Une hausse après achat ne prouve ni un signal causal ni un prix réellement négociable.

## Autres observations contrôlées

- **4 000 fills** : 1 316 réduisent le déséquilibre de shares YES/NO, 2 679 l'augmentent et 5 ne le changent pas.
- Sur les **466 marchés résolus avec les deux côtés achetés**, seuls **36** avaient un solde brut d'achats global garanti positif dans les deux scénarios, indépendamment des autres mouvements.
- Dans ces 466 marchés, RN1 finit avec davantage de shares sur une autre issue que son premier choix dans **180** cas ; le choix final majoritaire gagne **244** fois, contre **253** premières issues gagnantes. Pas de preuve que le simple basculement ait amélioré le taux de réussite.
- Environ **84 % des montants d'achat** dans les marchés résolus sont engagés entre **1 et 4 heures avant la résolution**, cohérent avec une intervention proche / potentiellement pendant l'événement, sans prouver l'heure exacte de début du match.
- Des `MAKER_REBATE` et `TAKER_REBATE` ont été observés dans `/v2/activity`, mais leurs périodes de comptabilisation ne sont pas attribuées fill par fill.

## Diagnostic actualisé

**Meilleur modèle descriptif** : algorithme sportif de forte rotation qui accumule les deux côtés à des instants différents, choisit dynamiquement ses quantités, accepte une exposition directionnelle importante et bénéficie potentiellement des tarifs / récompenses d'apport de liquidité.

**Non démontré** : un modèle statistique de pronostics sportifs meilleur que celui du marché, la part nette de maker/taker, une EV reproductible, la politique exacte de choix des prix / tailles.

Pour avancer scientifiquement : rapprocher l'ensemble des transactions/activités sur la même fenêtre, reconstruire inventaire et règlements token par token, obtenir des snapshots de carnet *au moment du trade*, et tester les signaux hors-échantillon sur plusieurs centaines d'**événements indépendants**. Les 26 événements du test de prix sont insuffisants.

## Intégrité et méthode de reproduction

Les recherches sont stockées dans les tables privées RLS du schéma `pi` via les migrations `023`, `024`, `025`. Script `sql/026_rn1_price_benchmark_backfill.sql` réapplique les règles causales, avant une comparaison en lecture seule via l'API authentifiée `rn1_strategy_evidence`. Aucune API de placement d'ordre ou clé de trading n'est utilisée.

Sources officielles : [Data API V2](https://data-api.polymarket.com/v2/docs), [Polymarket CLOB documentation](https://docs.polymarket.com/).
