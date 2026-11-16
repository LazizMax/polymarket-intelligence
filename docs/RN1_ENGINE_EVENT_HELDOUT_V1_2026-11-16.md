# RN1 · Moteur — Implémentation v1 d'identification en boîte noire
**16 novembre 2026 · backend live v24 et nouvelle interface cloud, lecture seule**

## Ce qui est désormais en production

- Nouvelle action privée/authentifiée `rn1_engine_forensics` dans `supabase/functions/pi-dashboard/index.ts` ; source de calcul `supabase/functions/pi-dashboard/rn1-engine.ts` ; Edge Function `pi-dashboard` **v24 ACTIVE** au déploiement. L'autorisation existante du compte utilisateur n'a pas été modifiée.
- Nouvel onglet **RN1 · Moteur** dans `web/index.html` : benchmark de prévision, 5 folds par événement, log-loss / Brier / average precision, bootstrap par événement des gains de log-loss, test des deux issues du même marché, bandes de déséquilibre, contre-exemples, limitations et état de l'oracle.
- CI de recherche : `tests/test_rn1_engine_forensics.py` (contrats temporels, éligibilité et transparence) et `tests/rn1_engine_fixture_test.mjs` (exécution **réelle** de la fonction TypeScript sur données synthétiques), branchés dans `.github/workflows/rn1-research-ci.yml` avec Node 22. Tester en GitHub Actions est distinct de valider un modèle scientifique sur données RN1.
- Aucun ordre, abonnement, accès au code privé ni migration de données ne sont réalisés. Les archives historiques de 756k fills restent intactes.

## Contrat causal

L'unité statistique est **(marché, token YES ou NO, sonde pré-trade)**, et non un ordre Maker. À un timestamp `received_at`, calculer les features de la quote et des positions reçues **avant ce timestamp** ; label binaire = **au moins un fill Maker BUY inféré et rapproché** dans `(received_at, received_at+60s]`. **Aucun fill observé** n'est pas synonyme d'absence d'ordre placé, ni nécessairement d'absence d'exécution réelle (la source live est partielle). La sélection des marchés par activité RN1 récente induit un biais de recrutement.

Éligibilité : sonde `position_status=complete` et `position_observed_at<=received_at` ; quote CLOB valide, horodatée `book_at<=received_at` ; prix/spread non manquants ; **les deux issues** de la position retournées `returned_by_api=true`, toutes deux liées aux tokens réellement cotés ; événement `event_slug` non nul. Livres REST échantillonnés à la minute (jusqu'à ~55 secondes d'âge observé).

Features **antérieures au fill** :
1. Indicateur origine `rn1_recent` vs contrôle sportif (contrôle de sélection ; n'est PAS une variable de profit).
2. Midpoint, spread, taille du premier bid/ask, balance des tailles du carnet, variation du midpoint par rapport à la **précédente** quote du token au plus 180 s auparavant, âge de la quote.
3. Inventaire : coût d'entrée marché, ratio d'écart des shares propres et opposées, tailles des deux issues. N'inclut pas le portefeuille complet.
4. **Aucune probabilité externe** n'est injectée : les modèles M1 (oracle) et M2 (hybride) sont marqués **non identifiables**, pas « rejetés ».

Quatre modèles de complexité croissante utilisent les **mêmes fenêtres éligibles** : taux constant, contrôle de sélection, Polymarket microstructure, et microstructure + inventaire. Régression logistique L2=0.01, standardisation sur le train uniquement, 240 pas gradient fixe, 5-fold déterministe par **hash(event_slug)** ; aucune fenêtre d'un même événement dans le train et le test du même pli. Métriques agrégées sur les probabilités **out-of-fold**, plus gain de log-loss et intervalle bootstrap 300 tirages **clusterisés par événement**. Un gain non significatif ne valide pas de branche du code.

Le code d'inférence est dans `supabase/functions/pi-dashboard/rn1-engine.ts`, versionnée et vérifiable. Les scores live sont calculés côté serveur lorsque l'utilisateur ouvre l'onglet ; ne pas inventer de valeur de score avant lecture de la réponse authentifiée.

## Contrôle de couverture SQL au lancement (les nombres augmentent)
- **4 075** fenêtres token × sonde éligibles, **226** fenêtres ayant un fill Maker BUY rapproché dans la minute qui suit, **53** événements distincts, **159** marchés.
- Toutes les variables d'entrée suivent un snapshot de positions connu avant le début de la fenêtre ; `book_age_seconds` observé ≈ 0.04 à 54.95 secondes.
- Cohorte indépendante « miroir YES/NO » calculée avec des filtres proches mais pas strictement identiques à l'éligibilité du modèle : **2 136** observations marché × instant, dont **217** avec au moins un fill rapproché, **12** où les deux côtés reçoivent un fill, **205** avec un seul côté.
- Sur les **150** cas à un seul côté et déséquilibre relatif de parts >10 % : **80** achats sur l'issue sous-détenue vs **70** sur l'issue sur-détenue. 80/150 = 53,33 %. **Ne soutient pas** une politique simple « rebalancer systématiquement dès que déséquilibré ». Cela **n'invalide pas** une politique dépendant simultanément de la cote, de la queue, d'un modèle de prix ou de l'exposition.
- L'onglet calcule lui-même le même test miroir sur **sa propre cohorte éligible** (scores et comptes peuvent donc différer légèrement), avec intervalle bootstrap par événement.

## Découverte sur la source potentielle d'odds externes

`pi.rn1_nba_espn_scoreboards` contient 7 snapshots journaliers au contrôle, dont 1 payload JSON incluant des **odds DraftKings** (les champs `open`/`close`, spread/totals). Vérification ultérieure : le seul match avec odds DraftKings dans cette sauvegarde ESPN était **OKC–Sacramento**, début prévu le 16/11/2026 à 02:00 UTC, tandis qu'une capture de la même journée a été reçue à **01:46 UTC, avant le match**. La mention initiale « postérieur au match » était erronée. Ces données ne démontrent **pas** que RN1 utilisait ce fournisseur, et il manque la série de variations d'odds au moment de ses décisions. Elles ne sont pas une série live d'odds horodatée à chaque mise à jour. **Interdiction de les utiliser rétroactivement comme oracle causal**. Cela constitue un candidat de sourcing prospectif limité (pregame, règles de contrat à aligner) à évaluer avant de dépenser quoi que ce soit.

## Verdict scientifique à ce stade

**Nous avons maintenant un banc d'essai concret d'identification de système et un test miroir répliqué, pas encore une architecture gagnante.** M0 possède des prédictions vérifiables hors événements d'entraînement ; le score live doit être inspecté dans le dashboard authentifié. M1/M2 requièrent une **source externe d'odds pré-décision à horodatage de réception démontrable**, des contrats équivalents et des contrôles sans exécution. Ne pas inférer le code privé exact.

## Ordre de la suite

1. Analyser les **scores et exemples d'échec** des quatre modèles M0 avec bootstrap événement ; corriger uniquement les défauts de données et erreurs objectives.
2. Vérifier la **sensibilité** aux horizons de 30/60/120 s, à l'âge du carnet, à `rn1_recent` vs témoins, au temps prospectif et au biais des négatives.
3. Étudier une collecte **prospective** des odds externes et de changements de carnet au même intervalle ; ne jamais transformer le champ `close` ESPN en information horodatée à t sans contrôler le **moment de réception** de chaque snapshot et son alignement avec la décision. Ne pas lancer de dépenses ou de collecteur intense sans plafond.
4. Tester l'effet d'edge externe sur les **mêmes fenêtres**, avec M1/M2 vs M0 et gain out-of-event, puis seuils parcimonieux et pseudocode uniquement si les tests réussissent.
