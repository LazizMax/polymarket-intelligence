"""Polymarket Intelligence MVP 3 — public, read-only prospective monitoring.

Data API v2 wallet trades are POLLED; trade.timestamp is blockchain/source time,
NOT the instant when the fill first became public. Order-book GET snapshots
are recorded only after detection. No private keys or trading methods.
"""
from __future__ import annotations
import hashlib
import json
import math
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from price_study import atomic_write, safe_number, seconds
from research import WALLET_PATTERN

TRADES_URL = 'https://data-api.polymarket.com/v2/trades'
BOOK_URL = 'https://clob.polymarket.com/book'
HORIZONS = (60, 300, 900, 3600)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_trade_id(trade: dict, wallet: str) -> str:
    # The public data feed does not expose a guaranteed per-fill trade ID.
    # Exact same-looking fills may collide; clearly disclosed in UI.
    keys = ['transaction_hash', 'timestamp', 'token_id', 'side', 'price', 'size', 'condition_id']
    values = [wallet.lower()] + [str(trade.get(k, '')) for k in keys]
    return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()


def normalized(trade: dict, wallet: str) -> dict | None:
    if not isinstance(trade, dict): return None
    token = str(trade.get('token_id') or '').strip()
    timestamp = seconds(trade.get('timestamp'))
    price, size = safe_number(trade.get('price')), safe_number(trade.get('size'))
    side = str(trade.get('side') or '').upper()
    if not token or timestamp is None or price is None or size is None or side not in ('BUY','SELL') or not (0 < price < 1 and size > 0):
        return None
    return {'id':stable_trade_id(trade, wallet), 'wallet':wallet.lower(), 'timestamp':timestamp,
            'side':side,'price':price,'size':size,'token_id':token,
            'tx_hash':str(trade.get('transaction_hash') or ''),
            'title':str(trade.get('title') or trade.get('slug') or ''),
            'event_slug':str(trade.get('event_slug') or ''),
            'condition_id':str(trade.get('condition_id') or ''), 'source':trade}


def levels(book: dict, side: str) -> list[tuple[float,float]]:
    raw = book.get('asks' if side=='BUY' else 'bids') or []
    out=[]
    for x in raw:
        p,s=safe_number(x.get('price')),safe_number(x.get('size'))
        if p is not None and s is not None and 0<p<1 and s>0:out.append((p,s))
    return sorted(out,key=lambda a:a[0],reverse=(side=='SELL'))


def book_metrics(book: dict) -> dict:
    bid=levels(book,'SELL');ask=levels(book,'BUY')
    return {'best_bid':bid[0][0] if bid else None, 'best_ask':ask[0][0] if ask else None,
            'spread':round(ask[0][0]-bid[0][0],8) if bid and ask else None,
            'book_timestamp':book.get('timestamp'), 'hash':book.get('hash'),
            'ask_levels':len(ask), 'bid_levels':len(bid)}


def buy_quote(book: dict, budget: float, fee_bps: float=0) -> dict:
    """Depth VWAP for a *full* hypothetical spend, fee estimated separately."""
    if not (0<budget<=1000000):return {'status':'invalid_budget'}
    remaining=budget; shares=0.; levels_used=0
    for p,s in levels(book,'BUY'):
        amount=min(remaining,p*s)
        shares += amount/p
        remaining -= amount
        levels_used+=1
        if remaining <= max(1e-7,budget*1e-9):break
    if remaining > max(1e-7,budget*1e-9) or shares<=0:
        return {'status':'insufficient_depth','fillable_budget_usdc':round(budget-remaining,6),
                'requested_budget_usdc':budget}
    return {'status':'full_quote','shares':shares,'vwap':budget/shares,'entry_cost_usdc':budget,
            'entry_fee_assumed_usdc':budget*fee_bps/10000,'levels_used':levels_used}


def sell_quote(book: dict, shares: float, fee_bps: float=0) -> dict:
    if shares<=0:return {'status':'invalid_shares'}
    remaining=shares;proceeds=0.;count=0
    for p,s in levels(book,'SELL'):
        take=min(remaining,s); proceeds += take*p; remaining-=take;count+=1
        if remaining<=max(1e-7,shares*1e-9):break
    if remaining>max(1e-7,shares*1e-9):
        return {'status':'insufficient_depth','fillable_shares':shares-remaining,'requested_shares':shares}
    return {'status':'full_quote','proceeds_usdc':proceeds,'vwap':proceeds/shares,
            'sell_fee_assumed_usdc':proceeds*fee_bps/10000,'levels_used':count}


class PublicFeed:
    def __init__(self, session=None):self.session=session if session is not None else requests.Session()
    def get_json(self,url,params):
        for attempt in range(4):
            try:
                response=self.session.get(url,params=params,headers={'Accept':'application/json'},timeout=15)
                if response.status_code in (429,502,503,504) and attempt<3:
                    delay=safe_number(response.headers.get('Retry-After'))
                    time.sleep(min(15,delay if delay is not None else 2**attempt)); continue
                response.raise_for_status();return response.json()
            except (requests.RequestException,ValueError) as ex:
                if attempt>=3 or (isinstance(ex,requests.HTTPError) and ex.response is not None and ex.response.status_code not in (429,502,503,504)):
                    raise RuntimeError(f'{url}: {str(ex)[:220]}') from ex
                time.sleep(min(10,2**attempt))
        raise RuntimeError('No response')
    def trades(self,wallet:str,start:int, max_pages:int=5)->tuple[list[dict],bool]:
        rows=[];cursor=None; seen=set(); exhaustive=False
        for page in range(max_pages):
            query={'user':wallet,'limit':200,'start':max(1,start),'taker_only':'false'}
            if cursor:query['cursor']=cursor
            result=self.get_json(TRADES_URL,query)
            if not isinstance(result,dict) or not isinstance(result.get('data'),list) or not isinstance(result.get('pagination'),dict):
                raise RuntimeError('Unexpected /v2/trades response')
            rows.extend(result['data']);pagination=result['pagination']; nxt=pagination.get('next_cursor')
            if not nxt:
                exhaustive=True;break
            if nxt in seen:raise RuntimeError('Repeated trades cursor')
            seen.add(nxt);cursor=nxt
            # Trade feed is newest-first, cursor-based; cap is deliberate safety limit.
        return rows,exhaustive
    def book(self,token:str)->dict:
        result=self.get_json(BOOK_URL,{'token_id':token})
        if not isinstance(result,dict) or 'bids' not in result or 'asks' not in result:
            raise RuntimeError('Unexpected CLOB order book')
        return result


def connect(path:Path)->sqlite3.Connection:
    path.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path, timeout=15)
    db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA busy_timeout=8000')
    db.executescript('''
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, wallet TEXT, trade_timestamp INTEGER, detected_ts REAL,
      side TEXT, token_id TEXT, title TEXT, event_slug TEXT, condition_id TEXT, tx_hash TEXT,
      source_price REAL, size REAL, source_json TEXT, book_json TEXT,
      book_requested_ts REAL, book_received_ts REAL, quote_json TEXT,
      quote_status TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_wallet ON signals(wallet,detected_ts);
    CREATE TABLE IF NOT EXISTS evaluations (
      signal_id TEXT, horizon_s INTEGER, observed_ts REAL,
      sell_quote_json TEXT, bid_book_json TEXT,
      paper_pnl_assumed_usdc REAL, status TEXT,
      PRIMARY KEY (signal_id,horizon_s)
    );
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wall_time REAL, wallet TEXT, rows INTEGER,
      exhausted INTEGER, duration_s REAL, error TEXT
    );
    ''')
    db.commit();return db


def save_signal(db:sqlite3.Connection,trade:dict, detected_at:float,quote:dict,book:dict|None,
                before:float|None,after:float|None,error:str|None)->bool:
    c=db.execute('INSERT OR IGNORE INTO signals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
       (trade['id'],trade['wallet'],trade['timestamp'],detected_at,trade['side'],trade['token_id'],
        trade['title'],trade['event_slug'],trade['condition_id'],trade['tx_hash'],trade['price'],trade['size'],
        json.dumps(trade['source']),json.dumps(book) if book else None,before,after,
        json.dumps(quote),quote.get('status'),error))
    db.commit();return bool(c.rowcount)


def is_recorded(db:sqlite3.Connection,identifier:str)->bool:
    return db.execute('SELECT 1 FROM signals WHERE id=?',(identifier,)).fetchone() is not None


def due_evaluations(db:sqlite3.Connection,now:float,cap:int=12)->list[dict]:
    rows=db.execute('''SELECT s.id,s.token_id,s.quote_json,s.detected_ts,h.horizon
      FROM signals s CROSS JOIN (SELECT 60 AS horizon UNION ALL SELECT 300 UNION ALL SELECT 900 UNION ALL SELECT 3600) h
      LEFT JOIN evaluations e ON e.signal_id=s.id AND e.horizon_s=h.horizon
      WHERE s.side='BUY' AND s.quote_status='full_quote'
        AND s.detected_ts+h.horizon<=? AND e.signal_id IS NULL
      ORDER BY s.detected_ts+h.horizon LIMIT ?''',(now,cap)).fetchall()
    return [{'id':x[0],'token_id':x[1],'quote':json.loads(x[2]),'detected_ts':x[3],'horizon':x[4]} for x in rows]


def write_evaluation(db,signal,book,observed,fee_bps,error=None):
    entry=signal['quote'];status='quote_error' if error else 'no_book';pnl=None; sell={}
    if book is not None and not error:
        sell=sell_quote(book,entry['shares'],fee_bps)
        status=sell.get('status','unknown')
        if status=='full_quote':
            pnl=(sell['proceeds_usdc'] - sell['sell_fee_assumed_usdc']
                 - entry['entry_cost_usdc'] - entry.get('entry_fee_assumed_usdc',0))
    if error:sell={'error':str(error)[:230]}
    db.execute('INSERT OR IGNORE INTO evaluations VALUES (?,?,?,?,?,?,?)',
               (signal['id'],signal['horizon'],observed,json.dumps(sell),json.dumps(book) if book else None,pnl,status))
    db.commit()


def run(config:dict,folder:Path,feed:PublicFeed|None=None,clock=time.time,sleep=time.sleep,max_cycles:int|None=None):
    feed=feed or PublicFeed();folder.mkdir(parents=True,exist_ok=True)
    wallets=[x.lower().strip() for x in config['wallets']]
    if not wallets or len(wallets)>20 or any(not WALLET_PATTERN.fullmatch(w) for w in wallets):
        raise ValueError('Select 1 to 20 valid addresses')
    interval=int(config.get('poll_seconds',20));budget=float(config.get('paper_budget_usdc',50))
    fee=float(config.get('fee_bps',0))
    if not (10<=interval<=300 and 1<=budget<=10000 and 0<=fee<=1000):
        raise ValueError('Bad monitoring configuration')
    db=connect(folder/'live.sqlite');started=float(clock())
    config={**config,'wallets':wallets,'started_epoch':started,'mode':'read_only','fee_bps':fee}
    atomic_write(folder/'config.json',config)
    errors=0;polls=0;signals=0;warnings=[]
    def emit(state,detail=''):
        atomic_write(folder/'live_status.json',{'state':state,'detail':detail,'updated_utc':utc_now(),
            'started_epoch':started,'wallets':wallets,'polls':polls,'signals':signals,
            'errors':errors,'warnings':warnings[-12:], 'poll_seconds':interval})
    emit('running','Initialisation : les trades antérieurs au démarrage ne seront pas traités.')
    try:
        cycles=0
        while not (folder/'stop.requested').exists():
            cycles+=1
            if max_cycles is not None and cycles>max_cycles:break
            cycle_start=float(clock())
            for wallet in wallets:
                t0=float(clock());err=None;rows=[];complete=False
                try:
                    # Window overlaps run-start, but events preceding it are baseline only.
                    rows,complete=feed.trades(wallet,int(started)-60)
                    if not complete and 'Pagination cap reached' not in warnings:
                        warnings.append('Pagination cap reached: high-frequency wallets may have gaps.')
                    # Dedup by fingerprint; use source transaction timestamp with explicit caveat.
                    for raw in sorted(rows,key=lambda x:seconds(x.get('timestamp')) or 0):
                        trade=normalized(raw,wallet)
                        if not trade or trade['timestamp'] < started:continue
                        if is_recorded(db,trade['id']):continue
                        detected=float(clock());book=None;before=None;after=None;error=None
                        if detected-trade['timestamp']>600:
                            quote={'status':'late_detection','reason':'Trade over 10 minutes old at detection'}
                        else:
                            before=float(clock())
                            try:
                                book=feed.book(trade['token_id'])
                                quote=buy_quote(book,budget,fee) if trade['side']=='BUY' else {'status':'exit_observed_no_paper_short'}
                                quote.update(book_metrics(book))
                            except Exception as ex:
                                error=str(ex)[:240];quote={'status':'book_error'}
                            after=float(clock())
                        if save_signal(db,trade,detected,quote,book,before,after,error):signals+=1
                except Exception as ex:
                    err=str(ex)[:260];errors+=1
                checks_time=float(clock())
                db.execute('INSERT INTO checks(wall_time,wallet,rows,exhausted,duration_s,error) VALUES(?,?,?,?,?,?)',
                           (checks_time,wallet,len(rows),int(complete),checks_time-t0,err));db.commit()
                polls+=1
            for due in due_evaluations(db,float(clock())):
                book=None;error=None;observed=float(clock())
                try:
                    book=feed.book(due['token_id']);observed=float(clock())
                except Exception as ex:error=str(ex)
                write_evaluation(db,due,book,observed,fee,error)
            emit('running',f'{polls} contrôles · {signals} nouveaux signaux · prochain passage dans {interval}s')
            if max_cycles is not None and cycles>=max_cycles:break
            sleep(max(0.0,interval-(float(clock())-cycle_start)))
        emit('stopped','Surveillance arrêtée ; historique conservé.')
    except Exception as exc:
        errors+=1;emit('failed',str(exc)[:240]);raise
    finally:db.close()


def read_dashboard(folder:Path)->dict:
    dbfile=folder/'live.sqlite'
    if not dbfile.exists():return {'signals':[],'evaluations':[],'checks':[]}
    with sqlite3.connect(f'file:{dbfile.as_posix()}?mode=ro',uri=True,timeout=5) as db:
        db.row_factory=sqlite3.Row
        signals=[dict(r) for r in db.execute('''SELECT wallet,trade_timestamp,detected_ts,side,token_id,title,event_slug,source_price,size,
                 quote_status,quote_json,book_requested_ts,book_received_ts,error
                 FROM signals ORDER BY detected_ts DESC LIMIT 500''').fetchall()]
        evaluations=[dict(r) for r in db.execute('''SELECT e.horizon_s,e.observed_ts,e.paper_pnl_assumed_usdc,e.status,s.wallet,s.event_slug,s.title
                 FROM evaluations e JOIN signals s ON s.id=e.signal_id ORDER BY e.observed_ts DESC LIMIT 1000''').fetchall()]
        checks=[dict(r) for r in db.execute('SELECT * FROM checks ORDER BY id DESC LIMIT 500').fetchall()]
    for s in signals:
        q=json.loads(s.pop('quote_json') or '{}');s.update({f'book_{k}':v for k,v in q.items() if k in ('best_bid','best_ask','spread')})
        s['delay_source_to_detection_s']=round(s['detected_ts']-s['trade_timestamp'],2)
        s['http_book_duration_s']=round(s['book_received_ts']-s['book_requested_ts'],3) if s['book_requested_ts'] and s['book_received_ts'] else None
    return {'signals':signals,'evaluations':evaluations,'checks':checks}
