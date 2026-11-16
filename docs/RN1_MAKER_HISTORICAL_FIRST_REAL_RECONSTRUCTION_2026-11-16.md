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
