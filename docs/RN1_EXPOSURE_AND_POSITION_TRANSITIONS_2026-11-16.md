# RN1 — Inventaire YES/NO, concentration événementielle et variations entre sondes

**Étude exploratoire · 16 novembre 2026.** Recherche en lecture seule, aucune transaction et aucun signal de copie validé.

## Objet

Après avoir testé sans succès neuf formules simples de **taille des fills Maker** (cf. `RN1_MAKER_SIZING_MARKET_VALIDATION_2026-11-16.md`), étudier comment RN1 **construit l'inventaire sur les deux issues d'un contrat**, le montant attribué aux positions **actuellement ouvertes** et le regroupement des contrats d'un même match.

## Provenance de la collecte et limites du périmètre

- Table `pi.rn1_quote_probe_runs` : sondes CLOB sélectionnant **huit marchés à chaque passage**, et **16 issues** répertoriées ; la sélection change au cours du temps.
- Filtre : uniquement `position_status='complete'` avec `position_observed_at <= received_at`, au plus **2 000 sondes complètes récentes**.
- Les positions contiennent `market_key`, `outcome_index` (0/1), `current_size`, `entry_cost_usdc`, et `returned_by_api`.
- Si l'API publique n'a retourné aucune position pour une issue, le collecteur conserve un **placeholder de taille zéro**, avec `returned_by_api=false` et **coût NULL**. Pour les agrégats de coût, nous transformons uniquement ce NULL en zéro au moyen de `SUM(COALESCE(entry_cost_usdc,0))`. **L'absence de retour API n'est pas une preuve indépendante de zéro actif.**
- Les libellés d'événements sont rapprochés de `quotes[*].event_slug` et `market_type` issus de la **même sonde**.
- Cette sélection ne constitue **ni l'ensemble du wallet ni un relevé de trésorerie ou de marge**. On ne peut pas reconstituer la bankroll ou un plafond d'exposition globale à partir de ces sommes.

## État des inventaires observés

Lors de la vérification de la phase initiale, environ **406 sondes** couvraient **3 248 observations marché–instant**, 236 marchés et 75 événements distincts. Les chiffres de l'application sont recalculés en continu ; les chiffres de ce document sont un **point de contrôle historique**, pas une valeur actuelle immuable.

- **2 171** observations avec les deux issues réellement retournées et positives.
- **677** avec une seule issue positive (l'autre issue pouvant être un zéro imputé par absence de retour).
- **400** sans aucune issue retournée, dont les deux coûts manquent et sont imputés à zéro.
- Médiane du coût attribué aux positions **positives** d'un marché : environ **2 778 USDC**. Le maximum de marché observé était alors environ **37 373 USDC**.
- Médiane de la somme des coûts d'entrée **dans les huit marchés sélectionnés à chaque sonde** : environ **35 839 USDC**, avec un maximum sur une sélection autour de **103 662 USDC**. Ces sommes ne sont PAS le capital simultanément risqué sur tous les marchés du wallet.

La métrique descriptive `abs(shares0−shares1)/(shares0+shares1)` mesure le déséquilibre **en nombre de parts**, pas la probabilité ou la valeur nette en dollars. Elle n'est définie que lorsque le dénominateur est positif.

## Transitions par marché — protocole causal de mesure

1. Pour chaque `market_key`, ordonner les sondes successives par horodatage et comparer uniquement deux observations espacées de **180 secondes ou moins**.
2. Mesurer `Δsize0`, `Δsize1`, `Δattributed_open_cost`, `Δabs(size0-size1)`, et `Δmin(size0,size1)`.
3. **Variation d'écart négative** : l'écart absolu de parts diminue ; positive : il augmente. Augmenter `min(size0,size1)` signifie renforcer les parts appariées ; ces deux mesures peuvent évoluer dans des sens différents.
4. Analyse stricte : ne conserver, pour le verdict prioritaire, que les changements avec **les deux issues retournées par l'API aux deux observations**. Séparer tout changement pouvant provenir d'un zéro imputé.
5. Croiser à titre de diagnostic les exécutions reconnues dans `pi.rn1_quote_probe_fills` entre les deux relevés, sans affirmer leur exhaustivité ni leur causalité unique.

Dans un contrôle d'environ **279 changements strictement confirmés** : le déséquilibre absolu diminue **128** fois, augmente **149** fois et reste stable **2** fois. L'échantillon élargi présente une majorité de hausses du coût attribué aux positions ouvertes. Ces données **ne montrent pas de rééquilibrage systématique après chaque intervention**, mais sont compatibles avec une coexistence de nouvelles accumulations et de couvertures.

La disparition d'une position dans la réponse API peut créer une baisse de coût artificielle : la variante stricte est donc indispensable. Les « fills matchés » ne couvrent pas toutes les exécutions du marché entre les sondes.

## Regroupement des marchés du même événement

L'analyse regroupe les marchés sélectionnés qui possèdent le même `event_slug` dans la **même sonde**, et calcule :
- le nombre de marchés simultanément représentés dans la sélection (ex. moneyline, spread, total) ;
- la somme des coûts attribués aux parts ouvertes dans ces marchés **sélectionnés seulement** ;
- les maxima **observés** par événement, plus les derniers coûts sélectionnés et le nombre de relevés.

Ces sommes ne sont **ni la valeur nette ni la Value at Risk d'un match** : les marchés du même événement ont des règlements corrélés et d'autres marchés de l'événement peuvent être absents de l'échantillon. Le maximum historique observé **n'est pas une limite de risque privée prouvée**.

## Proxy conditionnel de perte à l'échéance pour un contrat binaire

Sous l'hypothèse restrictive d'un marché binaire correctement résolu, avec exactement une issue qui paie **1 USDC par part**, et de **positions inchangées jusqu'au règlement** :

```text
paiement brut terminal minimal du contrat = min(parts_0, parts_1)
borne conditionnelle de perte contre le coût affiché
  = max(0, coût attribué aux parts actuellement ouvertes − min(parts_0, parts_1))
```

Ce n'est **pas un PnL réalisé**, ni un mark-to-market, ni une garantie, ni une VaR.

**Validation externe du mécanisme de paiement :** [Polymarket Help Center — How Are Prediction Markets Resolved?](https://help.polymarket.com/en/articles/13364518-how-are-prediction-markets-resolved) indique qu'une part gagnante vaut 1 USD et une perdante zéro. La [documentation CTF publiée par Polymarket](https://github.com/Polymarket/agent-skills/blob/main/ctf-operations.md) détaille les opérations de split, merge et redeem des paires YES/NO. Ces sources justifient uniquement l'identité binaire conditionnelle, **pas** la complétude des positions API de RN1, l'exactitude de leur coût attribué, ni une garantie sur l'issue litigieuse d'un marché.
 Les frais, opérations antérieures, avoirs omis, remboursements, transferts, résolution litigieuse, nouvelles exécutions et contraintes de liquidité ne sont pas intégrés. La somme des pires cas par contrat sélectionné peut supposer simultanément des résultats sportifs incompatibles : c'est une **borne conservatrice conditionnelle**, pas une distribution probabiliste de pertes.

Dans le relevé initial, la borne conditionnelle médiane par **marché actif** était d'environ **740 USDC**, son 90e centile environ **3 517 USDC**, et son maximum observé environ **12 159 USDC**. La borne conservatrice médiane agrégée sur les **huit marchés sélectionnés** était d'environ **8 447 USDC**. Ces chiffres ne caractérisent pas la bankroll globale.

## Implémentation et vérification

- Backend `supabase/functions/pi-dashboard/index.ts` : action authentifiée, **lecture seule** `rn1_exposure_forensics`, qui calcule les résumés par marchés, événements, les paires de relevés à ≤180 s et une série temporelle des 15 marchés avec les plus fortes positions ouvertes observées. SQL limité aux **2 000 sondes complètes les plus récentes** pour un calcul borné.
- Nouveau panneau `web/index.html` : **RN1 · Exposition**, avec distribution des deux issues, total de la sélection (clairement identifié), transitions séparées par qualité API, concentration par événement, graphique interactif par marché du coût et de la borne conditionnelle de perte.
- Test `tests/test_rn1_exposure_forensics.py` intégré aux workflows RN1.
- Validations : compilation de la fonction Edge, SQL réel sur les sept sections, tests du frontend par `node --check`, tests de contrats CI.
- Aucune réimportation des 756 000 archives gelées, aucune table dupliquée ajoutée et aucune transaction Polymarket exécutée.

## Prochain test discriminant

Poursuivre les mêmes marchés sur des **sessions indépendantes** et des horizons plus longs afin de distinguer seuils observés stables vs simple fin de match / rotation des marchés. Pour estimer un véritable plafond de risque il faut observer **l'ensemble des positions simultanées du wallet** et idéalement les ordres Maker *ouverts ou annulés* (non visibles dans les fills). Construire ensuite une estimation de corrélation de règlement pour les différents marchés du même événement, distincte d'une simple addition des coûts.
