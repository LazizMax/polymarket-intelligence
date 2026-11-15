# ROI Cloud — synchronisation automatique de tous les wallets

## Couverture

- Tous les wallets présents dans `pi.wallets` reçoivent une entrée `pi.roi_import_state` automatiquement à la migration 014. Chaque wallet ajouté ultérieurement est inscrit par la tâche serveur.
- **Premier passage :** parcourir toutes les pages `/v2/positions?status=CLOSED`, 200 positions par page, avec curseurs persistants et redémarrage sur la dernière page traitée.
- **Ensuite :** rechercher les positions nouvelles ou révisées au moins toutes les **6 heures par wallet**, en reparcourant une fenêtre de **14 jours** de dates d'activité. Si les données sources ne sont pas ordonnées, la collecte ne coupe pas la pagination prématurément.
- **Audit complet :** tous les **30 jours** par wallet, pour détecter des modifications anciennes et retirer les positions absentes de l'historique source après l'épuisement du scan.
- Une nouvelle journée de PnL observée sur un wallet priorise également sa prochaine vérification ROI.
- L'historique déjà importé reste consultable pendant les actualisations récentes et les audits : les anciennes positions ne sont pas masquées par une nouvelle génération provisoire.
- ROI estimé automatiquement à partir des coûts des positions clôturées utilisables. Les coûts inconnus sont exclus **et comptés**, pas convertis en zéro. Le ROI sur capital et celui de chaque exécution ne sont toujours pas audités.

## Planification

Le job `pi-closed-roi-auto-2min` exécute au maximum **deux pages (400 positions) toutes les deux minutes**, sur un wallet à la fois, en utilisant le secret existant stocké dans Supabase Vault. C'est un débit volontairement limité pour ne pas saturer le projet Fit Tracker qui héberge provisoirement les données.

À ce débit, le premier chargement des 100 wallets peut nécessiter de nombreux passages. Il n'y a pas de promesse de complétude immédiate.

```sql
select sync_mode,count(*),count(*) filter(where last_complete_at is not null) as historiques_entierement_importes
from pi.roi_import_state group by sync_mode order by sync_mode;

select wallet,sync_mode,pages_fetched,rows_seen,last_recent_at,last_full_audit_at,last_error
from pi.roi_import_state order by last_attempt_at desc nulls last limit 20;

select jobid,jobname,active,schedule from cron.job where jobname like 'pi-%';
```

Pause d'urgence du job ROI (sans modifier le job PnL ni Fit Tracker) :

```sql
select cron.alter_job(
 job_id := (select jobid from cron.job where jobname='pi-closed-roi-auto-2min'),
 active := false
);
```

Reprise :

```sql
select cron.alter_job(
 job_id := (select jobid from cron.job where jobname='pi-closed-roi-auto-2min'),
 active := true
);
```

## Protection des résultats

Les positions du marché peuvent comporter des coûts incohérents ou une quantité résiduelle ; elles ne contribuent pas au calcul du ROI pondéré ni à la moyenne. Un import incomplet affiche explicitement un ROI partiel. Une actualisation récente conserve le dernier historique complet et signale qu'elle est en cours.

**Important :** une position clôturée de Polymarket est un ensemble de trades sur un token, **pas** une ligne correspondant à chaque exécution. La formule actuelle reste `ROI = realized_pnl / (total_size × avg_price)`, en approximation des coûts non réconciliés. La valorisation globale du portefeuille est une prochaine étape.

## Réconciliation de données héritées

La version précédente réinitialisait le compteur `generation` lorsqu'une actualisation manuelle était lancée, pouvant masquer temporairement des lignes déjà importées. La nouvelle version utilise un scan stable qui met les lignes à jour sans recréer un ensemble visible vide. Le portefeuille `aenews2` a été réparé sans perte : les 4 081 positions déjà enregistrées ont été re-rattachées à l'historique visible avant la mise en route automatique.
