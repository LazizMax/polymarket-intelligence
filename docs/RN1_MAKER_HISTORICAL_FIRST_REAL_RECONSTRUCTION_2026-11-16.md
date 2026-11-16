# RN1 — Première reconstruction Maker historique réelle (16 novembre 2026)

## Objectif
Reconstituer les exécutions Maker réellement archivées, les associer **aux prix Polymarket strictement antérieurs** et aux événements NBA, puis comparer les minutes avec et sans fill Maker. Les bookies et l'ancien pilote Taker ne sont pas le corpus principal.

## État exécuté et vérifié en production
- Projet Supabase dédié : `qamdvfakwclkuswrdckp` (schéma privé `pi`).
- Edge Function `pi-rn1-maker-history` **v3 ACTIVE**, source `supabase/functions/pi-rn1-maker-history/index.ts`.
- Migration appliquée : `rn1_maker_historical_reconstruction_v1` et `rn1_maker_minute_panel_v1`, versionnées dans `sql/070_rn1_maker_historical_reconstruction.sql`.
- Cron `pi-rn1-maker-historical-1min` (job 17) actif, garde SQL : ne lance de requête que si pages 1–40 non traitées. **Cohorte terminée**, donc pas de nouvelle extraction sur ce job.
- **40 pages originales**, contrôles SHA256, 40 000 fills source, **32 116 Maker / 7 884 Taker** avec attribution par comparaison aux Taker source, validée contre les nombres audités par page. Pas de réingestion depuis Polymarket des pages complètes.
- Période : 9–15 novembre 2026, **1 368 événements**, **8 600 tokens** représentés dans cette cohorte.
- **2 160 fills** alignés sur une cote antérieure Polymarket `<=60s` : seulement **775 Maker**, **1 385 Taker**. Historique de prix très partiel : ne pas extrapoler à tous les 32 116 Maker.
- **13 044 fills** alignés sur une action ESPN passée (temps de jeu), dont **5 672 Maker / 7 372 Taker**. `play_at` d'ESPN récupéré a posteriori : ce n'est **pas** une preuve que RN1 a reçu l'événement avant le fill.
- Panel `pi.rn1_maker_historical_minute_panel` : **19 068 minutes**, **18 213** avec delta prix 5 minutes valide, **454 fenêtres positives** (fill Maker dans les 60s suivantes), **26 événements** ayant historique prix recoupé. L'ancienne étude Taker n'est pas utilisée pour ces labels.
- L'affichage du panel reste une **vue privée SQL**, pas encore intégré dans l'interface RN1 · Moteur.

## Premiers tests descriptifs (pas de validation hors événement)
Condition prix passé en cinq minutes | Minutes | Fill Maker <=60 secondes | Taux
--- | ---: | ---: | ---:
Baisse de plus de 1 point de probabilité | 6 849 | 203 | 2,96 %
Stable (+/- 1 point) | 4 333 | 63 | 1,45 %
Hausse de plus de 1 point | 7 031 | 176 | 2,50 %

Agrégation à poids égal **par événement** (minimum 20 minutes dans les deux catégories) :
- *Mouvement absolu supérieur à 1 point vs stable* : 23 événements comparables, 18 avec plus de fills en phase volatile, 5 en phase calme, écart moyen de taux **+1,434 point de pourcentage**.
- *Hausse vs baisse* : 26 événements comparables, 11 avec davantage de fills après hausse, 15 après baisse ; différence moyenne hausse − baisse **−0,965 point de pourcentage**.

**Interprétation prudente :** l'exécution Maker plus fréquente après une variation de prix peut être un effet de la volatilité et du passage d'ordres déjà posés, sans aucune réaction de placement du bot. Les labels sont des **fills**, pas des ordres créés/annulés, et les données de carnet ne prouvent pas un ordre originel. Les minutes sans fill sont des contrôles d'exécution, pas des contrôles prouvant l'absence d'ordres. Ces taux ne sont pas des prédictions validées, des causalités, une EV ou un ROI.

## Premier benchmark hors événement (5 folds déterministes)
Sur les **18 213 minutes** avec momentum 5 minutes valide, dont **442 positives** : séparation par hash du `event_slug` (un même match ne peut pas figurer à l'entraînement et en validation d'un même fold). Un estimateur des taux `volatile / quiet` avec lissage de Laplace est comparé à un taux global constant, tous deux entraînés uniquement sur les autres folds.

- **Log-loss constante : 0,114274**
- **Log-loss volatilité absolue : 0,113611**
- **Gain = +0,000663** seulement.

Ce benchmark est un **modèle de probabilité de fill**, PAS une reconstruction des ordres affichés. Il manque bootstrap par match, test temporel purgé, spreads, inventaires, modèle de temps-de-fill, et contrôle des tokens cotés sous-échantillonnés. Ne pas l'interpréter comme une EV de trading.

## Prochain travail bloquant
1. Comparer événement-holdout et test chronologique purgé, avec fréquences des tokens, phase de match, période, comportement d'inventaire et clustering intra-événement.
2. Étendre par **cohortes ciblées** aux pages historiques pertinentes, sans matérialiser les 2 millions de fills dans Postgres : base de 630 Mo avant ce premier lot, besoin de garder la marge de stockage.
3. Acquérir ou reconstruire les proxies de placement Maker (carnet à plusieurs timestamps, quotes) ; comparer prix/fills et transitions d'inventaire.
4. Afficher dans **RN1 · Moteur** les couvertures, calendriers, séries, déclencheurs et contre-exemples à partir du backend authentifié.
5. Ne pas qualifier RN1 de momentum/mean reversion/machine learning ni copier les règles tant qu'elles ne prédisent pas sur des événements inconnus.

## Requêtes de contrôle
```sql
select count(*) pages,sum(maker_fills) maker,sum(taker_fills) taker,
 sum(matched_price) priced,sum(matched_score) scored
from pi.rn1_maker_historical_pages;

select count(*) minutes,count(*) filter(where maker_fill_next_60s) positives,
 count(distinct event_slug) events
from pi.rn1_maker_historical_minute_panel;
```

**Conclusion :** reconstruction Maker historique initiale effectivement exécutée ; reconstruction intégrale des décisions d'ordre depuis toutes les archives **non terminée**. Ce lot prouve la faisabilité et documente les limites de couverture, sans inventer de condition de placement.

## Seconde validation et nouvelle interface — 16 novembre 2026

- **Cohorte de 40 000 fills conservée** : on n'a pas recommencé l'import. Un panel `pi.rn1_maker_historical_minute_panel_v2` a été ajouté et versionné dans `sql/071_rn1_maker_eligible_token_window_panel_v2.sql`. Une minute de contrôle n'est désormais retenue que si elle tombe entre le premier et le dernier fill archivé du token, avec au moins 3 fills archivés et un slug unique.
- **V2 : 13 502 minutes**, 13 335 avec momentum 5 minutes valide, 402 minutes suivies d'un fill Maker, 26 événements et 155 tokens. Les sous-populations sont **sélectionnées par l'activité passée de RN1** : elles ne représentent pas des fenêtres de marché indépendantes ou aléatoires.
- **Variations 5 min :**
  - baisse >1 point : 5 107 minutes, 175 positives Maker (**3,427 %**), taux Taker **6,873 %** ;
  - stable ±1 point : 3 079 minutes, 61 positives Maker (**1,981 %**), taux Taker **7,308 %** ;
  - hausse >1 point : 5 149 minutes, 159 positives Maker (**3,088 %**), taux Taker **8,429 %**.
- **Contrôle à poids égal par événement** : 22 matchs éligibles (au moins 20 minutes dans chaque régime calme/volatile), 15 ont davantage de fenêtres positives Maker en période volatile, 6 en période calme (1 ex-aequo). Différence moyenne **+0,01524** de probabilité de fill, encore non causale.
- **Validation 5-fold par événements disjoints** : 13 335 minutes/395 positives, log-loss constante **0,134170** vs volatilité **0,133669**, gain **0,000501**.
- **Validation temporelle par matchs disjoints** : entraînement sur 18 matchs chronologiquement antérieurs, validation sur les 8 suivants : 4 201 minutes, 104 positives ; log-loss constante **0,116920** vs volatilité **0,116547**, gain **0,000373**. Pas de causalité, bootstrap ni mesure de PnL.
- **Stratification rétrospective NBA** (existence d'un panier ESPN dans la minute précédente) :
  - Sans panier : calme **2,034 %** (43/2 114) vs volatile **3,340 %** (156/4 670).
  - Avec panier : calme **1,865 %** (18/965) vs volatile **3,187 %** (178/5 586).
  - Les événements ESPN ne sont **pas** garantis disponibles au bot avant fill.
- **Recoupement avec les probes de carnet existantes : 0 token commun** entre 8 600 tokens de la cohorte et 220 tokens des fills du système de probes. Pas d'identification d'ordres affichés / annulés à partir de ces archives.
- **Backend authentifié déployé** `pi-dashboard` **v31 ACTIVE** : route `rn1_maker_historical_report` dans `rn1-maker-history.ts`. Le dashboard `RN1 · Moteur` a été modifié pour présenter les chiffres réels et les limites. Vérification directe du backend : le POST sans authentification renvoie HTTP 401 ; la route authentifiée ne peut être entièrement testée sans session utilisateur.
- **Sécurité** : panel et tables conservés en schéma privé, RLS et refus d'accès aux rôles anon/authenticated. Les résultats ne sont pas publiés en accès public brut.

**Verdict révisé :** l'intensité de variation de prix prédit très légèrement la présence d'un fill Maker; elle ne permet pas d'identifier une règle de placement. Le sujet prioritaire suivant est la reconstruction d'inventaire au moment des exécutions et la preuve temporelle des ordres resting via des carnets alignés, idéalement sur la même cohorte, avant d'inférer un algorithme.
