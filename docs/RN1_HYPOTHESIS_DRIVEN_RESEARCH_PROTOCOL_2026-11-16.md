# RN1 — Protocole hypothético-déductif de reverse engineering

Date : 2026-11-16. Remplace le mode de recherche descriptif par une procédure de sélection de modèles falsifiables. Les observations restent des *données de test*, pas des conclusions sur l'algorithme.

## Question finale

Trouver un ensemble **minimal** de règles qui prédit les décisions observables de RN1 (marché, côté, instant, taille d'ordre, prix limite, exposition, arrêt), y compris les moments où il **ne trade pas**, et qui généralise hors échantillon. L'observation d'un fill n'est **pas** l'observation d'un ordre Maker placé, modifié, annulé ou partiellement rempli.

## Hypothèses prioritaires — préenregistrées avant tout test supplémentaire

| ID | Modèle explicatif | Prédiction quantitative | Données et dénominateur | Test qui pourrait le rejeter |
| --- | --- | --- | --- | --- |
| H01 | Ordre initial = 1 % d'un capital de référence constant | La somme des fills attribuables à un même ordre se concentre près de 0,01 × capital | Ordres Maker privés non visibles ; reconstruire des groupes d'exécutions en *proxy* seulement | Aucun capital commun ne réduit l'erreur hors échantillon, même après regroupements robustes |
| H02 | Ordre = 1 % du coût d'entrée déjà ouvert sur le marché | Notional d'un **ordre**, divisé par le coût du marché avant ordre ≈ 1 % | Snapshots avant fill ; attention au décalage temporel et aux fills partiels | Dispersion élevée des **ordres regroupés**, pas des fills bruts |
| H03 | Quantité fixe de parts par ordre / niveau de cote | La quantité en shares varie moins que le notional USDC quand la cote bouge | Trades Maker par token, marché et phase, regrouper les fills | Modèle à parts constantes moins performant hors échantillon que les concurrents |
| H04 | Notional fixe USDC par ordre / niveau | Notional en USDC varie moins que shares à cote différente | Idem | Modèle USDC fixe moins performant hors échantillon |
| H05 | Rééquilibrage YES/NO vers une cible | Le côté acheté dépend du déséquilibre **pré-trade** ; l'erreur de cible diminue après exécution | Deux côtés réellement retournés par API, transitions de même marché | Pas d'effet conditionnel sur l'inventaire préexistant, ou modèle moins bon qu'un choix de côté naïf |
| H06 | Seuil d'exposition ou de perte conditionnelle | Probabilité de nouvel ordre décroît après franchissement d'un seuil ; la taille diminue ou change de côté | Marchés suivis **avant** activité, périodes sans fills, coût ouvert et min(shares) | Aucun seuil stable entre matchs/sessions, sans fuite temporelle |
| H07 | Market making / grille passive | Prix des fills Maker se concentre à des offsets stables par rapport au bid/ask pré-trade ; recharges d'un même niveau | Books avant fill, tick, spread, déduplication et incertitude sur le prix de l'ordre | Offsets non stables hors échantillon ou explicables par la liquidité du marché |
| H08 | Pair arbitrage / prix combiné des deux issues | Les acquisitions opposées à un horizon défini abaissent le coût par paire complète sous le paiement binaire, net des frais | Reconstitution séquentielle de lots appariés, slippage et coûts, ne pas confondre achat et hedge intentionnel | Pas d'amélioration robuste de l'espérance nette ou impossibilité d'exécuter les deux jambes |
| H09 | Signal de match ou de prix | La probabilité d'ordre Maker change conditionnellement à score, phase, mouvement de cote et spread | Jeux horodatés, périodes sans trade, quote pre-trade, Maker **pas historique Taker-only** | Effet disparaît après contrôle du prix/phase ou hors échantillon |
| H10 | Règles différentes selon contexte | Les paramètres sont distincts selon sport, type de marché, phase et exposition | Modèle hiérarchique avec pénalité de complexité | Segmentation n'améliore pas la prédiction hors échantillon |

## Premier test concret effectué (2026-11-16)

Hypothèse **H02 naïve, au niveau fill** : notional du fill Maker = 1 % du coût d'entrée ouvert du même marché, tel qu'observé avant ce fill.

Source : `pi.rn1_quote_probe_fills` (rôle `maker_inferred`) joint à `pi.rn1_quote_probe_runs` (sondes `position_status='complete'`, `position_observed_at<=received_at<trade_at`) et aux deux `positions` du `market_key`. **418 fills** de **74 marchés** au moment du test, **417** avec coût pré-trade non nul. Ratio médian ≈ **0,9548 %**, mais 10/417 seulement dans [0,8 %, 1,2 %], et 45/417 dans [0,5 %, 1,5 %]. Les déciles sont ≈0,0184 % et ≈34,35 %.

**Verdict :** les données ne soutiennent **pas** une règle stricte au niveau de chaque fill. Une médiane voisine de 1 % est un leurre si la dispersion est énorme. H02 **au niveau ordre** n'est **pas testée** : un ordre peut générer plusieurs fills, et le coût pré-trade peut changer entre sonde et exécution. H01 n'est **pas testable directement** sans bankroll/ordres. Le test ne démontre pas non plus qu'il n'existe aucun sizing en %.

## Protocole obligatoire pour chaque hypothèse

1. **Prédiction avant analyse** : écrire la règle, l'unité (fill, ordre, marché, événement, wallet), la variable expliquée, la fenêtre et les paramètres permis. Exemple : `P(buy YES | imbalance, price, spread)` ou `predicted_order_usdc=0.01*market_open_cost`.
2. **Échantillon d'apprentissage séparé** : estimer les paramètres uniquement sur le passé ; ne pas calibrer sur le test. Scinder par **match ou événement**, pas par fills aléatoires corrélés.
3. **Contrefactuel et baseline** : inclure périodes sans fill, contrôle de marché/heure, modèle constant et modèle simpliste de fréquence majoritaire. Un modèle qui explique seulement les fills est susceptible d'être trivial.
4. **Score mesurable** : pour taille, erreur relative robuste/MAE et calibration ; pour côté ou entrée, log-loss, Brier et précision-rappel selon la classe. Reporter échantillon effectif, intervalles bootstrap **clusterisés par marché/événement**, et coûts de complexité.
5. **Classement** : `rejetée`, `non distinguable / données insuffisantes`, `compatible mais non discriminante`, `candidate`, `confirmée hors échantillon`. **Ne jamais appeler validée** une hypothèse simplement compatible avec une moyenne ou médiane.
6. **Explication des échecs** : lister les exemples où elle prédit mal, rechercher une variable d'interaction **prédéfinie**, puis tester la nouvelle version sur un **nouvel échantillon**. Pas de raffinements illimités a posteriori.
7. **Convergence** : n'ajouter une règle au modèle global que si elle améliore nettement la performance hors échantillon et reste interprétable ; comparer modèle complet vs ablation de chaque règle.

## Tableau de bord à construire

**RN1 · Modèles** : chaque hypothèse est une fiche avec équation, statut, données éligibles, couverture, score train/test, comparaison à la baseline, intervalle de confiance, exemples d'échecs, prochaine expérience décisive. Comparer les modèles sur les **mêmes unités** et le **même holdout**. Les graphiques descriptifs existants restent des outils de diagnostic, pas la sortie principale.

## Ordre des prochains travaux

1. Regrouper prudemment les fills Maker compatibles avec un même ordre ou un même niveau, en exposant les regroupements incertains ; évaluer H01–H04 sur le **niveau ordre proxy** et plusieurs méthodes de regroupement. Ne pas déduire une taille d'ordre totale d'un fill isolé.
2. H05–H06 : construire un panel marché × minute incluant des marchés observés **sans exécution** ; mesurer l'effet du déséquilibre et du coût préexistants sur la probabilité de nouvelles exécutions. Séparer exécutions de soumissions d'ordres, non observables.
3. H07–H09 : tester prix limite approximatif, paire binaire et événement sportif, avec contrôle des quotes avant trade et holdout événementiel.
4. Produire un modèle compact à règles explicites, puis une simulation de paper trading causale et nette de frais, sans promettre la réplicabilité de RN1.

## Garde-fous

- Les **756 000 fills BUY gelés** sont un lot distinct de l'échantillon live ; ne pas réimporter ce lot.
- Les **4 000 trades historiques sports** proviennent de `/v2/trades` **Taker-only** ; ne pas les présenter comme un échantillon représentatif Maker.
- Ne pas inférer les ordres Maker **non remplis** ni la bankroll privée des fills.
- Aucun ordre réel n'est passé dans cette recherche.
