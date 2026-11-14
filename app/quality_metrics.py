"""Auditable wallet and sector quality indicators. No predicted profitability claims."""
from __future__ import annotations
from collections import defaultdict
from historical_db import wallet_summaries, n
from historical_intelligence import wallet_roi_report, event_ledger
from roi_screening import lower_roi_by_event, MIN_EVENTS

MIN_EVIDENCE_EVENTS = 30


def label(wallet, name=''):
    if name and name.strip() and name.strip().lower()!=wallet.lower():
        return name.strip()
    return wallet[:7]+'…'+wallet[-5:]


def wallet_metrics(db):
    """No win rate on isolated closed positions. A position-level 100% can be selection bias."""
    wallets={r['wallet']:dict(r) for r in wallet_summaries(db)}
    rois={r['wallet']:r for r in wallet_roi_report(db)}
    events=defaultdict(list)
    for e in event_ledger(db):
        if e['event_identifier_valid']:
            events[e['wallet']].append(e)
    result=[]
    for w,meta in wallets.items():
        r=rois.get(w,{})
        es=events.get(w,[])
        samples=len(es)
        closed_complete=bool(meta.get('closed_exhausted'))
        open_complete=bool(meta.get('open_exhausted') and meta.get('open_states_complete'))
        nwin=sum(e['pnl_usdc']>0 for e in es)
        nloss=sum(e['pnl_usdc']<0 for e in es)
        nzero=samples-nwin-nloss
        basis_valid=[e for e in es if e['basis_coverage_complete']]
        total_basis=sum(e['basis_usdc'] for e in basis_valid)
        weighted_partial=(100*sum(e['pnl_usdc'] for e in basis_valid)/total_basis
                          if total_basis>0 else None)
        eligible_for_screen=(closed_complete and open_complete and samples>=MIN_EVENTS and
                             len(basis_valid)==samples and not r.get('couts_manquants_clotures')
                             and not r.get('incoherences_positions_cloturees')
                             and not r.get('incoherences_positions_ouvertes'))
        bound=lower_roi_by_event(es,wallet=w) if eligible_for_screen else None
        top_gain=max((e['pnl_usdc'] for e in es),default=0.)
        wins=sum(e['pnl_usdc'] for e in es if e['pnl_usdc']>0)
        # A 100% win rate is not proof of edge; exclude tiny or incomplete samples.
        win_rate=(100*nwin/samples if closed_complete and samples>=MIN_EVIDENCE_EVENTS else None)
        data_status=('À auditer' if not closed_complete or not open_complete else
                     'Coûts manquants' if r.get('couts_manquants_clotures',0) else
                     'Échantillon réduit' if samples<MIN_EVIDENCE_EVENTS else
                     'Snapshots exploitables (non réconciliés)')
        if not es and closed_complete:data_status='Aucun événement clos'
        realized=n(meta.get('realized_pnl'))
        volume=n(meta.get('volume_usdc'))
        # This is a secondary descriptive turnover efficiency ratio, *not* an investment ROI.
        efficiency=(100*realized/volume if realized is not None and volume and volume>0 else None)
        result.append({
            'wallet':w,'trader':label(w,meta.get('name') or ''),
            'events':samples,'winning_events':nwin,'losing_events':nloss,'flat_events':nzero,
            'winrate_pct':round(win_rate,2) if win_rate is not None else None,
            'roi_closed_pct':r.get('roi_mises_cloturees_pct'),
            'roi_robust_lower_pct':bound['roi_event_bootstrap_low_5pct'] if bound else None,
            'screening_quality':('A examiner hors échantillon' if bound and bound['roi_event_bootstrap_low_5pct']>0
                                else 'Borne incertaine' if bound else 'Non éligible'),
            'roi_global_pct':r.get('roi_mises_global_pct'),
            'partial_roi_pct':round(weighted_partial,2) if weighted_partial is not None else None,
            'cost_events':len(basis_valid),'closed_complete':closed_complete,
            'inconsistent_closed_rows':r.get('incoherences_positions_cloturees',0),
            'open_complete':open_complete,'missing_closed_costs':r.get('couts_manquants_clotures',0),
            'pnl_closed_usdc':r.get('pnl_cloture_usdc'),
            'pnl_positions_usdc':r.get('pnl_positions_global_usdc'),
            'economic_pnl_usdc':n(meta.get('economic_pnl')),
            'realized_pnl_usdc':realized,
            'volume_usdc':volume,'efficiency_pct':round(efficiency,2) if efficiency is not None else None,
            'top_profit_concentration_pct':round(100*top_gain/wins,2) if wins>0 else None,
            'trades':int(meta.get('trades_imported') or 0),
            'data_status':data_status,'updated':meta.get('last_refresh_utc'),
            'reasons':roi_missing_reason(r,samples)
        })
    return result


def roi_missing_reason(r, events=0):
    reasons=[]
    if not r.get('historique_cloture_complet'):reasons.append('Historique des positions clôturées tronqué')
    if r.get('couts_manquants_clotures'):reasons.append(f"{r['couts_manquants_clotures']} position(s) sans coût ou PnL valide")
    if r.get('incoherences_positions_cloturees'):reasons.append(f"{r['incoherences_positions_cloturees']} position(s) avec contradictions de comptabilité API")
    if events==0:reasons.append('Aucun événement clôturé identifié')
    if not r.get('positions_ouvertes_completes'):reasons.append('Positions ouvertes non vérifiées (ROI global indisponible)')
    return reasons


def sector_metrics(db, wallet_rows=None):
    from historical_db import classify
    wallets={m['wallet']:m for m in (wallet_rows if wallet_rows is not None else wallet_metrics(db))}
    groups=defaultdict(list)
    for e in event_ledger(db):
        if not e['event_identifier_valid']:continue
        groups[(e['wallet'],e['sector'])].append(e)
    out=[]
    for (w,sector),events in groups.items():
        meta=wallets[w]
        valid=[e for e in events if e['basis_coverage_complete']]
        all_cost=len(valid)==len(events)
        cost=sum(e['basis_usdc'] for e in valid)
        roi=100*sum(e['pnl_usdc'] for e in valid)/cost if all_cost and cost>0 and meta['closed_complete'] else None
        out.append({'wallet':w,'trader':meta['trader'],'sector':sector,'events':len(events),
            'pnl_usdc':round(sum(e['pnl_usdc'] for e in events),2),
            'roi_pct':round(roi,2) if roi is not None else None,
            'cost_coverage_pct':round(100*len(valid)/len(events),1),
            'source_proven_pct':round(100*sum(e['sector_source'] in ('Gamma (tags)','Classification manuelle') for e in events)/len(events),1),
            'closed_complete':meta['closed_complete'],
            'confidence':('Échantillon insuffisant' if len(events)<MIN_EVIDENCE_EVENTS else
                          'Historique incomplet' if not meta['closed_complete'] else
                          'Exploratoire')})
    return out
