# RN1 — Récupération de stockage et replay exhaustif (15 novembre 2026)

## Opérations de stockage effectivement réalisées

Sur le projet Supabase **Fit Tracker** hébergeant le schéma privé `pi`, la sonde de cotations s'était suspendue à `paused_quota` puisque `pg_database_size()` dépassait **304 087 040 octets**. Le SQL d'archives en direct était passé à ~314 365 619 octets dans notre audit.

Sept index PostgreSQL ont été reconstruits **avec `REINDEX INDEX CONCURRENTLY`**, sans supprimer d'enregistrements, table ni archive :
- `pi.idx_pi_closed_position_market`
- `pi.closed_position_roi_pkey`
- `pi.rn1_full_activity_metrics_pkey`
- `pi.rn1_full_market_metrics_pkey`
- `pi.idx_pi_closed_position_latest`
- `pi.idx_pi_rn1_full_markets_activity`
- `pi.idx_pi_pnl_wallet_day`

Taille après reconstruction : **~285 Mo** lors de la mesure, contre **~314,4 Mo** avant. Comme l'ingestion est en cours, le total évolue constamment ; ne jamais figer ce chiffre dans l'interface comme une propriété permanente.

Les deux flux `trades_all` et `activity_all` conservent leurs archives gzip privées ; **leur budget de matérialisation SQL seulement** a été limité à `288358400` octets (~275 MiB), puis la métrique `metrics_paused_at` s'est remplie après 760 000 lignes matérialisées par flux. Les lignes validées des archives ont continué d'augmenter au-delà. Cette distinction est fondamentale : les statistiques SQL ne doivent pas être présentées comme couvrant l'intégralité du flux archivé.

Le probe de carnets a été restauré à `collecting` **uniquement après vérification de plus de 12 Mo de marge sous le plafond** ; son plafond `304087040` octets est resté identique. Cron `pi-rn1-live-quote-probe-1min` actif, nouvelles sondes confirmées après reprise (de 99 à 109 cycles au contrôle).

**Risque résiduel :** les autres applications et mises à jour ROI continuent à utiliser la base. Aucune promesse de capacité illimitée ; en cas de croissance, les garde-fous restent applicables. Ne pas augmenter les plafonds ou supprimer des index essentiels juste pour les contourner.

## Nouveau replay : reconstitution chronologique du comportement Maker

- Code : `supabase/functions/pi-rn1-replay/index.ts`
- Fonction déployée : `pi-rn1-replay` (Edge Function privée derrière vérification du token scheduler et de son SHA)
- Tables privées RLS : `pi.rn1_replay_jobs`, `pi.rn1_replay_pages`
- Cursors/résumés en SQL ; **inventaire par marché et références futures en checkpoints gzip privés** `pi-rn1-research-private/replay-v1/checkpoints/`. Chaque page brute est vérifiée via SHA256 ; les fichiers historiques existants ne sont jamais modifiés.
- Ordonnancement serveur : cron `pi-rn1-large-replay-1min` (job ID 12 au contrôle), exécution au maximum 4 pages par appel, avec bail, verrou de progression et reprise sans double comptage.
- Cohorte figée à l'initialisation : **756 pages × 1000 fills = 756 000 observations maximales**. L'API peut continuer de collecter des pages plus anciennes : les pages ajoutées *après le gel* ne sont PAS incluses dans cette première cohorte. **Après épuisement de la source, un nouveau replay intégral doit repartir du plus ancien fill ; ne pas concaténer l'état actuel à des transactions historiquement antérieures.**
- Validation de démarrage : 5000 fills traités, 4421 Maker, 579 Taker, zéro inconnu, toutes les pages comparées aux audits Maker/Taker archivés ; ensuite 9000 puis 25 000 fills ont été vérifiés, sans erreur persistante.

### Reconstruction (ce que le moteur mesure et ce qu'il ne mesure pas)

Pour chaque exécution chronologique :
1. Vérification du contenu et du hachage de la page originale, de l'identité du wallet, de l'issue et du prix.
2. Comparaison multiensemble avec le flux officiel `taker_only=true` sur la même fenêtre ; source-page role totals comme contrôle indépendant. Doublons mixtes restent `unknown`. Si le contrôle échoue, le worker s'arrête au lieu d'inventer les rôles.
3. Inventaire **des achats/ventes exécutés observés** avant le fill : YES, NO, coûts moyens de flux, déséquilibre et effet avant/après. Ce n'est **pas le wallet réel** : les merges, redemptions, transferts, historiques précédents et ordres non exécutés manquent.
4. Formation de nouvelles paires par l'achat de l'issue moins représentée, avec écart de prix grossier par paire au coût moyen historique opposé. **Marge comptable théorique**, pas du cashflow réellement verrouillé ou du ROI net.
5. Pour les achats Maker et Taker : prochaine **exécution publique du même wallet et du même token** après 1, 5, 15, 30, 60 minutes, si elle tombe dans une fenêtre de tolérance limitée. Cette référence est *endogène*, pas un midpoint CLOB indépendant. Les futurs manquants sont distingués des résultats négatifs ; ne pas traiter ces exécutions comme une preuve de sélection adverse indépendante.

La cohorte est soumise au biais de sélection des exécutions réalisées (ordres non remplis inconnus). Les calculs de `markout` des transactions futures propres à RN1 restent un **proxy**, pas une prédiction de bénéfice exécutable ni un backtest de copy trading.

### Observations partielles, susceptibles d'évoluer

Sur les premières 25 000 exécutions vérifiées : 22 646 Maker, 2 354 Taker, zéro rôle inconnu. Parmi 20 534 achats Maker comparables dans le proxy de flux, 8 105 réduisent l'écart YES/NO et 12 429 l'augmentent. Sur 8 132 achats Maker avec référence future du même wallet à ~15 minutes : variation pondérée d'environ **−0,00199 $/part**, sans interprétation comme perte de trading réalisée. **Le nombre d'observations dépend de la couverture des futures exécutions.**

### Vérification / commandes utiles (lecture seule)

```sql
select status,pages_done,frozen_last_page,fills_done,maker_fills,taker_fills,unknown_fills,last_error,last_success_at
from pi.rn1_replay_jobs where job_key='rn1_full_chronology_v1';

select count(*) processed_pages,sum(valid_fills) fills,
sum(maker_fills) makers,sum(taker_fills) takers,sum(unknown_fills) unknowns
from pi.rn1_replay_pages;

select stream,rows_valid,metrics_rows,metrics_paused_at,status from pi.rn1_full_streams;
select status,completed_runs,matched_fills,last_success_at from pi.rn1_quote_probe_state;
```

L'interface sur la branche GitHub présente la progression du replay et les métriques Maker ; la modification est distincte du déploiement frontend GitHub Pages. Le backend `pi-dashboard` a été déployé en version 23 avec le nouveau champ `full_replay`. Les tables de replay ont RLS actif et aucun droit SELECT public/anonymous.

## Suites de recherche

Une fois que l'ensemble de la cohorte figée est relu, vérifier la stabilité des résultats par période et par événement ; pour la véritable sélection adverse, joindre **des séries de prix historiques indépendantes** (et pas seulement les futurs achats RN1), avec taux de couverture et fenêtres temporelles fiables. Le profit brut réconcilié sur 22 185 marchés et le coût des paires ne doivent pas être confondus avec les markouts des fills Maker. Dernière étape avant imitation : frais, latence, probabilité de remplissage, exposition réelle et validation prospective.
