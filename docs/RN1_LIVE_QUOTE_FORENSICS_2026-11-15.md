# RN1 — Live Quote Forensics / test de la formule de cotation (2026-11-15)

## Hypothèse à tester

RN1 accumule passivement YES/NO, avec un coût complémentaire d'environ 0,9812 pUSD par paire sur la cohorte réconciliée de 22 185 marchés (résultat brut +1 326 425 $ sur la composante paire ; risque directionnel résiduel -277 217 $). Cette décomposition repose sur des **prix moyens des trades effectivement exécutés**. Elle n'identifie ni les ordres non remplis ni une règle fixe de prix (du type `bid_yes = p_fair - marge - risque`).

**Ne jamais inférer les vrais meilleurs bids/asks de 2026-09 et 2026-10 à partir d'une série de prix par minute**. La source officielle ne donne pas les historiques de carnets non capturés.

## Nouveau collecteur, en lecture seule

- `pi-rn1-quote-probe` appelle `/v2/trades?user=<RN1>&start=1&limit=1000&taker_only=false` pour identifier les marchés où RN1 a exécuté au cours de la dernière heure, puis Gamma `/markets?condition_ids=...` en **répétant** le paramètre `condition_ids` (une chaîne CSV renvoie `[]` sans erreur).
- Les marchés récents RN1 encore ouverts et sportifs sont prioritaires (jusqu'à cinq). Le reste de la capacité de **huit marchés** est rempli avec les marchés sportifs actifs les plus liquides de Gamma (groupe témoin, distinct de RN1). Aucun marché inactif n'est traité comme ouvert.
- **Protocole v1 CTF : `clobTokenIds` ; Protocole v2 : `positionIds`.** La présence occasionnelle des deux champs ne suffit pas à choisir : il faut regarder `version`.
- Appel public `POST https://clob.polymarket.com/books` avec les deux identifiants d'issue, jusqu'à 16 livres par cycle. Meilleur bid = **prix maximum** dans les niveaux de bids ; meilleur ask = **prix minimum** parmi les asks. Conserver timestamp, hash, tick size, tailles et trois premiers niveaux.
- L'ensemble brut des carnets, les identifiants et les dates de début/fin de requête sont conservés dans un **objet gzip privé** `pi-rn1-research-private/quotes/<date>/...`, avec SHA-256, plus un résumé SQL par minute dans `pi.rn1_quote_probe_runs`.
- L'application n'expose que les statistiques et leur niveau de preuve, jamais le service-role key ni le contenu des archives.

## Comparaison rigoureuse

Un achat RN1 postérieur peut être rapproché d'un carnet **dont la réponse était reçue 10 à 120 secondes AVANT le timestamp du fill**. Les observations plus tardives et les livres périmés sont exclus. Le timestamp propre au livre est préservé et contrôlé. Un délai de 60 s peut tout de même dissimuler plusieurs mouvements de marché ; un ajustement exact du bid n'est donc pas identifiable.

Pour chaque fill rapproché :
- prix, taille, heure, marché, outcome, hash d'exécution publique ;
- carnet antérieur, meilleur bid/ask, mid, spread, décalage du fill en ticks par rapport au bid ;
- maker/taker **inféré** par sous-ensemble de la source `taker_only=true`, si les pages couvrent suffisamment la même période. Doublons de signatures à rôle mixte => `unknown` ;
- frais sports théoriques si taker : `C * 0.05 * p * (1-p)` ; maker = 0. Il ne s'agit pas d'une commission effectivement débitée par le protocole pour chaque ligne. Rewards et rebates distincts.

La source des transactions est limitée à **la première page latest-first de 1000 fills par sondage** : au-delà, la couverture peut être incomplète. Un même fill identifié par signature + occurrence est inséré une seule fois ; en l'absence d'un identifiant unique d'exécution fourni, les doublons exacts peuvent rester ambigus.

## Tests falsifiables

1. **Prix maker comparé au bid précédent** : taux d'égalité au meilleur bid avec ±0,5 tick et MAE en ticks, en excluant les samples dont les livres ont plus de 60 secondes.
2. **Modèles de décalage constant** : bid, bid−1 tick, bid−2 ticks, bid+1 tick. Première tranche 80 % des trades **par temps** = apprentissage ; dernières 20 % = comparaison hors période. Ce n'est qu'un score de prédiction du prix d'exécution *conditionnel au fill*, **pas un backtest de profits ni un calcul de chances d'exécution**.
3. **Carnets combinés** : `bid_yes + bid_no` pour le coût hypothétique de deux limites maker si toutes deux sont exécutées ; `ask_yes + ask_no + frais taker théoriques` pour une traversée immédiate des deux books avec taille suffisante. Les deux cas dépendent de la liquidité/latence et ne prouvent pas une marge garantie.
4. **Sélection adverse** : un fill maker peut être défavorable si le prix baisse immédiatement après ; les épisodes futurs devront être observés *après* le fill, et jamais utilisés pour construire le signal précédent.
5. **Hors échantillon de marchés** : exiger des observations couvrant plusieurs événements sportifs distincts et semaines ; une tranche temporelle de fills n'est pas une validation indépendante par événement.

Les modèles ne sont pas présentés comme fiables avant **100 exécutions dans la période témoin sur au moins 10 marchés** ; même après, seul l'écart de prix est vérifié, pas la rentabilité.

## Limites pratiques et sécurité

- **Intervalle** : cron 1 minute ; un mouvement intra-minute peut être raté. Une réplication quasi exhaustive requiert un service WebSocket permanent hébergeant la souscription publique market stream — non disponible comme tâche permanente dans les Edge Functions planifiées.
- **Couverture** : seulement huit marchés à la fois ; un marché de RN1 non ciblé n'a aucune preuve de carnet antérieur et ne doit pas être joint rétroactivement.
- **Garde-fous** : base partagée avec Fit Tracker. Le collecteur se met en pause au-dessus de ~290 MiB SQL ou 700 MiB d'archives privées, sans augmenter les quotas ni interrompre les autres applications. Les données déjà collectées restent lisibles.
- **Aucun ordre envoyé**. Ni clé de trading, ni signature, ni position ouverte, ni probabilité interne du bot visible.
- **Source de vérité** : API CLOB /books, Gamma /markets et Data API /v2/trades, avec hashes et horodatages d'acquisition. `pi.rn1_quote_probe_fills` ne contient que des joins explicitement causaux.

Tables privées RLS : `pi.rn1_quote_probe_state`, `pi.rn1_quote_probe_runs`, `pi.rn1_quote_probe_fills` (migration 035). Déclenchement sécurisé : `sql/036_rn1_quote_probe_schedule.sql`. UI RN1 · Algorithme, action authentifiée `rn1_quote_forensics`.

## Critère de succès réel

Une règle de cotation n'est reproductible que si elle **prévoit des prix d'ordres et des remplissages sur des marchés jamais vus, couvre ses frais et son risque d'inventaire, et donne un résultat positif lors d'un paper trading événementiel contrôlé**. Le matching historique d'ordres exécutés et les spreads théoriques ne suffisent pas.

## Reprise du 15 novembre — positions réelles synchronisées (migration 037)

Audit du dépôt et du backend avant modification : PR #26 et GitHub Pages publiés, pi-dashboard v20 et pi-rn1-quote-probe v2 actifs. À 15:02 UTC : 670 000 trades + 670 000 activités archivés, 59 sondes CLOB, 50 fills avec carnet prétrade, 59 sondes SANS positions (ancienne fonction). Ces 59 anciens relevés sont conservés, **jamais rétroactivement enrichis avec un inventaire courant**, ce qui introduirait une fuite d'information.

**Contrat API /v2/positions :** le filtre `condition` accepte théoriquement plusieurs ids. Mais un test réel sur huit conditions a renvoyé 10 positions dont six provenaient de marchés NON demandés, sans erreur HTTP. Avec une condition on obtient deux positions sur ce seul marché ; avec deux conditions, quatre positions sur ces seuls marchés. Le champ `condition` est donc limité côté collecteur à **deux identifiants de marché par requête** (longueur inférieure à 200 caractères), puis vérification *de chaque réponse* : wallet exact, condition exacte, token exact, index d'outcome, pagination totalement épuisée, pas de doublons. Si une seule des requêtes échoue, statut `unavailable`, zéro inventaire déduit. Ne pas assimiler `[]` issu d'un filtre ignoré à une position de taille zéro.

Ordre de collecte lors d'une minute :
1. identifier jusqu'à huit marchés actifs, en priorité récemment tradés par RN1 ;
2. lire séparément les **positions ouvertes effectivement détenues** sur chaque paire de conditions, vérifiées jusqu'au dernier curseur (un retour `has_more=true` annule la capture d'inventaire) ;
3. enregistrer `position_observed_at`, **puis seulement** lancer la requête CLOB et enregistrer `requested_at`, `received_at` ;
4. enregistrer les deux carnets complets, les tokens, le JSON de positions et les quatre réponses d'origine dans une **archive gzip privée SHA-256** ;
5. rapprocher exclusivement les fills RN1 exécutés 10 à 120 secondes *après* la réception d'un carnet précédent. Ne jamais modifier les fills anciens ni inventer les positions auparavant.

`pi.rn1_quote_probe_runs` porte désormais `position_status`, `position_observed_at`, `positions` : deux lignes par marché sélectionné même lorsqu'une issue n'est pas détenue (taille zéro autorisée uniquement si le filtre et la pagination ont été validés).

Les modèles testés sur les fills maker **avec carnet précédent et inventaire valide** :
- prix au meilleur bid, à un ou deux ticks en dessous ;
- pénalisation 1 ou 2 ticks selon le déséquilibre (plus on détient la même issue, moins on paie) ;
- limite hypothétique d'achat complémentaire `min(best_bid, 1 - prix_moyen_de_l_issue_opposée - marge)`, marge cible 1 % ou 2 %.
Les modèles sont évalués sur la **même cohorte de fills éligibles**, avec sélection par erreur moyenne uniquement sur la partie chronologiquement ancienne (80 %) puis contrôle sur la dernière partie (20 %). Le tableau n'affiche de classement hors période qu'avec au moins 100 fills et 10 événements ; un prix d'exécution bien prédit ne prouve ni la probabilité d'exécution ni un profit.

Attention : une photo de portefeuille prise quelques secondes avant le trade ne reconstitue pas forcément tous les fills, merges ou transferts intervenus entre-temps. L'ancienne métrique de flux de 134 000 trades était encore plus imparfaite ; les deux ne doivent pas être confondues. Les montants de marge complémentaire obtenus avec le dernier coût moyen observé sont **indicatifs**, pas une formule du bot ni un PnL réalisé.

## Contrôle de l'âge du carnet (nouvel échantillon de la journée)

Sur 65 fills RN1 déjà appariés à 20 marchés, le `bid_offset_ticks` par rapport à un snapshot précédent n'est **pas stationnaire en fonction de l'âge du carnet** :

| Âge du carnet au moment du fill | Fills maker au meilleur bid enregistré | MAE absolue |
|---|---:|---:|
| 10–30 s | 21/29 = 72,4 % | 0,45 tick |
| 30–60 s | 5/28 = 17,9 % | 3,32 ticks |
| >60 s (jusqu'à 120 s) | 4/8 | 1,88 tick |

Cette divergence impose de **présenter séparément les fenêtres 10–30s et 30–60s** : calculer un taux combiné diluerait l'information et risquerait de faire croire à une règle de prix différente. Le groupe >60s est trop petit pour tirer une tendance.

Sur 546 paires de carnets observées, **546/546** avaient `bid_yes+bid_no<1` et **0/546** avaient `ask_yes+ask_no<1`. Écart moyen `1 - (bid_yes+bid_no)` = **0,0206 $ par paire**. Cela correspond à une **marge maker passive théorique conditionnée aux DEUX remplissages**, pas à un arbitrage immédiat acheté aux asks. La distribution de futures exécutions et la sélection adverse restent indispensables pour valider un signal économiquement exploitable.

Ces observations sont uniquement les premières ~60 minutes, sur un faible nombre d'événements potentiellement corrélés, et **ne remplacent pas** la future validation hors échantillon sur des jours/événements indépendants.
