# Arbitrage Lab — scanner pilote de paires YES/NO (lecture seule)

## Mission
Premier prototype de la future recherche de stratégies autonomes : identifier des écarts théoriques de prix *à l'instant de la lecture*, sans faire passer ces écarts pour un PnL réalisé, et sans automatisation d'ordres.

Ce module est **distinct** de l'audit RN1. RN1 (`0x2005d16a84ceefa912d4e380cd32e7ff827875ea`) n'a pas encore de ledger de trades complet dans `pi.trades`. Ses positions et son PnL agrégé ne suffisent pas à reconstituer les frais ou les couvertures par événement.

## Architecture
- UI existante GitHub Pages, onglet **Arbitrage Lab**, compte Supabase Auth habituel.
- Action `arbitrage` de la fonction authentifiée `pi-dashboard`.
- API Gamma `/markets`, limité à 5–50 marchés actifs, ordre décroissant par volume 24h.
- API CLOB `POST /books`, une requête groupée, deux token IDs par marché binaire YES/NO.
- Calcul pur dans `supabase/functions/pi-dashboard/arb-math.ts` et fixtures de tests adjacentes.
- Aucune table, secret supplémentaire, inscription de portefeuille ou clé de trading.
- Aucune exécution d'ordre, marge maker ni frais réels facturés.

## Calculs
Pour une quantité `Q` égale des deux issues, sommer les niveaux asks jusqu'à `Q` actions sur chaque carnet. Exclure si l'un des carnets ne couvre pas `Q` ou si le minimum d'ordre du carnet n'est pas satisfait.

- `C_yes = sum(price_i * shares_i)`
- `C_no = sum(price_j * shares_j)`
- `C_pair = C_yes + C_no`
- `gross = Q - C_pair` (règlement complémentaire supposé, **après exécution des deux côtés**)
- `provision = C_pair * réserve% / 100`
- `net indicatif = gross - provision`
- `ROI indicatif = net indicatif / (C_pair + provision)`

La provision est une **hypothèse**, pas le vrai barème dynamique de Polymarket. Elle ne capture pas les délais, le slippage additionnel, les ordres partiels, la priorité temporelle, les rebate et les règles spécifiques de chaque marché.

## Limites incontournables
1. Deux books sont récupérés successivement dans une réponse groupée ; ce n'est pas une exécution atomique de deux jambes.
2. La profondeur affichée peut disparaître au moment de l'ordre.
3. Le scan porte sur les **marchés renvoyés par Gamma dans cet échantillon**, pas sur l'ensemble des marchés.
4. Les marchés multi-issues ou les contrats dont les règles de règlement ne sont pas binaires et complémentaires ne sont pas couverts.
5. Un signal positif n'est ni « bénéfice garanti », ni « EV validée ».
6. Aucun abonnement permanent aux books ni paper trading prospectif à ce stade.

## Validation
- Test unitaire : tri des asks, coût moyen pondéré, volume insuffisant, provision hypothétique.
- Vérifier compilation TypeScript, syntaxe JavaScript navigateur et autorisation serveur en CI.
- Relever les réponses réelles Gamma/CLOB côté fonction avant toute extension.
- Étape suivante : journaliser **toutes** les opportunités et non-opportunités, enregistrer snapshots horodatés, puis comparer après délai simulé, frais réels et remplissages partiels.

## Déploiement
Le dépôt GitHub déploie automatiquement **le HTML uniquement**. Les Edge Functions Supabase sont déployées séparément. Ne fusionner la branche ou publier une fonction que lorsque leur version est cohérente, sinon l'UI montrera `Action inconnue`.
