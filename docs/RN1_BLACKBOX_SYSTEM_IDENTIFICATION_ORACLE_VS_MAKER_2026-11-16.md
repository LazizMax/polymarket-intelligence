# RN1 — Identification de système en boîte noire : market making, oracle externe ou modèle hybride
**Protocole d'ingénierie, 16 novembre 2026 · lecture seule · hypothèses à falsifier**

## 0. Décision d'architecture et anti-objectif
Nous cherchons la **machine de décision** de RN1, pas une collection de corrélations et pas le code privé octet par octet. Une règle programmée peut apparaître probabiliste si des entrées privées manquent (odds, file d'attente, ordres ouverts, capital, interruptions, hasard). Les fills visibles sont des **sorties d'un processus censuré** : `ordre -> attente -> exécution/annulation`. L'absence de fill n'est pas nécessairement une décision de ne pas placer d'ordre.

**Priorité expérimentale absolue** : comparer, sur les **mêmes situations antérieures à la décision**, trois moteurs complets, puis rechercher quels composants supplémentaires améliorent objectivement la prédiction **sur de nouveaux événements**. Ne plus tester isolément 20 règles de sizing avant d'identifier le mécanisme générateur.

## 1. Les trois architectures concurrentes

### M0 — Fournisseur de liquidité / paire / rebates, sans signal externe de juste valeur
Entrées : carnet Polymarket (bid, ask, depth, tick), bid/ask des deux issues, phase de match, exposition propre, potentiel de rewards et frais, budget. Décision : coter passivement les deux côtés, chercher la marge sur les paires, réduire le déséquilibre et modifier l'activité selon la liquidité. Le prix de référence est dérivé **uniquement du marché Polymarket**.

**Signatures réfutables** : (a) le prix et l'activité s'expliquent par spread, profondeur, coût YES+NO, déséquilibre et rewards ; (b) un signal externe n'améliore pas le modèle hors événements d'apprentissage ; (c) renouvellement de prix et tailles autour de niveaux de carnet, sans avance systématique sur des mouvements exogènes.

### M1 — Chasseur de mauvaise valorisation, avec oracle de probabilité externe
Entrées : une juste valeur indépendante `p_ref(t)` (par exemple consensus de bookmakers dévigés, prix d'un autre exchange, ou modèle sportif propriétaire), carnet Polymarket, coûts et risques. Une divergence **de signe et magnitude** prédit l'issue achetée, la fréquence, le prix limite et la taille.

**Signatures réfutables** : (a) RN1 intervient davantage lorsque `edge = p_ref - prix_accessible - coût` est grand et dans le bon sens, **à carnet/phase/inventaire comparables** ; (b) ses décisions changent après mouvement de `p_ref` avant mouvement Polymarket (ordre temporel vérifié), (c) M1 améliore les prédictions hors événements et pas uniquement le markout mécanique d'un ordre Maker exécuté au bid.

### M2 — Market making guidé par une valeur juste, avec contrôle d'inventaire
Architecture candidate **prioritaire à tester, non affirmée** :
```text
p_ref = fair_value(external_odds?, score?, game_clock?, Polymarket_state?)
net_inventory = shares_yes - shares_no
reservation_value = p_ref - lambda_inventory * normalized_inventory
target_bid = tick_floor(reservation_value - margin(spread, volatility, fees, rewards, latency))
target_size = sizing(estimated_edge, available_liquidity, event_exposure, open_order_budget)
state = {inactive, two_sided_quoting, one_sided_accumulation, rebalance, stop}
if eligible_market AND limit_risk_ok AND expected_maker_value > min_edge:
    place_or_refresh_limit_order(target_bid, target_size)
else:
    do_not_quote_or_cancel()
```
Ce pseudocode est un **gabarit à tester**, pas du code RN1 retrouvé. Il est parfaitement possible que M0 ou M1 seuls suffisent.

**Pourquoi cet ordre de comparaison ?** RN1 a une composante économique liée à l'exécution Maker, aux deux issues et aux récompenses. Il faut l'expliquer avant d'invoquer un modèle prédictif sportif externe, puis tester si cet oracle apporte un signal **additionnel**.

## 2. Jeu d'observations réellement disponible au contrôle

- **Historique figé** : 756 000 fills auditables, dont 674 459 Maker (~89,214 %) et 81 541 Taker (~10,786 %) ; **ne pas réimporter**. Historique *sans carnet exact* à la milliseconde du placement d'ordre.
- **Pilotage de prix indépendant** `pi.rn1_independent_price_jobs` : état `complete`, 756 pages vérifiées, échantillon déterministe de 33 237 fills BUY, dont 29 731 Maker et 3 506 Taker ; futures séries de prix publiques à 1/5/15/30/60 minutes. Ce sont des **markouts** incluant le prix d'exécution et possiblement impact de RN1, pas une juste valeur indépendante du marché.
- **Sondes carnet + positions** : 437 sondes `position_status='complete'` au dernier contrôle, échantillonnage tournant d'environ 8 marchés par minute ; 6 140 observations de carnet valides sur 247 marchés et 76 événements dans la requête croisée.
- **Rapprochement live** : 493 fills Maker inférés, dont 408 ont au moins une cotation du même token **strictement postérieure au fill et dans les 2 minutes**. Cela démontre la possibilité d'un premier diagnostic de markout, **pas** l'identification de leur ordre limite originel.
- **Événements sportifs** : `rn1_nba_espn_plays`, `rn1_nba_espn_scoreboards`, 47 liens `rn1_nba_espn_links` ; le timestamp d'une action dans un play-by-play historique n'est pas la preuve que RN1 pouvait la recevoir à cet instant.
- **Référence bookmaker externe** : aucune source indépendante et horodatée **identifiée dans les tables RN1 inspectées**. Ce manque est le **goulot de preuve** pour la théorie d'un oracle.
- **Audit économique antérieur** : 22 185 marchés à deux issues rapprochés ; rebates/rewards = environ 43 % de la variation économique de PnL sur la fenêtre publiée, ce qui rend M0/M2 crédibles mais ne démontre ni l'un ni l'autre.
- **Important** : les 4 000 trades historiques du pilote `pi.trades` provenaient d'un endpoint avec défaut `taker_only` ; ne jamais les réutiliser comme échantillon de la politique Maker.

Les compteurs live augmentent, ne pas mélanger horizons, provenance, univers ni dénominateurs.

## 3. Données à aligner en *event time*

Une ligne d'état canonique **`(event_id, market_id, token_id, t_decision, state_age, source_quality)`** et un futur **strictement exclu des features**.

Entrées obligatoires **observées AVANT décision** :
- `p_market_yes/no`, bid/ask, spread, tick, depths, last trade, changements de livre, book receipt timestamp, qualité et latence ;
- inventaire des deux issues, coût d'entrée, ordre de dernière activité, exposition événement *observée* (pas de fausse bankroll) ;
- phase sport (pregame/live/period/remaining clock), score et horodatage **de réception** du message, pas uniquement le temps officiel de jeu ;
- éventuelles odds externes exactes avec `source, published_at, received_at, market_definition, outcome, decimal_odds, freshness, overround` ;
- potentiel de fees/rebates/rewards effectivement applicable avec version de règle.

Sorties séparées :
`P(aucune exécution)`, `P(BUY YES)`, `P(BUY NO)`, `P(SELL)`, taille et prix des **fills**, état d'inventaire suivant. Ne pas les baptiser intention de placer/annuler un ordre Maker.

**Modèle de référence externe** : pour une cote décimale `O_i`, `q_i=1/O_i`, `p_ref_i=q_i / SUM(q_all_outcomes)` comme première correction du vig. C'est une approximation, pas une probabilité vraie. Comparer uniquement les marchés à **même contrat de résolution** : prolongation oui/non, 2-way vs 3-way, spreads/handicaps, totals et lignes exactes. Ne pas utiliser un match historique connu en 2026 pour déduire rétrospectivement une information disponible avant publication.

**Attention au terme « oracle »** : le *resolution oracle* de Polymarket règle le marché après l'événement ; il ne donne **pas** les probabilités live dont parle cette hypothèse. On teste ici un **pricing/reference oracle** hypothétique.

## 4. Les expériences capables de distinguer M0, M1 et M2

| Test | Discrimination recherchée | Comparaison et falsification |
| --- | --- | --- |
| T0 : marché éligible vs marché traité | Pourquoi RN1 choisit-il ce marché plutôt qu'un autre ? | panel marché × fenêtre, y compris marchés témoins sans fill ; éviter de sélectionner les marchés uniquement parce que RN1 y a tradé |
| T1 : divergences d'odds | Suit-il un `edge = p_ref - p_market` ? | même phase, spread, profondeur, prix et inventaire ; M1/M2 doivent ajouter de l'information face à M0 ; contrôler la fraîcheur |
| T2 : choc exogène | L'algorithme réagit-il au bookmaker **avant** Polymarket ? | étudier mouvements de bookmaker non encore reflétés dans le carnet, puis réactions de RN1 ; si seulement Polymarket bouge, pas de preuve d'oracle |
| T3 : instrument miroir YES/NO | Rééquilibre-t-il plutôt qu'anticiper le sport ? | comparer le côté choisi à `net_inventory` et à `edge`, et leurs interactions ; ablation de chaque variable |
| T4 : paires et economics | Recherche-t-il un rendement de paire passif ? | `bid_yes + bid_no` exécutable, profondeur, queue, frais et rewards ; ne pas confondre deux fills réalisés et exécution simultanée garantie |
| T5 : règles à seuils | Existe-t-il un `if` sur edge, spread, risque ou temps ? | arbres très peu profonds, régression à seuil, détection de discontinuités locales ; seuils pré-enregistrés après apprentissage, testés **sur événements nouveaux** |
| T6 : états cachés | Passe-t-il de quote à rebalance puis stop ? | HMM/change-point ou automate à états peu nombreux, transitions conditionnées par phase et inventaire ; comparer à modèle sans états |
| T7 : signature des tailles | Formule de sizing après identification du régime | seulement alors, comparer shares fixes, USDC fixes, `edge × cap`, position risk cap, profondeur, price bucket ; groupes d'ordres **proxy** avec robustesse aux gaps 1–60 s |
| T8 : test économique final | La théorie produit-elle un avantage copiable ? | paper trading prospectif, limites effectivement exécutables, latence, frais/rebates authentiques, queue/partials, risque directionnel et comparaison à rien faire |

**Expérience la plus informative** : variation de probabilité chez le bookmaker alors que le prix Polymarket, le spread et l'inventaire sont quasiment inchangés. Si RN1 réagit systématiquement **avant** que Polymarket se réajuste, M1/M2 gagnent du crédit. Sans odds historiques horodatées, cette expérience est impossible et ne doit pas être simulée avec un prix futur.

**Contrefactuels** : marchés témoins non sélectionnés par RN1, fenêtres sans fill dans les mêmes marchés, et trades comparables d'autres acteurs si disponibles et correctement licenciés. Pas de conclusion de « signal » depuis `E[future price | RN1 filled]` seul : c'est une sélection post-exécution.

## 5. Méthode d'apprentissage / sélection des règles

1. **Registre de modèles avant l'analyse** avec équations et prédictions. M0 (carnet+inventaire+rebate), M1 (+ odds externes), M2 (+ interactions oracle/inventaire) ; à côté, modèle simpliste `buy-frequency/market-activity` et `market-only` pour ne pas battre uniquement un homme de paille.
2. **Validation imbriquée sans fuite** : train passé, choix des seuils par validation temporelle, test sur événements entiers exclus et période future ; mêmes lignes éligibles pour tous les modèles ; bootstrap clusterisé par **événement/match**, pas par fill.
3. **Ordre des prédictions** : marché activé → présence d'une exécution → côté (YES/NO) → prix relatif au carnet → quantité → changement d'inventaire. Toujours garder la **probabilité d'aucun fill**. Le placement des ordres non exécutés reste latent.
4. **Mesures** : probabilité d'activité (log loss, Brier, PR-AUC et calibration) ; côté (log loss, Brier, confusion) ; prix (MAE en ticks par rapport au bid/ask prétrade) ; taille (erreur multiplicative/MAE log) ; changement d'état (accuracy, Brier). Comparer les gains de log loss avec intervalles event-clustered.
5. **Découverte contrôlée de règles** : détecter seuils, tailles discrètes, délais et transitions via arbres de profondeur 1–3, symbolic regression parcimonieuse et HMM simple ; tester sur marchés/événements **inconnus**. Ne pas créer une nouvelle hypothèse après chaque cas raté sans lui réserver un nouveau jeu de test.
6. **Ablations et complexité** : M2 n'est retenu que si les odds externes ou l'état latent ajoutent un gain robuste qui résiste à l'ablation et justifie leur complexité. Si M0 suffit, on ne prétend pas qu'il n'existe aucun oracle privé : on dit « pas nécessaire pour expliquer les données visibles ».
7. **Signature conditionnelle, pas identité de code** : un modèle performant ne démontre jamais le langage, le fournisseur ni la formule exacte de son bot. Résultat classé `refuté / compatible / ajoute du pouvoir prédictif / robuste hors événement / non identifiable`.

## 6. Travaux d'ingénierie à prioriser et critères de sortie

**P0 — Audit / jeu canonique** : terminer le catalogue des surfaces accessibles, l'horodatage strict et les cases de couverture (fill vs book vs position vs sport vs odds). Inclure les séries historiques déjà calculées, pas de nouveau replay 756k. Livrable : matrice « variable / source / temps / exactitude / volume ». Toutes les lignes avec source ou book postérieurs à la décision sont exclues du modèle.

**P1 — Oracle/reference feed** : acquisition légale/licenciée et historisée de bookmaker sharp/consensus à l'heure de l'événement, ou capture prospective dès maintenant ; **ne pas acheter d'abonnement ou augmenter les quotas sans instruction du propriétaire**. Dévig, aligner les contrats et noter leur fraîcheur. Si la référence est introuvable, garder M0 comme base et marquer M1 « non testable », pas « réfuté ».

**P2 — Épisodes à haute valeur d'information** : sélectionner des marchés pré-définis actifs et témoins par échantillonnage **indépendant de RN1**, puis capter leurs carnets en flux public WebSocket et les scores live avec temps de réception. Éviter de déduire un prix limite initial des seuls fills ; la sonde REST 1/min est trop grossière pour les micro-signaux. Nécessite un collecteur persistant distinct du frontend statique et de l'Edge cron courte durée ; plafonds de débit/coût/stockage explicites. Stockage compressé des deltas uniquement, tables SQL agrégées.

**P3 — Modèles rivaux** : construire M0/M1/M2 sur le panel canonique avec *risk set* de périodes sans fill ; scores exacts, CIs, holdout événementiel et temporel, ablations. Première analyse doit départager **oracle vs pas oracle**, pas produire une centaine de courbes sans direction.

**P4 — Extraire « code probable »** : traduire le meilleur modèle parcimonieux en pseudocode annoté, avec chaque branche reliée aux décisions correctement prédites et aux contres-exemples. Branches non identifiables explicitement indiquées.

**P5 — Dashboard RN1 · Moteur** : panneau principal « Architecture en tête : M0/M1/M2 », gain prédictif hors événement et couverture ; diagramme des transitions, seuils estimés et confiance, trace d'une décision individuelle avec valeurs connues au temps t, contre-exemples et mise à jour des verdicts. Le moteur tourne côté cloud, pas dans des scripts que l'utilisateur doit manipuler.

**P6 — Simulation non-tradante** : shadow quoting avec carnet/historique réellement observés, latence, probabilité de fill, frais et rewards ; comparer un modèle rentable sur paper trading à la politique Maker naïve. Ne pas passer d'ordres réels sans accord distinct.

## 7. Interdictions méthodologiques
- Traiter un fill Maker au bid comme preuve que RN1 prédit bien le résultat sportif ; il peut simplement vendre de la liquidité et toucher les rebates.
- Déclarer un oracle externe parce que le prix bouge après un fill RN1 ; l'edge doit survivre à la comparaison à un pur Maker et aux fenêtres témoins.
- Utiliser un score ou une cote **publiée après** une décision en les habillant de timestamp d'événement.
- Mélanger M1 prégame avec odds live périmées ou marchés à règles de prolongation différentes.
- Inférer les ordres non exécutés, annulations, file ou capital privé des données de fills publiques.
- Segmenter ad infinitum jusqu'à un résultat significatif ; correction multiplicité, registre et holdout fermés.
- Saturer Supabase ou payer un prestataire sans permission ; ne jamais détruire les archives existantes.

## 8. Sources publiques de faisabilité (consultées le 2026-11-16)
- Polymarket API et canaux de données : https://github.com/Polymarket/agent-skills/blob/main/SKILL.md
- WebSocket Market public, WebSocket Sports public ; **User WS nécessite l'authentification du wallet concerné et n'est pas accessible pour RN1** : https://github.com/Polymarket/agent-skills/blob/main/websocket.md
- Dévig des odds et limites de fraîcheur d'un bookmaker : https://odds.observer/methodology
- Audit interne économique : `docs/RN1_STRATEGY_VERDICT_2026-11-15.md`
- Markouts archivés : `docs/RN1_INDEPENDENT_MARKOUT_RESEARCH_2026-11-15.md` et `pi.rn1_independent_price_jobs`
- Ancien protocole d'hypothèses : `docs/RN1_HYPOTHESIS_DRIVEN_RESEARCH_PROTOCOL_2026-11-16.md`
