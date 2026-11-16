# RN1 — Première expérience de signatures algorithmiques (2026-11-16)

## Objet
Tester les hypothèses de taille **H03 : shares fixes** et **H04 : USDC fixes**, sans confondre fills et ordres Maker. Première passe exploratoire ; **aucun modèle validé hors échantillon**.

## Données réellement interrogées
`pi.rn1_quote_probe_fills`, filtre `role='maker_inferred' AND side='BUY'`. Au moment de la requête : **485 fills**, **90 marchés**, plage **2026-11-15 14:05:20 UTC → 2026-11-16 00:41:34 UTC**. Ce n'est pas le lot historique gelé de 756k fills. La couverture live est partielle et les ordres privés ne sont pas observables.

## Construction reproductible du proxy d'ordre
Partition par `market_key, token_id, side, round(fill_price,2)`, tri par `trade_at`. Nouveau groupe si écart entre deux fills successifs de la partition **strictement supérieur à T secondes**. Les gaps sont calculés entre fills consécutifs, pas depuis le début du groupe. L'arrondi au centime peut fusionner des prix distincts et les fills de deux ordres différents peuvent être confondus. La fragmentation d'un même ordre peut aussi traverser des prix ou des intervalles supérieurs à T.

| Gap maximal T | Groupes proxy | Groupes >1 fill | SD(log shares) | SD(log USDC) |
| ---: | ---: | ---: | ---: | ---: |
| 1 s | 419 | 49 | 2.285 | 2.565 |
| 3 s | 382 | 60 | 2.289 | 2.542 |
| 10 s | 345 | 80 | 2.273 | 2.499 |
| 30 s | 295 | 90 | 2.270 | 2.455 |
| 60 s | 277 | 91 | 2.269 | 2.459 |

À T=10s, médiane **200 shares** et **39,1915389977 USDC** par groupe ; **80** groupes multi-fills. La dispersion log des shares est inférieure à celle des USDC pour toutes les fenêtres testées.

## Verdict
- **H03 shares fixes** : compatible *relativement* à H04 sur la seule dispersion brute, mais **pas validée** : SD(log shares) ≈2.27 reste très grande ; prix, marché, phase, répartition par événement et fragmentation non contrôlés.
- **H04 USDC fixes** : moins compatible sur cette métrique brute ; **pas rejetée** dans un modèle conditionnel.
- **H01 capital % et H02 % du coût de marché** : non testées ici ; il faut joindre le proxy à un snapshot strictement pré-trade et distinguer capital inconnu.
- **Pas d'identification du code** à ce stade. Les résultats sont diagnostiques, pas des règles confirmées.

## Prochaine expérience discriminante
1. Construire une table d'analyse (ou une requête réutilisable) des groupes proxy avec état **strictement antérieur** au premier fill, côté opposé, coût d'entrée et quotes disponibles ; conserver les groupes sans snapshot avec drapeau d'inéligibilité.
2. Pré-enregistrer modèles concurrents `shares=C`, `USDC=C`, `USDC=a*market_open_cost`, `shares=f(price,inventory)` et versions par marché/type ; imposer les **mêmes groupes éligibles** à chaque modèle.
3. Faire **5 folds par événement** (jamais random split des fills), mesurer MAE(log size), erreur multiplicative médiane, intervalle bootstrap par événement, comparaison à une baseline simple ; vérifier robustesse T=1,3,10,30,60.
4. Tester des **seuils** de déséquilibre, prix, spread et temps : arbre de décision de faible profondeur, puis vérifier les seuils sur un holdout événementiel. Toute règle qui ne bat pas la baseline reste non identifiée.
5. Ajouter périodes sans exécution pour pouvoir prédire **quand** RN1 intervient ; ne jamais prétendre observer les ordres Maker non exécutés.

## SQL de base (fenêtre T=10s)
```sql
WITH f AS (
 SELECT *, lag(trade_at) OVER (
  PARTITION BY market_key, token_id, side, round(fill_price::numeric,2)
  ORDER BY trade_at
 ) AS prev
 FROM pi.rn1_quote_probe_fills
 WHERE role='maker_inferred' AND side='BUY'
), g AS (
 SELECT *, sum(CASE WHEN prev IS NULL
  OR extract(epoch FROM trade_at-prev)>10 THEN 1 ELSE 0 END)
 OVER (PARTITION BY market_key,token_id,side,round(fill_price::numeric,2)
       ORDER BY trade_at) AS grp
 FROM f
)
SELECT market_key,token_id,round(fill_price::numeric,2) AS price,grp,
 count(*) AS fills,sum(shares) AS shares,sum(shares*fill_price) AS usdc,
 min(trade_at) AS started
FROM g GROUP BY 1,2,3,4;
```
