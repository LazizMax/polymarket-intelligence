# RN1 — Identification M0, paires YES/NO, inventaire, chronologie et faisabilité d'un oracle

**Date : 2026-11-16 | Implémentation :** `supabase/functions/pi-dashboard/rn1-engine.ts`, modèle `rn1-engine-event-v2` ; route authentifiée `rn1_engine_forensics`, onglet cloud **RN1 · Moteur**. L'Edge Function `pi-dashboard` est déployée en **v26 ACTIVE** après le correctif de purge temporelle. Les scores ci-dessous correspondent à une extraction cohérente au cours du développement du modèle v2, **avant la purge supplémentaire de 60 s et avant que les sondes suivantes ne soient collectées** ; le dashboard recalcule les scores sur les données live et peut donc afficher d'autres nombres.

## Problème et critère d'identification

**Question structurante :** les décisions exécutées de RN1 exigent-elles une estimation externe indépendante de la juste probabilité ou le carnet, la cotation des deux issues et l'inventaire suffisent-ils à les prédire ?

M0 : pas d'oracle externe, microstructure Polymarket, YES/NO, inventaire. M1 : oracle externe de juste valeur, **non testable** sans probabilités indépendantes horodatées avant décision. M2 : market maker à réservation fondée sur une juste valeur externe, **non testable** pour la même raison.

Nouveau test de M0 (pas M1) : ajouter les données de l'autre côté du carnet, avec `paired_bid_sum = bid_yes+bid_no`, `paired_ask_sum = ask_yes+ask_no`, spread, liquidité opposée. La somme des bids n'est **ni** un arbitrage garanti ni une preuve de deux ordres simultanément placés. On mesure la prédiction du **fill Maker BUY inféré et effectivement observé dans les 60 secondes suivantes**, pas les intentions d'ordre.

## Jeu canonique et validation

- `pi.rn1_quote_probe_runs` : cours public, date de réception, positions des deux issues confirmées par API ; `position_observed_at<=received_at`, books `book_at<=received_at`.
- `pi.rn1_quote_probe_fills` : Maker BUY inféré, source live partielle ; labels binaires `trade_at>received_at AND trade_at<=received_at+60 seconds`. Les négatives ne sont **pas exhaustives**.
- Cinq plis déterministes par **event_slug**. Pour chaque pli, les coefficients (normalisation incluse) sont appris sur les autres événements, jamais sur les événements du test. Modèle logistique L2 par vecteur de features, 240 pas fixe, bootstrap 300 tirages par événements pour l'intervalle du gain de log-loss.
- Six règles comparées sur **les mêmes fenêtres éligibles** : fréquence constante, groupe de sélection suivi/témoin, carnet seul, carnet+inventaire, deux carnets, deux carnets+inventaire.
- Coupe chronologique secondaire : événements rangés par première observation ; 70 % initiaux servent à déterminer la coupure ; seuls les événements dont la **dernière** observation est au moins **60 secondes avant** la coupure peuvent servir au train ; ceux dont la première observation suit la coupure constituent le test. Tous les événements traversant cette période sont **embargoed**. La période live demeure courte et ne fournit pas de vraie généralisation sur plusieurs semaines.

### Scores hors événement lors d'une extraction réelle (~4 317 fenêtres, 235 positives, 54 événements)

| Modèle | Log-loss | Brier | Average precision |
|---|---:|---:|---:|
| Constant | 0.212358 | 0.051572 | 0.04738 |
| Origine RN1/témoin | 0.211522 | 0.051486 | 0.05354 |
| Carnet seul | 0.211001 | 0.051419 | 0.06600 |
| Carnet + inventaire | **0.208106** | **0.051077** | 0.08410 |
| Les deux carnets | 0.211252 | 0.051428 | 0.06582 |
| Les deux carnets + inventaire | 0.208295 | 0.051082 | 0.08438 |

**Paires YES/NO :** gain de log-loss en ajoutant le carnet opposé au carnet seul = **−0.000251**, IC bootstrap événement [−0.000970, +0.000197] ; gain en l'ajoutant au carnet + inventaire = **−0.000189**, IC [−0.000759, +0.000155]. Aucun gain robuste. Ce résultat est en faveur du modèle simplifié **pour prédire les fills observés**, pas de l'absence de gestion des paires dans RN1.

**Inventaire :** le gain par rapport au carnet seul est d'environ +0.00290 dans cette extraction, mais la précédente estimation event-bootstrap sur 4 257 fenêtres avait un intervalle [−0.00153,+0.00781]. **Ne pas affirmer une règle d'inventaire valide** avant une preuve plus robuste.

### Contre-épreuve chronologique avant ajout de la purge 60 s

Au snapshot de l'analyse : **1 527 fenêtres train (101 positives)** ; **2 346 fenêtres futures test (81 positives)** ; 7 événements embargoed. Le modèle constant avait un log-loss **0.159845**, le carnet seul **0.160424**, carnet + inventaire **0.155845**, deux carnets + inventaire **0.156118**. L'ajout de la paire ne surpasse pas l'inventaire. **Ces chiffres sont une photo de travail antérieure au dernier correctif** qui exige désormais `last_train_observation + 60 s < cutoff` ; le code live et le dashboard v26 recalculent avec cette marge pour éviter tout chevauchement label/temps.

Ce test est rétrospectif et court ; il ne démontre ni profit ni avantage de trading.

## Test miroir de règle `if inventory_imbalance>10%: buy underweight`

Dans un contrôle SQL utilisant une cohorte similaire : **2 136** marchés-instants avec deux côtés confirmés ; **205** fenêtres avec fill sur une issue seulement. Dans les 150 fortement déséquilibrées, **80** achats portent sur l'issue sous-détenue, **70** sur l'issue sur-détenue. Dans une reproduction plus récente de l'éligibilité du moteur : **156** cas, **84** sous-détenue / **72** sur-détenue. **Pas de preuve d'une règle systématique d'achat sous-détenu**. Les nuances : états de risque non observés, sélection des fills, prix et ouverture des ordres passifs non visibles.

## Couverture du candidat « oracle externe » — découverte et restriction

- `pi.rn1_nba_espn_scoreboards` a livré **51 observations de matchs sur 7 journées**, dont **une** avec une ligne de moneyline fournie par **DraftKings** dans le JSON ESPN. Cette ligne concerne **OKC–Sacramento**, coup d'envoi prévu **2026-11-16 02:00 UTC**, snapshot ESPN enregistré **2026-11-16 01:46:01 UTC**, environ **14 minutes avant** le coup d'envoi.
- ESPN utilise des sous-champs nommés `moneyline.home.close.odds` et `moneyline.away.close.odds`, mais le champ `close` ne doit **pas** être interprété comme une cote finale **déjà connaissable** à une époque antérieure ; la seule preuve de disponibilité publique est notre horodatage de **réception** du snapshot. Les données peuvent être cachées, tardives ou revues.
- Prix visible dans le snapshot : away **−620**, home **+458** (américaines). De-vig proportionnel : away `(620/720) / [(620/720)+(100/558)] ≈ 82.77 %`, home ≈17.23 %. Cette valeur n'est pas la probabilité vraie.
- La seule quote Polymarket du match retrouvée dans les sondes était vers **01:40 UTC**, **six minutes AVANT** la réception du bookmaker, avec des mids **0.835/0.165**. Il serait scientifiquement **incorrect** d'opposer ces prix comme si les deux sources étaient synchrones. La référence ne peut pas être présentée comme disponible pour une décision à 01:40. Aucun fill RN1 n'a été attribué à ce snapshot dans cette expérience.
- **La présence de DraftKings via ESPN ne démontre pas que RN1 utilise DraftKings, ESPN, un oracle quelconque, ou qu'il possède une juste valeur supérieure au marché.** Les conditions et licences d'utilisation d'un flux tiers doivent être vérifiées avant une collecte accrue. Les endpoints ESPN utilisés par l'existant ne constituent pas un service officiel d'odds garanti.

**Prochaine expérience décisive** : captation **prospective, horodatée à réception** et avec conditions de licence appropriées de plusieurs bookmakers/agrégateurs, de manière comparable aux WebSockets carnet Polymarket, puis construction de séquences où les odds externes bougent AVANT Polymarket ; holdout événementiel, contrôle des mêmes marchés sans fill, ablation `p_ref`. Les odds historiques de The Odds API sont soumises à un accès payant ; aucun abonnement ni dépense n'a été lancé ici.

## Score et décision
- **M0 complet** : le modèle carnet+inventaire fait mieux que la baseline dans la période étudiée, mais les gains conditionnels sont encore modestes et les négatives incertaines. **Candidat, non validé**.
- **M0 avec cotation des deux issues** : **pas de gain observé** sur ce benchmark ; ne pas multiplier cette famille de variables sans nouvelles observations ou signal discriminant.
- **M1 oracle / M2 hybride** : **non identifiables**, pas réfutés. Un snapshot pré-match de bookmaker ne constitue pas un corpus de probabilité avant les décisions.
- **Prochaine allocation de recherche** : haute résolution des books + vraie série de référence bookmaker, contrôle des absences de fills, puis seuils parcimonieux/automate seulement si le modèle permet de prédire des événements nouveaux.

**Sources internes** : `docs/RN1_BLACKBOX_SYSTEM_IDENTIFICATION_ORACLE_VS_MAKER_2026-11-16.md`, `docs/RN1_ENGINE_EVENT_HELDOUT_V1_2026-11-16.md`, fichier moteur, CI `tests/rn1_engine_fixture_test.mjs`.
