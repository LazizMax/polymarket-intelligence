# RN1 — Premiers tests : mouvements de prix et événements déclencheurs
**15 novembre 2026 · contrôle ciblé, sans relecture des 756 000 archives**

## Réponse opérationnelle

Les variations de prix sont disponibles sur Polymarket via l'API CLOB `/prices-history?market=<token_id>&startTs=...&endTs=...&fidelity=1` et le Data API v2 `/v2/prices-history` (rétention des données fines à vérifier selon l'âge). Les carnets temps réel sont accessibles via le WebSocket public CLOB `price_change`/`book`/`last_trade_price`, mais ne constituent **pas** une preuve des ordres Maker privés placés, supprimés, ou non remplis. Le flux sportif public permet de recevoir en direct `score`, `period`, `last_update`, mais ne donne pas automatiquement une archive historique complète des changements de score. Pour les anciens matchs, un historique tiers de play-by-play avec `wallclock` (ESPN NBA) peut être comparé à nos fills.

### I. Prix avant exécution : base déjà collectée

- `pi.rn1_fill_price_benchmark`: **1 373 achats**, **159 tokens**, **26 événements** (1 326 achats NBA, 47 tennis), du 12 au 14 novembre. Attention : ce sous-ensemble n'est pas un tirage représentatif des 756 000 fills, et ne possède **pas** un rôle Maker/Taker vérifié ligne par ligne dans cette table.
- `pi.rn1_historical_price_points`: 21 680 points sur 159 tokens, dont 21 407 à une minute et 273 points de résolution zéro.
- L'horodatage `reference_epoch` de la cote de référence est **60 à 119 secondes avant le fill**, jamais après. La variable `prior_5m_price` mesure un prix plus ancien : la variation étudiée est la différence sur les cinq minutes **avant la référence**, PAS exactement [fill−5m, fill].
- Sur les 1 373 achats, variation préalable du prix : **39 %** en hausse de plus de 1 centime, **32 %** en baisse de plus de 1 centime, **28 %** stable à ±1 centime (arrondis). **La règle « RN1 n'achète qu'après une baisse » est contredite.**
- Une vérification sur les 21 407 minutes-prix du même échantillon, en retrouvant un prix antérieur 5 à 10 minutes auparavant, donne : 207 minutes avec un fill RN1 parmi 4 741 minutes de cote stable (4,37 %) ; 493 parmi 6 761 minutes avec déplacement de 1–5 cents (7,29 %) ; 532 parmi 9 112 minutes avec mouvement de 5+ cents (5,84 %). Ce sont des **fenêtres minute-token**, pas des « trades » indépendants.
- **Limite déterminante :** les 159 historiques de prix ont été *sélectionnés autour des propres trades RN1*. Même la comparaison aux autres minutes de ces fichiers contient un biais de sélection et dépendance par token/match. Les nombres 7,29 % et 4,37 % ne prouvent pas que RN1 déclenche ses ordres sur volatilité. Un groupe témoin de fenêtres aléatoires sur les MÊMES marchés, heure, période du match et liquidité est indispensable.

### II. Résultat plus discriminant : 12 entre-deux NBA vérifiés dans le play-by-play ESPN

On a pris 12 événements NBA des 11–13 novembre 2026 et comparé :

1. `pi.rn1_event_schedule.start_at` = heure programmée (Gamma Polymarket).
2. Premier `plays[].wallclock` en premier quart-temps via `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=<ESPN_game_id>` = **premier jeu réellement horodaté** (proxy proche de l'entre-deux), en UTC.
3. `min(first_at)` de `pi.rn1_pattern_market_entries` pour ce `event_slug` = premier **achat RN1** observé dans les 756 000 fills vérifiés.
4. `min(bought_at)` de `pi.rn1_fill_price_benchmark` = première observation du petit sous-échantillon de prix.

L'heure programmée précède le premier jeu de **10,30 à 12,90 minutes**, médiane **11,35 minutes**. Sur **10/12 matchs**, le premier BUY RN1 de la chronologie tombe de **19 à 53 secondes** après le vrai début (médiane **35,5 s**). Sur les **2 autres**, RN1 avait un achat pré-match ; le sous-échantillon de prix retrouve des achats de **43 à 52 secondes** après l'entre-deux. Tous les **12/12 matchs** affichent ainsi au moins un fill échantillonné dans les 94 s qui suivent le premier jeu.

| Match RN1 | ESPN eventId | Heure premier play UTC | Premier BUY chronologique après premier play |
|---|---|---|---:|
| TOR–PHI, 12 nov | 401909976 | 2026-11-13 00:11:54 | +21 s |
| DET–WAS, 12 nov | 401909977 | 2026-11-13 00:12:17 | +50 s |
| OKC–POR, 11 nov | 401909975 | 2026-11-12 03:11:44 | +31 s |
| ORL–UTA, 11 nov | 401909973 | 2026-11-12 02:11:20 | +46 s |
| POR–SAC, 13 nov | 401909303 | 2026-11-14 03:10:18 | **−568 s**, achat pré-match ; premier fill du sous-échantillon **+52 s** |
| NYK–IND, 13 nov | 401909296 | 2026-11-14 00:12:54 | +42 s |
| DAL–MIN, 12 nov | 401909978 | 2026-11-13 01:10:47 | +37 s |
| OKC–LAC, 13 nov | 401909304 | 2026-11-14 03:40:28 | **−582 s**, achat pré-match ; premier fill du sous-échantillon **+43 s** |
| ATL–CHI, 13 nov | 401909299 | 2026-11-14 01:10:33 | +34 s |
| GSW–HOU, 11 nov | 401909974 | 2026-11-12 02:42:48 | +19 s |
| UTA–HOU, 13 nov | 401909301 | 2026-11-14 01:41:22 | +24 s |
| MIL–ORL, 13 nov | 401909297 | 2026-11-14 00:10:56 | +53 s |

**Interprétation :** compatible avec un système de quoting qui démarre/redevient exécutable au *vrai* début NBA, ou une hausse de contreparties cherchant à trader dès le début. **L'heure de placement du limit order Maker de RN1 n'est pas observable ; un fill à t+20 s peut provenir d'un ordre en attente depuis t−10 min**. De plus, ces 12 matchs ont été choisis parmi les événements où un historique de prix RN1 existait : éviter d'extrapoler à toute la NBA.

### III. Vérification exploratoire aux reprises de quart-temps (même échantillon, sélectif)

Sur ces 12 NBA, comparaison des fills RN1 du sous-échantillon dans la première minute de chaque quart versus moyenne par minute des six minutes suivantes :
- Q1 : 36 fills première minute versus 19,67 / minute après ; 
- Q2 : 26 versus 14,50 ;
- Q3 : 21 versus 7,00 ;
- Q4 : 7 versus 2,17.

C'est compatible avec une intensité plus élevée à certains redémarrages de jeu, mais le sous-échantillon est sélectionné autour des fills et répète les mêmes marchés : pas de test causal.

## Ce que l'on peut conclure maintenant

1. **DISPONIBILITÉ : oui**, prix historiques et états sportifs horodatés (score live / play-by-play externe).
2. **TRIGGER « seulement baisse de cote » : faux** dans le sous-échantillon disponible.
3. **TRIGGER de timing réel NBA : signal positif et récurrent** sur 12 matchs, à vérifier sur événements hors échantillon et autres sports.
4. **PLACEMENT Maker vs FILL Maker : non identifiable rétrospectivement** dans les données publiques ; impossible de reconstituer l'heure de dépôt des ordres privés.
5. **Lien causal but/panier/point important → dépôt d'ordre : NON DÉMONTRÉ.** Des événements sportifs peuvent simultanément déplacer les cotes et accroître la contrepartie disponible, sans que RN1 change ses limites à cet instant.

## Le test le plus utile ensuite, sans relancer une journée de collecte

Sur un échantillon de matchs hors des 12 NBA : 
- prix pré-fill à −10, −5, −2, −1 minutes, amplitude, momentum/retournement et spread ;
- temps depuis le *vrai* début, points/buts, changement de leader, fin de période ;
- comparaison des **opportunités de marché sans fill RN1** en appariant sport/événement/token/phase horaire, pas simple comparaison entre trades gagnants ;
- Maker et Taker séparés par rôle audité (non disponible dans la petite table de benchmark ; à reprendre des archives auditables) ;
- étudier **probabilité de remplissage** prospective des quotes publiques, séparément de la propension de RN1 à poser un ordre qui est privée.

**Money management** : phase 2 distincte. Lier mise marginale, probabilité d'entrée, déséquilibre d'inventaire, risque maximal sur un marché et valeur du portefeuille juste avant la transaction. L'historique public ne donne pas nécessairement le capital réellement libre/immobilisé; un ratio d'exposition sur capital reconstitué doit être étiqueté comme une estimation.

Aucune conclusion ne repose sur une simulation de profits non exécutés, et aucune opération de trading réel n'a été déclenchée.
