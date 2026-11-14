# Polymarket Intelligence

Application Windows locale pour analyser les transactions historiques publiques sur Polymarket.

## Fonctionnement

Trois écrans : **Classements**, **Profils**, et **Collecte / mises à jour**.

Les métriques de ROI sont affichées avec leur couverture de données. Un historique incomplet ne doit jamais être présenté comme un ROI global fiable. Les simulations de copie ne sont pas des profits réalisés.

## Confidentialité

Ce dépôt public contient uniquement le **code et les tests**. Les bases SQLite, configurations personnelles, clés, cookies, journaux et exports de wallets restent sur le PC dans `%LOCALAPPDATA%\PolymarketIntelligence`.

## Publication

La publication continue est préparée dans `.github/workflows/release.yml` :

1. Importer la source de l'application dans `app/`, les tests dans `tests/`.
2. Mettre à jour `app/version.json` pour chaque nouvelle version.
3. Un push sur `main` déclenche les tests, la création d'une GitHub Release et la mise à jour de `latest.json` après validation.

Dans l'application permanente, l'adresse du manifeste de mise à jour est :

`https://raw.githubusercontent.com/LazizMax/polymarket-intelligence/main/latest.json`

**État actuel** : le code V2.0 est publié, mais cette application reste un outil exploratoire. **Aucune stratégie rentable à copier n'a encore été validée.** Voir le [cahier d'audit stratégique et critères de validation](docs/AUDIT_STRATEGIQUE_2026-11-14.md).

## Remarques

- Ce programme est un outil de recherche en lecture seule, pas un bot exécutant des transactions réelles.
- Un PnL positif historique ne garantit aucun profit futur.
