#!/usr/bin/env python3
"""Polymarket wallet research (v1.1) — read-only collection and cautious audit.

Requires Python 3.10+ and `requests`. No API keys or trading endpoints.
"""
from __future__ import annotations
import argparse
import csv
import json
import math
import random
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import requests

BASE = 'https://data-api.polymarket.com'
WALLET_PATTERN = re.compile(r'^0x[0-9a-fA-F]{40}$')
BOARDS = [('all', 'PNL'), ('all', 'VOLUME'), ('month', 'PNL'), ('week', 'PNL')]


def finite(v: Any) -> float | None:
    try:
        if v is None or isinstance(v, bool) or v == '':
            return None
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError, OverflowError):
        return None


def iso(seconds: Any) -> str | None:
    n = finite(seconds)
    if n is None or n <= 0:
        return None
    try:
        return datetime.fromtimestamp(n, tz=timezone.utc).isoformat()
    except (ValueError, OverflowError):
        return None


def get_num(d: dict, key: str):
    return finite(d.get(key)) if isinstance(d, dict) else None


def json_out(path: Path, data: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


def write_csv(path: Path, rows: list[dict], columns: list[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for row in rows:
            writer.writerow({k: "'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@')) else v for k, v in row.items()})


class API:
    def __init__(self, session=None, wait=.18, retries=4):
        self.session = session if session is not None else requests.Session()
        self.wait, self.retries, self.calls = wait, retries, 0

    def fetch(self, path: str, **params):
        for attempt in range(self.retries + 1):
            if self.wait:
                time.sleep(self.wait)
            try:
                response = self.session.get(BASE + path, params=params, headers={'Accept':'application/json'}, timeout=30)
                self.calls += 1
                if response.status_code in (429, 502, 503, 504) and attempt < self.retries:
                    delta = finite(response.headers.get('Retry-After'))
                    time.sleep(min(90, delta if delta is not None else 2 ** attempt))
                    continue
                response.raise_for_status()
                obj = response.json()
                if not isinstance(obj, dict) or 'data' not in obj:
                    raise ValueError(f'Bad response envelope at {path}')
                return obj['data'], obj.get('pagination')
            except (requests.RequestException, ValueError) as ex:
                if attempt == self.retries or (isinstance(ex, requests.HTTPError) and ex.response is not None and ex.response.status_code not in (429,502,503,504)):
                    raise RuntimeError(f'{path}: {str(ex)[:250]}') from ex
                time.sleep(min(90, 2 ** attempt))
        raise RuntimeError(f'{path}: all attempts exhausted')

    def pages(self, path: str, filters: dict, *, max_pages: int, size: int = 500, kind='feed'):
        rows, seen_tokens, cursor = [], set(), None
        pages = 0
        for _ in range(max_pages):
            if cursor is None:
                params = {**filters, 'limit': size}
            elif kind == 'board':
                params = {'cursor': cursor}
            else:
                params = {**filters, 'cursor': cursor}
            if kind == 'positions' and cursor is not None:
                params['user'] = filters['user']
            data, page = self.fetch(path, **params)
            if not isinstance(data, list) or not isinstance(page, dict):
                raise RuntimeError(f'{path}: expected list data and pagination')
            rows.extend(data)
            pages += 1
            following = page.get('next_cursor')
            if not following:
                if page.get('has_more') is True:
                    raise RuntimeError(f'{path}: pagination inconsistency')
                return {'rows': rows, 'pages': pages, 'exhausted': True, 'next_cursor': None}
            if following in seen_tokens:
                raise RuntimeError(f'{path}: repeated cursor')
            seen_tokens.add(following)
            cursor = following
        return {'rows': rows, 'pages': pages, 'exhausted': False, 'next_cursor': cursor}


def read_controls(path: str | None) -> list[str]:
    if not path:
        return []
    raw = Path(path).read_text(encoding='utf-8').splitlines()
    rows = [line.split('#')[0].strip().lower() for line in raw]
    invalid = [w for w in rows if w and not WALLET_PATTERN.fullmatch(w)]
    if invalid:
        raise ValueError(f'Invalid control wallet address: {invalid[0]}')
    return list(dict.fromkeys(w for w in rows if w))


def select_candidates(boards: dict[str, list[dict]], count: int, controls: list[str]):
    pool: dict[str, dict] = {}
    for key, rows in boards.items():
        for row in rows:
            wallet = str(row.get('user_id') or '').lower()
            if not WALLET_PATTERN.fullmatch(wallet):
                continue
            c = pool.setdefault(wallet, {'wallet': wallet, 'name': row.get('user_name') or '', 'sources': []})
            if key not in c['sources']:
                c['sources'].append(key)
            c[f'board_{key}_pnl_usdc'] = get_num(row, 'pnl')
            c[f'board_{key}_volume_shares'] = get_num(row, 'volume')
            c[f'board_{key}_rank'] = get_num(row, 'rank')
    # Preserve representation from each board rather than selecting only all-time PnL leaders.
    labels = [f'{period}_{sort}' for period, sort in BOARDS]
    indices = {key: 0 for key in labels}
    chosen, selected = [], set()
    while len(chosen) < count:
        progressed = False
        for key in labels:
            rows = boards.get(key, [])
            while indices[key] < len(rows):
                entry = rows[indices[key]]
                indices[key] += 1
                wallet = str(entry.get('user_id') or '').lower()
                if wallet in pool and wallet not in selected:
                    chosen.append(pool[wallet]); selected.add(wallet); progressed = True
                    break
            if len(chosen) >= count:
                break
        if not progressed:
            break
    for wallet in controls:
        if wallet not in selected:
            chosen.append(pool.get(wallet, {'wallet': wallet, 'name': '', 'sources': ['control_external']}))
            selected.add(wallet)
    return chosen, len(pool)


def collect_one(api: API, wallet: str, args):
    output = {'wallet': wallet, 'collected_utc': datetime.now(timezone.utc).isoformat(), 'datasets': {}, 'failures': {}}
    simple = [
        ('stats', '/v2/user-stats', {'user':wallet}),
        ('volume', '/v2/user-volume', {'user':wallet}),
        ('pnl_series', '/v2/user-pnl', {'user':wallet, 'interval':'all', 'fidelity':'1d'}),
        ('portfolio_value', '/v2/value', {'user':wallet}),
    ]
    paged = [
        ('trades', '/v2/trades', {'user':wallet, 'start':1, 'taker_only':False}, args.trade_pages, 'feed'),
        ('activity', '/v2/activity', {'user':wallet, 'start':1, 'exclude_deposits_withdrawals':False}, args.activity_pages, 'feed'),
        ('open', '/v2/positions', {'user':wallet, 'status':'OPEN', 'include_archived':True}, args.position_pages, 'positions'),
        ('closed', '/v2/positions', {'user':wallet, 'status':'CLOSED'}, args.position_pages, 'positions'),
        ('combo_activity', '/v2/activity/combos', {'user':wallet}, args.combo_pages, 'feed'),
        ('combo_open', '/v2/positions/combos', {'user':wallet, 'status':'OPEN'}, args.combo_pages, 'feed'),
        ('combo_resolved_win', '/v2/positions/combos', {'user':wallet, 'status':'RESOLVED_WIN'}, args.combo_pages, 'feed'),
        ('combo_resolved_loss', '/v2/positions/combos', {'user':wallet, 'status':'RESOLVED_LOSS'}, args.combo_pages, 'feed'),
        ('combo_resolved_partial', '/v2/positions/combos', {'user':wallet, 'status':'RESOLVED_PARTIAL'}, args.combo_pages, 'feed'),
    ]
    for name, path, filters in simple:
        try:
            data, _ = api.fetch(path, **filters)
            output['datasets'][name] = data
        except Exception as error:
            output['failures'][name] = str(error)
    for name, path, filters, cap, kind in paged:
        try:
            output['datasets'][name] = api.pages(path, filters, max_pages=cap, size=args.page_size, kind=kind)
        except Exception as error:
            output['failures'][name] = str(error)
    return output


def group_bootstrap(groups: list[float], iterations: int=1500, seed: int=146) -> float | None:
    """Exploratory 5th percentile lower bound of per-event mean closed-position PnL."""
    if len(groups) < 30 or any(not math.isfinite(x) for x in groups):
        return None
    rng = random.Random(seed)
    n = len(groups)
    estimates = []
    for _ in range(iterations):
        estimates.append(sum(groups[rng.randrange(n)] for _ in range(n)) / n)
    estimates.sort()
    return round(estimates[int(.05 * len(estimates))], 5)


def summary(record: dict, candidate: dict | None = None):
    d = record.get('datasets', {})
    c = candidate or {'wallet':record.get('wallet', '')}
    s = {'wallet':record.get('wallet', ''), 'name':c.get('name',''), 'sources': '|'.join(c.get('sources', [])), 'collected_utc':record.get('collected_utc')}
    for key in ('all_PNL','all_VOLUME','month_PNL','week_PNL'):
        s[f'board_{key}_rank'] = c.get(f'board_{key}_rank')
        s[f'board_{key}_pnl_usdc'] = c.get(f'board_{key}_pnl_usdc')
    stats = d.get('stats') if isinstance(d.get('stats'), dict) else {}
    vol = d.get('volume') if isinstance(d.get('volume'), dict) else {}
    pnl = d.get('pnl_series') if isinstance(d.get('pnl_series'), dict) else {}
    points = pnl.get('points', []) if isinstance(pnl.get('points', []), list) else []
    points = [p for p in points if isinstance(p, dict) and finite(p.get('timestamp')) is not None]
    points.sort(key=lambda p: finite(p['timestamp']))
    last = points[-1] if points else (stats.get('all_time_pnl') or {})
    if not isinstance(last, dict): last = {}
    s.update(
        official_distinct_markets=get_num(stats, 'trades'),
        official_trade_count=get_num(vol, 'trade_count'),
        volume_usdc=get_num(vol, 'volume_usdc'),
        volume_shares=get_num(vol, 'volume'),
        pnl_last_observation_utc=iso(last.get('timestamp')),
        pnl_last_source_block=get_num(last, 'source_block'),
        economic_pnl_usdc=get_num(last, 'economic_pnl'),
        position_pnl_usdc=get_num(last, 'position_pnl'),
        settled_pnl_usdc=get_num(last, 'settled_pnl'),
        realized_pnl_usdc=get_num(last, 'realized_pnl'),
        realized_market_pnl_usdc=get_num(last, 'realized_market_pnl'),
        realized_combo_pnl_usdc=get_num(last, 'realized_combo_pnl'),
        realized_lp_pnl_usdc=get_num(last, 'realized_lp_pnl'),
        fees_paid_net_usdc=get_num(last, 'fees_paid'),
        source_fidelity=pnl.get('source_fidelity'),
        pnl_points=len(points),
    )
    if s.get('board_all_PNL_pnl_usdc') is not None and s['realized_pnl_usdc'] is not None:
        s['all_time_board_vs_realized_series_gap_usdc'] = round(s['realized_pnl_usdc'] - s['board_all_PNL_pnl_usdc'], 2)
    else:
        s['all_time_board_vs_realized_series_gap_usdc'] = None
    if s['economic_pnl_usdc'] is not None and s['volume_usdc'] is not None and s['volume_usdc'] > 0:
        s['economic_pnl_per_100_usdc_turnover_pct_NOT_ROI'] = round(100 * s['economic_pnl_usdc']/s['volume_usdc'], 4)
    else:
        s['economic_pnl_per_100_usdc_turnover_pct_NOT_ROI'] = None

    for horizon in (30,90):
        # Use a published cumulative point <= horizon start, rather than extrapolating from the latest.
        latest = finite(last.get('timestamp'))
        earlier = [p for p in points if latest is not None and finite(p.get('timestamp')) <= latest-horizon*86400 and get_num(p, 'economic_pnl') is not None]
        s[f'economic_pnl_change_{horizon}d_usdc'] = (round(s['economic_pnl_usdc']-get_num(earlier[-1], 'economic_pnl'),2)
                          if earlier and s['economic_pnl_usdc'] is not None else None)

    essentials = ('trades', 'activity', 'open', 'closed', 'combo_activity', 'combo_open', 'combo_resolved_win', 'combo_resolved_loss', 'combo_resolved_partial')
    for name in essentials:
        dataset = d.get(name)
        s[f'{name}_rows'] = len(dataset.get('rows', [])) if isinstance(dataset, dict) else None
        s[f'{name}_exhausted'] = dataset.get('exhausted') if isinstance(dataset, dict) else False
    trades = d.get('trades', {}).get('rows', []) if isinstance(d.get('trades'), dict) else []
    closed = d.get('closed', {}).get('rows', []) if isinstance(d.get('closed'), dict) else []
    activity = d.get('activity', {}).get('rows', []) if isinstance(d.get('activity'), dict) else []
    s['observed_distinct_markets'] = len({r.get('condition_id') for r in trades if r.get('condition_id')})
    s['observed_distinct_events_proxy'] = len({r.get('event_slug') or r.get('condition_id') for r in trades if (r.get('event_slug') or r.get('condition_id'))})
    timestamps = [finite(t.get('timestamp')) for t in trades if finite(t.get('timestamp')) is not None]
    s['trades_first_utc'] = iso(min(timestamps)) if timestamps else None
    s['trades_last_utc'] = iso(max(timestamps)) if timestamps else None
    s['observed_span_days'] = round((max(timestamps)-min(timestamps))/86400,1) if len(timestamps) > 1 else 0
    s['trade_rows_missing_price_size'] = sum(finite(r.get('price')) is None or finite(r.get('size')) is None for r in trades)
    s['observed_trades_cash_usdc_NOT_CANONICAL_VOLUME'] = round(sum((finite(t.get('size')) or 0)*(finite(t.get('price')) or 0) for t in trades),2)
    types = Counter(str(a.get('type') or 'UNKNOWN') for a in activity)
    s['activity_type_counts'] = json.dumps(dict(sorted(types.items())), ensure_ascii=False)
    s['wallet_dataset_errors'] = '|'.join(sorted(record.get('failures', {}).keys()))
    s['economic_pnl_is_same_as_trading_pnl'] = False
    # Interpret event groups as rough clusters, never as independent bets. A single event may contain related markets.
    grouped: dict[str, float] = defaultdict(float)
    for position in closed:
        p = finite(position.get('realized_pnl'))
        if p is None:
            continue
        group = str(position.get('event_id') or position.get('event_slug') or position.get('condition_id') or '')
        if group:
            grouped[group] += p
    values = list(grouped.values())
    s['closed_event_groups'] = len(values)
    s['closed_event_win_share'] = round(sum(x>0 for x in values)/len(values),4) if values else None
    s['closed_event_bootstrap_lower_mean_usdc_EXPLORATORY'] = group_bootstrap(values)
    positive_sum = sum(max(0, v) for v in values)
    s['closed_largest_positive_event_share_of_gross_winnings'] = round(max([max(v,0) for v in values],default=0)/positive_sum,4) if positive_sum>0 else None
    s['closed_realized_pnl_sum_usdc_DIAGNOSTIC'] = round(sum(finite(p.get('realized_pnl')) or 0 for p in closed),2)
    s['history_rows_exhausted'] = all(s[f'{name}_exhausted'] for name in essentials)
    s['snapshot_complete'] = s['history_rows_exhausted'] and not record.get('failures') and all(k in d for k in ('stats','volume','pnl_series'))
    s['wallet_lifetime_accounting_verified'] = False
    s['copy_trading_usable_profit_estimate'] = None
    s['sampling_warning'] = 'Leaderboard-selected population; no selection-bias correction'
    # Covers at least 30 event groups and 90d observed; still NOT a statistically confirmed edge.
    s['exploratory_candidate'] = bool(s['snapshot_complete'] and s['observed_span_days'] >= 90
        and len(values) >= 30 and s['closed_event_bootstrap_lower_mean_usdc_EXPLORATORY'] is not None
        and s['closed_event_bootstrap_lower_mean_usdc_EXPLORATORY'] > 0)
    return s


def analyze(run_dir: Path):
    manifest_path = run_dir / 'manifest.json'
    if not manifest_path.exists():
        raise FileNotFoundError('manifest.json not found. Run collect first.')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    rows = []
    for c in manifest.get('selected_candidates', []):
        file = run_dir / 'wallets' / (c['wallet']+'.json')
        if file.exists():
            rows.append(summary(json.loads(file.read_text(encoding='utf-8')),c))
    columns = list(dict.fromkeys(k for r in rows for k in r))
    # Keep complete audit rows, including incomplete and unfavorable candidates.
    write_csv(run_dir / 'audit_all_wallets.csv', rows, columns)
    profits = sorted(rows, key=lambda r:(r['realized_pnl_usdc'] is not None, r['realized_pnl_usdc'] if r['realized_pnl_usdc'] is not None else -math.inf),reverse=True)
    write_csv(run_dir / 'ranking_1_realized_pnl.csv', profits, columns)
    quality = sorted(rows, key=lambda r:(r['exploratory_candidate'],r['closed_event_groups'] or 0,r['observed_span_days'] or 0),reverse=True)
    write_csv(run_dir / 'ranking_3_data_and_sample_quality.csv', quality, columns)
    # Efficiency requires minimum 30 event groups, all critical feeds exhausted and actual economic-PnL & USD turnover.
    eligible = [r for r in rows if r['snapshot_complete'] and r['closed_event_groups'] >= 30
        and r['economic_pnl_per_100_usdc_turnover_pct_NOT_ROI'] is not None]
    eligible.sort(key=lambda r: r['economic_pnl_per_100_usdc_turnover_pct_NOT_ROI'],reverse=True)
    write_csv(run_dir / 'ranking_2_turnover_efficiency_exploratory.csv', eligible, columns)
    report = {'analyzed_utc':datetime.now(timezone.utc).isoformat(), 'wallets_analyzed':len(rows),
              'snapshot_complete_count':sum(r['snapshot_complete'] for r in rows),
              'exploratory_candidates':sum(r['exploratory_candidate'] for r in rows),
              'eligible_for_efficiency_ranking':len(eligible), 'confirmed_copyable_wallets':0,
              'confirmed_profitable_copy_strategies':0,
              'limitations':['No on-chain reconciliation, liquidity or fill-execution backtest',
              'Top-of-leaderboard selection bias; add random or losing-wallet control cohorts',
              'Pnl/volume is NOT an ROI on capital',
              'Closed-position cluster bootstrap is exploratory, not selection-corrected statistical proof',
              'Currency and fee fields rely on the API and may be lagged or null',
              'Rows exhausted is not proof of complete lifetime ledger'],
              'rankings':['ranking_1_realized_pnl.csv','ranking_2_turnover_efficiency_exploratory.csv','ranking_3_data_and_sample_quality.csv']}
    json_out(run_dir / 'audit_report.json', report)
    return report


def collect(args):
    run_dir=Path(args.output); run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir/'wallets').mkdir(exist_ok=True)
    api=API(wait=args.delay)
    board_data, statuses = {}, {}
    for period, sort in BOARDS:
        key = period+'_'+sort
        print('Board', key, file=sys.stderr)
        result=api.pages('/v2/leaderboard', {'time_period':period,'sort_by':sort,'category':'overall'},
            max_pages=args.board_pages, size=args.page_size, kind='board')
        board_data[key]=result['rows']
        statuses[key]={'rows':len(result['rows']),'pages':result['pages'],'exhausted':result['exhausted']}
        json_out(run_dir / ('board_'+key+'.json'), result)
    controls=read_controls(args.controls)
    active_control_meta={'requested':args.active_controls,'sampled':0,'method':'Recent global trade-feed sample, NOT a uniform random sample of all wallets'}
    if args.active_controls:
        try:
            sample=api.pages('/v2/trades', {'taker_only':False}, max_pages=args.control_pages, size=args.page_size)
            excluded={str(r.get('user_id') or '').lower() for rows in board_data.values() for r in rows}
            observed=sorted({str(r.get('proxy_wallet') or '').lower() for r in sample['rows']
                             if WALLET_PATTERN.fullmatch(str(r.get('proxy_wallet') or ''))
                             and str(r.get('proxy_wallet') or '').lower() not in excluded})
            random.Random(args.control_seed).shuffle(observed)
            sample_selected=observed[:args.active_controls]
            controls=list(dict.fromkeys(controls+sample_selected))
            active_control_meta.update(sampled=len(sample_selected), feed_rows=len(sample['rows']),
                feed_exhausted=sample['exhausted'], seed=args.control_seed)
        except Exception as error:
            active_control_meta['error']=str(error)
    chosen, total=select_candidates(board_data, args.wallets, controls)
    try:
        service_status, _ = api.fetch('/v2/status')
        json_out(run_dir/'api_freshness.json',service_status)
    except Exception as error:
        service_status={'error':str(error)}
    manifest={'status_snapshot':service_status,'active_controls':active_control_meta,'created_utc':datetime.now(timezone.utc).isoformat(),'origin':BASE,
        'api_spec':'https://data-api.polymarket.com/v2/openapi.json',
        'discovery':statuses,'discovered_unique_wallets':total,'selected_candidates':chosen,
        'caveat':'Selection is leaderboard-biased; control file allows external wallets.'}
    json_out(run_dir/'manifest.json',manifest)
    for index,candidate in enumerate(chosen,1):
        print(f'[{index}/{len(chosen)}] Wallet {candidate["wallet"]}',file=sys.stderr)
        record=collect_one(api,candidate['wallet'],args)
        json_out(run_dir/'wallets'/(candidate['wallet']+'.json'), record)
    result=analyze(run_dir)
    result['api_requests']=api.calls
    json_out(run_dir/'audit_report.json',result)
    print(json.dumps(result,ensure_ascii=False,indent=2))


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    subs=parser.add_subparsers(dest='command',required=True)
    collect_p=subs.add_parser('collect',help='Collect v2 API snapshots and compute audit tables')
    collect_p.add_argument('--wallets',type=int,default=10)
    collect_p.add_argument('--board-pages',type=int,default=1)
    collect_p.add_argument('--trade-pages',type=int,default=20)
    collect_p.add_argument('--activity-pages',type=int,default=20)
    collect_p.add_argument('--position-pages',type=int,default=10)
    collect_p.add_argument('--combo-pages',type=int,default=5)
    collect_p.add_argument('--page-size',type=int,default=500)
    collect_p.add_argument('--controls',help='One extra wallet per line; optional comparison cohort')
    collect_p.add_argument('--active-controls',type=int,default=5,help='Number of comparison wallets from recent global trade feed; 0 disables')
    collect_p.add_argument('--control-pages',type=int,default=2,help='How many global trade pages to scan for controls')
    collect_p.add_argument('--control-seed',type=int,default=146,help='Reproducible recent-feed control draw')
    collect_p.add_argument('--delay',type=float,default=.18)
    collect_p.add_argument('--output',default='output')
    analyze_p=subs.add_parser('analyze',help='Recalculate rankings using a saved collection')
    analyze_p.add_argument('--input',required=True)
    args=parser.parse_args(argv)
    if args.command=='collect':
        if min(args.wallets,args.board_pages,args.trade_pages,args.activity_pages,args.position_pages,args.combo_pages,args.page_size,args.control_pages) < 1 or args.active_controls < 0:
            parser.error('All counts must be >=1')
        if args.page_size>1000 or args.delay<0:
            parser.error('page-size must be <=1000 and delay nonnegative')
        collect(args)
    else:
        print(json.dumps(analyze(Path(args.input)),ensure_ascii=False,indent=2))

if __name__=='__main__':
    main()
