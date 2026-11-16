# RN1 — Premier benchmark hors marchés : H03 vs H04 (2026-11-16)

## But
Départager **shares fixes** et **USDC fixes**, avec variantes conditionnelles à la cote, sur des groupes d'exécutions Maker proxy **non vus à l'entraînement**. Ce benchmark n'est **pas** une reconstruction du code ni une validation de profitabilité.

## Données et proxy
Table `pi.rn1_quote_probe_fills`, `role='maker_inferred'`, `side='BUY'`, `shares>0`, `fill_price>0`. Groupes par `market_key,token_id,side,round(fill_price,2)`, nouvelle séquence lorsque l'écart avec le fill précédent est >10 s. 345 groupes, 90 marchés, 5 folds déterministes `mod(abs(hashtext(market_key)),5)`. Les groupes ne sont pas des ordres privés vérifiés.

## Protocole
Chaque groupe de marché est prédit à partir des **quatre autres folds**, jamais de son propre marché. Pour `shares` et `USDC`, prédiction constante = `exp(avg(ln(y)))` sur le train. Pour les modèles conditionnels à la cote, même estimateur géométrique sur les observations train dans la même tranche de prix `width_bucket(price,0,1,5)`, fallback au global si tranche vide. Métrique = `exp(median(abs(ln(y/pred))))`, erreur multiplicative médiane, **plus petit = meilleur**. Cinq folds par **marché**, pas par événement ; plusieurs marchés du même événement peuvent être répartis entre train et test. Aucun bootstrap/intervalle de confiance encore calculé.

## Résultats réels
| Hypothèse | Erreur multiplicative médiane |
| --- | ---: |
| H03 shares constants | ×8.111 |
| H04 USDC constants | ×7.352 |
| H03 shares par tranche de cote | ×7.743 |
| H04 USDC par tranche de cote | ×7.364 |

**Interprétation :** H04 fixe surpasse H03 fixe dans ce benchmark particulier, contrairement à la seule dispersion descriptive précédente. Tous les modèles ont une erreur très élevée et sont impropres à prédire une taille opérationnelle. Les différences de score entre modèles proches ne sont **pas** significatives sans estimation d'incertitude. Les métriques de taille en shares et USDC sont comparables sur une échelle log-multiplicative pour les mêmes groupes, mais les tailles peuvent être très hétérogènes selon les marchés.

## Limites
- Proxy d'ordre très imparfait : fills partiels, ordres distincts fusionnés, prix arrondis.
- Folds de marché plutôt que folds d'événement ; potentielle fuite de structure d'un événement.
- Aucun contrôle de l'exposition, de l'imbalance, du spread, de la phase du match ni de la liquidité.
- Seulement les **fills exécutés**, pas les ordres non exécutés ni les moments sans fill.
- Pas de test prospectif, pas de conclusion sur l'avantage net.

## Décision
**H03/H04 : non identifiées.** Ne pas attribuer à RN1 une règle « parts fixes » ni « montant fixe » sur la base de ces résultats. Prochaine expérience : construire des états pré-trade et comparer `shares=f(price,inventory,spread)`, `USDC=f(price,inventory,spread)`, `notional=alpha*market_cost` et règles à seuils, sur holdout **événementiel** ; quantifier incertitude et stabilité aux fenêtres de regroupement. Ensuite tester entrée/non-entrée avec périodes sans fill.

## SQL utilisé
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
 sum(shares)::float8 shares,sum(shares*fill_price)::float8 usdc,min(trade_at) first_at
 FROM g GROUP BY 1,2,3,4
),d AS (
 SELECT *,mod(abs(hashtext(market_key)),5) fold,width_bucket(price,0,1,5) bucket
 FROM o WHERE shares>0 AND usdc>0
),p AS (
 SELECT t.*,
 (SELECT exp(avg(ln(shares))) FROM d x WHERE x.fold<>t.fold) global_shares,
 (SELECT exp(avg(ln(usdc))) FROM d x WHERE x.fold<>t.fold) global_usdc,
 (SELECT exp(avg(ln(shares))) FROM d x WHERE x.fold<>t.fold AND x.bucket=t.bucket) bucket_shares,
 (SELECT exp(avg(ln(usdc))) FROM d x WHERE x.fold<>t.fold AND x.bucket=t.bucket) bucket_usdc
 FROM d t
)
SELECT count(*) n,count(distinct market_key) markets,count(distinct fold) folds,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(shares/global_shares)))) global_shares_mfe,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(usdc/global_usdc)))) global_usdc_mfe,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(shares/coalesce(bucket_shares,global_shares))))) bucket_shares_mfe,
 exp(percentile_cont(.5) WITHIN GROUP(ORDER BY abs(ln(usdc/coalesce(bucket_usdc,global_usdc))))) bucket_usdc_mfe
FROM p;
```
