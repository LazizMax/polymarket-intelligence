# RN1 — Contrôle conditionnel NBA : panier, prix, fill (16 novembre 2026)

## Pourquoi cette étude
Tester le signal initial `panier → davantage de fills RN1` sans confondre changement de score, volatilité de la cote, période du match, exposition du portefeuille et décision de placement d'un ordre privé.

### Sources et bornes
- Historique Polymarket RN1 : 756 000 fills archivés privés, mais **seulement 4 000 trades matérialisés** dans `pi.trades` permettent ce test fin. Les 756 000 fills ne sont **pas** simulés comme s'ils avaient une heure de trade et une cote capturées ici.
- Historique NBA ESPN : **41 matchs complets**, 20 100 actions horodatées et 4 922 actions qui marquent au moment de la vérification. Sur ceux-ci, 23 matchs correspondent à des trades dans `pi.trades` (3 757 fills, 625 040,60 USDC de notionnel observé).
- Prix : 153 tokens d'un **sous-échantillon sélectionné autour de trades RN1**, avec résolutions en général d'une minute. Ces prix historiques ne sont **pas** des carnets CLOB et ne révèlent aucune heure de dépôt Maker.
- 18 510 intervalles de prix historiques exploitables pendant les matchs, dont **12 741** recouvrent au moins une action de jeu : 9 659 avec panier et 3 082 avec action sans panier. En dehors d'une action identifiable, 5 769 intervalles sont écartés des comparaisons principales.
- Aucune opération de marché n'a été effectuée ; seule la recherche sur données publiques a été menée.

## Résultat brut et paradoxe apparent
- Sur 23 matchs disponibles, fenêtres de **30 s** avec une action marquant des points : **28,98 %** suivies d'au moins un fill dans les 30 secondes suivantes, contre **23,76 %** pour les fenêtres avec d'autres actions.
- Les intervalles de prix contenant un panier ont une amplitude moyenne de **3,815 centimes** contre **2,581 centimes** pour ceux contenant une action sans panier. Les mouvements de ≥1 centime sont respectivement **81,54 %** et **71,74 %**.
- Ces associations **ne mesurent pas** si RN1 dépose ses ordres à cet instant. Elles sont compatibles avec un effet de la volatilité et de l'arrivée de contreparties sur des limites Maker déjà présentes.

## Design du contrôle conditionnel
L'unité analysée est un intervalle de prix pour un token donné, avec une cote précédente de **60 à 180 secondes** antérieure et un prix actuel à l'instant T. L'événement ESPN est recensé **entre les deux observations de prix**. L'outcome est la présence d'au moins un fill RN1 du même token strictement après T et au plus T+30 secondes ou T+60 secondes.

Ne conserver que les intervalles avec une action ESPN horodatée. Construire des strates selon :
1. **Même token**, donc même issue et même marché.
2. **Même phase du match** en temps réel écoulé depuis le premier jeu, par tranches de 15 / 30 / 60 minutes.
3. **Même amplitude** de mouvement de cote : <1 centime, 1–3 centimes, ou ≥3 centimes.
4. **Même direction** de variation : hausse, baisse ou stabilité.
5. Exiger **au moins 2 fenêtres** avec panier et **2 fenêtres** sans panier dans chaque strate (les autres ne sont pas extrapolées).

| Phase de contrôle | Strates | Matchs | Fenêtres avec / sans panier | Fill ≤30 s, avec / sans panier | Différence moyenne par strate, 30s | Fill ≤60 s, avec / sans panier | Différence moyenne par strate, 60s |
|---|---:|---:|---:|---:|---:|---:|---:|
| 15 min | 320 | 23 | 1 090 / 724 | 4,04 % / 4,56 % | **+0,09 pp** | 6,06 % / 8,29 % | **−1,61 pp** |
| 30 min | 594 | 23 | 2 438 / 1 562 | 4,10 % / 4,80 % | **−0,10 pp** | 7,01 % / 9,80 % | **−1,98 pp** |
| 60 min | 729 | 23 | 4 280 / 2 379 | 4,86 % / 4,96 % | **−0,08 pp** | 8,20 % / 10,30 % | **−1,67 pp** |

**Ne pas additionner les lignes** : les trois contrôles réutilisent les mêmes observations et changent uniquement la granularité d'appariement.

Sur 30 minutes et une fenêtre d'outcome de 60 secondes, l'écart moyen **par match** est −4,95 pp (7 matchs positifs, 15 négatifs, 1 nul). Ce chiffre diffère de la moyenne par strate et de la différence brute des taux : pondérations et tailles d'échantillon sont différentes. En raison de la dépendance entre fenêtres et de la sélection initiale, ne pas le traiter comme une preuve causale.

### Lecture
Le surcroît initial de fills après un panier **n'est pas robuste** à la comparaison à cote et moment similaires. La fréquence de remplissage d'ordres peut réagir à la volatilité et à la liquidité, y compris lorsque RN1 n'a pas modifié ses limites.

Attention aussi à un point causal important : **le mouvement de cote peut être lui-même une conséquence du panier**. Conditionner sur ce mouvement supprime une partie éventuelle de l'effet total du panier, et peut créer un autre biais. Ce test cherche seulement une association supplémentaire, au-delà du prix observé, pas à identifier une causalité vraie.

### Ce que les données ne permettent toujours pas de prouver
- **Maker ≠ heure de placement**. Les 756k archives ne donnent pas l'historique des ordres privés annulés/non exécutés.
- **Taker ≠ tous les trades RN1**. Le rôle est vérifié uniquement sur un sous-échantillon live lié aux sondes CLOB ; les 4 000 trades du pilote ne portent pas une classification Maker/Taker historique fiable.
- **Échantillon conditionné sur les propres trades RN1** ; les 153 tokens de prix ne forment pas un groupe témoin aléatoire.
- **Résolution de prix en minute** ; manquent les mouvements du carnet en quelques secondes, les sauts de volatilité et les profondeurs au temps exact du score.
- Les intervalles proches d'un panier et les fills successifs ne sont pas indépendants.
- La validation sur des matchs vraiment hors échantillon et l'exécution paper-trading n'existent pas encore ; aucun ROI net de copie n'est ici calculé.

## Intégration logicielle
- Backend privé `pi-dashboard` : action authentifiée `rn1_sports_robustness` qui calcule les trois granularités **sur demande**, distinctement de `rn1_sports_impact`.
- Application GitHub Pages → **RN1 · Matchs** → **Validation conditionnelle** → **Calculer les comparaisons appariées**. Les effectifs, taux, écarts et résultats par match sont consultables. Pas de relecture des archives 756k.
- Les collecteurs ESPN et CLOB conservent leur cadence et leurs garde-fous de données ; ce test est en lecture seule.

## Prochaine phase
1. Reproduire ces métriques sur un nouvel ensemble de matchs NBA, en sélectionnant les marchés **avant** que RN1 y trade ; conserver les résultats de validation séparément des résultats de développement.
2. Comparer les meilleures quotes réellement capturées sur le WebSocket CLOB aux événements de score et aux fills ; le polling minute n'identifie pas un ordre Maker créé.
3. Passer au risque et **money management** : capital immobilisé, inventaire YES/NO préalable, taille marginale des achats, fréquence de rééquilibrage et exposition nette par événement, sans prétendre connaître l'intégralité du capital du wallet.
