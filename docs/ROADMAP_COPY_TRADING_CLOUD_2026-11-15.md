# Polymarket Intelligence — feuille de route métier reprise sur le cloud

**Établie le 15 novembre 2026 à partir du cahier des charges initial** et de [l'audit stratégique du 14 novembre](AUDIT_STRATEGIQUE_2026-11-14.md).

## 1. Mission

**Décider si un ensemble de traders Polymarket permet d'exécuter une stratégie de copie à EV nette positive** à des prix réellement accessibles, avec taille de portefeuille, risque et règles d'entrée/sortie explicites.

L'objectif n'est **pas** d'identifier les portefeuilles affichant le PnL, le ROI brut ou le R² les plus impressionnants. Les performances historiques sont des **hypothèses de recherche**, à falsifier par une évaluation prospective.

Règle incontournable : aucun ordre réel et aucune recommandation de copier un portefeuille sans validation séparée *à prix copieur*.

## 2. Point de départ vérifié (15 novembre 2026)

| Composant | État observé |
| --- | --- |
| Hébergement et UI | GitHub Pages, 3 écrans (Classements, Analyse wallet, Collecte & qualité), API Supabase privée et Auth |
| Wallets suivis | 100 ; sélection initiale biaisée par classements gagnants |
| Observations PnL quotidiennes | 46 688 |
| Positions clôturées enregistrées | 5 884 (en croissance) |
| Historiques ROI clôturés entièrement parcourus | 2/100 ; 98 en backfill |
| Trades individuels dans `pi.trades` | **0** |
| Événements économiques dans `pi.wallet_activity` | **0** |
| Positions instantanées `pi.position_snapshots` | **0** |
| Courbe de capital dans `pi.wallet_equity_daily` | **0** |
| Base PostgreSQL Fit Tracker + Polymarket | ~34 MB |
| Jobs en place | PnL 5 wallets/15 min ; ROI 2 pages/2 min |

**Ce qui est fiable :** stockage, accès privé, pagination fermée pour les wallets terminés, courbes de PnL source, métriques descriptives de régularité, calcul exploratoire sur coûts estimés.

**Ce qui n'est pas démontré :** exactitude comptable des coûts, ROI du portefeuille, causalité du PnL, intelligence de chaque trade, latence/prix du copieur, stratégie rémunératrice.

## 3. Essai source effectué le 15 novembre — implications

Le Data API v2 répond HTTP 200 aux feeds `/v2/trades?user=...&start=1` et `/v2/activity?user=...&start=1`, enveloppe `data` et pagination par curseur opaque. Sur une **page de 100 entrées** d'un wallet suivi :

- Trades : 100 lignes, toutes avec `transaction_hash`, mais aucune garantie d'identifiant de fill unique à partir du seul hash.
- Activités : 85 `TRADE`, 5 `REDEEM`, 3 `YIELD`, 2 `REWARD`, 2 `MAKER_REBATE`, 3 `TAKER_REBATE`.
- **Deux hash de transaction sont répétés** parmi ces activités : dédupliquer en prenant `transaction_hash` comme clé primaire **effacerait des opérations réelles**.
- `start=1` est nécessaire pour demander l'historique complet de ces feeds. Ne pas utiliser `offset` ; conserver exactement les filtres lors des reprises de curseur.

Ces observations sont un **audit exploratoire d'une page**, et non une preuve que tous les flux économiques du wallet sont disponibles. Il faut capturer les lignes brutes avec identifiant de source, position dans page et checksum, puis résoudre identité et déduplication avec prudence et, si nécessaire, événements on-chain.

Documentation primaire : https://data-api.polymarket.com/v2/docs

## 4. P0 — Ledger économique auditable (prochain chantier actif)

### P0-A : ingestion de vérité primaire

**Développer :**
- Import initial puis incrémental de `trades` et `activity`, pages séparées, en conservant la provenance, `cursor`, horodatage de récupération et réponse brute archivée.
- Types de flux : achats/ventes, redemptions, split/merge de positions, transferts/dépôts/retraits, yields, rebates et rewards lorsqu'ils sont observables. Ne jamais traiter une absence de donnée comme un zéro.
- Identifiants de transaction/fill non ambigus ou statut `identity_uncertain` et rapprochement on-chain. Un hash peut porter plusieurs lignes.
- Gestion de reprises, idempotence, limites de débit, retries 429/503 et contrôles d'overlap. Mesurer stockage et latence sur 5 wallets aux profils différents avant d'élargir aux 100.

**Sortie vérifiable :** sur 5 wallets tests (incluant des contrôles non gagnants), pagination couverte ou explicitement incomplète, checksum/provenance, trades gagnants et perdants conservés, collisions/duplicats signalés. Aucune balance nette « vérifiée » si les flux ne sont pas complets.

### P0-B : rapprochement et indicateurs financiers

- Reconstituer inventaire par token/event et flux de trésorerie, coûts WAC/FIFO selon politique documentée, sorties, frais, gains latents et récompenses.
- Traiter positions ouvertes, combo, transferts et événements non expliqués explicitement.
- Comparer **PnL reconstruit** aux points `user-pnl` officiels par wallet et période ; publier résidu, taille, couverture et motifs d'écart.
- Trois familles de rendements clairement distinctes :
  1. ROI des positions closes sur mises historiques vérifiées.
  2. ROI sur cumul des mises/turnover, si flux complets.
  3. Rendement ajusté des flux du capital et drawdown equity % ; **non disponible** avant valorisation/réconciliation des positions et dépôts/retraits.

**Sortie vérifiable :** rapport détaillé d'audit, aucune position incertaine convertie en résultat neutre, mesures de couverture et résidus comparés à une tolérance documentée après mesure empirique.

## 5. P1 — Établir une shortlist de 10–20 wallets crédibles

- Reconstituer l'information disponible **à la date T**, cohorte gelée prospectivement, hors-échantillon post-T non utilisé pour sélectionner.
- Inclure des wallets témoins et contrôles non gagnants, **pas seulement les classements de winners**.
- Classer par spécialité : crypto, sport, politique, économie, etc. Vérifier la provenance des catégories plutôt que se fier à des heuristiques opaques.
- Mesurer ROI audité, nombre d'événements indépendants, volume, drawdown, linéarité + pente, concentration, distribution des gains/pertes et robustesse au hasard.
- Séparer market makers, rebates, stratégies extrêmement rapides, arbitrages, gains concentrés ou potentiellement couverts hors plateforme.
- Intervalle de confiance et correction des comparaisons multiples, plus baselines secteur/heure/prix.

**Livrable :** 10–20 fiches `pourquoi performant / en quoi copiable / quelles réserves`, avec versionnage de sélection et date de gel.

## 6. P2 — Simulation économique d'une copie

Pour les spécialistes retenus :
- Étudier la différence de prix **source → observateur/copieur** à T+30 s, 2 min, 5 min, 15 min.
- Ne pas inventer de carnet historique : historique de prix = *markout*, pas liquidité exécutable.
- Première stratégie simple : suivi des entrées autorisées, tenue jusqu'à la résolution ; exclure les marchés trop courts/illiquides et trop chers après déplacement.
- Frais maker/taker, spread, niveau de carnet, délai et exécutions partielles. Simulation pour plusieurs tailles d'ordre, budget fictif fixe et plafond par événement.
- Optimiser règles et seuils sur le train uniquement ; ne pas les ajuster en voyant les résultats test.

**Livrable :** rendement net contrefactuel par signal, taux de faisabilité, marges et exclusions ; montrer différences entre performance source et performance du copieur.

## 7. P3 — Validation prospective en paper trading (étape de décision)

**Commencer à enregistrer des snapshots de carnet et timestamps prospectifs dès que les premiers candidats émergent**, car un carnet ancien non archivé ne se reconstruit pas rétroactivement.

- Détection de nouvelles transactions, date de réception, carnet CLOB, spread, profondeur, frais en vigueur.
- Portefeuille fictif avec liquidité et contraintes de taille, positions actives et sorties/résolutions ; **aucun ordre réel**.
- Enregistrer tous les signaux éligibles, exécutables, non exécutables ou manqués, sans suppression rétrospective.
- Cohorte de test gelée ; comparaison à entrées naïves et témoins mêmes marchés/périodes.
- Go seulement si la borne inférieure prudente de la performance nette est positive, après scénarios de coûts et latences défavorables, sur assez d'événements réellement indépendants.

## 8. P4 — Opportunités et signaux (conditionnel)

Seulement si P3 passe les critères : afficher des signaux explicites avec le wallet/stratégie, marché, prix maximal copiable, frais, slippage, taille de position autorisée, risque et raison d'exclusion.

**Aucune automatisation d'ordres réels dans l'état actuel.** Un système de signaux paper-only peut être construit et évalué avant autorisation éventuelle d'opérations réelles et vérification des contraintes applicables.

## 9. UX : conserver trois écrans, améliorer leur objectif

1. **Opportunités** : candidats, preuves nettes de copie ou état exploratoire, seuil prix, liquidité, performance hors échantillon.
2. **Analyse wallet** : analyse financière réconciliée, historique, spécialisation, hypothèse de stratégie, courbes, transactions et markout/copier.
3. **Données** : fiabilité des imports, couverture des flux, anomalies, jobs, horodatage, ressources et stockage.

Le classement existant reste descriptif jusqu'à ce que P1–P3 soient prouvés ; ne pas le renommer `meilleurs traders à copier`.

## 10. Séquence d'implémentation

**Tout de suite :** P0-A, pilote sur 5 wallets + ingestion d'activités et de transactions, suivi de la qualité des identifiants ; préparer la captation prospective de carnets à coût limité.

**Ensuite :** P0-B pour ces mêmes wallets, réconciliation explicite ; puis extension guidée par la qualité plutôt que par le nombre de wallets.

**Puis :** P1 candidats datés et contrôles, P2 simulations économiques, P3 paper trading. P4 seulement après preuve.

Prioriser **les mesures qui changent une décision de trading**, pas les nouveaux graphiques. Conserver l'UI fluide, Supabase partagé provisoirement avec Fit Tracker et limiter les imports jusqu'à mesure des volumes réels.

## Critère d'arrêt/retour métier

Si les données sont trop fragmentaires pour auditer les wallets, ou si les avantages apparents proviennent de stratégies impossibles à copier, **ne pas augmenter l'engagement financier**. Documenter les raisons, tester d'autres sous-populations ou arrêter l'approche.

Dernière question à laquelle le produit doit pouvoir répondre : **« Si j'avais reçu ce signal à cet instant et placé cet ordre à un prix réellement accessible, quel profit net aurais-je obtenu, avec quel risque, et cette performance survit-elle à un test prospectif indépendant ? »**
