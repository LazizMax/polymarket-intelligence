# Arbitrage Lab V2 — arbitrage temporel, replay prospectif et gestion du risque (paper only)

## Ce qui est livré
- `pi.arb_temporal_snapshots` dans le schéma **privé** existant (RLS + aucune permission de lecture publique).
- Tâche `pi-arb-temporal-books-10min` utilisant le secret Cron déjà présent dans Vault et le collecteur `pi-ingest`.
- Un passage balaie 40 marchés Gamma, sélectionne au plus **12 marchés binaires CTF YES/NO** compatibles, puis récupère leurs carnets CLOB groupés.
- Pour une taille fixe de **50 shares** par issue, enregistre ASK moyen pondéré d'achat et BID moyen pondéré de liquidation, ou **NULL** si la profondeur manque. Horodatage de réception unique par lot, identifiants de token et marché conservés.
- Collecte périodique automatique avec purge **14 jours** pour éviter l'accumulation illimitée sur Supabase partagé avec Fit Tracker.
- Dans Arbitrage Lab, une section **Simulation séquentielle** calcule des scénarios de positions non couvertes, couverture ultérieure et sorties forcées sur un maximum de **3 800 observations des 48 dernières heures**.

## Hypothèse modélisée (causale, mais PAS exécutable automatiquement)
1. Pas de position : acheter fictivement la jambe dont le coût ASK pondéré est le plus faible, si elle coûte au plus le seuil choisi (défaut 0,47 $).
2. **À un relevé ultérieur seulement**, si l'autre issue peut être achetée à l'ASK et si l'ensemble de la paire couvre la réserve de coûts ainsi qu'un ROI net minimum, enregistrer une **paire paper couverte**.
3. Au-delà d'une durée d'exposition maximale, simuler une liquidation au BID pour une taille de 50 shares, **en comptabilisant sa perte ou son gain**. En l'absence de BID suffisant, la position reste non couverte et sa valorisation est **inconnue**, jamais égale à zéro.
4. Ne pas ouvrir d'autre position sur le même marché tant que la précédente n'est pas fermée dans le scénario. Ne pas fusionner les résultats de différents marchés ou modifier rétroactivement les entrées.
5. Ne pas ouvrir et couvrir au même timestamp. Les données sont prises dans l'ordre réel d'observation.

## Restriction explicite
**Aucun ordre réel et aucun ordre maker fictivement prétendu exécuté**. Le replay utilise des hypothèses d'achats/vendes taker au moment d'un relevé, avant latence réelle, changements de prix, frais exacts et contraintes de priorité. Il sert de baseline quantitative, pas de preuve de rentabilité ou de duplication de RN1.

La marge affichée sur les positions papier couvertes n'est donc *pas* un profit encaissé. Les récompenses maker ne sont pas ajoutées. Il n'y a aucune extrapolation de prix entre les scans espacés de dix minutes. Les marchés entrants/sortants du top volume engendrent une sélection imparfaite ; des marchés sportifs courts peuvent être manqués.

## Mesures avant d'aller plus loin
- Nombre et fréquence des observations par marché ; couverture par token.
- Paires papier clôturées, pertes lors des stops, positions encore ouvertes et pire perte possible sur une jambe.
- Comparer différents seuils uniquement avec séparation train/test, sans optimiser a posteriori les performances.
- **Future phase** : collecte des exécutions publiques et de la profondeur à la file pour estimer les remplissages maker, puis vérification des biais de latence/exécution et backtest hors-échantillon.

## Exploitation / reprise
- Relire `pi.ingestion_jobs where stream='arb_temporal'` pour les échecs.
- Vérifier `select count(*),max(observed_at) from pi.arb_temporal_snapshots` ; la première exécution peut nécessiter jusqu'au prochain tick de 10 min.
- Désactiver uniquement ce scan via `select cron.unschedule(jobid) from cron.job where jobname='pi-arb-temporal-books-10min';` (ne touche pas au ROI/PnL).
- Garder le secret Vault en base, jamais dans GitHub ou dans l'UI.
- Déployer les modules d'Edge Function et appliquer le schéma avant de publier l'UI, GitHub Pages n'actualise pas les fonctions Supabase.
