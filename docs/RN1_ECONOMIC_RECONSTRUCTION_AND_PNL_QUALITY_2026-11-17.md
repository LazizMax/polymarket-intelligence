# RN1 — Audit économique, couverture YES/NO et qualité du P&L

**Audit réellement exécuté le 17 novembre 2026**. Wallet RN1 : `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`. Ce rapport distingue : (a) flux et événements observés, (b) simulation comptable rétrospective, (c) P&L **estimé** sur un échantillon, (d) P&L **rapporté mais incomplet** par un fournisseur.

## 1. Périmètre et précautions de méthode

Les sources économiques étaient **déjà présentes** : `pi.rn1_full_market_metrics`, `pi.rn1_full_activity_metrics`, `pi.closed_position_roi`, `pi.wallet_pnl_daily`. **Aucune archive de fills n'a été réimportée, aucune ancienne donnée supprimée.** Le projet couvre plusieurs fenêtres différentes :

- Agrégats de marché : à l'audit, environ **143 900+ marchés**, 3,6 millions de fills agrégés, premier trade 21 mars 2026, dernier trade 15 novembre 2026. Pratiquement tous les fills de cet agrégat sont des **BUY** (14 SELL recensés sur ~3,616 millions), mais la liquidation passe aussi par MERGE et REDEEM.
- `closed_position_roi` : **11 600 positions-token**, **11 579** avec coût considéré valide par le modèle, génération 1, entrées datées du **4 au 15 novembre 2026** uniquement ; ce n'est pas l'historique exhaustif.
- `wallet_pnl_daily` : **496 dates**, du 10 juillet 2025 au 17 novembre 2026, toutes marquées `completeness='partial'`. Chaque ligne est un **snapshot cumulatif**, non un P&L journalier à additionner.
- Les chiffres agrégés évoluent tant que le pipeline d'origine s'alimente. Les nombres ci-dessous sont des snapshots de l'audit, pas une promesse de fraîcheur à la minute.

**Attention à la devise :** Polymarket a migré vers un collatéral V2 appelé pUSD en avril 2026 (les vues historiques peuvent conserver le nom `*_usdc`). Les montants sont affichés comme **équivalents en collatéral dollar rapportés**, sans inventer une conversion de caisse vérifiée. Source : https://help.polymarket.com/en/articles/14762452-polymarket-exchange-upgrade-april-28-2026.

## 2. Couverture des deux issues et fusions réellement constatées

Un jeu complémentaire d'une part YES et d'une part NO peut être fusionné pour restituer **une unité de collatéral** selon le fonctionnement CTF/Polymarket : https://github.com/Polymarket/agent-skills/blob/main/ctf-operations.md.

Dans les agrégats RN1 :

- Environ **84 000 marchés** ont des **achats sur les deux issues**.
- Sur ces marchés, coût moyen combiné historique YES+NO **médian = 0,9800 unité de collatéral** ; ~**50 000** marchés affichent un coût combiné inférieur à 1, ~34 000 supérieur ou égal à 1.
- Une vérification par **clé de marché** relie **16 579 marchés avec événements MERGE** à **16 579 marchés avec achats observés des deux issues**. **0** marché avec MERGE ne retrouve qu'un seul côté acheté dans les agrégats accessibles lors de l'audit.
- Flux d'activité RN1 : **26 494 événements MERGE**, montant reporté **113 410 421,83** ; **171 633 événements REDEEM**, montant reporté **436 815 850,89**. Les chiffres de `reported_usdc_size` sont **des montants d'activité source**, non un registre complet de transferts nets vérifiés.
- Marchés où les deux issues sont achetées et où un MERGE existe : prix combiné historique médian ~0,9793, contre ~0,9800 pour les marchés sans MERGE ; **60,74 %** sous 1 contre **59,22 %**. Cela n'est pas une preuve de sélection optimale des seuls marchés profitables.

**Interprétation solide :** RN1 effectue effectivement des opérations de fusion de positions complémentaires sur des marchés où ses deux issues ont été achetées. La quantité et le coût des **lots réellement fusionnés à chaque transaction** restent à reconstituer.

## 3. Pourquoi le proxy de marge n'est PAS du profit

À titre **purement rétrospectif**, on peut calculer pour chaque marché :

`parts hypothétiquement appariables = min(total parts achetées YES, total parts achetées NO)`

`coût moyen de paire = coût YES / parts YES + coût NO / parts NO`

`marge brute THÉORIQUE = parts hypothétiquement appariables × (1 − coût moyen de paire)`

Sur les agrégats de l'audit : environ **396 millions de paires possibles** et une **marge brute hypothétique de l'ordre de 9,8 millions d'unités de collatéral** (sommes positives et négatives incluses).

**NE JAMAIS afficher ce montant comme P&L RN1**. Ce calcul mélange des achats pouvant être espacés de plusieurs heures, jours ou phases de match ; il ignore le stock réellement simultané, l'ordre de consommation des lots, les fusions réelles, les redemptions, les transferts, les positions résiduelles, les frais et les rebates. Les achats sur une seule issue ne sont pas rémunérés dans cette formule. C'est un indicateur de *potentiel comptable de couverture*, pas une marge de market maker réalisable.

## 4. Positions clôturées : résultat estimé et relation avec les coûts YES/NO

Dans `pi.closed_position_roi`, wallet RN1, génération 1 :
- **11 600 positions-token**, **11 579** valides, coût total **13 882 543,39**, P&L modèle réalisé **+662 655,91**, **ROI pondéré estimé 4,7733 %**. Ce chiffre ne couvre **pas** les 3,6 millions de trades et n'est **pas** certifié after-fees.
- **7 024 marchés distincts** dans les 11 600 positions ; **6 967 marchés** sont reliés directement à `rn1_full_market_metrics` via `condition_id = market_key`. Pour ces 6 967, aucun achat dans l'agrégat n'est enregistré **après** la dernière clôture connue. **Aucun** ne contient un événement MERGE dans les agrégats d'activité : **ce sous-échantillon mesure un résultat de clôture/règlement, pas un profit attribuable aux MERGE**.
- Parmi les marchés reliés avec achats des deux issues et coût moyen calculable :

| Coût moyen YES + NO (calculé **jusqu'à la clôture**) | Marchés | ROI pondéré estimé |
| --- | ---: | ---: |
| Moins de 0,90 | 1 207 | **+31,75 %** |
| 0,90–0,95 | 445 | **+8,33 %** |
| 0,95–1,00 | 823 | **+0,88 %** |
| 1,00–1,05 | 713 | **−4,48 %** |
| ≥1,05 | 1 339 | **−18,91 %** |

Ces valeurs sont intéressantes mais **ne constituent pas un test prédictif**. Le regroupement utilise le prix moyen calculé **à l'issue de tous les achats du marché** et les positions **déjà clôturées** : l'information sur le coût complet n'était pas disponible lors du premier ordre. Le lien entre coût inférieur à 1 et marge d'un jeu de parts complémentaires est en partie **comptable/mécanique**. Le modèle coûts/ROI est incomplet et la sélection des positions est restreinte. Les ROI sont des **estimations du sous-échantillon**, et non une validation hors échantillon d'une stratégie live.

## 5. Snapshots de P&L du fournisseur

La table `pi.wallet_pnl_daily` pour RN1 contient **496 snapshots** quotidiens avec le même source tag `polymarket_v2_user_pnl`, **tous incomplets**.

Au snapshot du 17 novembre 2026, le fournisseur rapportait :
- P&L réalisé cumulatif **13 426 782,43** ;
- P&L économique cumulatif **15 690 259,84**.

**Ces valeurs ne sont pas un ledger blockchain indépendant.** On **ne doit pas sommer** les 496 lignes, ni les rapprocher arithmétiquement du P&L des 11 600 positions closes (périodes et méthodes incompatibles). Le panneau affiche la variation entre deux snapshots consécutifs comme `reported_economic_delta`, pas comme « profit du jour » audité.

## 6. Livraison technique et sécurité

- Code : `supabase/functions/pi-dashboard/rn1-economics.ts`, fonction `rn1EconomicReconstruction(db)`, **lecture seule**, wallet RN1 fixé côté backend.
- Route authentifiée : `rn1_economic_reconstruction` dans `pi-dashboard/index.ts`.
- Frontend : `web/index.html` → **RN1 · Moteur** → **Exposition économique YES/NO et qualité du P&L**, distinguant strictement faits, hypothèses et estimations. Contrôle explicite de MERGE même marché, tableau de ROI rétrospectifs et avertissements d'utilisation.
- Aucune table supplémentaire de trades ; le calcul lit les agrégats existants. **La base frôle 1 Go** et augmente avec les collectes déjà en place : avant de normaliser de nouveaux millions de fills, auditer l'occupation, les index et la rétention. Ne pas détruire ou remplacer d'historique non reproductible.
- Le backend a été déployé sur Supabase **v48 ACTIVE** lors de cette phase. L'affichage dans une session utilisateur connectée n'a pas été testé en navigateur ; le contrôle sans session doit continuer de renvoyer une erreur d'autorisation.

## 7. Prochain test indispensable pour une vraie EV après frais

1. **Reconstitution temporelle par marché** sur un panel court de transactions sélectionnées : achats YES/NO avec leur prix, quantité et rôle ; événements MERGE/REDEEM avec montants et heures ; éventuels transferts, SPLIT et fees/rebates.
2. **Accounting invariant** : ouvertures + transferts + achats − ventes − merges − redemptions = inventaire terminal, pour chaque token/market et unité de collatéral. Si le résiduel ne se réconcilie pas, P&L non publié.
3. Comparer scénarios **Maker seul** et **Maker + Taker** et intégrer le coût de queue, le risque d'inventaire unilatéral, les frais et la liquidité réellement disponible en temps réel.
4. Ne conclure à une stratégie RN1 réplicable qu'après validation hors échantillon **du profit**, pas uniquement des paramètres d'ordre.

**Conclusion :** existence de MERGE sur des marchés avec deux côtés achetés = fait ; coût combiné moyen <1 fréquent = fait d'agrégation ; marge théorique de paire = simulation rétrospective ; ROI 4,77 % du petit échantillon = estimation ; P&L fournisseur = cumulatif partiel ; **profit net réellement attribuable aux grilles Maker RN1 = non encore démontré**.
