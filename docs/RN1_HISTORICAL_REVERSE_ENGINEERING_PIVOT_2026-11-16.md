# RN1 — Pivot historique : identification du code par les décisions passées
**16 novembre 2026 · audit réel de la base + sources historiques externes**

## Décision de recherche
Privilégier **l'historique déjà archivé**, et utiliser une collecte prospective seulement en complément. La cible reste **l'architecture du bot de RN1** : réactions aux variations de cote, aux scores, aux écarts de juste valeur externe et aux contraintes d'inventaire. Une corrélation après les fills n'est jamais présentée comme preuve d'une condition du programme.

## Inventaire vérifié directement dans Supabase
| Jeu de données | Volume constaté | Restrictions |
| --- | --- | --- |
| `pi.rn1_full_archive_pages`, `stream='trades_all'` | ~1 966 000 trades dans 1 966 pages compressées, juin–novembre 2026 | Fills dans Storage, pas dépliés en SQL ; l'archive contient Maker + Taker, ne pas relancer l'ingestion |
| `pi.rn1_historical_price_points` | **21 680 cotations** sur **159 tokens**, 12–14 novembre, 21 407 points de résolution 60 s + 273 autres | Historique Polymarket **seul**, pas un oracle externe, couvertures tronquées et sparse |
| `pi.rn1_nba_espn_plays` | **22 611 actions** sur **46 événements NBA**, 10–16 novembre | `play_at` = date de l'action ; `recorded_at` = moment de collecte a posteriori, ne prouve pas connaissance temps réel |
| `pi.rn1_trade_pages` | **4 000 BUY fills** sur 1 308 tokens, 12–15 novembre | Source historique pilote limitée à **Taker-only** ; ne jamais généraliser à la politique Maker |
| `pi.rn1_price_edge_cohort` | **576 marchés / 565 événements** | Échantillon économique, pas reconstitution transactionnelle complète |

**Contrôle de jointure causal** : parmi 4 000 BUY de l'ancien pilote, **1 373** ont au moins un prix public dans les 60 secondes précédant le trade, **1 371** ont une série valide avec un prix 5 minutes plus tôt (écart du lag 5 points entre 240 et 420 s). 159 tokens couverts. Les tokens des sondes **live** Maker `pi.rn1_quote_probe_fills` et ceux de ce lot historique ont un recouvrement **nul** : ne pas confondre ces deux cohortes.

## Mini-test réellement exécuté : réaction aux variations de prix passées
**Hypothèse exploratoire** : RN1 achète après une baisse de cote ou, inversement, suit les hausses.

Définir `delta_5min = prix_cotation_avant_achat - prix_cotation_5min_avant`; dans la comparaison naïve des 1 371 fills retenus vs 18 213 points de marché sur les mêmes 159 tokens :
- Prix 5min passé **aux moments des achats** : moyenne **+0,00758**, médiane 0 ; 41,21 % précédés d'une baisse.
- Prix 5min passé **sur l'ensemble des minutes de ces tokens** : moyenne **+0,00078**, médiane 0 ; 44,11 % précédés d'une baisse.
- Différence brute moyenne **+0,00680 point de prix**, soit 0,68 point de probabilité. Il n'y a **ni intervalle d'incertitude ni test hors événement** ici.
- **Verdict = non identifié**, pas « suit la tendance » : les minutes de contrôle ne sont pas pondérées par événement/sous-marché/temps comme les fills, les exécutions d'ordres peuvent être retardées, et la source de fills privilégie les Taker. La moyenne pourrait être dominée par quelques événements.

Les résultats ne prouvent pas un oracle ni une règle de sizing.

## Sources d'oracles historiques disponibles et limites
1. **The Odds API** (`the-odds-api.com`, distinct de `theoddsapi.com` déjà configuré pour la capture prospective) : API documentée de snapshots d'odds multi-bookmakers remontant à 2020, granularité **5 minutes** depuis 2022, endpoint historique renvoyant le snapshot **au plus tard à la date demandée**. **Accès payant** aux odds, pas d'achat/connexion automatique. Voir https://the-odds-api.com/historical-odds-data/ et https://the-odds-api.com/liveapi/guides/v4/.
2. **TheOddsAPI** (`theoddsapi.com`, producteur du collecteur à clé `RN1_ODDS_API_KEY`) : archive historique depuis mai 2026 dans sa formule **Business**, annoncée à **99 USD/mois** dans les prix publiés le 3 juillet 2026 ; pas d'archive dans la formule gratuite. Voir https://theoddsapi.com/pricing et https://theoddsapi.com/docs/.
3. **Polymarket CLOB/Data API** : historiques de prix par token, gratuits, dont les **21 680 points existants** en base. Cela aide à reconstruire la politique du bot mais **ce n'est pas indépendant du marché à expliquer**. Voir https://institute.polymarket.com/data.
4. **ESPN historisé** : résultats, play-by-play et quelques lignes d'ouverture/fermeture récupérables après les événements. Les odds `open/close` ne sont pas une série horodatée de variations en direct et la date de l'action ne prouve pas la date de diffusion. Ne pas utiliser une cote de clôture disponible seulement a posteriori comme un oracle pour prédire une décision antérieure.

**Attention au live :** même une archive bookmaker de 5 minutes peut s'avérer insuffisante pour le déclencheur secondes de RN1 ; il faut confirmer que les cotes **in-play** du sport et marché sont effectivement présentes dans l'archive historique sélectionnée, et pas seulement les cotes prégame.

## Protocole efficace, sans refaire l'ingestion
**H0** Baseline de fréquence/participation par marché, moment du match et liquidité ; **M0** Market maker (Polymarket, inventaire et paires) ; **M1** Oracle externe (écart odds externe - prix accessible Polymarket) ; **M2** Hybride (fair value + microstructure + inventory), avec comparaison sur **les mêmes conditions et événements**.

1. Sélectionner une cohorte stratifiée de **20–50 événements avec le plus de trades RN1**, sports et phases représentatifs, en privilégiant les marchés avec histoire de prix au moins 1 min ; retenir d'autres marchés du même sport **sans RN1** comme contrôles si historique disponible. Ne pas confondre Taker-only pilote avec les Maker de l'archive `trades_all`.
2. Lire l'archive compressée **existante** depuis Storage par **pages ciblées et budgetées**, sans duplication ni re-téléchargement massif. Normaliser **tous** les fills Maker/Taker de ces événements, les prix et états YES/NO ; grouper les fills en hypothèses d'ordre, ne pas traiter les ordres privés comme observés.
3. Construire le panel **événement×token×minute** avec prix publics **strictement antérieurs**, momentum / spread quand existant, phase du score et inventaire inférable **uniquement à partir des transactions RN1 passées**. Pas de suppositions d'inventaire initial, de liquidité ou d'ordres non exécutés.
4. Sur ce panel, **pré-enregistrer** les hypothèses de déclencheur : `Δprix 1/3/5/10 min`, écart YES/NO, délai depuis dernier fill, événement de score, déséquilibre, et un modèle de non-activité. Appliquer holdout **par match** et dans le temps, puis par sport/phase ; baseline sans signal.
5. Avant d'acheter des odds : étudier la **disponibilité des snapshots prétrade** pour 5–10 événements, y compris **in-play** et le contrat spécifique de chaque marché. Devis/coût et éventuelle collecte payante nécessitent un accord distinct.
6. Si la référence bookmaker historique existe, calculer une cote **sans vig** à l'heure t et tester son gain conditionnel : `p_ref(t)-prix_ask_accessible(t)-frais/queue` ; distinguer mouvement de la juste valeur, cotation passive, sélection Maker et PnL des rebates. Un prix futur est toujours exclu des features.
7. Publier dans **RN1 · Moteur** les règles survivant au holdout, les contre-exemples, les segments où les données manquent, et une ébauche de pseudocode. Aucun modèle n'est « le code RN1 » sans tests sur événements inconnus.

## À éviter
- Refaire la collecte de 1,97 million de transactions ; elles sont déjà archivées.
- Payer une API historique complète sans vérifier d'abord le taux de couverture **des marchés RN1 pendant les matchs**.
- Rejeter l'oracle simplement parce qu'on ne trouve que Polymarket dans les archives.
- Utiliser les 4 000 fills Taker-only du pilote pour déduire la stratégie Maker.
- Dire qu'un markout positif Maker prouve une capacité de prédiction externe.

## SQL : tests pilote auditables
```sql
WITH prices AS (
 SELECT token_id,observed_epoch,price,
  lag(price,5)OVER(PARTITION BY token_id ORDER BY observed_epoch)prev5,
  lag(observed_epoch,5)OVER(PARTITION BY token_id ORDER BY observed_epoch)prev5_epoch
 FROM pi.rn1_historical_price_points
 WHERE resolution_seconds=60 AND price BETWEEN 0.01 AND 0.99
),
fills AS (
 SELECT x->>'token_id' token_id,(x->>'timestamp')::bigint at,
  (x->>'price')::numeric fill_price,x->>'event_slug' event_slug
 FROM pi.rn1_trade_pages t
 CROSS JOIN LATERAL jsonb_array_elements(t.raw_payload->'source_response'->'data')x
 WHERE x->>'side'='BUY'
  AND x->>'token_id' IS NOT NULL AND x->>'timestamp' IS NOT NULL
),
matched AS (
 SELECT f.*,q.price-q.prev5 delta5
 FROM fills f JOIN LATERAL (
  SELECT p.* FROM prices p
  WHERE p.token_id=f.token_id AND p.observed_epoch BETWEEN f.at-60 AND f.at
  ORDER BY p.observed_epoch DESC LIMIT 1
 )q ON true
 WHERE q.prev5 IS NOT NULL AND q.observed_epoch-q.prev5_epoch BETWEEN 240 AND 420
),
controls AS (
 SELECT p.* FROM prices p
 WHERE p.prev5 IS NOT NULL AND p.observed_epoch-p.prev5_epoch BETWEEN 240 AND 420
 AND EXISTS(SELECT 1 FROM matched m WHERE m.token_id=p.token_id)
)
SELECT
 (SELECT count(*) FROM matched)fill_rows,
 (SELECT avg(delta5) FROM matched)mean_fill_momentum5,
 (SELECT avg((delta5<0)::int) FROM matched)pct_fill_post_drop,
 (SELECT count(*) FROM controls)control_rows,
 (SELECT avg(price-prev5) FROM controls)mean_control_momentum5,
 (SELECT avg(((price-prev5)<0)::int) FROM controls)pct_control_post_drop;
```

**Décision : passer à l'historique d'abord** ; le collecteur prospectif déjà installé reste simplement en mode `missing_api_key` sans appel externe (aucune clé connectée). Ne pas demander à l'utilisateur de configurer une clé gratuite live comme condition de ce travail.
