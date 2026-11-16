# RN1 — Première expérience discriminante : markout de Maker vs mouvement du marché

**16 novembre 2026 — lecture seule ; diagnostic exploratoire, PAS test concluant d'un oracle.**

## Prédiction / hypothèses
- **M0 (passive Maker)** : acheter sous le midpoint contemporain peut donner un markout positif `future_mid − fill_price` sans que le prix central du marché monte.
- **M1 (fair value / oracle)** : au-delà de l'exécution favorable, on s'attend à un mouvement directionnel ultérieur du midpoint, conditionnel à l'information disponible avant le fill, supérieur à un contrôle d'activité comparable.
- **M2 (hybride)** : les deux contributions peuvent coexister. Une différence positive de midpoint n'établit pas l'utilisation d'un flux bookmaker externe.

**Identité comptable** :
`future_mid-fill_price = (pre_mid-fill_price) + (future_mid-pre_mid)`.
Le premier terme est ici un **écart au midpoint pré-trade échantillonné** et **PAS** le spread réellement capturé lors du placement initial d'un ordre. Le deuxième mesure le mouvement du milieu du carnet observé, pas le PnL réalisé.

## Source et sélection
`pi.rn1_quote_probe_fills` Maker **inféré**, BUY, `book_timestamp<=trade_at`, `lag_seconds BETWEEN 0 AND 60`. Joindre la première quote **strictement après** `trade_at` pour le **même market_key et token_id** dans les deux minutes qui suivent, extraite de `pi.rn1_quote_probe_runs.quotes` avec `position_status='complete'`, `book_valid=true`, `book_at` (millisecondes) et `mid`.

Observation de contrôle 2026-11-16 : **374 fills**, **72 marchés**, **42 événements**. Les fills ne sont pas indépendants ; ils sont conditionnés à avoir été exécutés, le futur est à horizon variable 0–120 s, les pré-books ont un décalage jusqu'à 60 s. **Ne pas** confondre cette cohorte live avec les 29 731 Maker échantillonnés dans le benchmark historique indépendant, qui ne dispose pas des mêmes carnets pré- et post-fill.

## Résultats observés, moyennes non pondérées par la taille des fills
| Mesure | Valeur USDC/share |
| --- | ---: |
| Markout brut `future_mid - fill_price` | **+0.00642** |
| Écart d'exécution `pre_mid - fill_price` | **+0.00472** |
| Mouvement de marché `future_mid - pre_mid` | **+0.00170** |
| Markout brut médian | +0.00500 |
| Mouvement de marché médian | 0.00000 |
| Proportion de fills avec hausse du midpoint | 41.18 % |
| Proportion achetée sous le midpoint antérieur | 72.73 % |

Donc, **~73.5 % du markout brut moyen observé** vient *arithmétiquement* du différentiel achat/midpoint échantillonné, pas du mouvement du midpoint post-fill. Ce pourcentage n'est pas une estimation causale de l'avantage Maker : les deux quotes et le fill ne sont pas synchrones.

**Sensibilité à l'unité statistique :** à poids identique par événement, moyenne des 42 mouvements de midpoint `+0.00969`, SD des moyennes d'événements `0.04481`, intervalle normal grossier à 95 % `+0.00969 ± 0.01355` (soit approximativement [-0.00386, +0.02324]), 22/42 événements avec mouvement moyen positif. Le résultat dépend fortement de la pondération des événements et l'intervalle recouvre zéro. Ce n'est pas un intervalle bootstrap valide pour tous les paramètres, seulement un diagnostic de dispersion par événement.

## Verdict expérimental
- Le **markout brut positif ne prouve pas un oracle externe**, car une grande part est associée à l'écart du fill au midpoint pré-trade.
- Le **mouvement de marché résiduel** paraît faible à poids fill, non uniformément positif par événement, et son estimation est sensible à la méthode de pondération. Aucun modèle M0/M1/M2 **n'est encore départagé causalement**.
- Un test oracle convaincant exige **odds indépendantes reçues avant l'événement**, marchés témoins sans fill, sous-ensemble de chocs odds-before-Polymarket, score **hors événement et période**. Si les odds externes sont absentes, M1 = **non identifiable**, pas « rejeté ».

## SQL de reproduction (résultat principal)
```sql
WITH b AS (
 SELECT q->>'market_key' market_key, q->>'asset_id' token_id,
        q->>'event_slug' event_slug,
        to_timestamp((q->>'book_at')::double precision/1000) book_at,
        (q->>'mid')::double precision mid
 FROM pi.rn1_quote_probe_runs r
 CROSS JOIN LATERAL jsonb_array_elements(r.quotes) q
 WHERE r.position_status='complete'
   AND q->>'book_valid'='true'
   AND q->>'mid' IS NOT NULL
), f AS (
 SELECT f.market_key,f.token_id,f.trade_at,
        f.shares::double precision shares,
        f.fill_price::double precision fill_price,
        f.pre_mid::double precision pre_mid,
        (SELECT b.mid FROM b
         WHERE b.market_key=f.market_key AND b.token_id=f.token_id
           AND b.book_at>f.trade_at
           AND b.book_at<=f.trade_at+interval '2 minutes'
         ORDER BY b.book_at LIMIT 1) future_mid
 FROM pi.rn1_quote_probe_fills f
 WHERE f.role='maker_inferred' AND f.side='BUY'
   AND f.book_timestamp<=f.trade_at
   AND f.lag_seconds BETWEEN 0 AND 60
)
SELECT count(*) n,count(distinct market_key) markets,
 round(avg(future_mid-fill_price)::numeric,5) mean_raw_markout,
 round(avg(future_mid-pre_mid)::numeric,5) mean_mid_change,
 round(avg(pre_mid-fill_price)::numeric,5) mean_execution_discount,
 round(percentile_cont(.5) within group(order by future_mid-fill_price)::numeric,5) median_raw,
 round(percentile_cont(.5) within group(order by future_mid-pre_mid)::numeric,5) median_mid_change,
 round(100.0*count(*)filter(where future_mid>pre_mid)/count(*),2) pct_mid_up,
 round(100.0*count(*)filter(where fill_price<pre_mid)/count(*),2) pct_discount
FROM f WHERE future_mid IS NOT NULL AND pre_mid IS NOT NULL;
```

## Étapes suivantes pour améliorer la qualité
1. Fixer horizon +30/+60/+120s avec **fenêtres strictes** et répéter par marché/événement (pas le prochain carnet de 0 à 120s).
2. Exclure les buckets qui chevauchent des scores/market events reçus après fill, tester lag pré-book <5/10/30/60 s.
3. Contrôles passifs : quote marché × phase × spread × inventory comparable, **même en l'absence d'activité RN1**. Ne pas faire passer un comparateur quote-only pour le fill d'un Maker témoin.
4. Ajouter une série de probabilités bookmaker horodatées et la vérification des règles de règlement pour mesurer l'edge exogène. Observer quels mouvements RN1 anticipe, si tant est qu'ils existent.
5. Rapporter intervalle bootstrap par événement, ablation des variables et score M0 vs M1/M2. Exécuter sans placer d'ordre.

**Cadre principal** : `docs/RN1_BLACKBOX_SYSTEM_IDENTIFICATION_ORACLE_VS_MAKER_2026-11-16.md`.
