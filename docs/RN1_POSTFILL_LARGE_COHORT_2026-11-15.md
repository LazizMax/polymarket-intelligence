# RN1 — Exécution de l'analyse post-fill sur les plus grands échantillons vérifiables

Date : 2026-11-15. Source : Supabase `pi`, requêtes **lecture seule** ci-jointes.

## Périmètres et interdictions d'extrapolation

| Question | Échantillon réellement disponible | Limitation |
|---|---|---|
| Activité / maker-taker | 730 000 fills audités, plus 2 000 en attente | Pas de suivi individuel des ordres limites non exécutés |
| Variation d'inventaire avant/après chaque BUY | 134 000 fills chronologiques, 114 003 comparables | Inventaire de flux, pas inventaire réel après REDEEM/MERGE |
| Profit économique reconstitué | 22 185 marchés réconciliés, 9 571 événements | Gross avant frais et rebates, cohorte de marchés restrictive |
| Évolution 15 min avec série de prix externe | 1 373 fills, 80 marchés, 3 jours | Échantillon orienté ; identité Maker non démontrée par ce jeu |
| Archives de trades globales | >=732 000 achats stockés au moment de l'audit | Les pages sont stockées en gzip, non disponibles comme table séquentielle complète |

## Mesures exécutées

### Inventaire — 134 000 fills

Sur **114 003 achats comparables** (flux BUY/SELL exécutés, sans remises/merges/transferts), **41 415 réduisent l'écart** de quantités YES/NO, **72 581 l'augmentent**, 7 le laissent inchangé. Taux de réduction : **36,33 %**. Les deux moitiés donnent respectivement 20 705/57 021 et 20 710/56 982, soit un comportement stable à ce niveau.

Ce résultat **ne suppose pas que les achats Maker uniquement** sont classifiés au niveau du fill par cette table : la cohorte chronologique n'a pas de jointure Maker fiable par fill. Le fait que les archives historiques auditées présentent une forte part Maker ne permet pas de convertir 114 003 en 114 003 Maker.

### Économie — 22 185 marchés réconciliés

Résultat brut +1 049 208 $, dont **+1 326 425 $** de marge algébrique sur paires et **−277 217 $** de résultat résiduel directionnel, pour **9 571 événements**. Décomposition selon ratio de volumes des deux issues :

| Ratio max/min | Marchés | Gross $ | Paires $ | Résiduel $ |
|---|---:|---:|---:|---:|
| <1,1 | 1 350 | +255 038 | +228 694 | +26 344 |
| 1,1–1,5 | 3 352 | +576 096 | +372 145 | +203 952 |
| 1,5–2 | 2 568 | +171 190 | +291 787 | −120 596 |
| >=2 | 14 915 | +46 883 | +433 800 | −386 917 |

À ratio >=2, le résiduel absorbe **89,2 %** de la marge algébrique des paires (386 917 / 433 800). Cela ne démontre pas que l'absence de rééquilibrage est la cause des pertes ; les résultats incluent l'issue sportive et la sélection des marchés.

### Évolution de prix 15 min — références historiques limitées

**1 373 fills**, **80 marchés**, **3 journées**, suivi 15 min moyen à +929 secondes. Écart pondéré en quantité +0,03309 $/part, proportion de fills avec écart favorable 49,96 %. Données issues d'un **pilote latest-first sélectionné**, pas d'un historique Maker exhaustif. Aucune généralisation permise aux centaines de milliers de transactions.

## Décision méthodologique et suite technique

Pour mesurer correctement **le markout (variation du prix après exécution) des Maker sur un grand échantillon** et attribuer **l'effet sur l'inventaire avant/après chaque exécution**, il faut traiter les archives gzip horodatées dans l'ordre chronologique sur le plus grand nombre de pages vérifiées : un processeur de relecture doit restaurer les deux issues par marché, inclure l'identité Maker/Taker individuelle vérifiée, tenir un inventaire causal au moment du fill et joindre les observations de prix ultérieures à la même issue. La capture CLOB n'existe pas pour les anciennes périodes : des prix **d'exécutions publiques futures** peuvent servir de proxy, mais doivent porter un autre nom que les mid CLOB et leur biais de sélection doit être étudié.

**Bloqueur actuel :** la base Supabase partagée excède son plafond de sécurité ; la sonde de cotations est `paused_quota`. Ne pas lever le garde-fou, créer des tables volumineuses ni supprimer des données sans audit. Préférer un replayer qui lit les archives gzip en lecture seule et écrit des sorties compactes en stockage privé après vérification d'intégrité, sans relancer un recalcul SQL intégral sur la base.

Script SQL de vérification : [`sql/rn1_postfill_inventory_large_cohorts.sql`](../sql/rn1_postfill_inventory_large_cohorts.sql).
