# RN1 — Verdict quantitatif, rapprochement économique et limites de réplication
**Date de l'audit : 15 novembre 2026.** Dataset : Polymarket Data API v2 / Polymarket CLOB, portefeuille public RN1 `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`; stockage dédié `qamdvfakwclkuswrdckp`. Cette note ne recommande aucun ordre ni exécution automatisée.

## Conclusion en trois propositions

| Proposition | Verdict | Niveau de preuve |
|---|---|---|
| RN1 est historiquement profitable sur la fenêtre étudiée | **OUI** : PnL économique natif **+1 112 380,12 USDC** entre 2026-09-21 00:00 UTC et 2026-11-12 00:00 UTC | Fort pour la **mesure publiée par l'API**, pas un audit du portefeuille on-chain indépendant |
| Le mécanisme principal comprend une accumulation Maker binaire de YES/NO à coût intéressant | **Forte piste étayée** : 22 185 marchés à deux issues rapprochés, +1 326 424,98 USDC de composante de paire et −277 216,97 USDC de résiduel directionnel | Bon descriptif ex post ; les annulations et ordres non exécutés restent invisibles |
| Un tiers peut copier les transactions RN1 et reproduire le même rendement net | **NON DÉMONTRÉ.** Achats aux asks, coûts taker, délais, taux de remplissage Maker et rebates différents | Insuffisant ; ne pas assimiler le succès historique du wallet à une stratégie copy trade opérationnelle |

**Il faut séparer la preuve d'un wallet profitable de celle d'une stratégie copiable.** Le premier résultat est confirmé ; la seconde proposition requiert un test prospectif d'exécution indépendante.

## 1. Contrôle indépendant : PnL natif publié par Polymarket

Source : `GET https://data-api.polymarket.com/v2/user-pnl?user=0x2005d16a84ceefa912d4e380cd32e7ff827875ea&interval=all&fidelity=1d`. Les 495 points cumulés natifs de la réponse du 15/11 ont été sauvegardés en privé dans `pi.rn1_official_pnl_points` avec timestamps, blocs sources et JSON d'origine (sans perte de précision JSON via JavaScript). Un collecteur authentifié les actualise toutes les heures ; les valeurs ci-dessous sont les points exactement datés du 21/09 et du 12/11 à 00:00 UTC.

| Composante native | Changement du 21/09 au 12/11 |
|---|---:|
| **PnL économique cumulatif** | **+1 112 380,12 USDC** |
| PnL de marchés réalisé | +669 603,47 |
| Maker rebate | +246 169,45 |
| Taker rebate | +132 492,69 |
| Reward income | +99 351,60 |
| Changement du PnL latent | −35 237,09 |
| Évolution séparée du compteur de frais nets | −263 388,37 |
| Volume de trading nominal `volume_usdc` | 115 813 998,06 |

**Identité vérifiée sur cette période :**
`669 603,47 + 246 169,45 + 132 492,69 + 99 351,60 − 35 237,09 = 1 112 380,12`.
Ne pas soustraire les `fees_paid` de l'agrégat économique une deuxième fois : l'API présente des composantes et des agrégats qui se recouvrent.

La somme des maker rebates, taker rebates et récompenses est **478 013,74 USDC**, environ **43 %** du PnL économique. Sans ces trois postes, la variation des composantes marché + latent s'élève à **+634 366,38 USDC**. C'est une soustraction comptable, **pas une simulation de copy trading**, puisqu'un copieur ne pourrait pas reproduire les exécutions de marché.

Le rapport `PnL économique / volume négocié` est **0,9605 %**. Ce n'est **pas un ROI sur capital** : aucun capital moyen investi ni utilisation de marge n'est vérifié.

**Robustesse temporelle :** 31 journées en hausse et 21 en baisse sur les 52 variations quotidiennes, écart le plus négatif **−101 511,04 USDC**, recul maximal de PnL **observé aux seuls points quotidiens** **156 945,53 USDC**. Six des huit semaines civiles observées sont positives, deux négatives. La semaine du 9 novembre se termine volontairement au 12 novembre et n'est pas comparable à une semaine entière.

| Début de semaine | Variation PnL économique | Variation volume USDC |
|---|---:|---:|
| 2026-09-21 | −57 134,25 | 18 199 747,15 |
| 2026-09-28 | +127 150,36 | 14 926 579,57 |
| 2026-10-05 | +288 514,16 | 12 920 448,31 |
| 2026-10-12 | +226 687,21 | 14 824 812,77 |
| 2026-10-19 | +293 239,52 | 17 094 317,87 |
| 2026-10-26 | +59 920,20 | 17 586 224,53 |
| 2026-11-02 | +257 909,34 | 16 412 848,97 |
| 2026-11-09 (partielle) | −83 906,42 | 3 849 018,89 |

L'API native est une source externe à notre replay, mais **pas** une attestation bancaire ni une reproduction transaction par transaction de toutes les commissions.

## 2. Reconstruction économique : marchés à deux issues et règlements

Cohorte figée **`min_trade_at >= 2026-09-21` et `max_trade_at < 2026-11-12`**, marchandises marchés binaires avec achats sur les deux issues, transactionnel `pi.rn1_full_market_metrics` contre activité `pi.rn1_full_activity_metrics` regroupée par `market_key`. Le critère strict accepte un marché avec REDEEM > 0 lorsque `abs(REDEEM+MERGE - bought_shares_of_winning_side) <= 1` pour au moins un des deux résultats. Il n'assimile pas toutes les positions en cours à des pertes. Les frais, rebates et mouvements externes ne sont pas dans cette somme brute.

| Mesure | Cohorte vérifiée |
|---|---:|
| Marchés ayant les deux issues et un remboursement | 22 189 |
| **Rapprochés au seuil de 1 part/dollar** | **22 185 (99,98 %)** |
| Événements distincts | **9 571** |
| Coût cumulé des achats | 104 750 931,23 USDC |
| REDEEM + MERGE correspondants | 105 800 139,24 USDC |
| **Gain brut observé sur cette cohorte** | **+1 049 208,01 USDC** |
| Gain brut / achats de la cohorte (pas ROI capital) | **+1,0016 %** |
| Composante théorique de paires à 1 USD | **+1 326 424,98 USDC** |
| Composante résiduelle directionnelle | **−277 216,97 USDC** |
| Paires créées ex post : écart unitaire brut estimé | **+1,8803 centime/paire** |

La paire est décomposée selon le coût moyen de chaque issue : `min(qYES,qNO) * (1 - coûtYES/qYES - coûtNO/qNO)`. C'est **une décomposition comptable a posteriori**, pas la preuve que les deux limites Maker ont été postées simultanément, ni un résultat par ordre individuel.

**Précautions sur la population :** 134 marchés deux issues sont sans REDEEM identifié ; 4 sont non rapprochés. Les marchés **à une seule issue** ne sont pas comptés dans les +1,049 M$ : 26 885 marchés mono-issue sur la fenêtre, dont 11 728 avec REDEEM identifié et 15 157 sans REDEEM, ces derniers représentant 3 124 933,25 USDC de mises. On ne peut pas supposer sans vérification que tous les 15 157 sont définitivement perdants ; un échantillon de marchés vérifié via l'oracle contient néanmoins 135 perdants sur 138 mono-issue sans redemption dont la résolution a été contrôlée. Sur les 11 728 mono-issue avec remboursement, 11 712 satisfont un rapprochement à 1 part.

La **performance économique native de la totalité du wallet** (section 1) est la comparaison principale permettant d'éviter le biais de ne regarder que les deux issues.

## 3. Répartition hebdomadaire des seules positions deux issues réconciliées

| Semaine de la dernière transaction | Marchés | Brut réconcilié | Composante paires | Résiduel directionnel |
|---|---:|---:|---:|---:|
| 21/09 | 2 225 | +75 971,41 | −58 968,74 | +134 940,15 |
| 28/09 | 2 084 | +80 816,47 | +182 099,31 | −101 282,84 |
| 05/10 | 2 812 | +193 147,02 | +67 240,25 | +125 906,77 |
| 12/10 | 3 375 | +234 731,50 | +338 440,70 | −103 709,19 |
| 19/10 | 3 183 | +307 589,67 | +265 719,65 | +41 870,02 |
| 26/10 | 3 361 | +106 276,92 | +251 352,93 | −145 076,01 |
| 02/11 | 3 954 | +158 052,47 | +281 988,93 | −123 936,46 |
| 09/11 (tronquée) | 1 191 | −107 377,46 | −1 448,04 | −105 929,42 |

**7 semaines sur 8** avec résultat brut positif, mais seulement **6 sur 8** avec la composante « paires » positive. La semaine du 9/11 est tronquée par la date limite de cohorte.

## 4. Dispersion des gains et incertitude

Sur les 9 571 événements regroupés : gain brut moyen **+109,62 USDC/événement**, écart-type **4 989,31**, médiane **+5,11**. 5 024 événements ont un gain brut positif. Avec intervalle normal de moyenne très approximatif (événements supposés indépendants) : **+9,67 à +209,58 USDC/événement** pour le brut, **+100,77 à +176,41 USDC/événement** pour la composante de paires.

**Concentration importante :** le 1 % des meilleurs événements apporte **+2 476 687,87 USDC**, contre **−2 188 985,37 USDC** pour le 1 % des plus mauvais. Les deux queues excèdent en valeur absolue la marge brute nette globale. Ces événements ne sont pas statistiquement indépendants des dates, des ligues et de la stratégie; les intervalles normaux ne constituent pas un niveau de sécurité garanti.

## 5. Carnet exécutable et différence essentielle Maker/Taker

Le collecteur a observé **1 891 paires de cotations** associées à **141 marchés distincts** : `bid(YES)+bid(NO)` moyen **0,978 USD**, `ask(YES)+ask(NO)` moyen **1,022 USD**, médiane du surcoût à l'ask **0,010 USD**. **0 sur 1 891** paires avaient les deux asks sous 1 USD. Ces cotations, prises à intervalles rapprochés et répétées sur les mêmes marchés, ne sont pas 1 891 expériences indépendantes.

Une marge passive suggérée par les deux bids n'est **pas un arbitrage instantané exécutable**. Il faut être exécuté sur les deux issues, gérer les fills partiels et les positions directionnelles résiduelles ; le copieur qui paie les asks peut voir toute la marge disparaître.

Les achats RN1 rapprochés avec un carnet antérieur représentent seulement quelques centaines de fills et quelques dizaines de marchés, carnet parfois âgé d'environ 35 s : échantillon utile pour confronter les prix, pas pour prouver l'emplacement des ordres ni la possibilité de les copier.

Frais : les conditions publiques de Polymarket indiquent Maker 0 et Taker proportionnel à `shares × p × (1-p)`, avec coefficient variant selon la catégorie et la période. Les programmes de rebates sont variables et ne sont pas garantis au copieur. Voir :
- https://help.polymarket.com/en/articles/13364478-trading-fees
- https://help.polymarket.com/en/articles/13364471-maker-rebates-program

## 6. Test de seuil pour une réplication (simple sensibilité, PAS backtest)

Sur la fenêtre, sans les **478 013,74 USDC** de rebates/rewards, `PnL économique – rebates Maker – rebates Taker – rewards = +634 366,38 USDC`. Rapporté au volume natif **115 813 998,06 USDC**, il reste environ **0,5477 %** de marge maximale comptable disponible pour des coûts **additionnels** dans un *contre-factuel impossible où toutes les autres exécutions et issues restent identiques*.

| Friction incrémentale sur le volume | Résultat arithmétique résiduel sans rebates/rewards |
|---|---:|
| 0 % | +634 366 USDC |
| 0,25 % | +344 831 USDC |
| 0,50 % | +55 296 USDC |
| 0,75 % | −234 239 USDC |
| 1,00 % | −523 774 USDC |

Les vrais coûts ne sont pas simplement proportionnels au volume, les trades d'un copieur et ses volumes ne sont pas identiques, et les probabilités d'exécution Maker sont inconnues. **Ces calculs indiquent la fragilité d'un avantage net copiable, pas un rendement prédit.** Le dashboard propose un curseur de sensibilité explicitement étiqueté.

## 7. Vérification du plan d'échantillonnage et de la causalité

- Le replay chronologique analyse un ensemble gelé de **756 pages × 1 000 transactions**, avec provenance SHA, inventaire YES/NO reconstitué, rôles Maker/Taker confirmés par le flux `taker_only`.
- Les observations CLOB `prices-history` sont prises après les achats sur 8 tokens/page sélectionnés de manière déterministe. Pondération inverse de probabilité de sélection des tokens ; statistiques regroupées par événement à partir de la page source 677. Les prix publics historiques ne sont **pas des prix bid/ask exécutables** et ne sont **pas un PnL**.
- À mi-parcours, le signe du markout Maker 15 minutes varie fortement selon la semaine ; une analyse « leave-one-week-out » inverse le signe lorsqu'on retire la semaine du 7/09. Les tests Maker vs Taker au sein du même événement et moins accumulé vs dominant sont très imprécis : leurs intervalles englobent zéro. Ce sous-ensemble ne prouve donc pas une sélection de prix ou un avantage de rebalancement causal.
- La vraie politique de quoting de RN1, les ordres annulés/non remplis, la profondeur prise, les rebates par ordre, les transferts, les périodes d'indisponibilité et le capital immobilisé ne sont pas tous observables dans les flux publics. La reconstruction peut démontrer les faits de cashflow et les comportements des exécutions, pas le code privé exact du trader.

## 8. Décision opérationnelle

**Statuer maintenant :**
- **Rentabilité passée RN1 : OUI**, selon mesure économique native et cohorte two-sided réconciliée.
- **Mécanisme d'avantage le plus plausible :** fourniture de liquidité Maker / constitution de paires YES/NO à prix favorables, compensée par des pertes directionnelles, avec contribution non négligeable des rebates et rewards.
- **Reproductibilité par copy trading prenant la liquidité : NON DÉMONTRÉE ; économiquement fragile**. N'attribuer aucune rentabilité future à une stratégie qui n'a pas reproduit les deux jambes, les délais, les spreads, frais et rebates.
- **Reproductibilité d'un bot Maker propre : ENCORE NON VALIDÉE**, et très différente de copier les transactions après publication. Nécessite paper trading horodaté et reconstruction des probabilités de fill, inventaires, coûts et marges après frais, avec intervalles par événement/semaine.

Une validation prospective doit mesurer les ordres **passés avant le fill** et ceux **non exécutés**, frais et coûts selon les catégories/marchés, les paires effectivement complétées, l'écart de latence, les pertes d'inventaire, la disponibilité du capital et la stabilité sur des dates inconnues de RN1. Ne pas investir en réel sur la seule base de l'analyse rétrospective.

## 9. Reproductibilité des résultats

- Projet Supabase : `qamdvfakwclkuswrdckp`, schéma `pi`.
- Comptabilité native : `pi.rn1_official_pnl_points`, source `/v2/user-pnl?interval=all&fidelity=1d`, collecte dédiée `pi-rn1-official-pnl`.
- Marchés et paiements : `pi.rn1_full_market_metrics`, `pi.rn1_full_activity_metrics`; requêtes du serveur `rn1EconomicAttribution`.
- Rôles Maker/Taker et prix indépendants : `pi.rn1_replay_jobs`, `pi.rn1_independent_price_jobs`, archives privées immuables.
- Carnets : `pi.rn1_quote_probe_runs` et `pi.rn1_quote_probe_fills`.
- UI : `web/index.html` dans https://lazizmax.github.io/polymarket-intelligence/.
- Le contrôle ultime des **756 000 fills** reste à terminer si les compteurs `pages_done` sont inférieurs à 756. Le verdict de rentabilité historique sur la fenêtre est déjà soutenu par l'historique natif de PnL et les remboursements réconciliés ; les règles exactes de quotation/replication restent inconnues même si le replay de 756 pages s'achève.
