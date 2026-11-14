# Audit du cahier des charges et recentrage sur une EV exploitable

Date : 14 novembre 2026  
Périmètre : code public du dépôt `main` (v2.0.0), cahier des charges initial de « Polymarket Quantitative Intelligence & Copy Trading ».  
**Verdict : outil de recherche exploratoire ; aucun avantage de copy trading exploitable n'est encore démontré.**

## 1. Mission non négociable

Transformer les transactions publiques de Polymarket en **règles de décision de trading**, validées hors échantillon et avec les prix que pourrait effectivement obtenir un copieur. Le classement historique est un moyen, pas une fin.

La métrique de décision doit être le **rendement net d'une stratégie copiée** sur un capital fictif fixé à l'avance, avec frais, spread, profondeur, délais, exécutions manquées et positions non clôturées. Aucun PnL positif, ROI sur positions closes, markout ou leaderboard ne constitue seul une preuve de rentabilité.

## 2. État du code audité

| Cahier des charges | Code existant | Statut |
| --- | --- | --- |
| Leaderboards et découverte | `research.py`, `historical_discovery.py` | Existant, biais de sélection à corriger |
| Historique par wallet | `historical_worker.py`, `historical_db.py` | Collecte paginée et incrémentale ; exhaustivité économique non prouvée |
| ROI sur mises | `historical_intelligence.py`, `quality_metrics.py` | Calcul pondéré conditionné aux snapshots, pas ROI sur capital réel |
| Classements par secteur | `strategy.py`, `historical_intelligence.py` | Descriptifs, classification partiellement heuristique |
| Reverse engineering | `strategy.py` | Hypothèses descriptives ; pas de règles d'entrée démontrées |
| Études de prix après trade | `price_study.py` | Markouts historiques, non exécutables par définition |
| Suivi et carnet prospectifs | `live_monitor.py` | Polling + snapshots après détection, lecture seule |
| Classement copie | `copy_ranking.py` | Rendement fictif à sorties fixes, non stratégie complète copiée |
| Validation hors-échantillon | Aucun pipeline intégré de sélection datée puis évaluation | **Bloquant** |
| Moteur de signaux autorisés après validation | Aucun | **Bloquant** |
| Tests GitHub | `tests/` réduit à quelques tests ; compilation et tests en CI | Couverture insuffisante des métriques trading |

Les indicateurs `closed_exhausted` et `open_exhausted` attestent de la fin de la pagination d'un endpoint, pas d'une réconciliation complète de la vie économique du wallet. Le `roi_capital_reel_pct` est explicitement `None` dans le code. Les positions ouvertes et les frais doivent être confrontés aux flux et au PnL officiels.

## 3. P0 — Comptabilité et qualité des données avant tout classement

**Objectif :** chaque wallet possède un bilan économique auditable.

1. Conserver une ligne d'événement brute avec provenance et identifiant de transaction ; reconstruire achats, ventes, split/merge, redemptions, transferts, récompenses et coûts.
2. Rapprocher la somme des PnL reconstruits des PnL officiels par wallet et à différentes dates ; exposer chaque écart.
3. Afficher distinctement : (a) PnL net réalisé ; (b) latent ; (c) rewards/rebates ; (d) ROI sur coût cumulé vérifié ; (e) rendement sur capital (indisponible sans ledger de cash-flow).
4. Ne pas mélanger résultats de positions closes, positions encore ouvertes et historique de trades incomplet. Sur un historique incertain, afficher `Non vérifié`.
5. Distinguer événement, marché et transaction ; regrouper les résultats par événement, mais identifier aussi les événements fortement corrélés.
6. Donner le statut `source vérifiée / heuristique / inconnue` aux catégories de marché.

**Validation :** sur un jeu fixé de wallets, chacune des opérations majeures doit être rapprochée d'une source primaire ou signalée manquante ; le tableau final comporte taux de couverture, écart de réconciliation, et aucune donnée manquante convertie en zéro.

## 4. P1 — Recherche de traders candidats (sans anticipation)

Créer des cohortes de wallets **connus à une date T** à partir des classements disponibles historiquement, complétées par des contrôles non gagnants. Geler la sélection ; réserver les transactions postérieures à T au test.

Classer par spécialité (sport, politique, crypto, économie, etc.), type de trading, ROI sur mises audité, volume, nombre d'événements indépendants, durée, concentration, drawdown et stabilité. Écarter ou séparer clairement les stratégies de market making, rebates, arbitrage ultrarapide et comptes à couverture externe inconnue.

Grouper les événements corrélés ; utiliser des intervalles de confiance et corriger les comparaisons multiples. Comparer à des wallets témoins sur les mêmes secteurs et périodes, et à des entrées naïves à prix et horaires similaires.

**Livrable :** une liste courte de 10–20 wallets avec *pourquoi*, *preuve historique* et *pourquoi leurs trades seraient copiables*.

## 5. P2 — Tester la stratégie économique la plus simple

**Hypothèse de départ :** suivre les nouvelles entrées d'un petit nombre de spécialistes sur des marchés liquides et à horizon suffisamment long pour que la latence ne détruise pas l'avantage.

Pour chaque candidat, comparer sans fuite d'information :

- Source : prix effectivement obtenu par le trader.
- Copier : premier prix observable après publication du trade, puis scénarios 30 s, 2 min, 5 min, 15 min, avec analyse de sensibilité.
- Sortie : d'abord **tenue jusqu'à résolution**, politique simple et vérifiable ; plus tard, copie réelle des ventes si reconstruction d'inventaire possible.
- Frais : taker/maker, spread, profondeur, slippage, exécutions partielles, coûts et rebats uniquement si accessibles au copieur.
- Filtre obligatoire : *aucun trade si le prix copieur dégrade trop l'entrée originale* ; vérifier ce seuil sur une période d'entraînement seulement.
- Risque : capital fictif fixe, limite par wallet/événement/secteur et positions simultanées.

**Limite non négociable :** l'historique des prix n'est pas un historique de carnets exécutables. Si profondeur et carnet passés ne sont pas connus, afficher les analyses historiques comme *screening/markouts*, jamais comme PnL réel de copie.

**Livrable :** courbes de ROI net fictif avec cohortes d'entraînement/test, contre-factuels, coûts et raisons d'exclusion pour chaque signal.

## 6. P3 — Validation prospective déterminante

Pour les 10–20 wallets sélectionnés, enregistrer les trades publics, l'heure de détection, le carnet courant, les frais du marché, la liquidité et les résultats à résolution, sans engager de fonds.

Mesurer le nombre de signaux détectés/manqués, le délai source→détection (proxy, pas délai de publication), le prix original vs copieur, la capacité sur 50 / 100 / 250 USDC, les ordres impossibles et la distribution du ROI net.

Ne pas modifier le modèle pendant la période d'évaluation ; si une modification est nécessaire, repartir sur une nouvelle période de test. **Go** seulement si l'intervalle de confiance conservateur du résultat net demeure positif, après des scénarios de coût plus défavorables et un échantillon d'événements suffisamment diversifié.

## 7. Expérience produit — seulement trois écrans

1. **Opportunités :** classement priorisé par *EV nette copiée validée*, validé/provisoire/insuffisant, taille d'échantillon, marché et capital fictif.
2. **Analyse wallet :** PnL net réconcilié, ROI vérifié, secteurs, stratégie supposée, entrée typique, prix copieur, tests et liste des trades.
3. **Données :** sync incrémentale, statut, erreurs, couverture, provenance et mise à jour GitHub.

Ne pas présenter un taux de réussite ou un ROI de positions closes comme un ROI global sans contexte, ne pas masquer les résultats perdants.

## 8. Critères d'arrêt

- Stop si aucun portefeuille n'a de ledger et ROI suffisamment réconciliés.
- Stop si les gains historiques viennent surtout d'avantages impossibles à copier (maker/rebates, microsecondes, couverture externe).
- Stop si, à prix copiables, les frais/spreads/retards détruisent la marge.
- Stop si les performances de la période de test ne surpassent pas les baselines après contrôle du risque et de la sélection.

**Dernier jalon souhaité :** une règle de trading explicite, reproductible en paper trading, avec raison de sélectionner ou d'ignorer un signal et estimateur chiffré de rendement net — pas simplement un meilleur leaderboard.

## 9. Sources

- API wallet et pagination : https://data-api.polymarket.com/v2/docs
- Données de marché et CLOB : https://docs.polymarket.com/
- Frais par marché (2026) : https://help.polymarket.com/en/articles/13364478-trading-fees
- Recherche Akey et al. : https://doi.org/10.2139/ssrn.6443103

Ce document est un **audit du logiciel**, pas une preuve que la stratégie sera rentable. Aucun fonds ne doit être engagé sur la base des seuls classements actuels.
