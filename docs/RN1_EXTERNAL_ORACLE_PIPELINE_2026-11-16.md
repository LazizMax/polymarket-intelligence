# RN1 — Capture prospective d'odds indépendantes : pipeline opérationnel sans clé configurée
**16 novembre 2026 | Déploiements : pi-dashboard v27 ACTIVE, pi-rn1-odds v2 ACTIVE | Lecture seule**

## Mission et frontière de preuve
La question d'ingénierie est : **les fluctuations de juste valeur estimée par une source bookmaker indépendante permettent-elles de prédire les fills RN1 mieux qu'un moteur M0 qui ne connaît que Polymarket + l'inventaire ?**

Cela ne peut être testé que si la **réception effective des odds précède la décision**. Le fait que RN1 exploite personnellement TheOddsAPI, DraftKings ou FanDuel n'est **pas** établi et ne peut pas être inféré d'une comparaison de prix.

## Implémentation réalisée
- `sql/060_rn1_bounded_external_odds.sql` : nouvelle table **privée** `pi.rn1_external_odds_observations`, RLS activée, SELECT/INSERT des rôles anon/authenticated révoqués, et état de collecte `pi.rn1_external_odds_collector_state`.
- `supabase/functions/pi-rn1-odds/index.ts` : nouvelle Edge Function authentifiée **par le même secret de scheduler privé que l'infrastructure existante** ; pas de route publique de collecte.
- `supabase/functions/pi-rn1-odds/normalize.ts` : adaptateur pur et testé pour le format TheOddsAPI NBA h2h, matching exact équipes NBA, dates locales selon le fuseau du home team, décote de marge à deux issues, contrôle horodatages.
- `sql/061_rn1_external_oracle_cron.sql` : cron `pi-rn1-external-oracle-1hour` à `0 * * * *`, ACTIVE. Un appel Edge par heure **ne signifie pas** un appel API externe : **en l'absence de `RN1_ODDS_API_KEY`, la fonction retourne sans requête vers un bookmaker.**
- `supabase/functions/pi-dashboard/index.ts` : route **authentifiée** `rn1_oracle_evidence` avec compteurs, transitions d'odds, dernière heure de réception, et vérification de la couverture réellement antérieure aux quotes Polymarket moneyline ; jamais de score M1/M2 si la couverture et l'alignement contractuel manquent.
- `web/index.html` : dans **RN1 · Moteur**, section **Oracle externe · collecte & preuve temporelle**, statut de connexion, compteurs, recoupement temporel, dernières probabilités observées et limitations.
- CI `tests/test_rn1_external_oracle.py` et `tests/rn1_oracle_normalize_fixture_test.mjs` ; normalisation testée sur un match NBA synthétique OKC @ SAC avec un coup d'envoi en UTC le lendemain du jour local.

## Garde-fous d'utilisation et de coût
- Fournisseur proposé **TheOddsAPI** (https://theoddsapi.com/quickstart.html, API `api.theoddsapi.com`), source sélectionnée **NBA**, **h2h/moneyline**, **DraftKings et FanDuel uniquement**, **prix américains**. Ce fournisseur est **distinct** de `the-odds-api.com`, dont les API et tarifs sont différents.
- **Aucun accès sans clé** `RN1_ODDS_API_KEY`, jamais de clé envoyée via le navigateur, GitHub, logs ou requête SQL. L'injection des secrets se fait dans le **Supabase Dashboard → Edge Function Secrets**, projet **qamdvfakwclkuswrdckp** ; l'utilisateur doit créer et connecter sa propre clé, une action explicite qu'il contrôle.
- Budget d'exécution : cron **1 fois par heure**, **24 demandes externes au maximum par jour UTC**, écart **≥50 min**, **5 000 observations stockées maximum** (le code refuse de lancer une collecte supplémentaire au plafond), une demande par tick, aucun achat ni upgrade automatique. La logique de plafond est approximée en SQL à partir de l'état et ne doit pas être modifiée sans revoir les risques de concurrence ; les appels sont normalement sérialisés par le cron horaire.
- Selon les tarifs consultés au 16/11/2026, TheOddsAPI annonçait une formule NBA/MLB h2h gratuite avec un quota de 25 requêtes/jour, sans historique ; l'offre peut changer et l'inscription est distincte du projet Supabase.
- **Le projet Supabase avait déjà ~583 Mo en base et ~354 Mo d'archives comprimées, ainsi que des imports historiques en cours** lors de l'audit. Cette nouvelle collecte est volontairement **minuscule**, ne lance aucun backfill des 756 000 fills, et s'arrête au plafond d'observations. Surveiller les quotas de l'infrastructure totale ; pas de nouveaux abonnements.
- Ancien flux ESPN : des *odds* ont été repérées dans **un** snapshot avant le match OKC–SAC. Les endpoints utilisés sont **non officiels** et leurs droits de réutilisation ne sont pas établis ; **pas de nouveau scrapping/polling ESPN** pour les odds dans le pipeline créé ici. Les snapshots ESPN antérieurs ne sont pas rebaptisés « données TheOddsAPI ».

## Contrat statistique
1. L'objet bookmaker expose `event_id,home_team,away_team,start_time,books[].book,books[].market,books[].updated_at,books[].outcomes[].name/price`.
2. Pour la cote américaine `a`, `q(a)=|a|/(|a|+100)` si `a<0` et `100/(a+100)` sinon ; `p_home=q_home/(q_home+q_away)`. C'est un premier **dévig proportionnel**, pas la probabilité vraie.
3. Le marché est normalisé `nba-away-home-YYYY-MM-DD` avec **date locale du stade de l'équipe home**, pas la date UTC du kickoff. Une concordance textuelle n'est pas une garantie d'équivalence des règles de résolution ; **la correspondance des outcomes Polymarket doit encore être vérifiée** avant le test directionnel.
4. `first_seen_at` est le moment réel de **réception de la réponse** dans notre pipeline ; `book_updated_at` est une annotation du fournisseur. À l'analyse, on impose **`first_seen_at <= quote.received_at`** et `quote.received_at < start_at`, et maximum deux heures d'âge de la cotation. Aucune donnée reçue après le trade ou la quote n'entre dans les features.
5. On teste M1/M2 **sur le même sous-ensemble d'événements éligibles que M0**, avec event holdout + test futur, ablation `p_ref`, log-loss/Brier et incertitude clusterisée par événement. On n'appellera pas « oracle identifié » un simple markout Maker positif.
6. Dans l'interface, `eligible_quote_windows` signifie seulement la présence d'une cote *reçue à temps* et d'une quote moneyline compatible par slug ; **cela ne valide pas encore le mapping directionnel ni le contrat exact**.

## Vérification de production déjà effectuée
- La migration privée des tables a renvoyé `success=true`, RLS activée et droits de lecture anon/authenticated désactivés.
- Cron `pi-rn1-external-oracle-1hour` visible et actif.
- `pi-dashboard` v27 et `pi-rn1-odds` v2 déployés ACTIVE.
- Requêtes SQL de couverture du dashboard exécutées sans erreur : **0 observations**, **0 événements recoupés**, état `missing_api_key`.
- Appel réel à l'Edge Function via pg_net avec secret de scheduler Vault : **HTTP 200 `{"status":"missing_api_key","requests":0}`**. Confirme l'absence d'appel de bookmaker tant que la clé manque.
- CI smoke tests et fixture Node 22 réussis après correction du test de source (`c7559809`, puis workflow `478400da`).

## Résultat et blocage restant
**Pipeline de capture prêt, collecte externe réelle non démarrée : il manque volontairement la clé du fournisseur, fournie et configurée par l'utilisateur dans Supabase.** Le moteur n'a pas inventé de séries historiques, et M1/M2 restent non identifiables.

Dès configuration du secret, le prochain tick horaire peut collecter les cotes ; le dashboard affiche automatiquement la couverture. Pour les analyses de réaction **pendant** un match, le flux gratuit moneyline pré-match peut être insuffisant : il faudra alors négocier la source, la fréquence et le budget à partir de la première preuve de faisabilité.
