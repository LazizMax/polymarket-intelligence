# RN1 — Déclencheurs par momentum avant fill (15 novembre 2026)

## État opérationnel
L'API privée `pi-dashboard` v8 fournit l'action authentifiée `rn1_trigger_windows`.
L'interface GitHub Pages expose **RN1 · Déclencheurs**, avec filtres de groupe et de nombre de cycles.
Aucun ordre, portefeuille ou solde utilisateur n'est modifié par cette analyse.

## Données
- 359 cycles CLOB archivés au début de cette analyse, 5 674 snapshots pour 398 tokens et 199 marchés, avec 425 fills rapprochés du dernier carnet antérieur (tous âges jusqu'à 120 s).
- Source : `pi.rn1_quote_probe_runs` (books publics historiques réellement capturés, carnet reçu avant fill) et `pi.rn1_quote_probe_fills` (fills dédupliqués, Maker inféré / Taker vérifié).
- Comparaison **sans fill** : une fenêtre token-carnet observée n'ayant aucun fill RN1 rapproché dans les 60 secondes ; elle n'est pas la preuve qu'aucun ordre Maker était posé.
- Les groupes sont `rn1_recent` (marchés choisis à partir de l'activité récente de RN1) et `sports_control` (marchés liquides de sports, choisis par Gamma, NON appariés sur le même match ou phase).
- Filtrage : carnet `book_valid`, ancienneté à réception comprise entre 0 et 15 s, spread 0–10 centimes, prix mid compris entre 0,01 et 0,99, relevé précédent du même token 10–180 s auparavant ; fill pendant les 60 secondes **après le snapshot**.
- Agrégats par fenêtre (et non par trade indépendant), classification de la **variation du mid précédent** : stable <1c ; hausse/baisse 1–3c ; hausse/baisse ≥3c. L'horodatage du carnet est postérieur ou égal à l'horodatage du précédent, donc le modèle ne lit pas les futurs prix.
- Bornage opérationnel : 200, 600 ou 1 500 dernières sondes au choix, analysées à chaque demande. Les anciens relevés ne sont pas rescannés en continu.

## Premier résultat, à l'instant de la vérification
Sous les filtres ci-dessus, sur le groupe `rn1_recent` : 

| Variation préalable | Fenêtres | Fenêtres suivies d'un fill <60s | Proportion | Maker inférés (fills) | Taker vérifiés (fills) |
|---|---:|---:|---:|---:|---:|
| Stabilité <1c | 1 153 | 75 | 6,50 % | 135 | 3 |
| Hausse 1–3c | 465 | 44 | **9,46 %** | 64 | 1 |
| Baisse 1–3c | 469 | 30 | **6,40 %** | 43 | 2 |
| Hausse ≥3c | 275 | 19 | 6,91 % | 33 | 1 |
| Baisse ≥3c | 275 | 16 | 5,82 % | 27 | 0 |

À cet instant, l'échantillon `sports_control` donne 966 fenêtres stables / 5 suivies d'un fill, 120 hausses 1–3c / 1 fill, 118 baisses 1–3c / 8 fills, 64 hausses ≥3c / 5 fills, 62 baisses ≥3c / 5 fills. **Ne pas comparer ces deux groupes comme des traitements aléatoires**.

Le précédent test plus large sans filtre frais/spread observait 462 hausses 1–3c / 44 fenêtres avec fill (9,52 %) contre 465 baisses 1–3c / 28 (6,02 %). Les filtres causaux et microstructurels modifient les dénominateurs, pas la direction du signal brut.

## Contrôle de stabilité intra-token
En exigeant au moins **trois fenêtres de hausse et trois de baisse** de 1–3c pour un même token, il ne reste que **18 tokens** : 17/113 fenêtres en hausse sont suivies d'un fill contre 11/112 en baisse. En pondération égale par token, différentiel moyen +4,21 points, mais seulement 4 tokens favorisent la hausse et 4 la baisse (10 égalités). **L'effet n'est pas robuste ni répliqué hors événement.**

## Décision méthodologique
- Le biais de sélection « RN1 a tradé récemment ce marché » peut augmenter artificiellement le taux de fills dans les prochaines minutes ; la fréquence de trading et le momentum peuvent covarier.
- Plusieurs fills d'un même ordre et plusieurs fenêtres du même token sont corrélés ; 64 exécutions Maker ne signifient pas 64 décisions d'ordre distinctes.
- La classe Maker est **inférée** par comparaison aux archives taker_only ; le temps du dépôt, les ordres annulés et les ordres non remplis ne sont pas publics.
- Le carnet CLOB est échantillonné à **1 minute** : les sauts de cote plus rapides et les changements de priorité ne sont pas entièrement observés.
- Une hausse de la fréquence des fills peut venir d'une hausse de demande adverse au meilleur bid, même si RN1 **n'a rien changé à ses ordres**.
- Le true-tipoff NBA déjà observé sur 12 matchs est intéressant mais sélectionné, pas encore un test de causalité d'événements sportifs.
- Aucun résultat de PnL ou avantage de copy trading n'est calculé ici.

## Suite des travaux
1. Échantillonner les marchés **avant** leur activité RN1, et constituer des périodes témoins sur les **mêmes matchs** et au même stade de jeu.
2. Rattacher les épisodes de score, points, buts, changement de leader et interruptions via une source play-by-play fiable en UTC ; mesurer `t−120,−60,−10,+10,+60` secondes autour de chaque événement.
3. Séparer Maker/Taker avec audits explicites, contraster pics de **fills** vs pics de **volume/volatilité global** et mesurer la réversion du mid après fill.
4. Faire une validation hors date, hors marché et hors événement, avec intervalles de confiance regroupés au niveau du match et du token.
5. **Phase 2 money management**, distincte de l'étude des triggers : mise marginale (prix × parts), risque directionnel par match, portefeuille avant fill et ratio d'exposition fondé sur un capital estimé, en conservant les limites d'observation des fonds disponibles.

Traçabilité : commit d'API `64fd5f3`, frontend `c7f7690`; déploiement de `pi-dashboard` v8 et workflow GitHub Pages terminés.
