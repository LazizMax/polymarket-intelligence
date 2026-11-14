"""Parallel, bounded historical ingestion. Public read-only API requests.

Discovery/fast path is intentionally shallow; an incomplete sample is never reported
as fully audited. SQLite writes happen on the main thread only.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import time
import requests
from research import API
from historical_db import open_db, merge_wallet, latest_trade_ts, upsert_market, import_runs, WALLET
from historical_discovery import find_wallets,save_discovery

GAMMA='https://gamma-api.polymarket.com'
VALID_SLUG=re.compile(r'^[a-z0-9][a-z0-9-]{0,199}$')


def atomic_json(path:Path, payload:dict):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp')
    temp.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    temp.replace(path)


def fetch_wallet(wallet:str, first_ts:float|None, is_complete:bool, *, mode:str='rapide', pages:int=50)->dict:
    """Network fetch only, safe in worker threads. Cursor pages stay sequential per feed."""
    fast=mode=='rapide'
    start=max(1,int(first_ts-2*86400)) if is_complete and first_ts else 1
    # Conservative parallelism is across independent wallets, never within a cursor chain.
    api=API(wait=0.04, retries=3)
    result={'wallet':wallet,'collected_utc':datetime.now(timezone.utc).isoformat(),
            'datasets':{},'failures':{}}
    requests_simple=[('stats','/v2/user-stats',{'user':wallet}),
                     ('volume','/v2/user-volume',{'user':wallet}),
                     ('pnl_series','/v2/user-pnl',{'user':wallet,'interval':'all','fidelity':'1d'})]
    for name,path,params in requests_simple:
        try:result['datasets'][name]=api.fetch(path,**params)[0]
        except Exception as error:result['failures'][name]=str(error)
    paged=[('closed','/v2/positions',{'user':wallet,'status':'CLOSED'},3 if fast else pages),
           ('open','/v2/positions',{'user':wallet,'status':'OPEN','include_archived':True},1 if fast else min(pages,30)),
           ('trades','/v2/trades',{'user':wallet,'start':start,'taker_only':False},2 if fast else pages)]
    for name,path,params,budget in paged:
        try:result['datasets'][name]=api.pages(path,params,max_pages=budget,size=500,kind='feed' if name=='trades' else 'positions')
        except Exception as error:result['failures'][name]=str(error)
    result['requested_mode']=mode
    return result


def gamma_enrich(db,max_events:int=0):
    """Optional category enrichment; deliberately *not* part of default fast scan."""
    if max_events<=0:return {'events_requested':0,'events_saved':0,'errors':[]}
    slugs=[r[0] for r in db.execute('''SELECT DISTINCT event_slug FROM
        (SELECT event_slug FROM trades UNION ALL SELECT event_slug FROM positions)
        WHERE event_slug IS NOT NULL AND event_slug!='' AND event_slug NOT IN (SELECT event_key FROM market_tags)
        LIMIT ?''',(max_events,)) if VALID_SLUG.fullmatch(r[0])]
    good=0; errors=[];session=requests.Session()
    for slug in slugs:
        try:
            response=session.get(GAMMA+'/events/slug/'+slug,timeout=20,headers={'Accept':'application/json'})
            if response.status_code==429:
                delay=response.headers.get('Retry-After','2')
                try:time.sleep(min(12,max(1,float(delay))))
                except ValueError:time.sleep(2)
                response=session.get(GAMMA+'/events/slug/'+slug,timeout=20)
            response.raise_for_status(); obj=response.json()
            if isinstance(obj,dict):
                upsert_market(db,slug,obj.get('tags') or [],str(obj.get('title') or ''))
                good+=1
        except Exception as error:errors.append(slug+': '+str(error)[:100])
    return {'events_requested':len(slugs),'events_saved':good,'errors':errors}


def execute(db, wallets:list[str], *, status:Path, stop:Path, mode:str, pages:int, workers:int, progress:dict, messages:list[str]):
    if not wallets:return
    workers=min(6,max(1,workers))
    items=[]
    for wallet in wallets:
        if not WALLET.fullmatch(wallet):
            messages.append('Wallet invalide : '+wallet[:50]);continue
        old=db.execute('SELECT trade_exhausted FROM wallets WHERE wallet=?',(wallet,)).fetchone()
        latest=latest_trade_ts(db,wallet)
        items.append((wallet,latest,bool(old and old['trade_exhausted'] and latest)))
    progress.update(total=len(items),completed=0,phase=f'Collecte {mode} · {workers} workers',
                    requested_wallets=len(items))
    atomic_json(status,progress)
    # Bound memory: request up to workers wallets at once, then merge their records before next batch.
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for offset in range(0,len(items),workers):
            if stop.exists():progress['state']='canceled';break
            batch=items[offset:offset+workers]
            futures={executor.submit(fetch_wallet,w,ts,complete,mode=mode,pages=pages):w
                     for w,ts,complete in batch}
            for future in as_completed(futures):
                wallet=futures[future]
                try:
                    record=future.result()
                    try:c=db.execute('SELECT name FROM wallet_candidates WHERE wallet=?',(wallet,)).fetchone()
                    except Exception:c=None
                    result=merge_wallet(db,record,name=str(c[0] or '') if c else '',source='collecte '+mode)
                    errors=list(record['failures'])
                    if errors:messages.append(wallet[:10]+' · flux en erreur: '+', '.join(errors))
                    else:messages.append(wallet[:10]+f" · +{result.get('new_trades',0)} trades · {mode}")
                except Exception as error:
                    messages.append('Échec '+wallet[:10]+': '+str(error)[:180])
                    progress['wallet_errors']=progress.get('wallet_errors',0)+1
                progress['completed']+=1
                progress['wallet']=wallet
                progress['messages']=messages[-25:]
                atomic_json(status,progress)


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('--db',required=True)
    parser.add_argument('--status',required=True)
    parser.add_argument('--wallets',nargs='*',default=[])
    parser.add_argument('--mode',choices=['rapide','approfondi'],default='rapide')
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--pages',type=int,default=50)
    parser.add_argument('--gamma-limit',type=int,default=0)
    parser.add_argument('--import-folder')
    parser.add_argument('--discover',type=int,default=0)
    parser.add_argument('--board-pages',type=int,default=1)
    parser.add_argument('--control-pages',type=int,default=1)
    args=parser.parse_args(argv)
    status=Path(args.status);stop=status.with_suffix('.stop');stop.unlink(missing_ok=True)
    progress={'state':'running','started_utc':datetime.now(timezone.utc).isoformat(),
              'completed':0,'total':0,'wallet_errors':0,'mode':args.mode,
              'phase':'Démarrage','messages':[]}
    atomic_json(status,progress)
    db=open_db(args.db);messages=[]
    try:
        if args.import_folder:
            progress['phase']='Import des collectes précédentes';atomic_json(status,progress)
            def importing(done,total,name):
                progress.update(completed=done,total=total,wallet=name)
                atomic_json(status,progress)
            result=import_runs(db,args.import_folder,on_progress=importing)
            messages.append('Import: '+json.dumps(result,ensure_ascii=False)[:350])
        wallets=list(dict.fromkeys(str(w).lower() for w in args.wallets))
        if args.discover>0:
            progress.update(phase='Recherche des wallets sur les classements');atomic_json(status,progress)
            # The discovery API itself is serial but performed only once per scan.
            discovery=find_wallets(API(wait=.05,retries=2),board_pages=args.board_pages,
                                   control_pages=args.control_pages)
            saved=save_discovery(db,discovery)
            messages.append(f'{saved} wallets trouvés · {len(discovery["errors"])} sources indisponibles')
            messages+=discovery['errors'][-4:]
            fresh=[w for w in discovery['ordered'] if not db.execute('SELECT 1 FROM wallets WHERE wallet=?',(w,)).fetchone()]
            old=[w for w in discovery['ordered'] if w not in fresh]
            wallets=list(dict.fromkeys(wallets+(fresh+old)[:args.discover]))
        execute(db,wallets,status=status,stop=stop,mode=args.mode,pages=args.pages,
                workers=args.workers,progress=progress,messages=messages)
        if progress['state']!='canceled' and args.gamma_limit:
            progress.update(phase='Classification des événements',messages=messages[-20:]);atomic_json(status,progress)
            enriched=gamma_enrich(db,args.gamma_limit)
            messages.append(f"Catégories : {enriched['events_saved']}/{enriched['events_requested']}")
            messages+=enriched['errors'][-5:]
        if progress['state']!='canceled':
            progress['state']='completed' if progress['wallet_errors']==0 else 'partial'
    except Exception as error:
        progress['state']='failed';messages.append('Erreur générale : '+repr(error))
    finally:
        progress.update(phase='Terminé',finished_utc=datetime.now(timezone.utc).isoformat(),messages=messages[-25:])
        atomic_json(status,progress)
        db.close()
    return 0 if progress['state'] in ('completed','partial') else 1

if __name__=='__main__':sys.exit(main())
