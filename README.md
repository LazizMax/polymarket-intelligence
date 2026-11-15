# Polymarket Intelligence

Projet de recherche Polymarket : **évaluer si la copie de traders possède une EV nette positive**, puis la tester prospectivement, avec une interface cloud privée et un ancien client Windows.

## Feuille de route métier active — 15 novembre 2026

[**Roadmap Cloud : de l'audit des trades au paper trading copiable**](docs/ROADMAP_COPY_TRADING_CLOUD_2026-11-15.md)

**Prochaine étape :** [P0-A, collecter transactions individuelles et activités économiques avec provenance et identifiants robustes](https://github.com/LazizMax/polymarket-intelligence/issues/6). Les classements ROI actuels restent descriptifs ; ils ne prouvent pas la rentabilité d'une stratégie copiée. Les étapes P0-B, P1, P2 et P3/P4 sont suivies dans les [issues du dépôt](https://github.com/LazizMax/polymarket-intelligence/issues).

### Ancienne application Windows (historique du projet)

## État actuel — v2.1.0

**Phase P0 : audit des données et du ROI, partiellement implémentée.** L'application collecte les positions ouvertes/fermées, les positions rachetables et l'activité du wallet en mode approfondi. Le rapprochement avec le PnL officiel est diagnostique : aucun ROI global sur capital réel ni avantage de copy trading n'est encore certifié.

Voir [les corrections P0 v2.1.0](docs/P0_2.1.0.md) et [l'audit stratégique du cahier des charges](docs/AUDIT_STRATEGIQUE_2026-11-14.md).

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


## Version cloud (bêta)

[Ouvrir l'interface Polymarket Intelligence Cloud](https://lazizmax.github.io/polymarket-intelligence/)

GitHub Pages est activé : les modifications de l'interface `web/` sont publiées automatiquement à l'URL ci-dessus.

Le dashboard en ligne utilise le schéma privé `pi` d'un projet Supabase existant. Il impose un compte Supabase Auth explicitement autorisé. L'import initial de 100 wallets, le PnL quotidien et les drawdowns observés sont opérationnels. Un job planifié rafraîchit 5 wallets toutes les 15 minutes. **Aucun ROI sur capital ni avantage de copy trading n'a encore été validé.** La documentation technique et la procédure de suspension sont dans [le runbook cloud](docs/CLOUD_RUNBOOK_V1.md).


### ROI des positions clôturées

Dans **Analyse wallet**, la nouvelle section ROI présente le coût estimé, PnL réalisé et ROI de chaque position clôturée, ainsi que le ROI total pondéré, le ROI moyen arithmétique et le ROI médian. Les valeurs de coût manquantes ne sont pas converties en zéro. Un historique incomplet ou des positions exclues restent signalés. [Méthodologie et limites](docs/ROI_CLOSED_POSITIONS_V1.md).

Un ROI par **exécution** (chaque achat/vente) et le ROI sur capital exigent encore un ledger de transactions complet et réconcilié.
