"""Historical wallet intelligence database for Polymarket (offline-friendly).

Research only. Daily changes are cumulative economic-PnL changes, NOT event profits.
Categories based on Gamma tags when available, otherwise explicitly heuristic.
"""
from __future__ import annotations
import hashlib
import json
import math
import re
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
from collections import defaultdict
from strategy import category as heuristic_category

SCHEMA_VERSION = 2
DB_FILENAME = 'historique.sqlite'
WALLET = re.compile(r'^0x[0-9a-f]{40}$')


def n(v: Any) -> float | None:
    if v is None or isinstance(v, bool) or v == '': return None
    try:
        v = float(v)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError, OverflowError): return None


def utc_day(v: Any) -> str | None:
    f = n(v)
    if f is None or f <= 0: return None
    try: return datetime.fromtimestamp(f,timezone.utc).date().isoformat()
    except (ValueError, OverflowError, OSError): return None


def stable_hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj,sort_keys=True,ensure_ascii=False,separators=(',',':'),default=str).encode()).hexdigest()


def open_db(path: str | Path) -> sqlite3.Connection:
    path = Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    db = sqlite3.connect(str(path),timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA busy_timeout=30000')
    db.executescript('''
    CREATE TABLE IF NOT EXISTS wallets (
        wallet TEXT PRIMARY KEY, name TEXT, first_seen_utc TEXT, last_refresh_utc TEXT,
        volume_usdc REAL, official_trade_count INTEGER, data_source TEXT,
        trade_exhausted INTEGER DEFAULT 0, closed_exhausted INTEGER DEFAULT 0,
        pnl_fidelity TEXT, errors TEXT DEFAULT '', profile_utc TEXT
    );
    CREATE TABLE IF NOT EXISTS trades (
        wallet TEXT NOT NULL, record_key TEXT NOT NULL, timestamp REAL, event_key TEXT,
        event_slug TEXT, condition_id TEXT, title TEXT, side TEXT, price REAL, size REAL,
        raw_json TEXT NOT NULL, PRIMARY KEY(wallet,record_key)
    );
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_timestamp ON trades(wallet,timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_event ON trades(event_key);
    CREATE TABLE IF NOT EXISTS positions (
        wallet TEXT NOT NULL, record_key TEXT NOT NULL, event_key TEXT, event_slug TEXT,
        condition_id TEXT, title TEXT, realized_pnl REAL, first_entry REAL,
        last_event REAL, raw_json TEXT NOT NULL,
        PRIMARY KEY(wallet,record_key)
    );
    CREATE INDEX IF NOT EXISTS idx_positions_event ON positions(event_key);
    CREATE TABLE IF NOT EXISTS open_positions (
        wallet TEXT NOT NULL, record_key TEXT NOT NULL, event_key TEXT, title TEXT,
        realized_pnl REAL, unrealized_pnl REAL, total_pnl REAL, raw_json TEXT NOT NULL,
        PRIMARY KEY(wallet,record_key)
    );
    CREATE INDEX IF NOT EXISTS idx_open_positions_wallet ON open_positions(wallet);
    CREATE TABLE IF NOT EXISTS pnl_points (
        wallet TEXT NOT NULL, timestamp REAL NOT NULL, economic_pnl REAL,
        realized_pnl REAL, settled_pnl REAL, position_pnl REAL, source_fidelity TEXT,
        PRIMARY KEY(wallet,timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_pnl_wallet_time ON pnl_points(wallet,timestamp);
    CREATE TABLE IF NOT EXISTS market_tags (
        event_key TEXT PRIMARY KEY, category TEXT NOT NULL, category_source TEXT NOT NULL,
        tags TEXT, event_title TEXT, updated_utc TEXT
    );
    CREATE TABLE IF NOT EXISTS import_log (
        source_path TEXT PRIMARY KEY, imported_utc TEXT, status TEXT,
        wallets_seen INTEGER, added_trades INTEGER, note TEXT
    );
    ''')
    # Safe additive migration: existing V1.8.1 SQLite files remain usable.
    cols={r[1] for r in db.execute('PRAGMA table_info(wallets)').fetchall()}
    if 'open_exhausted' not in cols:
        db.execute('ALTER TABLE wallets ADD COLUMN open_exhausted INTEGER DEFAULT 0')
    db.commit()
    return db


def dataset_rows(record: dict, name: str) -> list[dict]:
    v=(record.get('datasets') or {}).get(name) or {}
    return [x for x in v.get('rows',[]) if isinstance(x,dict)] if isinstance(v,dict) else []


def choose_event(x: dict) -> tuple[str,str,str]:
    slug=str(x.get('event_slug') or '').strip()
    condition=str(x.get('condition_id') or x.get('conditionId') or '').strip().lower()
    eid=str(x.get('event_id') or '').strip()
    # Do not join arbitrary distinct positions solely on title.
    return slug or eid or condition,slug,condition


def pos_key(x: dict) -> str:
    event,_,condition=choose_event(x)
    tok=str(x.get('token_id') or x.get('asset') or '')
    outcome=str(x.get('outcome_index') if x.get('outcome_index') is not None else x.get('outcome') or '')
    if (tok or condition) and (event or tok):
        return stable_hash({'token':tok,'condition':condition,'event':event,'outcome':outcome})
    return stable_hash(x)


def source_points(data: dict) -> list[dict]:
    d=data.get('pnl_series')
    return [x for x in d.get('points',[]) if isinstance(x,dict)] if isinstance(d,dict) else []


def merge_wallet(db: sqlite3.Connection, record: dict, name: str='', source: str='snapshot') -> dict:
    """Atomic merge. Trades deduplicate; complete closed snapshot replaces older one.

    Partial closed feeds are not used to erase existing snapshots, to avoid data loss.
    Wallet-level current metadata only advances if the incoming collection is newer.
    """
    wallet=str(record.get('wallet') or '').lower()
    if not WALLET.fullmatch(wallet): raise ValueError('wallet invalide')
    d=record.get('datasets') or {}
    if not isinstance(d,dict): raise ValueError('datasets invalides')
    at=str(record.get('collected_utc') or datetime.now(timezone.utc).isoformat())
    old=db.execute('SELECT * FROM wallets WHERE wallet=?',(wallet,)).fetchone()
    meta_new=old is None or not old['profile_utc'] or at>=old['profile_utc']
    vol=d.get('volume') or {}
    if not isinstance(vol,dict):vol={}
    trade_data=d.get('trades') or {}
    closed_data=d.get('closed') or {}
    open_data=d.get('open') or {}
    tr_ex=bool(trade_data.get('exhausted')) if isinstance(trade_data,dict) else False
    cl_ex=bool(closed_data.get('exhausted')) if isinstance(closed_data,dict) else False
    op_ex=bool(open_data.get('exhausted')) if isinstance(open_data,dict) else False
    series=d.get('pnl_series') or {}
    fidelity=str(series.get('source_fidelity') or '') if isinstance(series,dict) else ''
    with db:
        if old is None:
            db.execute('INSERT INTO wallets(wallet,name,first_seen_utc) VALUES(?,?,?)',(wallet,name,at))
        if meta_new:
            db.execute('''UPDATE wallets SET name=COALESCE(NULLIF(?,''),name), last_refresh_utc=?,
                volume_usdc=COALESCE(?,volume_usdc),official_trade_count=COALESCE(?,official_trade_count),
                data_source=?,trade_exhausted=COALESCE(?,trade_exhausted),
                closed_exhausted=COALESCE(?,closed_exhausted),open_exhausted=COALESCE(?,open_exhausted),
                pnl_fidelity=COALESCE(NULLIF(?,''),pnl_fidelity),errors=?,profile_utc=? WHERE wallet=?''',(
                name,at,n(vol.get('volume_usdc')),int(n(vol.get('trade_count'))) if n(vol.get('trade_count')) is not None else None,source,
                int(tr_ex) if isinstance(trade_data,dict) and 'rows' in trade_data else None,
                int(cl_ex) if isinstance(closed_data,dict) and 'rows' in closed_data else 0,
                int(op_ex) if isinstance(open_data,dict) and 'rows' in open_data else 0,fidelity,
                ', '.join(sorted((record.get('failures') or {}).keys())),at,wallet))
        before=db.total_changes
        for t in dataset_rows(record,'trades'):
            k=stable_hash(t)   # full-fill fingerprint: safe against collapsing multiple fills in same transaction
            event,slug,condition=choose_event(t)
            db.execute('''INSERT OR IGNORE INTO trades(wallet,record_key,timestamp,event_key,event_slug,condition_id,title,side,price,size,raw_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)''',(wallet,k,n(t.get('timestamp')),event,slug,condition,
                str(t.get('title') or t.get('question') or ''),str(t.get('side') or '').upper(),
                n(t.get('price')),n(t.get('size')),json.dumps(t,ensure_ascii=False)))
        inserted=db.total_changes-before
        existing=db.execute('SELECT COUNT(*) FROM positions WHERE wallet=?',(wallet,)).fetchone()[0]
        # Only replace with a newer fully paged snapshot, or fill an empty table with provisional data.
        if (meta_new and cl_ex) or existing==0:
            db.execute('DELETE FROM positions WHERE wallet=?',(wallet,))
            for p in dataset_rows(record,'closed'):
                event,slug,condition=choose_event(p)
                db.execute('''INSERT OR REPLACE INTO positions(wallet,record_key,event_key,event_slug,condition_id,title,realized_pnl,first_entry,last_event,raw_json)
                    VALUES(?,?,?,?,?,?,?,?,?,?)''',(wallet,pos_key(p),event,slug,condition,
                    str(p.get('title') or p.get('question') or ''),n(p.get('realized_pnl')),
                    n(p.get('first_entry_at')),n(p.get('last_event_at')),json.dumps(p,ensure_ascii=False)))
        old_open=db.execute('SELECT COUNT(*) FROM open_positions WHERE wallet=?',(wallet,)).fetchone()[0]
        if (meta_new and op_ex) or old_open==0:
            db.execute('DELETE FROM open_positions WHERE wallet=?',(wallet,))
            for p in dataset_rows(record,'open'):
                event,_,_=choose_event(p)
                db.execute('''INSERT OR REPLACE INTO open_positions
                    (wallet,record_key,event_key,title,realized_pnl,unrealized_pnl,total_pnl,raw_json)
                    VALUES(?,?,?,?,?,?,?,?)''',(
                    wallet,pos_key(p),event,str(p.get('title') or p.get('question') or ''),
                    n(p.get('realized_pnl')),n(p.get('unrealized_pnl')),
                    n(p.get('total_pnl')),json.dumps(p,ensure_ascii=False)))
        for p in source_points(d):
            ts=n(p.get('timestamp'))
            if ts is None: continue
            db.execute('''INSERT INTO pnl_points(wallet,timestamp,economic_pnl,realized_pnl,settled_pnl,position_pnl,source_fidelity)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet,timestamp) DO UPDATE SET
                economic_pnl=excluded.economic_pnl,realized_pnl=excluded.realized_pnl,
                settled_pnl=excluded.settled_pnl,position_pnl=excluded.position_pnl,source_fidelity=excluded.source_fidelity
                WHERE ? = 1''',(
                    wallet,ts,n(p.get('economic_pnl')),n(p.get('realized_pnl')),n(p.get('settled_pnl')),
                    n(p.get('position_pnl')),fidelity,int(meta_new)))
    return {'wallet':wallet,'new_trades':inserted,'closed_snapshot_exhausted':cl_ex,'trades_exhausted':tr_ex}


def import_runs(db: sqlite3.Connection, path: str|Path, on_progress=None) -> dict:
    base=Path(path).expanduser().resolve()
    if not base.is_dir(): raise ValueError('Le dossier source est introuvable.')
    paths = ([base] if (base/'manifest.json').is_file() else
             sorted(p for p in base.iterdir() if p.is_dir() and (p/'manifest.json').is_file()))
    if not paths: raise ValueError('Aucune collecte contenant manifest.json.')
    total, added, errors, attempted=0,0,[],0
    progress_total=sum(len(list((run/'wallets').glob('0x*.json'))) for run in paths if (run/'wallets').is_dir())
    for run in paths:
        manifest=json.loads((run/'manifest.json').read_text(encoding='utf-8'))
        lookups={str(c.get('wallet') or '').lower():str(c.get('name') or '')
                 for c in manifest.get('selected_candidates',[]) if isinstance(c,dict)}
        files=sorted((run/'wallets').glob('0x*.json')) if (run/'wallets').is_dir() else []
        # Never assume a run has a complete list of wallets.
        for file in files:
            try:
                rec=json.loads(file.read_text(encoding='utf-8'))
                result=merge_wallet(db,rec,lookups.get(str(rec.get('wallet') or '').lower(),''),source='import historique')
                total+=1;added+=result['new_trades']
            except (ValueError,KeyError,TypeError,OSError) as ex:
                errors.append(f'{file.name}: {str(ex)[:120]}')
            finally:
                attempted+=1
                if on_progress: on_progress(attempted, progress_total, file.name)
        with db:
            db.execute('''INSERT INTO import_log(source_path,imported_utc,status,wallets_seen,added_trades,note)
                VALUES(?,?,?,?,?,?) ON CONFLICT(source_path) DO UPDATE SET imported_utc=excluded.imported_utc,
                status=excluded.status,wallets_seen=excluded.wallets_seen,added_trades=excluded.added_trades,note=excluded.note''',(
                    str(run),datetime.now(timezone.utc).isoformat(),'ok' if not errors else 'avec erreurs',len(files),added,'; '.join(errors[-5:])))
    return {'wallet_snapshots_processed':total,'new_trade_records':added,'errors':errors,
            'runs_processed':len(paths)}


TAG_RULES=[
 ('Sport',re.compile(r'\b(sports?|nba|nfl|mlb|nhl|soccer|football|basketball|tennis|ufc|esports?|cricket|formula ?1|f1|motorsport|hockey|baseball)\b',re.I)),
 ('Politique',re.compile(r'\b(politics?|elections?|us politics|world politics|government|congress|presidency|parliament)\b',re.I)),
 ('Crypto',re.compile(r'\b(crypto|bitcoin|ethereum|solana|defi|memecoin|digital assets)\b',re.I)),
 ('Économie',re.compile(r'\b(economics?|finance|fed|inflation|interest rates|macroeconomics?|stocks|markets)\b',re.I)),
 ('Culture / Tech',re.compile(r'\b(entertainment|culture|music|movies?|television|celebrity|technology|tech|ai|science|gaming)\b',re.I)),
]


def gamma_sector(tags: list[dict|str]) -> tuple[str,str]:
    text=' '.join(str(x.get('label') or x.get('slug') or '') if isinstance(x,dict) else str(x) for x in tags)
    found=[label for label,rx in TAG_RULES if rx.search(text)]
    return (found[0],'Gamma (tags)') if len(found)==1 else ('Non classé','Gamma (ambigu / non reconnu)')


def upsert_market(db:sqlite3.Connection,event_key:str,tags:list,event_title:str='',override:str|None=None):
    if not event_key: return
    cat,source=(override,'Classification manuelle') if override else gamma_sector(tags)
    with db:
        db.execute('''INSERT INTO market_tags(event_key,category,category_source,tags,event_title,updated_utc)
            VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET category=excluded.category,
            category_source=excluded.category_source,tags=excluded.tags,event_title=excluded.event_title,
            updated_utc=excluded.updated_utc''',(event_key,cat,source,json.dumps(tags,ensure_ascii=False),
            event_title,datetime.now(timezone.utc).isoformat()))


def classify(db: sqlite3.Connection, key: str, title: str) -> tuple[str,str]:
    if key:
        row=db.execute('SELECT category,category_source FROM market_tags WHERE event_key=?',(key,)).fetchone()
        if row: return row['category'],row['category_source']
    c=heuristic_category(title)
    return ('Non classé','Indisponible') if c in ('Indéterminée','Ambiguë') else (c,'Estimation par mots-clés')


def wallet_summaries(db:sqlite3.Connection) -> list[dict]:
    rows=db.execute('''SELECT w.*, (SELECT COUNT(*) FROM trades t WHERE t.wallet=w.wallet) AS trades_imported,
          (SELECT COUNT(DISTINCT event_key) FROM positions p WHERE p.wallet=w.wallet AND event_key!='') AS closed_events,
          (SELECT SUM(realized_pnl) FROM positions p WHERE p.wallet=w.wallet) AS closed_pnl,
          (SELECT COUNT(DISTINCT event_key) FROM trades t WHERE t.wallet=w.wallet AND event_key!='') AS traded_events,
          (SELECT economic_pnl FROM pnl_points v WHERE v.wallet=w.wallet ORDER BY timestamp DESC LIMIT 1) AS economic_pnl,
          (SELECT realized_pnl FROM pnl_points v WHERE v.wallet=w.wallet ORDER BY timestamp DESC LIMIT 1) AS realized_pnl
          FROM wallets w ORDER BY w.wallet''').fetchall()
    return [dict(r) for r in rows]


def sector_rows(db:sqlite3.Connection, wallet: str|None=None) -> list[dict]:
    sql='SELECT wallet,event_key,title,realized_pnl FROM positions WHERE realized_pnl IS NOT NULL'
    params=()
    if wallet: sql+=' AND wallet=?';params=(wallet,)
    grouped={}; cache={}
    for r in db.execute(sql,params):
        key=r['event_key'] or ''
        if key not in cache:cache[key]=classify(db,key,r['title'] or '')
        cat,source=cache[key]
        k=(r['wallet'],cat)
        g=grouped.setdefault(k,{'wallet':r['wallet'],'secteur':cat,'positions':0,'pnl_usdc':0.,
                                'events':set(),'provisional_count':0,'wins':0,'losses':0})
        pnl=n(r['realized_pnl'])
        if pnl is None: continue
        g['positions']+=1;g['pnl_usdc']+=pnl
        if key:g['events'].add(key)
        if source not in ('Gamma (tags)','Classification manuelle'):g['provisional_count']+=1
        if pnl>0:g['wins']+=1
        elif pnl<0:g['losses']+=1
    result=[]
    for v in grouped.values():
        v['evenements_distincts']=len(v.pop('events'))
        v['part_classement_estime_pct']=round(100*v['provisional_count']/v['positions'],1) if v['positions'] else None
        v['pnl_usdc']=round(v['pnl_usdc'],2)
        v['taux_positions_gagnantes_pct']=round(100*v['wins']/v['positions'],1) if v['positions'] else None
        result.append(v)
    return result


def event_rows(db:sqlite3.Connection,wallet: str|None=None) -> list[dict]:
    sql='SELECT wallet,event_key,title,realized_pnl FROM positions WHERE realized_pnl IS NOT NULL'
    param=()
    if wallet:sql+=' AND wallet=?';param=(wallet,)
    groups={}; cache={}
    for r in db.execute(sql,param):
        event=r['event_key'] or 'Sans identifiant'
        k=(r['wallet'],event)
        if event not in cache:cache[event]=classify(db,r['event_key'] or '',r['title'] or '')
        cat,source=cache[event]
        g=groups.setdefault(k,{'wallet':r['wallet'],'evenement':event,'titre':r['title'] or event,
                                'secteur':cat,'source_secteur':source,'positions':0,'pnl_usdc':0})
        g['positions']+=1;g['pnl_usdc']+=n(r['realized_pnl']) or 0
    return [{**v,'pnl_usdc':round(v['pnl_usdc'],2)} for v in groups.values()]


def daily_points(db:sqlite3.Connection, wallet: str|None=None) -> list[dict]:
    sql='SELECT wallet,timestamp,economic_pnl,realized_pnl,source_fidelity FROM pnl_points WHERE economic_pnl IS NOT NULL'
    args=()
    if wallet:sql+=' AND wallet=?';args=(wallet,)
    sql+=' ORDER BY wallet,timestamp'
    daily={}
    for x in db.execute(sql,args):
        date=utc_day(x['timestamp'])
        if date:
            daily[(x['wallet'],date)]={'wallet':x['wallet'],'jour_utc':date,'pnl_economique_cumul':x['economic_pnl'],
               'pnl_realise_cumul':x['realized_pnl'],'fidelite_source':x['source_fidelity']}
    prev={};out=[]
    for (w,date),v in sorted(daily.items()):
        last=prev.get(w)
        if last:
            gap=(datetime.fromisoformat(date)-datetime.fromisoformat(last['jour_utc'])).days
            v['jours_depuis_precedent_point']=gap
            v['variation_economique_usdc']=round(v['pnl_economique_cumul']-last['pnl_economique_cumul'],2) if gap==1 else None
            if gap>1:v['variation_periode_non_journaliere_usdc']=round(v['pnl_economique_cumul']-last['pnl_economique_cumul'],2)
        else:
            v['jours_depuis_precedent_point']=None;v['variation_economique_usdc']=None
        out.append(v);prev[w]=v
    return out


def periods(db:sqlite3.Connection,window:int,asof:str|None=None) ->list[dict]:
    all_points=daily_points(db)
    end=asof or (max((r['jour_utc'] for r in all_points),default=None))
    if not end:return []
    base=(datetime.fromisoformat(end)-timedelta(days=window)).date().isoformat()
    grouped=defaultdict(dict)
    for p in all_points:grouped[p['wallet']][p['jour_utc']]=p
    result=[]
    for w,m in grouped.items():
        endrow=m.get(end);startrow=m.get(base)
        if not endrow or not startrow:continue
        result.append({'wallet':w,'periode_jours':window,'fin_utc':end,'debut_utc':base,
            'variation_economique_usdc':round(endrow['pnl_economique_cumul']-startrow['pnl_economique_cumul'],2),
            'metrique':'Variation PnL économique (positions, récompenses possibles)'})
    return result


def coverage(db:sqlite3.Connection)->dict:
    return {
       'wallets':db.execute('SELECT COUNT(*) FROM wallets').fetchone()[0],
       'trades':db.execute('SELECT COUNT(*) FROM trades').fetchone()[0],
       'closed_positions':db.execute('SELECT COUNT(*) FROM positions').fetchone()[0],
       'pnl_points':db.execute('SELECT COUNT(*) FROM pnl_points').fetchone()[0],
       'gamma_events':db.execute('SELECT COUNT(*) FROM market_tags WHERE category_source=?',('Gamma (tags)',)).fetchone()[0],
       'complete_trade_histories':db.execute('SELECT COUNT(*) FROM wallets WHERE trade_exhausted=1').fetchone()[0],
       'complete_closed_histories':db.execute('SELECT COUNT(*) FROM wallets WHERE closed_exhausted=1').fetchone()[0],
    }


def latest_trade_ts(db:sqlite3.Connection,wallet:str) -> float | None:
    row=db.execute('SELECT MAX(timestamp) FROM trades WHERE wallet=?',(wallet,)).fetchone()
    return n(row[0]) if row else None


def trade_sectors(db:sqlite3.Connection, wallet:str|None=None) -> list[dict]:
    """Observed trading focus (volume from price * shares, not official portfolio turnover)."""
    sql='SELECT wallet,event_key,title,side,price,size FROM trades'
    args=()
    if wallet:sql+=' WHERE wallet=?';args=(wallet,)
    groups={}; cache={}
    for r in db.execute(sql,args):
        event=r['event_key'] or ''
        if event not in cache:cache[event]=classify(db,event,r['title'] or '')
        cat,src=cache[event]
        key=(r['wallet'],cat)
        g=groups.setdefault(key,{'wallet':r['wallet'],'secteur':cat,'trades':0,'achats':0,
                                 'ventes':0,'notionnel_observe_usdc':0.,'evenements':set(),
                                 'classifications_provisoires':0})
        g['trades']+=1
        g['achats']+=int(r['side']=='BUY');g['ventes']+=int(r['side']=='SELL')
        p=n(r['price']);q=n(r['size'])
        if p is not None and q is not None and p>=0 and q>=0:g['notionnel_observe_usdc']+=p*q
        if r['event_key']:g['evenements'].add(r['event_key'])
        if src not in ('Gamma (tags)','Classification manuelle'):g['classifications_provisoires']+=1
    result=[]
    for v in groups.values():
        v['evenements_distincts']=len(v.pop('evenements'))
        v['notionnel_observe_usdc']=round(v['notionnel_observe_usdc'],2)
        v['part_provisoire_pct']=round(100*v['classifications_provisoires']/v['trades'],1) if v['trades'] else None
        result.append(v)
    return result
