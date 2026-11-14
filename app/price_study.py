"""MVP 2.5 — read-only study of *post-trade price changes* for selected wallets.

Never interprets a historical price-series point as a fillable quote. No PnL, no
execution backtest, no orders, no wallet signing. Critical metadata on temporal
resolution is preserved. All HTTP calls use public Polymarket Data API v2.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Any
import hashlib
import json
import math
import random
import statistics
import time

import requests

BASE = "https://data-api.polymarket.com/v2"
MISSING = object()


def safe_number(value: Any) -> float | None:
    try:
        if value is None or value == '' or isinstance(value, bool):
            return None
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError, OverflowError):
        return None


def seconds(value: Any) -> int | None:
    n = safe_number(value)
    if n is None or n <= 0:
        return None
    # Some providers supply milliseconds, documented v2 normally supplies seconds.
    if n > 1e11:
        n /= 1000
    return int(n) if n < 1e11 else None


def atomic_write(path: Path, obj: dict | list):
    path.parent.mkdir(exist_ok=True, parents=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


def read_json(path: Path, fallback=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (ValueError, OSError, UnicodeError):
        return fallback


def source_rows(record: dict) -> list[dict]:
    dataset = record.get('datasets', {}).get('trades', {})
    if not isinstance(dataset, dict):
        return []
    return [row for row in dataset.get('rows', []) if isinstance(row, dict)]


def extract_buy_signals(record: dict, limit: int = 100, cooldown_seconds: int = 3600) -> tuple[list[dict], dict]:
    """Group BUY fills into *candidate* observations; not verified independent orders.

    Uses a tx hash if present. Without hash, groups by token / minute. A cooldown
    limits pseudo-replication from repeating fills for one outcome token.
    """
    raw = source_rows(record)
    groups = {}
    skipped = defaultdict(int)
    sells_by_token = defaultdict(list)
    for item in raw:
        if str(item.get('side') or '').upper() == 'SELL':
            token = str(item.get('token_id') or item.get('asset_id') or '').strip()
            stamp = seconds(item.get('timestamp') or item.get('block_timestamp') or item.get('match_time'))
            px = safe_number(item.get('price'))
            if token and stamp is not None and px is not None and 0 <= px <= 1:
                sells_by_token[token].append((stamp, px))
    for token in sells_by_token: sells_by_token[token].sort()
    for row in raw:
        if str(row.get('side') or '').upper() != 'BUY':
            skipped['not_buy'] += 1
            continue
        token = str(row.get('token_id') or row.get('asset_id') or '').strip()
        ts = seconds(row.get('timestamp') or row.get('block_timestamp') or row.get('match_time'))
        price = safe_number(row.get('price'))
        size = safe_number(row.get('size'))
        if not token or ts is None or price is None or size is None or not (0 < price < 1 and size > 0):
            skipped['missing_token_time_price_size'] += 1
            continue
        txid = str(row.get('transaction_hash') or row.get('transactionHash') or row.get('tx_hash') or '').strip().lower()
        key = (token, txid or f'minute-{ts//60}')
        group = groups.setdefault(key, {'token_id':token,'timestamp':ts,'notional_usdc':0., 'shares':0.,
            'fill_count':0,'event_id':str(row.get('event_id') or row.get('event_slug') or row.get('condition_id') or token),
            'condition_id':str(row.get('condition_id') or ''),
            'title':str(row.get('title') or row.get('event_slug') or row.get('slug') or token)})
        group['timestamp'] = min(group['timestamp'], ts)
        group['notional_usdc'] += price * size
        group['shares'] += size
        group['fill_count'] += 1
    potential=[]
    for group in groups.values():
        group['original_price'] = round(group.pop('notional_usdc') / group['shares'], 7)
        group['shares'] = round(group['shares'], 6)
        potential.append(group)
    potential.sort(key=lambda x:x['timestamp'])
    accepted=[]
    last_by_token={}
    # Keep first group in each hour-long burst (entry-side marker), then choose most recent distinct bursts.
    for signal in potential:
        previous=last_by_token.get(signal['token_id'])
        if previous is not None and signal['timestamp']-previous < cooldown_seconds:
            skipped['cooldown_overlap'] += 1
            continue
        last_by_token[signal['token_id']] = signal['timestamp']
        accepted.append(signal)
    accepted = sorted(accepted, key=lambda x:x['timestamp'], reverse=True)[:limit]
    for i, item in enumerate(accepted):
        # First later SELL on same token is only an activity marker, not a matched exit.
        later = next(((stamp,px) for stamp,px in sells_by_token[item['token_id']]
                      if stamp > item['timestamp']), None)
        item['next_observed_sell_ts'] = later[0] if later else None
        item['next_observed_sell_price'] = later[1] if later else None
        item['next_observed_sell_delay_sec'] = later[0]-item['timestamp'] if later else None
        item['signal_id'] = hashlib.sha256(f"{record.get('wallet')}|{item['token_id']}|{item['timestamp']}".encode()).hexdigest()[:16]
        item['wallet'] = str(record.get('wallet') or '')
    dataset = record.get('datasets', {}).get('trades', {})
    return accepted, {'raw_fill_rows':len(raw),'candidate_groups':len(potential),'signals_selected':len(accepted),
                      'skipped':dict(skipped),'trade_history_exhausted':bool(dataset.get('exhausted')) if isinstance(dataset,dict) else False}


def validate_points(rows: list[dict]) -> list[dict]:
    result={}
    for row in rows:
        if not isinstance(row,dict):continue
        t=seconds(row.get('timestamp'))
        price=safe_number(row.get('price'))
        res=safe_number(row.get('resolution_seconds'))
        if t is None or price is None or res is None or res<0 or res>86400 or not(0<=price<=1):
            continue
        result[(t,int(res))]={'timestamp':t,'price':price,'resolution_seconds':int(res),'observable_not_before':t+int(res)}
    return sorted(result.values(), key=lambda p:(p['observable_not_before'],p['timestamp']))


class PublicPriceAPI:
    def __init__(self, session=None, delay=0.12, max_retries=3):
        self.session = session or requests.Session()
        self.delay=delay
        self.max_retries=max_retries
        self.request_count=0

    def fetch_window(self, token_id: str, start: int, end: int, max_pages: int=12) -> list[dict]:
        if not token_id or start<=0 or end<=start:
            raise ValueError('Invalid token price-history window')
        cursor=None
        seen=set()
        rows=[]
        for _ in range(max_pages):
            params={'token_id':token_id, 'start':start, 'end':end, 'limit':1000}
            if cursor:params['cursor']=cursor
            for attempt in range(self.max_retries+1):
                if self.delay:time.sleep(self.delay)
                try:
                    response=self.session.get(BASE+'/prices-history',params=params,timeout=35,
                                              headers={'Accept':'application/json'})
                    self.request_count += 1
                    if response.status_code in (429,502,503,504) and attempt<self.max_retries:
                        retry=safe_number(response.headers.get('Retry-After'))
                        time.sleep(min(60,retry if retry is not None else 2**attempt))
                        continue
                    response.raise_for_status()
                    value=response.json()
                    if not isinstance(value,dict) or not isinstance(value.get('data'),list) or not isinstance(value.get('pagination'),dict):
                        raise ValueError('Unrecognized v2 price-history response')
                    break
                except (ValueError,requests.RequestException) as ex:
                    if attempt>=self.max_retries or (isinstance(ex,requests.HTTPError) and ex.response is not None
                                                      and ex.response.status_code not in (429,502,503,504)):
                        raise RuntimeError(f'Price history error: {str(ex)[:240]}') from ex
                    time.sleep(min(40,2**attempt))
            rows.extend(value['data'])
            nxt=value['pagination'].get('next_cursor')
            if not nxt:
                if value['pagination'].get('has_more') is True:
                    raise RuntimeError('Pagination inconsistent: has_more but next_cursor missing')
                return validate_points(rows)
            if nxt in seen:
                raise RuntimeError('Repeated pagination cursor')
            seen.add(nxt)
            cursor=nxt
        raise RuntimeError(f'Too many price history pages; stopped at {max_pages}. No partial cache saved.')


def cache_window(cache_dir: Path, api: PublicPriceAPI, token: str, start: int, end: int) -> tuple[list[dict], bool]:
    key=hashlib.sha256(json.dumps([token,start,end]).encode()).hexdigest()[:28]
    target=cache_dir/(key+'.json')
    saved=read_json(target)
    if isinstance(saved,dict) and isinstance(saved.get('data'),list) and saved.get('query') == [token,start,end]:
        return validate_points(saved['data']), True
    data=api.fetch_window(token,start,end)
    atomic_write(target,{'query':[token,start,end], 'collected_utc':datetime.now(timezone.utc).isoformat(),
                         'source':'https://data-api.polymarket.com/v2/prices-history', 'data':data})
    return data, False


def reference_after(points: list[dict], target: int, max_wait_sec: int, *, max_resolution: int | None=None) -> dict | None:
    """First completed point at/after requested timestamp, never a later point disguised as earlier.

    No price point is a firm executable bid/ask; it is a markout reference.
    """
    for p in points:
        available = p['observable_not_before']
        if available < target: continue
        if max_wait_sec >= 0 and available-target > max_wait_sec: return None
        if max_resolution is not None and p['resolution_seconds'] > max_resolution:
            # Don't use a 5m candle to claim a 30s copy.
            continue
        return p
    return None


def reference_before(points: list[dict], target: int, max_staleness: int=1800) -> dict | None:
    eligible=[p for p in points if p['observable_not_before']<=target and target-p['observable_not_before']<=max_staleness]
    return eligible[-1] if eligible else None


def analyze_signal(signal: dict, points: list[dict], lags=(30,300,900), horizons=(3600,21600,86400)) -> dict:
    """Compute indicative post-detection *markouts*, NOT profits, fills or executable quotes."""
    t=signal['timestamp']
    baseline=reference_before(points,t,max_staleness=7200)
    row={**signal,'price_points':len(points), 'price_before':baseline['price'] if baseline else None,
         'pre_price_resolution_sec':baseline['resolution_seconds'] if baseline else None,'scenarios':[]}
    for lag in lags:
        # The selected point must be finished and no more coarse than the presumed delay;
        # also refuse to advance execution indefinitely to the next day.
        entry=reference_after(points,t+lag,max_wait_sec=max(lag,120),max_resolution=lag)
        for horizon in horizons:
            item={'latency_seconds':lag,'horizon_seconds':horizon,'proxy_available':False,
                  'reason':'historique trop peu précis ou manquant', 'copy_price_proxy':None,
                  'mark_price_proxy':None,'gross_markout_per_share':None}
            if not entry or not (0 < entry['price'] < 1):
                row['scenarios'].append(item);continue
            # Fixed holding horizon starts at the candidate copy-reference time.
            # If only a post-resolution settlement point exists it may show here; not a tradable exit.
            target=entry['observable_not_before']+horizon
            exit_p=reference_after(points,target,max_wait_sec=max(600,horizon//12),max_resolution=min(1800,horizon))
            if not exit_p or not (0 < exit_p['price'] < 1):
                item['reason']='pas de valorisation intermédiaire : cours manquant ou prix de règlement (0/1)'
                row['scenarios'].append(item);continue
            item.update(proxy_available=True,reason='prix historiques indicatifs, exécution NON vérifiée',
                        copy_price_proxy=entry['price'],mark_price_proxy=exit_p['price'],
                        copy_reference_ts=entry['observable_not_before'],mark_reference_ts=exit_p['observable_not_before'],
                        actual_lag_seconds=entry['observable_not_before']-t,
                        entry_resolution_seconds=entry['resolution_seconds'],exit_resolution_seconds=exit_p['resolution_seconds'],
                        gross_markout_per_share=round(exit_p['price']-entry['price'],7))
            row['scenarios'].append(item)
    return row


def scenario_summary(signals: list[dict], lag: int, horizon: int, fee_bps=0, slippage_bps=0) -> dict:
    """Descriptive markout sensitivity. No PnL/ROI/copy-profit claims."""
    valid=[]
    grouped=defaultdict(list)
    for signal in signals:
        for case in signal.get('scenarios',[]):
            if case.get('latency_seconds')!=lag or case.get('horizon_seconds')!=horizon or not case.get('proxy_available'):
                continue
            entry=case['copy_price_proxy']
            exit_price=case['mark_price_proxy']
            if not entry or entry <= 0 or exit_price is None: continue
            assumed_cost=(fee_bps+slippage_bps)/10000*(entry+exit_price)
            net=exit_price-entry-assumed_cost
            event=signal.get('event_id') or signal.get('condition_id') or signal['token_id']
            obj={'wallet':signal['wallet'],'signal_id':signal['signal_id'],'event':event,
                 'token_id':signal['token_id'],'date':datetime.fromtimestamp(signal['timestamp'],timezone.utc).isoformat(),
                 'original_price':signal['original_price'],'copy_price_proxy':entry,'mark_price_proxy':exit_price,
                 'gross_markout_per_share':round(exit_price-entry,6),'net_sensitivity_per_share':round(net,6),
                 'net_sensitivity_pct_entry':round(net/entry*100,3),'resolution_at_copy_sec':case['entry_resolution_seconds'],
                 'actual_lag_seconds':case['actual_lag_seconds']}
            valid.append(obj)
            grouped[event].append(net)
            break
    event_mean=[statistics.mean(x) for x in grouped.values()]
    return {'signals_available':len(valid),'distinct_events':len(grouped),'average_net_markout_per_share':round(statistics.mean(event_mean),6) if event_mean else None,
            'events_with_positive_average':sum(x>0 for x in event_mean),'event_positive_fraction':round(sum(x>0 for x in event_mean)/len(event_mean),4) if event_mean else None,
            'rows':valid,'signals_missing':len(signals)-len(valid),
            'methodology':'Only indicative historical markout, not an execution backtest or expected ROI. Cost assumptions are hypothetical.'}


def run_study(folder: Path, wallets: list[str], max_signals: int=35, *, progress: Callable[[int,int,str],None] | None=None,
              cancel: Callable[[],bool] | None=None, api: PublicPriceAPI | None=None, now_ts: int | None=None) -> dict:
    """Save raw market snapshots, signal studies, quality status. Never alter old wallet data."""
    now_ts=now_ts or int(time.time())
    api=api or PublicPriceAPI()
    candidates=[]
    selected_meta=[]
    for wallet in wallets:
        record=read_json(folder/'wallets'/(wallet+'.json'))
        if not isinstance(record,dict):continue
        signals,meta=extract_buy_signals(record,limit=max_signals)
        # Only analyze trades with enough post-event elapsed time for 24-hour horizon.
        # Recent cases remain visible but may have no complete markout.
        candidates.extend(signals)
        selected_meta.append({'wallet':wallet, **meta})
    candidates.sort(key=lambda x:(x['wallet'],x['timestamp']))
    if not candidates:
        raise ValueError('Aucun signal BUY exploitable : collecte vide ou schéma incompatible.')
    cache_dir=folder/'price_cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    by_window=defaultdict(list)
    # One fixed 48h window per token/calendar two-day bucket (reduces duplicate calls).
    # Coverage: 6h before first trade, 26h after, round ends to fixed 2-day slots.
    for sig in candidates:
        start=(sig['timestamp']//172800)*172800-21600
        end=min(now_ts, start+172800+21600+86400)  # ~3.25 days at most
        if end <= start: continue
        by_window[(sig['token_id'],start,end)].append(sig)
    output=[]
    errors=[]
    total=len(by_window)
    for index,((token,start,end),items) in enumerate(by_window.items(),start=1):
        if cancel and cancel():
            raise InterruptedError('Analyse annulée avant la fin; aucun rapport partiel publié.')
        if progress: progress(index,total,f'Prix de {token[:13]}… ({len(items)} signaux)')
        try:
            points,cache_hit=cache_window(cache_dir,api,token,start,end)
            for signal in items:
                analyzed=analyze_signal(signal,points)
                analyzed['cache_hit']=cache_hit
                analyzed['requested_window_start']=start
                analyzed['requested_window_end']=end
                output.append(analyzed)
        except Exception as ex:
            errors.append({'token':token,'window_start':start,'window_end':end,'error':str(ex)[:300]})
            for signal in items:
                output.append({**signal,'price_points':0,'scenarios':[],'error':str(ex)[:200]})
    report={'generated_utc':datetime.now(timezone.utc).isoformat(),'source_api':BASE+'/prices-history',
            'wallets_selected':wallets,'selected_wallet_metadata':selected_meta,'signal_count':len(candidates),
            'signals_analyzed':len(output),'windows_queried':total,'api_calls':api.request_count,
            'price_errors':errors,'signals':output,
            'methodology':{'signal':'Recent BUY fill clusters (tx hash or minute) with 1h token cooldown; NOT independent decisions',
                           'prices':'Public v2 price history; per point resolution_seconds used; NEVER an executable order book price',
                           'timing':'Price point only available notionally after timestamp + resolution_seconds; use first later observation',
                           'copy_lags_seconds':[30,300,900],'markout_horizons_seconds':[3600,21600,86400],
                           'caution':'No actual detection timestamp, bid/ask, liquidity, fees, settlement cashflows or realistic fill execution.',
                           'conclusion':'No copytrading profitability inference is valid from this report.'}}
    atomic_write(folder/'price_report.json',report)
    return report
