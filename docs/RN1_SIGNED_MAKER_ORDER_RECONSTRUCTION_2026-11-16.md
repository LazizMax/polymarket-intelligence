# RN1 — Reconstitution des ordres Maker signés via Polygon

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
