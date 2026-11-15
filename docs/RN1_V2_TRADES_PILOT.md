# RN1 — Audit de ses vraies transactions (pilote v1)

Portefeuille : `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`.

**Ce que le code peut effectivement démontrer :** les transactions publiques reçues de `GET /v2/trades?user=<RN1>&start=1&limit=200`, leur provenance par page, leur chronologie, les marchés et les issues observées, le volume des BUY/SELL, l'existence d'achats sur les deux issues et le délai entre les premiers achats *visibles dans l'échantillon*.

**Ce qu'il ne démontre PAS :** les ordres maker placés et annulés, la priorité dans les files, la probabilité de fills, l'arbitrage verrouillé, le ROI et PnL net sur position, ni les profits de spreads. Le feed v2 ne fournit **aucun champ vérifié maker/taker** ni identifiant atomique unique de fill. Le tx hash ne doit pas être utilisé seul pour dédupliquer.

### Collecte effective
- Schéma privé `pi.rn1_trade_import_state` : curseur opaque, statut, compteur, lease anti-concurrence, erreurs, limite de 4 000 lignes.
- `pi.rn1_trade_pages` conserve le JSON brut intégral de la réponse (avec paramètres de requête), hash SHA256, indices de page et timestamps.
- `pi.trades` : lignes normalisées avec clé déterministe `sha256(pageSHA:indexDansPage)`, `raw_archive_key` pour pointer sur le JSON brut, `source_row_index`, `outcome_index`, token/condition, prix/quantité.
- L'archive brute est source de vérité ; les lignes normalisées dérivées ne garantissent pas la non-duplication entre deux pages de l'API. **Les doublons éventuels restent audités**, pas effacés arbitrairement. Pagination par `cursor`, pas `offset`.
- Tâche `pi-rn1-trades-pilot-2min` : 2 pages / passage ; arrêt automatique lorsque 4 000 lignes ont été consultées ou en cas d'épuisement de source. En cas d'erreur la position ne recule pas (rollback page + curseur), prochaine exécution sécurisée.
- Les données sont privées et n'impliquent aucune transaction réelle.

### Interprétation
Le tableau "marchés avec achats sur 2 issues" démontre seulement deux types de BUY dans le même condition ID. Les BUY peuvent avoir des quantités, prix et périodes différents. Le "délai entre premiers achats observés" est une mesure descriptive biaisée lorsque l'historique antérieur manque. Les VWAP sont par issue, **pas des prix de paires appariées**. La présence de ventes, merges/redemptions, incentives, transferts ou d'inventaires antérieurs rend non-fiables tout calcul de profits de paires à ce stade.

### Étape suivante après le pilote
Ajouter le feed `/v2/activity` et les événements on-chain, reconstituer l'inventaire propre à chaque outcome chronologiquement, réconcilier BUY, SELL, MERGE, REDEEM, récompenses, transferts et frais. Une fois les flux vérifiés, tester des hypothèses de market making avec vraies données du carnet et analyse des risques/queues, puis hors échantillon. Ne pas extrapoler l'échantillon 4 000 à la vie du compte.

### Déploiement
1. Appliquer `sql/019_rn1_trade_pilot.sql` (RLS privé, additive only).
2. Déployer `pi-ingest` avec `rn1-trade-utils.ts`, `pi-dashboard`, puis lancer un tick vérifié via le token déjà dans Vault.
3. Activer `sql/020_rn1_trade_pilot_schedule.sql` et vérifier statut cron.
4. Publier l'interface GitHub Pages et vérifier les agrégats SQL. Aucune modification du stockage Fit Tracker.
