# RN1 — Reconstitution des ordres Maker signés via Polygon

## Résultats définitifs du premier scan — 100 % terminé

**État de production vérifié :** `pi.rn1_maker_chain_scan_state.status='complete'`, **105/105 plages**, tous les blocs `96815414..97339531`, dernier checkpoint `next_block=97339532`, aucune erreur en attente. Cron 18 reste conditionné à `status='running'` : il ne relance pas ce scan terminé.

| Contrôle | Résultat |
| --- | ---: |
| Fills normalisés d'origine | 80 000 |
| Fills Maker historiques | **68 445** |
| Fills Maker attribués à un orderHash Polygon distinct et vérifié | **68 433** |
| Fills Maker individuellement ambigus (mais événement de l'ordre confirmé) | **12** |
| Transactions Maker confirmées sans ambiguïté | **66 936** |
| Transactions Maker ambiguës | **4** |
| Total transactions Maker auditées | **66 940** |
| Ordres signés Maker distincts avec fill attribué | **46 330** |
| Ordres signés exécutés dans au moins deux transactions | **9 845** |
| Part du notionnel attribué à ces ordres réexécutés | **23,63 %** |
| Ordres avec premier/dernier fill à ≥60 s d'intervalle | **890** |
| Ordres avec premier/dernier fill à ≥5 min d'intervalle | **230** |
| Plus long intervalle observé sous le même orderHash | **6 603 s (1 h 50 min 03 s)** |

**Audit exhaustif :** 66 936 + 4 = 66 940 transactions Maker ; 68 433 + 12 = 68 445 fills Maker. Les **12 événements d'ordres blockchain signés** des 4 transactions ambiguës sont conservés séparément dans `pi.rn1_maker_ambiguous_order_events`, sans créer de correspondance fingerprint→orderHash inventée. Aucun Maker orderHash affecté à un fill Taker, ni de hash d'ordre attribué à plusieurs marchés/tokens.

**Preuve des grilles d'exécution :** **1 206 transactions** contiennent au moins deux ordres Maker signés distincts, **687** plusieurs niveaux de prix arrondis au millième et **87** au moins trois niveaux ; largeur médiane des groupes multi-prix **0,01** point de probabilité. Cela prouve plusieurs niveaux **exécutés**, non la simultanéité de leur soumission.

**Test exploratoire des premières exécutions** sur les **766 fills Maker ayant un momentum Polymarket cinq minutes valide** (26 événements) : première exécution observée d'un orderHash **76/125 (60,8 %) en période calme**, contre **383/641 (59,75 %) en période volatile**. Sur 10 événements avec au moins 5 fills de chaque régime : 7 ont davantage de premières exécutions en période volatile, 3 en période calme. Pas de régularité démontrée et **premier fill ≠ création d'ordre**. Ces 766 observations seulement ne justifient aucune règle de placement ou profitabilité.

**Livraison UI** : `pi-dashboard` **v39 ACTIVE**, routes `rn1_onchain_orders_report` et `rn1_signed_order_detail` ; `web/index.html` permet d'ouvrir un ordre et de lire ses véritables fills et transactions, et distingue premières exécutions et réexécutions. L'accès sans session ne doit pas permettre de lire ces données privées ; le chemin UI connecté n'a pas été testé avec une session réelle.

**Portée :** ce résultat est exhaustif **pour la cohorte de 80 000 fills**, pas pour les quelque deux millions de transactions des archives complètes. Les ordres jamais exécutés, annulations et véritables décisions de placement restent non observés.

---


**Date :** 16 novembre 2026. **Périmètre :** wallet RN1 et 80 pages historiques déjà archivées (80 000 fills, dont 68 445 Maker). Cette phase ne porte **pas** sur les historiques de bookmakers.

## Résultat réellement exécuté

Les 80 pages sources ont été contrôlées par SHA-256 et leurs **80 000 transaction hashes** ont été réintégrés aux lignes normalisées en respectant token, prix et quantité. Un même hash de transaction **n'est pas** un order ID.

L'Edge Function `pi-rn1-onchain-orders` (authentification scheduler côté serveur) exploite le RPC Polygon public : 
- `eth_getLogs` filtré par contrat V2 `0xe2222d279d744050d28e00520010520000310f59`, signature événement `OrderFilled` et maker = RN1 ;
- extraction de `orderHash`, token ID, maker, prix d'exécution, quantité et `logIndex` ;
- comparaison **stricte** de la transaction, du token, du prix (tolérance numérique bornée), et des parts contre les fills archivés ;
- écriture du `maker_order_hash` uniquement si chaque attribution est unique et complète ;
- checkpoint transactionnel par plage de blocs ; les pages achevées ne sont pas rejouées ;
- taille de plage réduite automatiquement sur HTTP 400 / erreur de taille ; cinq erreurs non récupérables provoquent une pause, budget stockage à **900 Mo**.

**Plage de blocs** vérifiée via reçus premier/dernier fills : `96815414..97339531`. Scanner cron `pi-rn1-signed-orders-1min` actif, job 18, borné ; il s'arrête à `complete`. Le scanner traite uniquement cette cohorte déjà archivée, pas toute l'histoire.

**Checkpoint contrôlé** : 81 plages achevées, **77,27 % des blocs**, **51 836 fills** confirmés par le scanner plus 8 exemples contrôlés individuellement, **35 331 ordres signés distincts** dans `pi.rn1_maker_signed_orders`. **7 466 ordres** ont été exécutés sur plusieurs transactions. Nombre d'ambiguïtés : **3 transactions / 10 fills**.

Attention : ces chiffres sont une photographie au moment de la documentation. Lire `pi.rn1_maker_chain_scan_state` et `pi.rn1_maker_signed_orders` pour la valeur actuelle.

## Ambiguïtés réellement étudiées et non falsifiées

Trois transactions possèdent des **ordres signés distincts au même token, prix et quantité**. Les fills Data API ne sont pas reliés à un `logIndex`, donc les lignes source individuelles ne permettent pas de distinguer les deux order hashes.

La table privée `pi.rn1_maker_ambiguous_order_events` conserve les **10 événements Polygon signés distincts**, avec token, prix, parts et index du log, **sans les attribuer aux fingerprints des 10 fills**. Les trois audits restent `ambiguous`, aucun fill fictivement attribué.

## Résultats analytiques

- Un `orderHash` peut être observé sur plusieurs transactions : preuve directe de **plusieurs exécutions d'un même ordre signé**, bien supérieure à un regroupement arbitraire « même seconde, même prix ».
- Le prix calculé depuis les quantités V2 est pratiquement constant sous un même hash. Le plus grand écart numérique contrôlé est de 0,00000212 sur le snapshot ; **aucun écart supérieur à 0,001**. Les métriques SQL arrondissent à trois décimales.
- Plusieurs identifiants d'ordres distincts d'un même token peuvent être exécutés dans une même transaction à **plusieurs niveaux de prix**, parfois espacés d'un point de probabilité. Cela confirme des niveaux de prix différents pour les ordres **exécutés**, pas leur placement simultané à l'origine.
- Des exemples d'ordres signés ont des fills espacés de **6 234 secondes** (1 h 43 min 54 s). Ce délai est seulement l'**intervalle observé entre premier et dernier fill**, **pas** le temps depuis la soumission ni une preuve qu'il a été continuellement affiché sur le carnet.
- Les tailles cumulées exécutées sont une **borne inférieure** sur la quantité totale signée ; la quantité initiale, le restant jamais rempli, les annulations et le coût de queue ne sont pas observés.
- « Premier fill observé d'un orderHash » ne signifie **pas** « création d'un ordre » : ne pas introduire de causalité artificielle.

## Interface et code

- Backend authentifié : `supabase/functions/pi-dashboard/rn1-onchain-orders.ts`, routes `rn1_onchain_orders_report` et `rn1_signed_order_detail`.
- Frontend `web/index.html`, onglet **RN1 · Moteur** : couverture du scan, ordres confirmés, ordres exécutés plusieurs fois, exemples cliquables **Voir les exécutions**.
- Edge Function crawler : `supabase/functions/pi-rn1-onchain-orders/index.ts`.
- Migrations versionnées : `sql/073_rn1_maker_archive_tx_provenance.sql`, `sql/074_rn1_polygon_signed_maker_orders.sql`, `sql/075_rn1_ambiguous_signed_order_events.sql`.
- Tous les objets SQL sont dans le schéma privé `pi`, tables RLS, droits `anon/authenticated` révoqués. L'API métier nécessite l'authentification de la session utilisateur.

## Ce qui reste et ce qu'il ne faut surtout pas prétendre

1. Terminer le scan **borné** `96815414..97339531` et calculer couverture définitive (fills confirmés, order hashes, transactions réellement ambiguës et éventuelles absences).
2. Distinguer **premier fill observé** et **réexécution d'ordres existants** face à la volatilité et aux événements de match. Contrôler par événement, tester chronologiquement et ne pas extrapoler depuis seulement 159 tokens cotés dans l'historique prix.
3. Investiguer périodes de conservation des ordres, grilles de plusieurs prix, tailles de lots et exposition, uniquement dans les limites des preuves.
4. Pour reconstruire **le placement** et l'annulation, il faut des observations de carnet de la même période, une source d'ordres publics signés permettant le suivi avant fill, ou les journaux privés du wallet. **OrderFilled ne fournit pas le timestamp de création.**
5. **Pas** de stratégie profitable, d'EV après frais ou de règles de décision Maker « prouvées » à ce stade.

## Contrôles SQL

```sql
select status,chunks_done,from_block,to_block,next_block,
       fills_verified,tx_confirmed,tx_unmatched,last_error
from pi.rn1_maker_chain_scan_state;

select count(*) signed_orders,sum(verified_fills) fills,
       count(*) filter(where transaction_count>1) repeated_orders
from pi.rn1_maker_signed_orders;

select count(*) events,count(distinct transaction_hash) ambiguous_transactions
from pi.rn1_maker_ambiguous_order_events;
```
