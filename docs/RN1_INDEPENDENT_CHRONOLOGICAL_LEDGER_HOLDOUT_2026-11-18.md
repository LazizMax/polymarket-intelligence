# RN1 — Validation indépendante du registre comptable chronologique

**18 novembre 2026. Étude réellement exécutée, non simulée.**

## Objectif et protocole gelé

Après la première reconstruction de **3 marchés pilotes**, nous avons cherché à valider la méthode sur des marchés **n'ayant pas été sélectionnés pour leurs profits**. La sélection a été figée dans `pi.rn1_ledger_holdout_selection` **avant** d'examiner les nouvelles données brutes :

- Périmètre : wallet RN1, marchés entre le 15 et le 28 septembre 2026, 2–30 fills, ventes classiques absentes, aucun outcome inconnu, fenêtre d'exécution + événements économiques inférieure à 20 h.
- Exclure les 3 marchés pilotes déjà analysés.
- Partitionner selon la nature des événements déjà répertoriés : `merge_only`, `merge_redeem`, `redeem_only`, `trade_only`.
- Dans chacun des 4 groupes, classer les identifiants de marché par MD5 avec une graine fixe `rn1-independent-ledger-20261118-v1` et retenir les 4 premiers, **avant** d'ouvrir leur archive.
- Sélection **reproductible et non fondée sur les profits**, mais **stratifiée selon des événements observés a posteriori**. Les quatre groupes ont la même taille par construction : **ces 16 marchés ne constituent pas un échantillon représentatif de tous les marchés RN1**.

Au contrôle SQL initial, les groupes éligibles comptaient : `merge_only` 142, `merge_redeem` 215, `redeem_only` 5 309, `trade_only` 1 320. Le résultat ne doit pas être extrapolé en appliquant un poids égal aux catégories.

## Lecture et contrôle des sources

Fonction privée Supabase `pi-rn1-ledger-pilot` v3, action `scan_holdout_market`, autorisée seulement pour les **16 marchés présélectionnés**. Les pages gzip existantes des streams `trades_all` et `activity_all` sont lues depuis Storage, décompressées et contrôlées individuellement contre l'empreinte **SHA-256** enregistrée dans `pi.rn1_full_archive_pages`. Aucune copie de millions de trades n'est ajoutée à PostgreSQL.

Le premier envoi de 16 demandes parallèles a entraîné quatre réponses **HTTP 546 WORKER_RESOURCE_LIMIT**, et douze réussites. **Seules ces quatre demandes** ont été relancées séparément. Au terme du traitement : **16/16 succès HTTP 200**, **254 relectures de pages gzip** (certaines pages peuvent se recouper entre marchés), **191 événements pertinents** :
- **167 trades**,
- **8 événements MERGE**,
- **16 lignes d'événements REDEEM**.

L'archive des trades et les agrégats de quantités/coûts existants correspondent sur **16/16 marchés** ; les montants MERGE/REDEEM et nombres d'événements correspondent également sur **16/16**. Le rejeu chronologique ne donne **aucun inventaire négatif**, pour les 16 marchés.

Ces validations prouvent une cohérence entre **deux représentations des archives Data API déjà collectées**. Ce n'est **pas** une vérification indépendante des transferts réels de tous les tokens sur Polygon.

## Résultats : preuve comptable, pas P&L net

| Groupe stratifié | Marchés validés | Inventaire nul ou poussières | Inventaire non résolu | Solde brut agrégé des marchés quasi soldés |
| --- | ---: | ---: | ---: | ---: |
| MERGE seul | 4/4 | 0 | 4 | Non applicable |
| MERGE + REDEEM | 4/4 | **4** | 0 | **+6 611,09** |
| REDEEM seul | 4/4 | **4** | 0 | **−6 296,41** |
| Trades seuls | 4/4 | 0 | 4 | Non applicable |
| **Ensemble** | **16/16** | **8** | **8** | **+314,68** |

Les huit marchés réconciliés sans inventaire matériel présentent **5 soldes bruts positifs** et **3 négatifs**. Les achats de ces huit marchés ont représenté environ **37 067,03 unités de collatéral** ; le rapport brut du solde final aux dépenses est environ **+0,85 %**. **Ce rapport n'est pas un ROI RN1 ni un résultat after-fees**, pour plusieurs raisons :
- sélection stratifiée, calendrier limité et faibles effectifs ;
- aucune vérification exhaustive des frais de transaction, gas, rebates, transferts entrants/sortants ou SPLIT ;
- une position reconstruite à zéro à partir des exécutions et événements Data API ne prouve pas que le wallet n'avait aucun solde initial/externe ;
- les quatre marchés MERGE + REDEEM positifs et les quatre REDEEM seuls ne reflètent pas les proportions naturelles de ces stratégies dans l'activité RN1.

**Ne jamais classer les huit marchés non soldés comme pertes réalisées.** Par exemple, un marché avec des sorties de trésorerie négatives mais des milliers de parts restantes possède un inventaire dont la valeur terminale n'a pas été réconciliée.

### Exemples concrets hors échantillon

- `Spread: Patriots (-13.5)` : MERGE + REDEEM, **+2 393,06** de solde brut, inventaire final nul.
- `Spread: Browns (-1.5)` : MERGE + REDEEM, **+2 951,73**, inventaire final nul.
- `Japan vs. Uruguay: Both Teams to Score` : REDEEM seul, **−2 313,89**, inventaire final nul.
- `Spread: Indiana (-11.5)` : REDEEM seul, **−4 697,53**, inventaire final nul.
- `Spread: Bengals (-1.5)` : MERGE seul, **−4 177,41** de variation de trésorerie mais **9 848 parts encore en inventaire** ; ne pas interpréter comme une perte finale.
- `Ole Miss vs. Florida: O/U 80.5` : trades seuls, **−8 933,78** de variation de trésorerie, mais **22 759,25 parts restantes**.

## Pipeline et interface implémentés

- `supabase/functions/pi-rn1-ledger-pilot/index.ts` : lecture SHA-256, replay des 16 marchés autorisés, borne de 72 h et 70 pages.
- `pi.rn1_ledger_holdout_selection` : **16 clés présélectionnées** avec cohorte/rang/graine.
- `pi.rn1_ledger_holdout_audit` : **16 lignes**, résumés, inventaires et **191 événements chronologiques** en JSON, chiffrages et contrôles de provenance. Schéma privé ; **RLS activée**, privilèges `anon` / `authenticated` révoqués.
- `sql/080_rn1_independent_ledger_holdout.sql` : schémas + **snapshots versionnés** permettant de reconstruire la petite table dans un nouvel environnement.
- `supabase/functions/pi-dashboard/rn1-ledger-pilot.ts` : endpoints **authentifiés** `rn1_ledger_holdout_report` et `rn1_ledger_holdout_detail`.
- `web/index.html` : **RN1 · Moteur → Grand livre · validation indépendante sur 16 marchés**, table par groupe et expansion de chaque événement.
- Fonction Supabase `pi-dashboard` **v50 ACTIVE**. La consultation depuis une session navigateur effectivement connectée reste non vérifiée.

## Limites scientifiques et prochaine étape

L'analyse **valide l'algorithme de rapprochement de flux historiques**. Elle ne permet pas encore de publier un **P&L net blockchain**. La priorité suivante est d'étudier, **sur un sous-ensemble d'inventaires nuls**, les réceptions/transferts de tokens, les SPLIT éventuels, les mouvements de collatéral et les frais/gas, avec les émetteurs de token, les logs de transaction et les contrats effectivement utilisés.

Il faudra ensuite élargir par fenêtres successives avec **échantillonnage probabiliste ou pondération correcte des strates**, vérifier les périodes historiques, et seulement alors tenter une estimation du ROI RN1 avec incertitude. **Aucune formule de copy-trading rentable n'est encore validée.**

### Capacité

La base PostgreSQL est d'environ **1,108 Go** et peut continuer à grossir du fait des collectes préexistantes. Les archives privées totalisent déjà environ **4,078 millions de lignes par stream** et ne sont pas dupliquées par cette validation. Il convient d'éviter de nouvelles tables massives tant qu'un plan de rétention/stockage n'est pas audité.
