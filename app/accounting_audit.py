"""Cautious wallet-accounting audit. No money or ROI is treated as audited here.

Position snapshots are not a complete trading/cash-flow ledger. The comparison
with official PnL is *diagnostic*, especially if the snapshots have different
as-of times or include different PnL components (combos/rebates/LP rewards).
"""
from __future__ import annotations
import json
from collections import Counter
from datetime import datetime, timezone
from historical_db import n
from position_integrity import check_position


def _time(text):
    if not text:return None
    try:return datetime.fromisoformat(str(text).replace('Z','+00:00')).timestamp()
    except (ValueError,TypeError):return None


def wallet_accounting_audit(db, wallet: str) -> dict:
    row=db.execute('SELECT * FROM wallets WHERE wallet=?',(wallet.lower(),)).fetchone()
    if row is None:return {'status':'INCONNU','reasons':['Wallet absent de la base']}
    meta=dict(row)
    closed=list(db.execute('SELECT realized_pnl,raw_json FROM positions WHERE wallet=?',(wallet.lower(),)))
    held=list(db.execute('SELECT total_pnl,realized_pnl,unrealized_pnl,raw_json FROM open_positions WHERE wallet=?',(wallet.lower(),)))
    values=[];cost_missing=0;invalid_pnl=0;held_statuses=Counter();fees_seen=0.
    invariant_violations=Counter()
    for is_held,p in [(False,r) for r in closed]+[(True,r) for r in held]:
        try:r=json.loads(p['raw_json'])
        except (ValueError,TypeError):r={}
        invariant_violations.update(check_position(r,held=is_held))
        cost=n(r.get('total_cost_usdc'))
        if cost is None or cost<=0:cost_missing+=1
        fee=n(r.get('entry_fees_usdc'))
        if fee is not None:fees_seen+=fee
        if is_held:
            held_statuses[str(r.get('status') or 'UNKNOWN')]+=1
        val=n(p['total_pnl'] if is_held else p['realized_pnl'])
        if val is None:invalid_pnl+=1
        else:values.append(val)
    observed=sum(values) if values else None
    latest=db.execute('''SELECT timestamp,economic_pnl,realized_pnl,position_pnl
             FROM pnl_points WHERE wallet=? ORDER BY timestamp DESC LIMIT 1''',(wallet.lower(),)).fetchone()
    official=dict(latest) if latest else {}
    official_positions=n(official.get('position_pnl'))
    # A difference is useful diagnostic evidence, NOT proof of accounting accuracy.
    delta=round(observed-official_positions,4) if observed is not None and official_positions is not None else None
    closed_at=_time(meta.get('closed_snapshot_at'))
    held_at=_time(meta.get('open_snapshot_at'))
    official_at=n(official.get('timestamp'))
    # Daily official source can lag by up to 24 h, with distinct accounting scope.
    timestamp_gap=max(abs(t-official_at) for t in (closed_at,held_at) if t is not None) if official_at and (closed_at or held_at) else None
    activity=list(db.execute('SELECT kind,amount_usdc FROM activity_events WHERE wallet=?',(wallet.lower(),)))
    types=Counter(str(a['kind']).upper() for a in activity)
    cash_flow_types=('DEPOSIT','WITHDRAWAL')
    cash_flows={kind:round(sum(a['amount_usdc'] for a in activity if str(a['kind']).upper()==kind and a['amount_usdc'] is not None),4)
                for kind in cash_flow_types}
    reasons=[]
    if not meta.get('closed_exhausted'):reasons.append('Positions clôturées : pagination non terminée')
    if not meta.get('open_exhausted') or not meta.get('open_states_complete'):
        reasons.append('Positions détenues : états OPEN/REDEEMABLE/REDEEMABLE_LOST non tous couverts')
    if not meta.get('activity_exhausted'):reasons.append('Historique des mouvements de fonds/récompenses incomplet')
    if cost_missing:reasons.append(f'{cost_missing} position(s) sans coût d’entrée exploitable')
    if invalid_pnl:reasons.append(f'{invalid_pnl} position(s) sans PnL exploitable')
    if invariant_violations:reasons.append(f'{sum(invariant_violations.values())} contradiction(s) dans les données de positions')
    if not latest:reasons.append('Série officielle PnL indisponible')
    if not values:reasons.append('Aucun PnL de position exploitable')
    if timestamp_gap is None:reasons.append('Horodatages de snapshots insuffisants pour rapprocher les séries')
    elif timestamp_gap>36*3600:reasons.append('Snapshot de positions et PnL officiel non synchronisés')
    if delta is not None and abs(delta)>max(1.,.01*abs(official_positions)):
        reasons.append('Écart entre PnL des positions observées et PnL officiel (périmètres potentiellement différents)')
    # No authoritative equality asserted: other flows/combos may change the economics.
    status='A_RECONCILIER' if reasons else 'COHERENCE_INDICATIVE'
    return {
        'wallet':wallet.lower(),'status':status,'reasons':reasons,
        'closed_rows':len(closed),'held_rows':len(held),
        'held_statuses':dict(held_statuses),'activity_count':len(activity),
        'activity_types':dict(types),'deposit_withdrawal_amounts_observed':cash_flows,
        'activity_complete':bool(meta.get('activity_exhausted')),
        'lifecycle_complete':bool(meta.get('open_states_complete') and meta.get('open_exhausted')),
        'missing_position_costs':cost_missing,'invalid_position_pnls':invalid_pnl,
        'position_integrity_violations':dict(invariant_violations),
        'observed_position_pnl_usdc':round(observed,4) if observed is not None else None,
        'official_position_pnl_usdc':official_positions,
        'position_pnl_difference_usdc':delta,'official_economic_pnl_usdc':n(official.get('economic_pnl')),
        'official_realized_pnl_usdc':n(official.get('realized_pnl')),
        'asof_gap_hours':round(timestamp_gap/3600,1) if timestamp_gap is not None else None,
        'entry_fees_disclosed_usdc':round(fees_seen,4),
        'capital_roi_pct':None,'full_lifecycle_roi_pct':None,
        'warning':'Rapprochement indicatif de flux potentiellement non comparables ; aucune certification de PnL net.'
    }
