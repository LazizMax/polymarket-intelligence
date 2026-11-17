# RN1 — Prix historiques avant signature des ordres Maker

**Analyse exécutée et terminée le 17 novembre 2026.** Cette étude poursuit la reconstruction des décisions RN1 à partir des vrais ordres signés Polygon, et **non** des bookmakers.

## État de la preuve et audit temporel

- Archive initiale : **80 000 fills**, dont 68 445 Maker ; **46 330 identifiants d'ordres signés** distincts observés ; 68 433 fills Maker attribués sans ambiguïté, 12 autres explicitement ambigus.
- Trois groupes d'ordres originaux EIP-712 vérifiés, **1 361 order hashes distincts** issus de 1 177 transactions sélectionnées. La requête de calldata fournit le prix limite, la quantité signée et un timestamp déclaré à la milliseconde.
- Prix historique récupéré via `GET https://clob.polymarket.com/prices-history` sur une **fenêtre bornée de 900 secondes avant et 30 secondes après** la création déclarée. Le collecteur ne retient **jamais** un point dont le timestamp dépasse la création déclarée et exige un retard maximal de 90 s. Baseline 5 min dans une fenêtre de 300–420 secondes avant création.
- **1 285 / 1 361 (94,42 %) ordres** avec prix antérieur au plus vieux de 90 secondes ; **1 252 / 1 361 (91,99 %)** également avec variation de prix 5 minutes exploitable ; **76 / 1 361** marqués `missing` et exclus des comparaisons, sans interpolation ni remplissage futur.
- Âge moyen du point de prix précédent : **31,5 secondes**.
- Tests finaux : **0 prix postérieurs** au timestamp déclaré, **0 baseline postérieure à T−300s**, **0 prix retenus plus vieux que 90 secondes**.
- Données privées `pi.rn1_maker_signed_creation_quotes` + vue `pi.rn1_maker_signed_creation_price_analysis`. RLS, droits de lecture directe révoqués aux rôles non privilégiés.
- Cron `pi-rn1-signed-creation-quotes-1min` id **20 désactivé/supprimé** une fois les 1 361 ordres classifiés ; aucune collecte récurrente superflue.

**Limite cruciale :** `prices-history` est une série obtenue *rétrospectivement* ; bien que son horodatage précède celui de l'ordre, ce n'est **pas** la preuve qu'un price point identique était visible et publiquement disponible en temps réel au trader. Ce n'est pas non plus le meilleur bid/ask ni une file d'attente. Aucun ordre jamais exécuté n'est observable dans cette cohorte.

## Prix limite signé versus indicateur de prix Polymarket

Définition `signed_gap = signed_buy_limit_price − historical_last_price_at_or_before_declared_creation`.

La partie générale, sélectionnée par transactions et non par order ID, a **860 ordres distincts**, dont **811** avec prix antérieur exploitable, **796** avec momentum 5 minutes.

| Groupe de transactions | Ordres avec prix | Médiane signed_gap | p10 | p90 |
| --- | ---: | ---: | ---: | ---: |
| Général | **811** | **−0,0050** | −0,0550 | +0,0350 |
| Multi-prix, suréchantillonné | 337 | −0,0150 | −0,0650 | +0,0250 |
| Persistance, suréchantillonné | 137 | −0,0050 | −0,0290 | +0,0100 |

La médiane du groupe général est un **prix limite acheteur situé 0,5 point de probabilité sous la dernière référence historique retrouvée**. La dispersion est large ; la référence n'est pas nécessairement une cote exécutable.

## Selon la variation historique cinq minutes auparavant

Groupe général avec momentum valide (796 ordres) :

| Variation préalable de l'indicateur | Ordres | Matchs distincts | Écart signé médian | Pct au moins 0,5 point sous référence | Parts signées médianes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baisse >1 point | **304** | 247 | **−0,0100** | **54,28 %** | 1 429,5 |
| Entre −1 et +1 point | 148 | 126 | −0,0040 | 29,05 % | 1 480,0 |
| Hausse >1 point | **344** | 259 | **−0,0050** | **36,92 %** | 830,5 |

Sensibilité à l'âge du prix : en imposant une référence ≤30 secondes avant la création, le signal médian reste −0,010 après baisse contre −0,005 après hausse, avec respectivement 177 et 182 ordres.

**Contrôle match (événements) :** seulement **13 événements** contiennent au moins deux ordres signés après baisse et deux après hausse ; dans **10**, l'écart signé est plus négatif après baisse, dans **3** après hausse. Différence moyenne des écarts par match : **−0,0092**. **Ces 13 matchs seulement ne suffisent pas à valider un effet causal ou un comportement systématique.** De plus, l'âge moyen des références par régime peut différer et le niveau des prix évolue selon le match.

**Contrôle période historique :**
- ancien (cutoff 2026-11-09 20:39:27 UTC) : 448 ordres, signed_gap médian **−0,0050** ;
- récent : 363 ordres, signed_gap médian **−0,0050**.

L'écart médian global est stable entre les deux périodes, mais les conditions et marchés ne sont pas identiques.

## Relations avec les règles précédemment découvertes

Les ordres signés originaux confirment sur l'échantillon :
- **1 361/1 361** tailles demandées en parts entières et seulement **79/1 361** budgets signés en USDC entiers ;
- dans les 150 transactions multi-prix ciblées, **71 créations à timestamp égal** comprenant différents niveaux de prix ;
- **74/78** écarts entre niveaux adjacents créés au même timestamp à pas de **0,01** ;
- **78/89** paires avec timestamp égal à quantités identiques, contre **42/150** si leur timestamp diffère.

Nouvelle hypothèse quantitative **à tester hors échantillon** :

> RN1 signe souvent des limites d'achat légèrement inférieures au prix historique récent, avec une tendance à augmenter cet écart après baisse. Quand il émet plusieurs niveaux dans un même lot signé, ceux-ci sont fréquemment espacés de 0,01 et de taille identique en parts.

Il manque cependant les ordres *non exécutés*, l'heure effective d'arrivée au carnet, les annulations, la profondeur, la queue, et des cotations archivées prouvées en temps réel. **L'hypothèse ne constitue pas une stratégie profitable ou reproductible démontrée.**

## Implémentation livrée

- `supabase/functions/pi-rn1-onchain-orders/index.ts` : `rn1_creation_quote_tick`, claim, retries, fenêtre bornée et contrôle d'antériorité.
- `sql/077_rn1_signed_creation_quote_provenance.sql` : schéma et garanties SQL.
- `supabase/functions/pi-dashboard/rn1-creation-quotes.ts` : route authentifiée `rn1_signed_creation_price_report`, résultats par régime, période, âge de cotation et comparaison par match.
- `web/index.html` : panneau **Prix historique avant signature · RN1 Maker** dans **RN1 · Moteur**.
- Fonction backend `pi-dashboard` v43 **ACTIVE** le 17 novembre 2026.
- Site web : modifications versionnées dans GitHub, mais la présence de la nouvelle version chez l'utilisateur derrière son cache/session n'a pas été vérifiée interactivement.

## Prochain test critique

**Échantillon indépendant / hors échantillon** : extraire de manière bornée quelques nouveaux ordres d'autres pages archivées, ne pas réutiliser ces 1 361 identifiants, et mesurer **les mêmes métriques**. Agréger par match et saison/ligue pour éviter la pseudo-réplication.

**Effet d'inventaire et résultats économiques :** reconstruire les deux faces achetées/vendues, la position nette, les montants encaissés et payés et la valeur finale avant de conclure à un EV positif. Les seules exécutions Maker sélectionnées et les références de prix historiques ne permettent aucun ROI réel.
