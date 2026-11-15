# ROI des positions clôturées — première livraison cloud

## Ce qui est calculé

Une ligne représente **une position clôturée sur un token/issue**, et non une transaction individuelle. Plusieurs achats et ventes peuvent correspondre à une même position.

L'API Polymarket Data API v2 sert `GET /v2/positions?status=CLOSED&sort_by=TIMESTAMP&sort_direction=DESC` avec pagination par `next_cursor`. Pour une position clôturée, le champ `total_cost_usdc` représente la base des parts *restantes* et vaut souvent zéro ; il ne faut donc jamais l'utiliser comme investissement historique. La formule exploratoire repose sur :

- **Mise d'entrée estimée** = `total_size × avg_price` (parts achetées durant la vie de cette position × prix moyen pondéré de l'API).
- **ROI par position clôturée** = `100 × realized_pnl / mise estimée`.
- **ROI moyen** = moyenne arithmétique des ROI de position, **non pondérée**.
- **ROI médian** = médiane des ROI valides.
- **ROI total pondéré des positions exploitables** = `100 × Σ realized_pnl / Σ mise estimée`, pour les positions avec coût valide.
- **PnL** = somme des `realized_pnl` des mêmes positions incluses.

Les positions où le coût, la clôture ou les montants ne sont pas assez fiables sont gardées comme lignes **ROI non calculable**, et comptées dans l'indicateur de couverture. **Ne jamais filtrer les positions perdantes**. Le ratio `percent_realized_pnl` de v2 ne remplace pas la reconstruction : c'est un champ de compatibilité, pas une vérification comptable universelle.

## Limites importantes

- L'estimation du coût n'est pas un ledger financier audité : des acquisitions par split/merge, transferts, acquisitions sans achat, frais et récompenses ne sont pas complètement reconstituées.
- Le ROI total pondéré d'un échantillon de positions clôturées **n'est pas le ROI global du wallet**, ni le rendement du capital. Les positions encore ouvertes et les combos sont exclus.
- Un même token peut avoir connu plusieurs cycles de trading ; les snapshots agrègent la position par token. **Un ROI par fill (achat/vente individuel) n'est pas encore calculé**. Cela exigera le rapprochement des flux `/v2/trades` + `/v2/activity` et l'inventaire WAC/FIFO.
- La fin de pagination indique la couverture du feed de positions `CLOSED`, mais pas la réconciliation de l'ensemble de la comptabilité du wallet.
- `valid_cost = false` signifie que le coût ou la clôture n'a pas passé les contrôles, pas que le PnL est nul.

## Architecture et exploitation

- Tables privées `pi.closed_position_roi` et `pi.roi_import_state` ; RLS actif, aucun accès direct des visiteurs.
- API privée `pi-dashboard`, actions `roi` (lire données déjà agrégées) et `roi_request` (prioriser l'import).
- Import `pi-ingest` : 200 lignes par page, cursor opaque, génération par actualisation. Reprise sur erreur sans marquer l'historique complet ; anciens scans exclus pendant un nouvel import.
- Cron `pi-closed-roi-auto-2min` : import automatique de tous les wallets, par deux pages maximum toutes les deux minutes ; réexamens récents au plus tard toutes les 6 heures par wallet (selon la file), audit complet tous les 30 jours. Secret conservé dans Supabase Vault. [Détails](AUTO_ROI_REFRESH_V1.md).
- L'interface affiche l'avancement, les ROI par position paginés, le nombre de valeurs valides et inconnues, ainsi que la moyenne, médiane, ROI pondéré et PnL.
- Les sommes ne sont pas qualifiées de **ROI global complet** si l'historique est partiel ou si un coût manque.

### Premier test sur données réelles

Un wallet suivi a été parcouru sur 21 pages : 4 081 positions clôturées, dont 3 811 coûts estimables et 270 à qualité insuffisante. L'échantillon documenté présente un ROI moyen simple d'environ 489,44 %, une médiane d'environ 1,01 % et un ROI pondéré d'environ 2,60 %. **Ce ne sont pas des résultats audités ni des rendements copiables**.

## Contrôles techniques

- 10 tests Deno couvrent profit, perte, ROI nul, coûts manquants, absence de clôture, valeurs non finies, et l'anomalie de `total_cost_usdc=0` sur une position clôturée.
- Test PostgreSQL sur les requêtes réelles de l'API : le ROI pondéré diffère de la moyenne simple et les pertes sont conservées.
- Côté navigateur, les données sont lues via l'Edge Function autorisée ; les JWT et droits d'accès existants restent inchangés.
