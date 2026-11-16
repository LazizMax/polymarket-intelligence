# RN1 — Paramètres originaux des ordres signés (Polymarket V2)

**16 novembre 2026 — étude terminée et reproductible.** Scope : cohorte de 80 000 fills RN1 (68 445 Maker), audit Blockchain 105/105 plages, 46 330 ordres Maker signés avec au moins une exécution, 68 433 fills attribués sans ambiguïté et 12 fills ambigus conservés séparément.

## La percée : le calldata signé, pas seulement l'événement OrderFilled

Le RPC Polygon `eth_getTransactionByHash` expose le `input` de l'appel public `matchOrders` (sélecteur `0x3c2b4399`). Le contrat Polymarket V2 reçoit les structs `Order` complets :
- `makerAmount` : montant USDC/PMCT proposé, en unités à 6 décimales pour BUY ;
- `takerAmount` : nombre **initialement signé** de parts achetables, en unités à 6 décimales pour BUY ;
- `side`, `tokenId`, `maker`, `salt`, `signatureType`, `metadata`, `builder` ;
- `timestamp` : horodatage **déclaré par l'ordre signé**, en millisecondes UTC.

**Validation cryptographique :** EIP-712, domaine `Polymarket CTF Exchange`, version `2`, `chainId=137`, contrat d'exécution en `verifyingContract`. Pour chaque ordre enregistré, `TypedDataEncoder.hash(...)` **doit correspondre à un `maker_order_hash` déjà confirmé sur Polygon** pour la même transaction et le même token. Vérifier prix limite / prix exécuté et parts remplies ≤ parts signées ; sinon refuser le lot. Aucun attribut construit depuis une coïncidence de prix ou timestamp seul.

**Attention :** timestamp déclaré ≠ heure vérifiée de placement au CLOB, création signée ≠ carnet/queue/annulation. Quantité signée ≠ quantité nécessairement exposée au carnet ni parts exécutées. On n'observe pas les ordres jamais exécutés.

Sources Polymarket :
- https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/CTFExchange.sol
- https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/libraries/Structs.sol
- https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/mixins/Hashing.sol

## Échantillonnage effectivement exécuté

**1 177 transactions confirmées**, trois groupes disjoints déterministes :
- **877** transactions sélectionnées par hash de transaction (groupe général ; chevauchements avec les autres groupes exclus) ;
- **150** transactions où un ordre réexécuté est observé sur ≥60 secondes (groupe ciblé persistance) ;
- **150** transactions ayant exécuté plusieurs niveaux de prix (groupe ciblé grilles).

Ces 1 177 transactions fournissent **1 389 correspondances ordre/transaction**, mais **1 361 order hashes distincts** après déduplication (ordres réexécutés parfois présents dans plusieurs transactions sélectionnées). **1 361/1 361** ont un hash EIP-712 correct ; 0 violation des contrôles de prix, quantité ou création postérieure au premier fill parmi les données attribuées. Stockage base ≈784 Mo, seuil d'arrêt à 875 Mo.

La sélection est *par transaction*, non un échantillon aléatoire uniforme de tous les ordres ; les groupes ciblés **ne doivent pas être regroupés naïvement** avec le groupe général pour produire une fréquence RN1.

| Mesure | Groupe général (860 ordres uniques, 542 événements) | Persistants (146 ordres uniques) | Multi-prix (355 ordres uniques) |
|---|---:|---:|---:|
| Taille signée, médiane | **1 025,50 parts** | 1 075 parts | 1 562 parts |
| Taille exécutée observée, médiane | **242,99 parts** | 277,50 parts | 1 478 parts |
| Notionnel initial signé, médiane | **396,90 USDC** | 428,33 USDC | 786,40 USDC |
| Parts exécutées / parts signées, ratio médian | **30,60 %** | 51,39 % | 100 % |
| Ordres ayant ≥99,9 % des parts signées observées comme exécutées | **32,33 %** | 30,14 % | 79,72 % |
| Premier fill − timestamp déclaré, médiane | **10,12 s** | 77,78 s | 15,06 s |
| Premier fill − timestamp déclaré, p90 | **76,14 s** | 615,16 s | 92,22 s |

Dans le groupe général : **57,21 %** des ordres ont moins de 50 % de leurs parts signées observées comme exécutées dans la fenêtre archivée. Ce ratio est **une borne inférieure d'exécution observée**, non un taux final de fill ou un taux d'annulation : l'archive RN1 est une cohorte et peut omettre des exécutions hors fenêtre.

**Conclusion importante :** le sizing de RN1 reconstitué uniquement depuis les fills sous-estime fortement la quantité signée dans une grande partie des cas.

## Règle candidate de génération de grille

Dans les **150 transactions multi-prix** sélectionnées :
- **355 ordres signés** reconnus ; **71 groupes** contiennent au moins 2 niveaux de prix distincts, sur le même token, dans la même transaction, avec le **même timestamp déclaré à la milliseconde** (64 à deux niveaux, 7 à trois).
- Parmi ces 71 groupes, **60 (84,5 %)** ont la même quantité signée sur les niveaux (tolérance 0,01 part).
- **74 des 78 espacements consécutifs (94,87 %)** sont de **0,01** de probabilité. Trois écarts sont de 0,02, un de 0,03. Largeur médiane du groupe : 0,01.
- Contrôle *au sein des mêmes transactions* entre paires d'ordres à des prix distincts :
  - Timestamp exactement identique : **78/89 paires (87,64 %)** ont la même taille signée ;
  - Timestamp différent : **42/150 (28,00 %)** ont la même taille signée.
  - Dans les **24 transactions** ayant les deux types de paires, **20** favorisent des quantités égales pour les paires de même timestamp, **0** l'inverse, **4** sont à égalité. Les paires ne sont pas indépendantes ; l'analyse par transaction est plus fiable que les seules proportions de paires.
- **Réplication par période** (séparation fixe au 9 novembre 2026, 20:39:27 UTC) :
  - Ancien : taille égale même timestamp **47/54 (87,04 %)** vs timestamp différent **25/92 (27,17 %)** ; pas de 0,01 **43/46 (93,48 %)**.
  - Récent : taille égale même timestamp **31/35 (88,57 %)** vs timestamp différent **17/58 (29,31 %)** ; pas de 0,01 **31/32 (96,88 %)**.

**Hypothèse concrète, testable :** quand plusieurs niveaux sont créés dans un même lot signé, RN1 dimensionne généralement les niveaux avec le **même nombre de parts entières**, séparés de **1 cent de probabilité**. Cela prouve des **ordres signés exécutés** avec cette configuration, pas la présence simultanée de tous les niveaux en carnet ni une rentabilité.

## Unités de sizing : parts plutôt que dollars ronds

**1 361/1 361** des quantités initiales signées sont un **nombre entier exact de parts** (`takerAmount mod 1e6 = 0`). Seulement **79/1 361 (5,8 %)** des montants signés en collateral sont un nombre entier exact d'USDC (`makerAmount mod 1e6 = 0`). Les **1 361 timestamps déclarés** ont une composante milliseconde non nulle. Ces règles apparaissent dans les trois cohortes.

**Interprétation :** forte compatibilité avec un moteur de dimensionnement en parts, plutôt qu'un budget fixe systématique en USDC rond. La distinction entre décision du trader et comportement automatique de sa bibliothèque d'ordres reste non observable.

## Contrôles, production et sécurité

- Source / worker : `supabase/functions/pi-rn1-onchain-orders/index.ts` avec action `rn1_calldata_sample_tick`, échantillon borné, claim atomique + lease, retries maximaux, quota stockage 875 Mo.
- SQL versionné : `sql/076_rn1_signed_calldata_sampling.sql` ; tables privées `pi.rn1_maker_calldata_sample_txs` / `pi.rn1_maker_calldata_signed_orders`, vue `pi.rn1_maker_calldata_execution_analysis`; RLS activé, droits `anon/authenticated` révoqués.
- Backend authentifié `pi-dashboard` v42 ACTIVE, route `rn1_signed_calldata_research` et `rn1_signed_order_detail` enrichie.
- Frontend `web/index.html`, onglet **RN1 · Moteur** : progression, cohortes, proportions de fills, délais, grilles à timestamps identiques et contrôle « même timestamp vs différent » ; ouverture d'un ordre signé pour inspecter prix/taille initiaux si disponibles.
- Cron id 19 a été prévu seulement pendant le traitement des 1 177 transactions, avec garde SQL empêchant une requête HTTP une fois tous les statuts confirmés.

## Limites et suites

1. Reconstituer les règles de **choix de la taille par marché et exposition**, pas seulement les dimensions et espacements d'ordres observés. Examiner les variations des lots entre deux timestamps de création sur le même marché.
2. Rapprocher le timestamp signé des cotes Polymarket **antérieures prouvées** et des événements sportifs rétrospectifs, sans fuite d'information ni attribution causale abusive ; les archives de cotations existantes sont lacunaires.
3. Étudier l'inventaire complet (achats/ventes/transferts/redemptions hors cohorte). Les données des 80 000 fills ne permettent pas de reconstituer un solde exhaustif.
4. Élargir sélectivement la reconstruction aux archives restantes dans des fichiers compressés ou des lots agrégés, **pas** en répliquant plusieurs millions de lignes dans PostgreSQL.
5. Aucune rentabilité after-fees, EV reproductible ni capacité de copy-trading n'est démontrée par cette étude d'ordres exécutés.

## Requêtes reproductibles

```sql
select cohort,status,count(*) transactions,sum(matched_orders) orders
from pi.rn1_maker_calldata_sample_txs group by 1,2 order by 1,2;

select sampled_cohort,count(*) n,
 percentile_cont(.5) within group(order by signed_order_shares) signed_shares_p50,
 percentile_cont(.5) within group(order by observed_fill_ratio) observed_fill_ratio_p50,
 percentile_cont(.5) within group(order by age_to_first_fill_seconds) age_seconds_p50
from pi.rn1_maker_calldata_execution_analysis group by sampled_cohort;

select count(*),count(*) filter(where mod(signed_receive_shares,1000000)=0) whole_shares,
count(*) filter(where mod(signed_buy_amount,1000000)=0) whole_usdc
from pi.rn1_maker_calldata_signed_orders;
```
