"""Prospective copy-signal ranking from V1.5 *observed* order-book snapshots.

No network, no trade execution, no historical inference of unobserved prices.
One fixed horizon per comparison; event-cluster bootstrap is descriptive only.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import sqlite3
import statistics
import time
import uuid

HORIZONS = (60, 300, 900, 3600)


def _number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def _json(value):
    if not value:
        return {}
    try:
        data = json.loads(value)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def available_sessions(root: Path):
    base = Path(root) / 'live_sessions'
    if not base.is_dir():
        return []
    return sorted((p for p in base.iterdir() if p.is_dir() and (p / 'live.sqlite').is_file()), reverse=True)


def session_metadata(folder: Path):
    try:
        data = _json((folder/'config.json').read_text(encoding='utf-8'))
    except (OSError, UnicodeError):
        data = {}
    try:
        status = _json((folder/'live_status.json').read_text(encoding='utf-8'))
    except (OSError, UnicodeError):
        status = {}
    return {'session':folder.name, 'budget_usdc':_number(data.get('paper_budget_usdc')),
            'fee_bps_per_side':_number(data.get('fee_bps')),
            'poll_seconds':_number(data.get('poll_seconds')),
            'status':status.get('state','unknown')}


def _read_session(folder: Path, horizon: int):
    path = folder/'live.sqlite'
    db = sqlite3.connect(f'file:{path.resolve().as_posix()}?mode=ro', uri=True, timeout=10)
    try:
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute('''
            SELECT s.id AS signal_id, s.wallet, s.trade_timestamp, s.detected_ts,
              s.side, s.token_id, s.event_slug, s.condition_id, s.title,
              s.source_price, s.quote_json, s.quote_status,
              e.horizon_s, e.observed_ts, e.sell_quote_json,
              e.paper_pnl_assumed_usdc, e.status AS exit_status
            FROM signals s LEFT JOIN evaluations e
              ON e.signal_id=s.id AND e.horizon_s=?
            WHERE s.side='BUY' ORDER BY s.detected_ts ASC
            ''', (horizon,))]
        counts = [dict(r) for r in db.execute('''SELECT wallet, COUNT(*) AS polls,
          SUM(CASE WHEN error IS NOT NULL AND error!='' THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN exhausted=0 THEN 1 ELSE 0 END) AS incomplete_polls
          FROM checks GROUP BY wallet''')]
        return rows, counts
    finally:
        db.close()


def _event_group(row):
    event = str(row.get('event_slug') or '').strip()
    condition = str(row.get('condition_id') or '').strip()
    token = str(row.get('token_id') or '').strip()
    if event:
        return 'event:' + event
    if condition:
        return 'market:' + condition
    if token:
        return 'token:' + token
    return 'unknown'  # NEVER treat each unknown fill as independent.


def build_observations(sessions, horizon=300, max_lateness_s=90,
                       max_source_delay_s=120, extra_bps=0, as_of=None):
    """Return per-signal rows with reasons for inclusion/exclusion.

    Exclusion denominators include only signals whose target horizon has elapsed.
    Read-only SQLite, all rows (no UI LIMIT 500 cap). Dedup same signal across sessions.
    """
    if horizon not in HORIZONS:
        raise ValueError('Horizon must be 60, 300, 900, 3600 seconds')
    if min(max_lateness_s, max_source_delay_s, extra_bps) < 0:
        raise ValueError('Thresholds cannot be negative')
    now = float(as_of if as_of is not None else time.time())
    candidates, meta, checks = [], [], defaultdict(lambda:{'polls':0,'errors':0,'incomplete_polls':0})
    for folder in sessions:
        folder = Path(folder)
        metadata = session_metadata(folder)
        try:
            rows, session_checks = _read_session(folder, horizon)
        except (sqlite3.DatabaseError, OSError) as exc:
            meta.append({**metadata,'error':str(exc)[:250]})
            continue
        meta.append({**metadata,'error':''})
        for row in rows:
            row['session']=folder.name
            candidates.append(row)
        for c in session_checks:
            a=checks[str(c['wallet']).lower()]
            for k in ('polls','errors','incomplete_polls'):
                a[k]+=int(c.get(k) or 0)
    # Multiple monitoring sessions may contain the same source fill; keep earliest observed.
    seen = {}
    for row in sorted(candidates, key=lambda r: (float(r.get('detected_ts') or 0),str(r['session']))):
        key = (str(row['wallet']).lower(),str(row['signal_id']))
        if key not in seen:
            seen[key]=row
    observations=[]
    for raw in seen.values():
        wallet=str(raw.get('wallet') or '').lower()
        detected=_number(raw.get('detected_ts'))
        source_ts=_number(raw.get('trade_timestamp'))
        observed=_number(raw.get('observed_ts'))
        quote=_json(raw.get('quote_json'))
        sell=_json(raw.get('sell_quote_json'))
        cost=_number(quote.get('entry_cost_usdc'))
        proceeds=_number(sell.get('proceeds_usdc'))
        raw_pnl=_number(raw.get('paper_pnl_assumed_usdc'))
        mature=detected is not None and detected+horizon <=now
        lag=detected-source_ts if detected is not None and source_ts is not None else None
        late=(observed-detected-horizon) if observed is not None and detected is not None else None
        reason='eligible'
        pnl=None
        if not mature:reason='horizon_not_elapsed'
        elif lag is None or lag < -2:reason='source_timestamp_anomaly'
        elif lag >max_source_delay_s:reason='source_to_detection_too_late'
        elif raw.get('quote_status') != 'full_quote' or not cost or cost<=0:reason='no_full_entry_quote'
        elif not raw.get('exit_status'):reason='exit_not_recorded'
        elif raw['exit_status']!='full_quote':reason='no_full_exit_quote'
        elif late is None or late < -2:reason='exit_timestamp_anomaly'
        elif late >max_lateness_s:reason='exit_observation_too_late'
        elif proceeds is None or raw_pnl is None:reason='missing_quote_accounting'
        else:
            # A separate stress cost, on top of original recorded model fees.
            # Depth/ask/bid are already included in source markout.
            pnl=raw_pnl-(cost+proceeds)*extra_bps/10000.0
        pnl=pnl if reason=='eligible' else None
        observations.append({
            'wallet':wallet,'signal_id':raw['signal_id'],'session':raw['session'],
            'event_group':_event_group(raw),'title':raw.get('title') or '',
            'detected_ts':detected,'source_ts':source_ts,
            'source_to_detection_s':lag,'exit_lateness_s':late,
            'horizon_s':horizon,'mature':bool(mature),'reason':reason,
            'entry_cost_usdc':cost,'exit_proceeds_usdc':proceeds,
            'pnl_usdc':pnl,'roi_pct':100*pnl/cost if pnl is not None else None,
            'raw_markout_usdc':raw_pnl,'entry_price':_number(quote.get('vwap')),
            'source_price':_number(raw.get('source_price')),
            'entry_quote_status':raw.get('quote_status'),
            'exit_quote_status':raw.get('exit_status'),
        })
    observations.sort(key=lambda r:(r['wallet'],r['detected_ts'] or 0,r['signal_id']))
    return observations,meta,dict(checks)


def cluster_lower(values, seed, draws=1000):
    """One-sided 5th percentile of event-level mean return resampling.

    Exploratory only: does not correct cross-market correlation, multiple testing,
    nonrandom wallet selection, or optimistic execution assumptions.
    """
    vals=[float(v) for v in values if _number(v) is not None]
    if len(vals)<5:return None
    rng=random.Random(int(hashlib.sha256(seed.encode()).hexdigest()[:16],16))
    samples=[]
    n=len(vals)
    for _ in range(draws):
        samples.append(sum(vals[rng.randrange(n)] for _ in range(n))/n)
    samples.sort()
    return samples[int(.05*(draws-1))]


def summarize(observations,checks,minimum_signals=30,minimum_events=20,
              min_coverage_pct=80,bootstrap_draws=700):
    grouped=defaultdict(list)
    for o in observations:
        grouped[o['wallet']].append(o)
    ranking=[]
    for wallet,rows in grouped.items():
        mature=[r for r in rows if r['mature']]
        good=[r for r in mature if r['reason']=='eligible']
        events=defaultdict(list)
        for r in good:events[r['event_group']].append(r)
        event_roi=[statistics.fmean(r['roi_pct'] for r in data) for data in events.values()]
        event_pnl=[sum(r['pnl_usdc'] for r in data) for data in events.values()]
        n_events=len(events)
        # Temporal split by first detection for each event, not by fill.
        ordered_events=sorted(events.values(),key=lambda rows:min(x['detected_ts'] for x in rows))
        event_halves=([statistics.fmean(x['roi_pct'] for x in part) for part in ordered_events[:n_events//2]],
                      [statistics.fmean(x['roi_pct'] for x in part) for part in ordered_events[n_events//2:]])
        first_half=statistics.fmean(event_halves[0]) if len(event_halves[0])>=5 else None
        recent_half=statistics.fmean(event_halves[1]) if len(event_halves[1])>=5 else None
        pnl=sum(r['pnl_usdc'] for r in good) if good else None
        spend=sum(r['entry_cost_usdc'] for r in good) if good else 0.0
        coverage=100*len(good)/len(mature) if mature else None
        lower=cluster_lower(event_roi,wallet,draws=bootstrap_draws) if n_events>=5 else None
        performance=100*pnl/spend if spend else None
        concentration=(100*max((x for x in event_pnl if x>0),default=0)/
                       sum(x for x in event_pnl if x>0)) if any(x>0 for x in event_pnl) else None
        detail=checks.get(wallet,{})
        polls=int(detail.get('polls') or 0)
        incomplete=int(detail.get('incomplete_polls') or 0)
        problems=int(detail.get('errors') or 0)
        enough= (len(good)>=minimum_signals and n_events>=minimum_events and
                coverage is not None and coverage>=min_coverage_pct and polls>0 and
                incomplete==0 and problems==0)
        if not good: status='Aucune évaluation exploitable'
        elif not enough: status='Échantillon / couverture insuffisants'
        elif lower is not None and lower>0 and recent_half is not None and recent_half>0: status='Signal exploratoire positif'
        else: status='Avantage non établi'
        ranking.append({'wallet':wallet,'status':status,
            'signals_detected':len(rows),'matured_signals':len(mature),
            'eligible_signals':len(good),'event_groups':n_events,
            'coverage_pct':coverage,'observed_source_delay_median_s':(
                statistics.median(r['source_to_detection_s'] for r in good) if good else None),
            'exit_lateness_median_s':statistics.median(r['exit_lateness_s'] for r in good) if good else None,
            'sum_markouts_usdc':pnl,'sum_notional_usdc':spend if good else None,
            'markout_over_notional_pct':performance,
            'event_equal_weight_mean_pct':statistics.fmean(event_roi) if event_roi else None,
            'event_bootstrap_5pct_bound':lower,
            'earlier_half_event_mean_pct':first_half,
            'recent_half_event_mean_pct':recent_half,
            'positive_signal_pct':100*sum(r['pnl_usdc']>0 for r in good)/len(good) if good else None,
            'top_positive_event_share_pct':concentration,
            'polls':polls,'poll_errors':problems,'incomplete_polls':incomplete,
            'eligible':bool(enough),'reason_counts':_counts(rows)})
    ranking.sort(key=lambda r:(r['eligible'],
                 r['event_bootstrap_5pct_bound'] if r['event_bootstrap_5pct_bound'] is not None else -float('inf'),
                 r['event_groups']),reverse=True)
    return ranking


def _counts(rows):
    d=defaultdict(int)
    for r in rows:d[r['reason']]+=1
    return dict(d)


def import_sessions(source, root):
    """One-off, read-only SQLite backups from V1.5 sessions; never copy WAL files.

    Importing a live source is a frozen snapshot, NOT continued background monitoring.
    """
    src=Path(str(source).strip().strip('"')).expanduser().resolve(strict=True)
    dest=Path(root)/'live_sessions'
    dest.mkdir(parents=True,exist_ok=True)
    if src.name=='live_sessions' and src.is_dir():
        folders=[x for x in src.iterdir() if x.is_dir() and (x/'live.sqlite').is_file()]
    elif (src/'live.sqlite').is_file():
        folders=[src]
    else:
        raise ValueError('Sélectionne un dossier live_sessions ou une session qui contient live.sqlite.')
    count=0
    for folder in folders:
        if not (folder/'live.sqlite').is_file():continue
        if folder.resolve().parent==dest.resolve():continue
        target=dest/(folder.name+'_import_'+uuid.uuid4().hex[:6])
        target.mkdir(parents=True,exist_ok=False)
        try:
            for item in ('config.json','live_status.json','worker.log','pending_config.json'):
                p=folder/item
                if p.is_file() and not p.is_symlink():shutil.copy2(p,target/item)
            db_src=sqlite3.connect(f'file:{(folder/"live.sqlite").resolve().as_posix()}?mode=ro',uri=True,timeout=15)
            try:
                db_dest=sqlite3.connect(target/'live.sqlite')
                try:db_src.backup(db_dest,pages=128,sleep=.05)
                finally:db_dest.close()
            finally:db_src.close()
            count+=1
        except Exception:
            shutil.rmtree(target,ignore_errors=True)
            raise
    return count
