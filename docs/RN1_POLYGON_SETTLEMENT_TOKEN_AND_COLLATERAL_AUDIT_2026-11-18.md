# RN1 — Audit Polygon des transferts de parts, règlements et collatéral pUSD

**18 novembre 2026 — analyse réellement exécutée sur la blockchain Polygon.**

## Périmètre et chaîne de preuve

Point de départ : la validation indépendante d'un grand livre sur **16 marchés**, dont **8 soldés** (ou ne gardant que des poussières de parts) et 8 avec inventaire résiduel. Les 8 soldés ont été sélectionnés indépendamment des premiers trois pilotes historiques.

Le worker privé `supabase/functions/pi-rn1-chain-ledger/index.ts` (v6 ACTIVE à la date de ce rapport) lit exclusivement les transactions archivées des 8 marchés prédéfinis ; aucun hash arbitraire ne peut être fourni à l'API. La lecture utilise `eth_getTransactionReceipt` et `eth_getTransactionByHash` sur Polygon, avec le même tx hash comme point d'ancrage.

Au total :
- **8/8 marchés audités** ;
- **12 transactions de fusion/règlement** reçues sur Polygon, statuts réussis ;
- **4 événements CTF `PositionsMerge`** filtrés sur conditionId + transaction + montant correspondant exactement à la source ;
- **16 sorties ERC-1155** de RN1 correspondant chacune à un `MERGE` ou une ligne `REDEEM` de même quantité, dont 8 lignes de règlement à montant nul ;
- **8 `PayoutRedemption` positifs** de même conditionId, même transaction et même montant que les huit crédits archivés ;
- **12 `Transfer` ERC-20 pUSD** directement vers RN1, venant du zéro (mint), montant exactement égal aux quatre fusions et aux huit règlements positifs ;
- **0 transaction parmi les 12 dont RN1 est `tx.from`** : le gas est payé directement par d'autres adresses, **sans préjuger d'un remboursement de frais, d'une commission hors chaîne ou de rebates**.

ERC-1155 : contrat Conditional Tokens `0x4d97dcd97ec945f40cf65f87097ace5ea0476045`. ERC-20 pUSD observé : `0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb`. Certains événements CTF utilisent l'ancien collateral USDC.e `0x2791bca1f2de4661ed88a30c99a7a9449aa84174`, tandis que le routeur crédite du pUSD au wallet.

## Résultat essentiel : les encaissements ne sont plus seulement estimés

| Flux vérifié | Opérations | Montant reçu directement par RN1 |
| --- | ---: | ---: |
| Crédit pUSD suite aux MERGE | **4/4** | **23 332,054400 pUSD** |
| Crédit pUSD suite aux règlements positifs | **8/8** | **14 049,657731 pUSD** |
| **Total direct** | **12/12** | **37 381,712131 pUSD** |

Chaque événement source positif possède une seule transaction ERC-20 pUSD de montant exact, vers le wallet RN1, depuis le zéro. Chaque mouvement de sortie ERC-1155 de l'archive a un transfert de deux tokens correspondant en quantité au sein de la même transaction. Il existe donc désormais **une triple concordance** : événement source → mouvement de parts RN1 sur Polygon → crédit en collatéral au wallet.

**Ne pas confondre les bénéficiaires :** l'adresse `redeemer` de `PayoutRedemption` est souvent un contrat routeur, pas RN1. La preuve que RN1 est crédité provient du `Transfer` pUSD direct, pas seulement de l'événement de règlement intermédiaire.

## Piège détecté et corrigé : transactions groupées

Les opérations de fusion et de règlement incluent souvent plusieurs utilisateurs ou marchés dans **la même transaction**. Sur ces 12 transactions, **148 événements `PayoutRedemption` d'autres participants mais du même marché** ont été repérés et **exclus**.

Il serait incorrect de sommer tous les payouts d'une transaction, ou même tous les payouts au même conditionId : cela surestime considérablement le profit de RN1. Notre correspondance est à présent **événement par événement**, avec transaction, conditionId, montant et transfert de parts attribué au wallet, puis crédit ERC-20 direct.

Les transferts ERC-1155 sont reconstitués via les événements `TransferSingle` et `TransferBatch`. Les sorties de RN1 ont des quantités matching uniques sur les 20 lignes d'événements sources (4 MERGE, 16 REDEEM), dont les 8 règlements nuls. L'identification indépendante des tokenIds de chaque issue, la possibilité de flux hors archive, le coût d'acquisition des parts et la balance d'ouverture nécessitent toujours un audit supplémentaire.

## Gas : qui a réellement payé ?

Les 12 transactions de règlement et fusion représentent environ **14,5186165235 MATIC de gas total de transaction**, sur des lots multi-utilisateurs. **Aucune de ces transactions n'a RN1 comme `tx.from`**.

Cela ne signifie **ni** que RN1 est exempt de tout frais, **ni** qu'il doit supporter 14,52 MATIC : ce gas est **payé directement par les émetteurs des transactions**. Les remboursements, les frais applicatifs et les rebates ne sont pas attribuables à RN1 depuis ces seuls reçus.

En parallèle, les agrégats d'activité RN1 contiennent `MAKER_REBATE` (228 événements) et `TAKER_REBATE` (153 événements), mais **sans ventilation fiable par chacun des huit marchés**. Ces agrégats ne peuvent pas être ajoutés à leur P&L individuellement.

## Chiffre économique et limites

Le grand livre source des **huit marchés soldés** donne **+314,683721 unités** de différence brute entre encaissements et dépenses archivées pour **37 067,028410 unités** de dépenses d'achat estimées depuis les fills, soit environ +0,849 % du coût d'achat. Le travail blockchain confirme désormais que **les encaissements enregistrés des MERGE et REDEEM ont bien été crédités en pUSD**.

**Ce +314,68 n'est toujours PAS un P&L net after-fees vérifié.** Il manque :
1. Validation du débit exact de pUSD pour les **achats BUY**, en particulier le lien entre Maker/Taker et frais éventuels.
2. Attribution de frais, maker rebates, taker rebates, éventuelles rémunérations d'ordre et remboursement de gas.
3. Contrôle des transferts d'ERC-1155 hors trades, des SPLIT et des soldes d'ouverture/fermeture.
4. Extension sur un échantillon probabiliste suffisamment important et validation par période/ligue.

## Implémentation

- Worker privé `pi-rn1-chain-ledger` v6 : RPC Polygon, décodage CTF, ERC-1155 et transferts pUSD, choix borné aux huit marchés déjà validés, authentification par scheduler token. Ne fait **aucun appel d'écriture à la blockchain**.
- Base privée `pi.rn1_chain_settlement_audit` : **8 petites lignes** ; RLS et droits `anon/authenticated` révoqués.
- SQL versionné : `sql/081_rn1_chain_settlement_receipt_audit.sql` (CTF, parts, gas, exclusion des faux payouts), `sql/082_rn1_direct_collateral_pusd_credits.sql` (transferts directs de pUSD vers RN1).
- Backend `pi-dashboard` v52 ACTIVE, route authentifiée `rn1_chain_settlement_report` et UI **RN1 · Moteur → Vérification Polygon des fusions, règlements et frais réseau**.
- La session navigateur réelle connectée n'a pas été testée ; la route sans session doit rester inaccessible.

## Sources de protocole

- Gnosis Conditional Tokens `PositionsMerge`, `PayoutRedemption`, `TransferBatch` : https://github.com/gnosis/conditional-tokens-contracts/blob/master/contracts/ConditionalTokens.sol
- Polymarket v2 router, redeem/split/merge et passage USDC.e vers pUSD : https://github.com/Polymarket/polymarket-v2-external/blob/main/docs/router.md

**Prochain test critique : les débits exacts de collatéral lors des transactions BUY.** Tant que les dépenses d'achat, les commissions et les rebates ne sont pas attribuables à RN1 sur une base identique à celle des encaissements, la marge nette des grilles Maker reste inconnue.
