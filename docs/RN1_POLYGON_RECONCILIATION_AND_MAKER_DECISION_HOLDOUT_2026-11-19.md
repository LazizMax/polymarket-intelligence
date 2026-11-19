# RN1 — Clôture audit Polygon et validation hors événements de la règle de prix Maker
**19 novembre 2026 · source de preuve : Polygon / Supabase privé / GitHub**

## A. Ce qui a été réellement exécuté
- La file `pi.rn1_chain_acquisition_queue` du panel indépendant September 2026 est désormais **108/108 transactions au statut `verified`**, représentant **111 fills BUY**. Somme des débits pUSD directement observés : **37 067,028410**, strictement égale à la somme des coûts d'achat du ledger archivé ; zéro mismatch de cash.
- Les 8 toutes premières transactions avaient été contrôlées dans un audit précédent pour la correspondance des débits pUSD et des parts reçues ; **100 transactions supplémentaires ont également un token ID d'issue individuellement vérifié** et des preuves JSONB de reçus Polygon. Ne pas prétendre 108/108 token IDs prouvés par le nouveau worker.
- Sept transactions du marché `0x6c5152...` (CA Rosario Central, Sept 20) étaient marquées `ambiguous`, malgré exactes sommes pUSD et parts reçues. Le worker de diagnostic a appelé CTF `getCollectionId` puis `getPositionId` avec trois collatéraux :
  - USDC.e : aucun des 7 transferts ne correspond.
  - pUSD : aucun.
  - **WCOL neg-risk `0x3A3BD7bb9528E159577F7C2E685cC81A765002e2` : 7/7 exactes correspondances token ID (YES/NO) et montant.**
  - Tokens sous WCOL : outcome0 `18121526519433407266049544818887643036354529288334070851910186010177792112199`, outcome1 `44225980113333392068784161275839701879733186897398900375077580133170980044078`.
- SQL transactionnel sécurisé appliqué en direct et sauvegardé dans `sql/089_rn1_negrisk_wcol_seven_acquisition_reconciliation.sql` ; sept lignes corrigées, coût **398,655799 pUSD**. Le cache `pi.rn1_chain_token_map` reflète WCOL. Le nouveau worker `pi-rn1-acquisition-batch` v4 infère le collatéral en confrontant les IDs CTF dérivés aux parts effectivement transférées à RN1. Il échoue fermé si le collatéral ne peut être déterminé de façon unique.
- La collecte initiale des 108 transactions est terminée, aucune file `pending` ; le job cron est conçu pour ne soumettre des requêtes que lorsqu'il reste des lignes éligibles.

## B. Rapprochement brut strictement borné
Seuls les **8 marchés septembre indépendamment sélectionnés** sont concernés. Tous ont `sell_proceeds=0`, inventaire terminal nul et règlements pUSD positifs appariés aux reçus Polygon. Les 12 transactions de règlement sont déjà vérifiées dans le registre antérieur.

| Cohorte (définie par règlement final) | Marchés | Débits BUY pUSD | Crédits MERGE/REDEEM pUSD | Cashflow brut | Brut / achats |
|---|---:|---:|---:|---:|---:|
| MERGE + REDEEM | 4 | 26 633,115840 | 33 244,208739 | +6 611,092899 | +24,8228 % |
| REDEEM seulement | 4 | 10 433,912570 | 4 137,503392 | −6 296,409178 | −60,3456 % |
| **Total** | **8** | **37 067,028410** | **37 381,712131** | **+314,683721** | **+0,849 %** |

Ce n'est **PAS un P&L net**, ni un rendement du capital total, ni un échantillon aléatoire représentatif. Aucune charge de frais, rebate, gas remboursé, transfert intermédiaire ou acquisition externe n'est attribuée dans ce résultat. La segmentation par mode de clôture est **ex post** et ne donne pas une règle anticipative. Les transactions septembre ne se trouvent **ni** dans les 80k fills Maker historiques **ni** dans les 1 361 ordres signés de novembre. Le rapprochement ne prouve donc pas que le gain de ce panel vient du Maker.

La vue authentifiée `rn1_chain_cashflow_panel_report` exclut le calcul du résultat si les contrôles des transactions, des dépenses et de l'inventaire échouent.

## C. Nouveau benchmark causalement borné de prix limite Maker
- Source originale : `pi.rn1_maker_signed_creation_price_analysis`. Groupe `sampled_cohort='random_tx'`, `quote_status='confirmed'` : 811 ordres avec historique de prix validé sur 860 ordres de transactions sélectionnées ; **781** retenus après vérifications strictes : prix signé et référence dans [0,01;0,99], prix horodaté avant création déclarée et âge <=90 secondes, création <= premier fill.
- **503 événements distincts**, cinq folds `mod(abs(hashtext(event_slug)),5)`. Un événement et ses ordres ne peuvent jamais être train/test dans le même pli. Les offsets de chaque pli sont appris sur les quatre autres.
- Cible : prix limite d'achat effectivement signé (pas l'entrée/non-entrée, ni la valeur intrinsèque).
- M0 : prix historique précédent, sans décalage.
- M1 : prix précédent + médiane d'écart signé calculée hors pli (environ −0,005).
- M2 : M1 conditionné au momentum historique 5 minutes (baisse >1 point, hausse >1 point, stable, manquant) ; valeur globale de repli.
- M3 : M1 conditionné par tranche du niveau de prix (cinq tranches) ; repli global.
- Les paramètres de tous les modèles sont appris **uniquement sur l'entraînement événementiel**, et jamais sur leur pli testé.
- `sql/088_rn1_maker_signed_limit_oof_event_holdout_v1.sql` a créé **781 prédictions out-of-fold** dans `pi.rn1_maker_signed_limit_oof_v1` ; RLS activée, aucun accès direct anon/authenticated. Vérification SQL : 0 fold mal affecté, 0 offset global manquant.

| Modèle | Erreur absolue moyenne, pondérée par ordre | Erreur moyenne par événement |
|---|---:|---:|
| M0 | 0,032570 | 0,034960 |
| M1 | **0,031836** | **0,034208** |
| M2 | 0,031702 | 0,034080 |
| M3 | 0,032020 | 0,034381 |

**Inférence robuste :** un modèle avec écart global constant bat légèrement l'absence de décalage : amélioration moyenne par événement +0,000751 unité de prix (≈ +0,0751 point de probabilité en erreur absolue économisée). Bootstrap déterministe de **400 tirages d'événements avec remplacement** : IC empirique 95 % du gain M1 vs M0 **[+0,000395; +0,001150]**.

**Ablation momentum :** M2 gagne en moyenne seulement +0,000129 unité sur M1 par événement, IC bootstrap 95 % **[−0,000199; +0,000455]**. **Le bénéfice marginal du momentum n'est pas établi**. M3 ne bat pas M1 (gain moyen ≈−0,000173 par événement).

Il s'agit d'une **validation croisée interne sur ordres signés exécutés sélectionnés**, pas d'un nouveau holdout externe ou d'une étude prospective. Le holdout indépendant des **376 ordres** d'une étude antérieure (qui confirme la médiane −0,005 mais pas l'effet momentum) reste distinct et n'a pas été réutilisé ici. L'API `prices-history` fut interrogée rétrospectivement : les timestamps pré-signature ne prouvent pas que la même quote était accessible en temps réel. Aucun carnet, spread, queue ou ordre non exécuté n'est observé.

## D. Code et interface
- `supabase/functions/pi-rn1-acquisition-batch/index.ts` : worker v4 déployé, vrai CTF collateral detection.
- `sql/088_rn1_maker_signed_limit_oof_event_holdout_v1.sql` : table de validation interne.
- `supabase/functions/pi-dashboard/rn1-decision-policy.ts` : deux méthodes analytiques authentifiées, requêtes SQL testées sur Supabase.
- `supabase/functions/pi-dashboard/index.ts` : routes `rn1_signed_limit_policy_oof` et `rn1_chain_cashflow_panel_report`.
- Fonction `pi-dashboard` **v55 ACTIVE** lors du déploiement.
- `web/index.html` : deux panneaux ajoutés à **RN1 · Moteur** (sans nouvel onglet), commités ; **publication effective sur GitHub Pages non encore vérifiée depuis une session utilisateur**.

## E. Feuille de route (à exécuter ensuite)
1. **Reconstruire directement les décisions à la création** sur un échantillon de nouveaux order hashes indépendants, et non leur simple exécution : timestamp déclaré, limite, shares, prix bid/ask disponible avant l'ordre, momentum et inventaire pré-trade si une source horodatée existe.
2. Tester une politique explicite H07 de grille Maker (tick 0,01 confirmé sur holdout) + offset signé de référence, contre M0, avec une vraie métrique de détection entrée/non-entrée et des événements tenus hors apprentissage. Ne pas ajuster des seuils sur le holdout déjà vu.
3. Construire un ledger total des fills **Maker** (Nov) incluant achats, ventes, MERGE, REDEEM, frais, rebates, transfers et l'inventaire terminal ; ne pas porter le ROI brut de septembre sur novembre.
4. Les deux archives `rn1_full_streams` sont `paused_quota` après **4 078 000 rows / 4 078 pages chacune** et `source_exhausted_at=null`. Évaluer budget et couverture, pas de réingestion ou suppression non nécessaire.
5. Tester hors échantillon et en paper trading prospectif après frais, spread, slippage, latence et disponibilité réelle des quotes. Ne pas activer de copie en capital réel sur ce seul échantillon.
