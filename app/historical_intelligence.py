"""Event-level descriptive performance intelligence for saved Polymarket wallets.

Uses closed-position snapshot rows; intentionally does not assert predictive edge or
realized performance by day. Cost basis is fee-inclusive `total_cost_usdc` and is
NOT a capital-time-weighted return. No network, order placement, or secrets.
"""
from __future__ import annotations
from collections import defaultdict, Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import random
import statistics
from historical_db import classify, n, utc_day
from position_integrity import check_position


def event_ledger(db, wallet: str | None = None):
    sql = ('SELECT wallet,record_key,event_key,title,realized_pnl,raw_json '
           'FROM positions WHERE realized_pnl IS NOT NULL')
    args = ()
    if wallet:
        sql += ' AND wallet=?'; args=(wallet,)
    groups={}; classification={}
    for r in db.execute(sql,args):
        event=str(r['event_key'] or '').strip()
        # Never merge unrelated unidentified positions into one "independent event".
        grouping=event if event else 'position-sans-evenement:'+r['record_key']
        if event not in classification:
            classification[event]=classify(db,event,str(r['title'] or ''))
        sector, source = classification[event]
        key=(r['wallet'],grouping)
        try: raw=json.loads(r['raw_json'])
        except (ValueError,TypeError):raw={}
        basis=n(raw.get('total_cost_usdc'))
        pnl=n(r['realized_pnl'])
        if pnl is None:continue
        true_event=bool(str(raw.get('event_slug') or raw.get('event_id') or '').strip())
        g=groups.setdefault(key, {'wallet':r['wallet'],'event_key':event,
            'event_identifier_valid':true_event,'title':str(r['title'] or event),
            'sector':sector,'sector_source':source,'pnl_usdc':0., 'basis_usdc':0.,
            'basis_covered_positions':0,'positions':0,'first_entry_ts':None,
            'last_event_ts':None,'unpriced_positions':0})
        g['event_identifier_valid']=g['event_identifier_valid'] and true_event
        g['pnl_usdc']+=pnl;g['positions']+=1
        if basis is not None and basis>0:
            g['basis_usdc']+=basis;g['basis_covered_positions']+=1
        else:g['unpriced_positions']+=1
        first=n(raw.get('first_entry_at')); last=n(raw.get('last_event_at'))
        if first is not None and first>0:
            g['first_entry_ts']=min(g['first_entry_ts'] or first, first)
        if last is not None and last>0:
            g['last_event_ts']=max(g['last_event_ts'] or last,last)
    result=[]
    for v in groups.values():
        basis_complete=(v['unpriced_positions']==0 and v['basis_usdc']>0)
        v['basis_coverage_complete']=basis_complete
        v['pnl_per_entry_cost_pct']=(round(100*v['pnl_usdc']/v['basis_usdc'],3)
                                       if basis_complete else None)
        v['pnl_usdc']=round(v['pnl_usdc'],4)
        result.append(v)
    return result


def bootstrap_lower_bound(values:list[float], reps:int=1000, seed:str=''):
    """Exploratory percentile lower bound for average event PnL (90% bootstrap).
    Not corrected for selecting the best wallet/sector from many candidates.
    """
    if len(values)<30:return None
    h=int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8],'big')
    rng=random.Random(h); count=len(values); means=[]
    for _ in range(reps):
        means.append(sum(values[rng.randrange(count)] for j in range(count))/count)
    means.sort()
    return round(means[int(.05*(reps-1))],4)


def sector_report(db, wallet:str|None=None, *, min_events:int=0):
    events=event_ledger(db,wallet)
    full={r['wallet']:dict(r) for r in db.execute('SELECT wallet,closed_exhausted FROM wallets')}
    groups=defaultdict(list)
    for event in events:groups[(event['wallet'],event['sector'])].append(event)
    out=[]
    for (w,sector),group in groups.items():
        identifiable=[v for v in group if v['event_identifier_valid']]
        if len(identifiable)<min_events:continue
        pnls=[v['pnl_usdc'] for v in identifiable]
        wins=[x for x in pnls if x>0];losses=[x for x in pnls if x<0]
        gross_win=sum(wins);gross_loss=sum(losses)
        all_positions=sum(v['positions'] for v in group)
        confirmed=sum(v['positions'] for v in group if v['sector_source'] in ('Gamma (tags)','Classification manuelle'))
        eligible=[v for v in identifiable if v['basis_coverage_complete']]
        # Don't advertise an ROI on an incomplete basis. We only offer an
        # event-level cost-basis efficiency when every event cost is covered.
        full_cost=len(eligible)==len(identifiable) and len(identifiable)>0
        cost=sum(v['basis_usdc'] for v in eligible)
        cost_ratio=round(100*sum(v['pnl_usdc'] for v in eligible)/cost,3) if full_cost and cost>0 else None
        concentration=round(100*max(wins)/gross_win,1) if gross_win>0 else None
        closed_complete=bool(full.get(w,{}).get('closed_exhausted'))
        bound=bootstrap_lower_bound(pnls,seed=w+'|'+sector) if closed_complete and len(identifiable)>=30 else None
        out.append({'wallet':w,'secteur':sector,'pnl_usdc':round(sum(x['pnl_usdc'] for x in group),2),
            'evenements_distincts':len(identifiable),'evenements_sans_id':len(group)-len(identifiable),
            'positions_cloturees':all_positions,'evenements_gagnants':len(wins),'evenements_perdants':len(losses),
            'taux_evenements_gagnants_pct':round(100*len(wins)/len(identifiable),1) if identifiable else None,
            'gain_brut_usdc':round(gross_win,2),'perte_brute_usdc':round(gross_loss,2),
            'gain_moyen_par_evenement_usdc':round(statistics.mean(pnls),3) if pnls else None,
            'gain_median_par_evenement_usdc':round(statistics.median(pnls),3) if pnls else None,
            'part_du_plus_gros_gain_pct':concentration,
            'cout_entree_couverture_pct':round(100*len(eligible)/len(identifiable),1) if identifiable else None,
            'pnl_sur_cout_entree_pct_pas_roi_capital':cost_ratio,
            'part_classification_fiable_pct':round(100*confirmed/all_positions,1) if all_positions else None,
            'borne_basse_moyenne_evenement_usdc_exploratoire':bound,
            'historique_clos_terminé':closed_complete,
            'qualite':'Étude indicative' if not closed_complete or len(identifiable)<30 else 'Échantillon analysable (non validé hors période)'})
    return out


def wallet_fingerprint(db, wallet:str):
    """Observable behavior only; trades are not assumed to be independent bets."""
    rows=db.execute('SELECT timestamp,side,price,size,event_key FROM trades WHERE wallet=?',(wallet,)).fetchall()
    counts=Counter(); days=set(); prices=[]; buy_prices=[]; money=0.; buys=sells=0
    for r in rows:
        d=utc_day(r['timestamp'])
        if d:days.add(d)
        s=str(r['side'] or '').upper();buys+=s=='BUY';sells+=s=='SELL'
        p=n(r['price']);sz=n(r['size'])
        if p is not None and 0<=p<=1:
            prices.append(p)
            if s=='BUY':buy_prices.append(p)
            if sz is not None and sz>=0:money+=p*sz
        if d:counts[d]+=1
    first=min(days) if days else None; last=max(days) if days else None
    span=(datetime.fromisoformat(last)-datetime.fromisoformat(first)).days+1 if first and last else None
    return {'wallet':wallet,'trades_observes':len(rows),'achats':buys,'ventes':sells,
        'part_achats_pct':round(100*buys/(buys+sells),1) if buys+sells else None,
        'jours_actifs_observes':len(days),'periode_entre_premier_et_dernier_jour':span,
        'trades_par_jour_actif':round(len(rows)/len(days),2) if days else None,
        'prix_mediane':round(statistics.median(prices),4) if prices else None,
        'part_achats_prix_sous_20_pct':round(100*sum(v<.2 for v in buy_prices)/len(buy_prices),1) if buy_prices else None,
        'notionnel_trades_observes_usdc':round(money,2),
        'premier_jour':first,'dernier_jour':last}


def short_list(db, *, sector:str|None=None, minimum:int=30, only_complete:bool=True,
               max_concentration:float=60.0, min_classification:float=75.0):
    """List eligible for manual review, not a proof of profit or tradable edge."""
    x=sector_report(db,min_events=minimum)
    return sorted((row for row in x if (not sector or row['secteur']==sector)
                   and (not only_complete or row['historique_clos_terminé'])
                   and row['part_du_plus_gros_gain_pct'] is not None
                   and row['part_du_plus_gros_gain_pct'] <= max_concentration
                   and (row['part_classification_fiable_pct'] or 0)>=min_classification),
                  key=lambda row:(row['borne_basse_moyenne_evenement_usdc_exploratoire'] is not None,
                      row['borne_basse_moyenne_evenement_usdc_exploratoire'] or -1e99,
                      row['pnl_usdc']),reverse=True)


def wallet_roi_report(db, wallet: str | None = None) -> list[dict]:
    """Cost-weighted historical returns, NOT bankroll/capital ROI.

    Each position is counted once. Closed and open snapshots must both be complete
    before a global return is published. A missing, zero, or invalid cost suppresses
    the ratio rather than biasing the estimate toward a profit-only survivor.
    """
    query='SELECT wallet,name,closed_exhausted,open_exhausted FROM wallets'
    params=()
    if wallet:
        query+=' WHERE wallet=?';params=(wallet,)
    wallets={r['wallet']:dict(r) for r in db.execute(query,params)}
    sums={w:{'closed_positions':0,'open_positions':0,'closed_cost_usdc':0.,
             'open_cost_usdc':0.,'closed_pnl_usdc':0.,'open_pnl_usdc':0.,
             'missing_closed':0,'missing_open':0,'bad_closed':0,'bad_open':0,'events':set(),
             'open_events':set()} for w in wallets}
    for row in db.execute('SELECT wallet,event_key,realized_pnl,raw_json FROM positions' +
                          (' WHERE wallet=?' if wallet else ''),params):
        w=row['wallet']; g=sums.get(w)
        if g is None:continue
        g['closed_positions']+=1
        if row['event_key']:g['events'].add(row['event_key'])
        try:r=json.loads(row['raw_json'])
        except (TypeError,ValueError):r={}
        cost=n(r.get('total_cost_usdc'));pnl=n(row['realized_pnl'])
        if check_position(r):g['bad_closed']+=1
        if cost is None or cost<=0 or pnl is None:g['missing_closed']+=1
        else:g['closed_cost_usdc']+=cost;g['closed_pnl_usdc']+=pnl
    for row in db.execute('SELECT wallet,event_key,total_pnl,realized_pnl,unrealized_pnl,raw_json FROM open_positions'+
                          (' WHERE wallet=?' if wallet else ''),params):
        w=row['wallet'];g=sums.get(w)
        if g is None:continue
        g['open_positions']+=1
        if row['event_key']:g['open_events'].add(row['event_key'])
        try:r=json.loads(row['raw_json'])
        except (TypeError,ValueError):r={}
        cost=n(r.get('total_cost_usdc'));pnl=n(row['total_pnl'])
        if check_position(r,held=True):g['bad_open']+=1
        if pnl is None:
            realized=n(row['realized_pnl']);unrealized=n(row['unrealized_pnl'])
            if realized is not None and unrealized is not None:pnl=realized+unrealized
        if cost is None or cost<=0 or pnl is None:g['missing_open']+=1
        else:g['open_cost_usdc']+=cost;g['open_pnl_usdc']+=pnl
    results=[]
    for w,meta in wallets.items():
        g=sums[w]
        cl_complete=bool(meta['closed_exhausted'])
        op_complete=bool(meta['open_exhausted'])
        cl_ok=cl_complete and g['closed_positions']>0 and g['missing_closed']==0 and g['bad_closed']==0 and g['closed_cost_usdc']>0
        full_ok=cl_complete and op_complete and g['missing_closed']==0 and g['missing_open']==0 and g['bad_closed']==0 and g['bad_open']==0 and g['closed_cost_usdc']+g['open_cost_usdc']>0
        realized_roi=100*g['closed_pnl_usdc']/g['closed_cost_usdc'] if cl_ok else None
        all_cost=g['closed_cost_usdc']+g['open_cost_usdc']
        all_pnl=g['closed_pnl_usdc']+g['open_pnl_usdc']
        results.append({
            'wallet':w,'name':meta['name'],
            'roi_mises_cloturees_pct':round(realized_roi,3) if realized_roi is not None else None,
            # A held position may have realized profits from already-sold shares,
            # while total_cost_usdc covers only *remaining* inventory. The ratio
            # would overstate lifetime ROI. Requires reconstructed cash-flow ledger.
            'roi_mises_global_pct':None,
            'pnl_cloture_usdc':round(g['closed_pnl_usdc'],2) if cl_ok else None,
            'cout_cloture_usdc':round(g['closed_cost_usdc'],2) if cl_ok else None,
            'pnl_positions_global_usdc':round(all_pnl,2) if full_ok else None,
            'cout_positions_global_usdc':round(all_cost,2) if full_ok else None,
            'evenements_clotures':len(g['events']),'evenements_ouverts':len(g['open_events']),
            'positions_cloturees':g['closed_positions'],'positions_ouvertes':g['open_positions'],
            'couts_manquants_clotures':g['missing_closed'],
            'incoherences_positions_cloturees':g['bad_closed'],
            'incoherences_positions_ouvertes':g['bad_open'],
            'couts_manquants_ouvertes':g['missing_open'],
            'historique_cloture_complet':cl_complete,
            'positions_ouvertes_completes':op_complete,
            'roi_capital_reel_pct':None,  # deposits, withdrawals and reinvestment require a ledger
            'roi_global_reason':'Coût des positions ouvertes ≠ coût total des achats historiques ; ledger requis',
        })
    return results
