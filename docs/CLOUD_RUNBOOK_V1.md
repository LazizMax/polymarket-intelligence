# Polymarket Intelligence Cloud — Runbook opérationnel (2026-11-14)

**URL fixe du site :** https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-dashboard

**Données :** projet Supabase existant Fit Tracker (`bxfvgywfiifnsbjgudzj`), schéma privé `pi`. L'application Fit Tracker continue d'utiliser `public.user_data` ; aucune autre table du projet n'a été migrée ni effacée.

## 1. Déploiement effectif

- `pi-dashboard` : Edge Function publique pour afficher **uniquement la page de connexion** ; les actions `POST` (classement, wallet, santé des données) exigent un JWT valide **vérifié par Supabase Auth** et une ligne `pi.dashboard_access` avec `enabled=true`. Les lectures SQL sont exécutées dans l'Edge Function ; la clé Postgres n'est jamais envoyée au navigateur.
- `pi-ingest` : Edge Function séparée, privée par logique d'application. Actions d'administration uniquement avec `SUPABASE_SERVICE_ROLE_KEY` en-tête Authorization ; route spéciale `scheduled` protégée par un jeton Vault de 256 bits, comparé à son SHA-256 enregistré dans `pi.scheduler_auth`. `verify_jwt=false` pour ces deux fonctions ; **ne jamais déduire du seul réglage gateway que les données sont ouvertes**.
- Le tableau utilise les vues pré-calculées `pi.wallet_metrics_daily`, indexées et paginées ; l'utilisateur ne recharge pas les 46 673 lignes à chaque ouverture.
- Les graphiques wallet chargent au maximum 1 900 jours par fenêtre. L'interface est autonome (HTML, JS, CSS), sans hébergeur ni police externe.
- Les fichiers source sont dans `supabase/functions/pi-dashboard/` et `supabase/functions/pi-ingest/`. Les déploiements Supabase ont été effectués via les outils connectés ; **une modification GitHub ne déclenche pas encore automatiquement leur déploiement**.

## 2. État du premier pilote

- 100 wallets issus des classements publics PnL/volume (fort biais de sélection).
- 46 673 observations de PnL journalier initiales ; 91 wallets avec au moins 90 jours.
- 100 fiches de métriques, environ 17 Mo de tables/index et métadonnées.
- Drawdown du PnL cumulé observé en **USDC**, ratio variation PnL / DD PnL, R², pourcentage de jours actifs positifs et part du jour le plus rémunérateur dans les variations positives.
- Capital investi, ROI du capital, drawdown du capital (%), coût complet des positions et performance d'une stratégie copiée restent **non établis**. Ne jamais afficher ces métriques comme vérifiées.

## 3. Planification automatique

Un job Supabase Cron actif nommé `pi-pnl-refresh-5-wallets-15min` exécute :

- 5 wallets maximum toutes les 15 minutes ;
- le prochain groupe est choisi parmi ceux ayant la plus ancienne `last_attempt_at` ;
- un premier import complet pour un wallet encore absent, puis une révision incrémentale de ses **7 derniers jours** ;
- une sauvegarde du statut par wallet dans `pi.ingestion_jobs` et un curseur dans `pi.ingestion_cursors` ;
- un refroidissement de 24 h pour les wallets après 5 erreurs, pour éviter les boucles ;
- reprise et réessais sur HTTP 429/503 dans une enveloppe limitée.

Le premier appel planifié du 14 novembre 2026 à 23:30 UTC a réussi pour **5 wallets**. Une première erreur de sérialisation JSON, lors d'un test manuel précédent, reste conservée ; le correctif a été testé sur 6 actualisations réussies au total et 48 lignes mises à jour.

### Vérifier les exécutions

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname='pi-pnl-refresh-5-wallets-15min';

select started_at, wallet, status, rows_fetched, error_message
from pi.ingestion_jobs order by id desc limit 20;
```

### Suspendre les imports sans arrêter Fit Tracker

```sql
select cron.alter_job(
 job_id := (select jobid from cron.job where jobname='pi-pnl-refresh-5-wallets-15min'),
 active := false
);
```

### Réactiver

```sql
select cron.alter_job(
 job_id := (select jobid from cron.job where jobname='pi-pnl-refresh-5-wallets-15min'),
 active := true
);
```

## 4. Accès au dashboard

Le navigateur ouvre l'URL et affiche la connexion. Utiliser les identifiants du compte **Supabase Auth déjà existant dans Fit Tracker**, seul compte actuellement autorisé dans `pi.dashboard_access`. Le mot de passe est vérifié par Supabase Auth, jamais par une table `pi`. Le jeton de session est conservé en `sessionStorage` et le dashboard ne lit la base qu'après validation côté serveur.

**Tests effectués :** HTML public répond HTTP 200, `POST` sans session répond HTTP 401, Deno typecheck et syntaxe JavaScript embarquée en CI, migration PostgreSQL en CI, premier refresh planifié réel. **À vérifier avec l'utilisateur :** une connexion depuis son navigateur Windows avec son compte Auth, et l'ergonomie complète écran par écran.

Ne jamais communiquer de clé `SUPABASE_DB_URL`, de `service_role` ou du secret Vault par chat, git, ou navigateur.

## 5. Garde-fous sur les résultats

- La courbe PnL ne mesure ni cash du wallet ni valeur de marché de toutes les positions.
- Le ratio gains / DD ici ne vaut **pas** ROI/DD du capital.
- Le R² peut être élevé pour une mauvaise stratégie ; le filtre par pente et par concentration de la meilleure journée est nécessaire.
- Les comptes proviennent des leaders existants : survivorship bias, multiple testing et wash-like activity possibles.
- L'API PnL peut réviser l'historique ; le refresh incrémental ne corrige que les 7 derniers jours. Prévoir un ré-audit complet périodique.
- Cette web beta ne recommande encore aucun achat et n'a aucun moteur de copy trading validé.

## 6. Performance et exploitation

Le classement a été mesuré sur 100 wallets avec `EXPLAIN ANALYZE` (environ **1,0 ms de temps SQL**, hors latence réseau, authentification, navigateur et cold start). Aucun p95 bout-en-bout n'a encore été mesuré.

Conserver l'import à faible cadence car Polymarket partage le même compute Supabase que Fit Tracker. Si la charge augmente, déplacer le schéma `pi` dans un projet indépendant et recalculer son coût.

## 7. Sécurité Supabase à conserver

- Ne jamais exposer `pi` ni `net` dans la configuration Data API.
- RLS actif sur les tables `pi`, aucune politique `anon` ni `authenticated`.
- L'extension `pg_net` est gérée par Supabase et peut encore présenter des droits de schéma dans ses ACL système ; un simple `REVOKE` par le rôle `postgres` ne les a pas modifiés. Vérifier que le schéma `net` demeure absent des schémas exposés par PostgREST.
- Seul le personnel/backend autorisé doit pouvoir requêter Vault et exécuter les jobs `cron`.

## 8. Prochains livrables

1. Vérifier la connexion de l'utilisateur au nouveau site et mesurer la latence réseau.
2. Authentification dédiée indépendante de Fit Tracker si le pilote devient un vrai produit.
3. Importer et auditer transactions, positions et flux ; reconstruire l'equity et les ROI correctement.
4. Tester cohortes hors échantillon puis l'EV de stratégies copiables à prix observables.
5. Déployer automatiquement les fonctions depuis GitHub seulement après configuration sécurisée des secrets CI, sans mélanger ce pipeline avec les releases Windows.
