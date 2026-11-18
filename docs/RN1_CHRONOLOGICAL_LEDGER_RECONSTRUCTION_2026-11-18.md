# RN1 — Premier grand livre chronologique YES/NO, MERGE et REDEEM

**18 novembre 2026 — pilote exécuté et validé sur 3 marchés.**
Wallet RN1 : `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`.

## Objectif

Passer du coût moyen sur toute la vie du marché (proxy qui mélange les temporalités) à la reconstitution **séquentielle** de chaque mouvement de parts et de collatéral à partir des archives historiques déjà collectées, **sans importer à nouveau 4 millions de trades**.

## Sources et méthode contrôlées

- Archives privées immuables `pi-rn1-research-private`, streams `trades_all` et `activity_all` ; pages indexées dans `pi.rn1_full_archive_pages`.
- Trois marchés choisis volontairement, dont un quasi totalement fusionné, un fusionné + réglé, et un où des parts restent non réglées.
- Fonction Supabase privée `pi-rn1-ledger-pilot` :
  1. Authentification par scheduler token, whitelist de trois marchés, fenêtres de temps bornées à 72 heures et au plus 70 pages.
  2. Télécharger chaque gzip directement depuis Storage, le décompresser, calculer **SHA-256** du JSON décompressé et vérifier la correspondance exacte à l'index.
  3. Extraire les événements du marché sélectionné, et seulement pour le wallet RN1.
  4. Utiliser le stream trades pour les BUY/SELL et le stream activity **uniquement pour les événements hors TRADE**, de façon à ne pas compter deux fois les mêmes trades.
  5. Contrôler que nombres de trades, parts achetées et coûts correspondent aux agrégats `rn1_full_market_metrics`, puis que les événements et encaissements MERGE/REDEEM correspondent à `rn1_full_activity_metrics`.
  6. Rejouer les actions dans l'ordre des secondes source avec inventaires des issues 0 et 1 et un solde de trésorerie brut.
- **75 relectures de pages gzip** vérifiées SHA-256 (23 + 25 + 27), couvrant 33 événements utiles (3 + 11 + 19). Ce sont des *relectures* des archives existantes, pas 75 nouvelles pages d'ingestion.
- Les positions intermédiaires sont vérifiées **non négatives**, sous une tolérance de 0,02 part. Les événements d'une même seconde ne garantissent pas leur ordre exact sur la blockchain.

## Convention du grand livre

Pour un événement `TRADE BUY` sur l'issue `i` : `position[i] += parts` ; `cash -= parts × prix`.

Pour `TRADE SELL` : `position[i] -= parts` ; `cash += parts × prix`.

Pour `MERGE` : `position[0] -= parts` et `position[1] -= parts` ; `cash += usdc_size`. Dans les pilotes, le type MERGE a un `outcome_index = 999` (deux issues) ; les montants de collatéral rapportés ont coïncidé avec les parts fusionnées.

Pour `REDEEM` : `position[outcome_index] -= parts` ; `cash += usdc_size`. Le **règlement d'une issue perdante a un `usdc_size = 0`** même si des parts sont détruites ; l'autre issue peut restituer du collatéral. Ne pas traiter les parts d'une issue perdante comme un encaissement !

Le solde brut des flux historiques est `encaissements MERGE + REDEEM + SELL − dépenses BUY`.

**Ce n'est pas un profit net après frais.** On n'a pas encore reconstitué les transferts, éventuels SPLIT, positions initiales non observées, frais de transaction, gas, rebates attribués par marché, opérations sur collatéral et autres sources de mouvement on-chain.

## Résultats audités

| Marché | Trades | MERGE | REDEEM | Dépenses BUY | Encaissements MERGE + REDEEM | Solde brut de flux | Résidu issue 0 / issue 1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Exact Score : SD Eibar 3–3 UD Las Palmas ? | 2 | 1 | 0 | 161,833327 | 166,660000 | **+4,826673** | 0 / **0,006667** |
| Browns vs. Buccaneers : O/U 43.5 | 10 | 1 | 0 | 5 699,888000 | 2 820,380000 | **−2 879,508000** | **6 264,62** / 0 |
| Spread : Chiefs (−6.5) | 16 | 1 | 2 | 8 215,701000 | 9 262,825000 | **+1 047,124000** | **0 / 0** |

Unités monétaires : collatéral dollar-equivalent rapporté dans l'archive, **pas USDC certifié**.

**Chiefs (−6,5)** :
- Achats : 9 262,825 parts issue 0 et 15 047,300 parts issue 1 ;
- MERGE : retire 5 654,300 parts à chaque issue, encaisse 5 654,300 unités ;
- REDEEM perdant, issue 1 : retire 9 393,000 parts, encaisse **0** ;
- REDEEM gagnant, issue 0 : retire 3 608,525 parts, encaisse **3 608,525** ;
- Inventaires finaux **0 / 0**, sans négativité intermédiaire ;
- Résultat brut de trésorerie enregistré **+1 047,124**, soit **12,745 % des dépenses BUY**. **Cette proportion n'est pas un ROI net de stratégie Maker.**

**Eibar 3–3** :
- Achète 166,666667 parts issue 1 à 0,97 et 166,660 parts issue 0 à 0,001 ;
- MERGE de 166,660 paires, encaisse 166,660 unités ;
- Résidu **0,006667** part sur l'issue 1, classé *dust* plutôt que résultat définitif ;
- Flux brut **+4,826673**, soit **2,982 % des achats**.

**Browns–Buccaneers** :
- Achète 9 085 parts sur l'issue 0 et 2 820,38 sur l'issue 1 ;
- MERGE de 2 820,38 paires, encaisse le même montant ;
- Résidu **6 264,62 parts issue 0**, sans opération REDEEM correspondante dans la fenêtre source ;
- Flux de trésorerie à ce stade **−2 879,508**, **pas une perte réalisée** : la valorisation/vente/réclamation de l'inventaire restant est inconnue.

Les deux pilotes à inventaire nul ou poussières totalisent **+1 051,950673** de solde brut historique pour **8 377,534327** de dépense BUY, ratio brut **12,557 %**. L'addition ne constitue en aucun cas une estimation du ROI RN1 : échantillon sélectionné et minuscule, frais et transferts non réconciliés.

## Contrôles effectivement passés

Les 3 marchés ont :
- tous leurs trades retrouvés dans les pages immuables (2/2, 10/10, 16/16) ;
- leurs achats par issue (quantités et coûts) **réconciliés au dix-millième** avec `pi.rn1_full_market_metrics` ;
- leurs nombres et encaissements MERGE/REDEEM réconciliés à **0,02 unité** avec `pi.rn1_full_activity_metrics` ;
- **aucun inventaire exécuté négatif** au fil de la chronologie ;
- événements sources conservés dans une table privée de **3 petites lignes** et 33 éléments de timeline JSON, `pi.rn1_ledger_pilot_audit`, avec RLS et accès direct `anon`/`authenticated` interdits.

## Code et interface livrés

- `supabase/functions/pi-rn1-ledger-pilot/index.ts` — lecteur d'archives SHA-256 avec source `scan_pilot_market` réservé au scheduler.
- `sql/079_rn1_chronological_cash_ledger_pilot.sql` — schéma privé et **snapshots exacts des 3 replays**.
- `supabase/functions/pi-dashboard/rn1-ledger-pilot.ts` — rapports authentifiés `rn1_ledger_pilot_report` et `rn1_ledger_pilot_detail`.
- `web/index.html` — **RN1 · Moteur → Grand livre chronologique · pilotes vérifiés** : résumés, statuts, soldes YES/NO, ouverture des événements dans un tableau chronologique.
- Supabase `pi-dashboard` v49 **ACTIVE** ; la version affichée par un navigateur utilisateur connecté n'a pas été vérifiée par session réelle.

## Feuille de route suivante

1. Étendre ce protocole à un **panel aléatoire de marchés terminés**, et pas seulement des exemples particulièrement faciles, avec contrôle des transferts et des soldes blockchain.
2. Identifier les **frais/rabais** précis des transactions d'achat et les coûts du collatéral pour passer d'un solde brut à un net mesurable.
3. Reconstituer les flux **SPLIT**, transfert et ouverture des balances, si disponibles, et les rattacher à chaque token.
4. Tester les hypothèses de timing/sizing de RN1 sur des marges **économiques réalisables** par une stratégie simulée, en tenant compte de la liquidité.
5. **Stockage** : la base approchait 1,106 Go à la dernière vérification. Éviter d'y normaliser des millions de nouvelles lignes ; réutiliser les blobs gzip privés et ne conserver que des registres compacts vérifiés.

**Conclusion** : pour la première fois dans cette étude, les flux d'achats YES/NO, fusions, règlements et inventaires peuvent être rejoués et réconciliés au niveau d'un marché individuel. Les deux pilotes à stock nul ou poussières montrent un **solde de trésorerie brut positif**, **pas** une preuve de rentabilité Maker globale ou after-fees.
