# RN1 — Test de sizing conditionnel à la cote et au spread (2026-11-16)

## Hypothèse
Le sizing d'un groupe d'exécutions Maker dépend de conditions sur la **cote** et le **spread pré-exécution**. Une grille de seuils peut approximer des branches de code, mais une amélioration statistique n'établit pas la présence de ces branches dans le programme privé.

## Données et méthode
`pi.rn1_quote_probe_fills`, `role='maker_inferred' AND side='BUY'`, `shares>0 AND fill_price>0`. Regroupement proxy même marché/token/côté/prix arrondi à 2 décimales, gap entre fills consécutifs ≤10 s. La moyenne des `pre_spread` au sein du groupe est utilisée comme proxy de spread, et le prix arrondi comme proxy de cote. **348 groupes** disponibles lors de la requête. **Caveat important :** un groupe peut contenir plusieurs exécutions ; moyenner le spread des fills n'est pas nécessairement une variable disponible au moment de placer l'ordre. Un test causal devra prendre exclusivement le spread avant le **premier fill**, voire avant le placement de l'ordre (non observé).

5 folds `mod(abs(hashtext(market_key)),5)`, donc **holdout par marché** mais pas encore par événement. Baseline = moyenne géométrique USDC sur 4 folds d'apprentissage. Condition spread : <0.02, [0.02,0.05), ≥0.05 ; prix : 5 buckets égaux de [0,1]. Pour chaque groupe test, moyenne géométrique sur les données train de la cellule correspondante ; fallback spread puis baseline si cellule vide. Score `exp(median(abs(log(actual/predicted))))`, plus petit = meilleur.

## Résultats
| Modèle | Erreur multiplicative médiane |
|---|---:|
| Montant USDC constant | ×7.239 |
| Montant conditionnel au spread | ×7.238 |
| Montant conditionnel au prix et spread | ×6.593 |

Amélioration relative de la métrique vs baseline ≈8.9 %. **Pas de preuve** de seuil dans le code ; le spread seul est pratiquement équivalent à la baseline. Les seuils ont été choisis comme exploration, pas optimisés sur holdout, mais la comparaison reste exploratoire et sans incertitude statistique. Ne pas interpréter comme performance de trading.

## Prochaine expérience décisive
1. Refaire avec l'état strictement **avant le premier fill** du groupe ; interdire les spreads observés après ce premier fill.
2. Comparer séparément `price-only`, `spread-only`, `price+spread`, `inventory-only`, `price+inventory`, `price+spread+inventory`, sur les mêmes groupes éligibles.
3. Reconstituer les `event_slug` depuis `rn1_quote_probe_runs.quotes` et imposer un holdout **par événement**, non par marché ; puis holdout temporel prospectif.
4. Rapporter bootstrap clusterisé par événement, dispersion entre folds, et stabilité des résultats aux regroupements 1,3,10,30,60 s.
5. Pour trouver des vrais `if/else`, comparer arbres peu profonds (1–3 niveaux) et règles continues, et mesurer les discontinuités locales hors échantillon. Aucun seuil ne doit être déclaré détecté avant cette étape.

## SQL exécuté
```sql
WITH f AS (
 SELECT f.*,lag(trade_at) OVER(PARTITION BY market_key,token_id,side,round(fill_price,2) ORDER BY trade_at,fingerprint) prev
 FROM pi.rn1_quote_probe_fills f
 WHERE role='maker_inferred' AND side='BUY' AND shares>0 AND fill_price>0
),g AS (
 SELECT *,sum(CASE WHEN prev IS NULL OR extract(epoch FROM trade_at-prev)>10 THEN 1 ELSE 0 END)
 OVER(PARTITION BY market_key,token_id,side,round(fill_price,2) ORDER BY trade_at,fingerprint) grp
 FROM f
),o AS (
 SELECT market_key,token_id,round(fill_price,2) price,grp,
 sum(shares*fill_price)::float8 usdc,avg(pre_spread)::float8 spread
 FROM g GROUP BY 1,2,3,4
),d AS (
 SELECT *,mod(abs(hashtext(market_key)),5) fold,
 width_bucket(price,0,1,5) pb,
 CASE WHEN spread<.02 THEN 0 WHEN spread<.05 THEN 1 ELSE 2 END sb
 FROM o WHERE usdc>0 AND spread IS NOT NULL
),p AS (
 SELECT t.*,
 (SELECT exp(avg(ln(usdc))) FROM d x WHERE x.fold<>t.fold) base,
 (SELECT exp(avg(ln(usdc))) FROM d x WHERE x.fold<>t.fold AND x.sb=t.sb) spreadpred,
 (SELECT exp(avg(ln(usdc))) FROM d x WHERE x.fold<>t.fold AND x.pb=t.pb AND x.sb=t.sb) bothpred
 FROM d t
)
SELECT count(*) n,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(usdc/base)))) baseline,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(usdc/coalesce(spreadpred,base))))) spread_only,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(usdc/coalesce(bothpred,spreadpred,base))))) price_spread
FROM p;
```
