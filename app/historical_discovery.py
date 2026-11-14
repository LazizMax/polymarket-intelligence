"""Discover wallets using official Polymarket v2 leaderboards and control sample.

Biased discovery, never a census or unbiased draw of Polymarket users.
"""
from __future__ import annotations
from datetime import datetime, timezone
import json
from collections import defaultdict
from historical_db import WALLET

BOARD_PAIRS = [
    ('overall','all','PNL'),('overall','month','PNL'),('overall','all','VOLUME'),
    ('sports','all','PNL'),('sports','month','PNL'),
    ('politics','all','PNL'),('politics','month','PNL'),
    ('crypto','all','PNL'),('crypto','month','PNL'),
    ('economics','all','PNL'),('culture','all','PNL'),('tech','all','PNL')]


def prepare(db):
    with db:
        db.execute('''CREATE TABLE IF NOT EXISTS wallet_candidates(
            wallet TEXT PRIMARY KEY, name TEXT, source_labels TEXT, first_seen_utc TEXT,
            last_seen_utc TEXT, latest_rank INTEGER, snapshot_pnl_usdc REAL)''')


def find_wallets(api, *, board_pages:int=1, page_size:int=100, control_pages:int=1):
    if not 1<=board_pages<=10:raise ValueError('Budget de pages hors limites')
    if not 1<=page_size<=500:raise ValueError('Taille page hors limites')
    boards={};errors=[];collected={}
    for category, period, order in BOARD_PAIRS:
        label=f'{category}/{period}/{order}'
        try:
            result=api.pages('/v2/leaderboard',{'category':category,'time_period':period,'sort_by':order},
                             max_pages=board_pages,size=page_size,kind='board')
            boards[label]=[]
            for row in result['rows']:
                w=str(row.get('user_id') or '').lower()
                if not WALLET.fullmatch(w):continue
                boards[label].append(w)
                info=collected.setdefault(w,{'wallet':w,'name':'','sources':[],'rank':None,'pnl':None})
                info['name']=str(info['name'] or row.get('user_name') or '')
                if label not in info['sources']:info['sources'].append(label)
                if info['rank'] is None:info['rank']=row.get('rank')
                if info['pnl'] is None:info['pnl']=row.get('pnl')
        except Exception as e:
            errors.append(label+': '+str(e)[:180])
    if control_pages>0:
        try:
            result=api.pages('/v2/trades',{'taker_only':False},max_pages=control_pages,size=page_size,kind='feed')
            sample=sorted({str(x.get('proxy_wallet') or '').lower() for x in result['rows']
                           if WALLET.fullmatch(str(x.get('proxy_wallet') or '').lower())})
            # Recent global fills are NOT a uniform control sample of all accounts.
            label='contrôle/trades récents'
            boards[label]=[]
            for w in sample:
                if w not in collected:
                    collected[w]={'wallet':w,'name':'','sources':[label],'rank':None,'pnl':None}
                    boards[label].append(w)
        except Exception as e:errors.append('Échantillon actif: '+str(e)[:180])
    # Round-robin selection avoids a shortlist entirely dominated by one board.
    selected=[];seen=set();offset={label:0 for label in boards}
    while True:
        progress=False
        for label,accounts in boards.items():
            while offset[label]<len(accounts):
                wallet=accounts[offset[label]];offset[label]+=1
                if wallet not in seen:
                    selected.append(wallet);seen.add(wallet);progress=True
                    break
        if not progress:break
    return {'wallets':collected,'ordered':selected,'errors':errors,'boards':{k:len(v) for k,v in boards.items()}}


def save_discovery(db, discovery):
    prepare(db)
    stamp=datetime.now(timezone.utc).isoformat()
    with db:
        for w,info in discovery['wallets'].items():
            existing=db.execute('SELECT source_labels,first_seen_utc FROM wallet_candidates WHERE wallet=?',(w,)).fetchone()
            prior=json.loads(existing['source_labels']) if existing and existing['source_labels'] else []
            combined=list(dict.fromkeys(prior+info['sources']))
            db.execute('''INSERT INTO wallet_candidates(wallet,name,source_labels,first_seen_utc,last_seen_utc,latest_rank,snapshot_pnl_usdc)
                          VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET
                          name=COALESCE(NULLIF(excluded.name,''),wallet_candidates.name),
                          source_labels=excluded.source_labels,last_seen_utc=excluded.last_seen_utc,
                          latest_rank=excluded.latest_rank,snapshot_pnl_usdc=excluded.snapshot_pnl_usdc''',(
                          w,info['name'],json.dumps(combined,ensure_ascii=False),
                          existing['first_seen_utc'] if existing else stamp,stamp,
                          info['rank'],info['pnl']))
    return len(discovery['wallets'])


def candidates(db, limit:int=500):
    prepare(db)
    return [dict(r) for r in db.execute('''SELECT c.*,w.trade_exhausted,w.closed_exhausted,w.last_refresh_utc
         FROM wallet_candidates c LEFT JOIN wallets w ON w.wallet=c.wallet
         ORDER BY c.last_seen_utc DESC, c.wallet LIMIT ?''',(limit,))]
