"""MVP 2: descriptive wallet behaviour, NOT proof of strategy or copy-trading edge.

Read-only analysis of saved v2 API snapshots. No credentials, no live trading.
All estimated labels are explicitly heuristic and must never be sold as facts.
"""
from __future__ import annotations
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import csv
import json
import math
import re
import statistics
from typing import Any

CATEGORY_RULES = [
    ('Politique', re.compile(r'\b(election|president|trump|biden|congress|senate|house\s+of\s+representatives|governor|vote|voting|politics|democrat|republican|prime\s+minister|parliament)\b', re.I)),
    ('Sport', re.compile(r'\b(nba|nfl|mlb|nhl|ufc|fifa|uefa|premier\s+league|champions\s+league|super\s+bowl|world\s+cup|tennis|atp|wta|grand\s+slam|formula\s+1|f1|lakers|celtics|arsenal|real\s+madrid|soccer|football\s+match|basketball)\b', re.I)),
    ('Crypto', re.compile(r'\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|crypto|blockchain|memecoin|token|altcoin)\b', re.I)),
    ('Économie', re.compile(r'\b(federal\s+reserve|fed\s+rate|interest\s+rate|inflation|cpi|gdp|unemployment|nonfarm|recession|s&p\s*500|nasdaq|dow\s+jones|treasury\s+yield|fomc)\b', re.I)),
    ('Culture / Tech', re.compile(r'\b(oscar|grammy|album|movie|film|box\s+office|netflix|apple\s+vision|openai|chatgpt|tiktok|youtube|game\s+release|gta\s+vi)\b', re.I)),
]
PRICE_BUCKETS = [('0–10 %',0,.10), ('10–30 %',.10,.30), ('30–70 %',.30,.70), ('70–90 %',.70,.90), ('90–100 %',.90,1.000001)]


def number(value: Any) -> float | None:
    try:
        if value is None or value == '' or isinstance(value, bool): return None
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError, OverflowError):
        return None


def pct(n: float, d: float) -> float | None:
    return round(100*n/d,2) if d else None


def category(text: Any) -> str:
    if not isinstance(text,str) or not text.strip(): return 'Indéterminée'
    hits=[label for label,rule in CATEGORY_RULES if rule.search(text.replace('_',' ').replace('-',' '))]
    return hits[0] if len(hits)==1 else ('Indéterminée' if not hits else 'Ambiguë')


def source_rows(data: dict, key: str) -> list[dict]:
    item=data.get(key)
    return [t for t in item.get('rows',[]) if isinstance(t,dict)] if isinstance(item,dict) else []


def iso_day(ts: Any) -> str | None:
    n=number(ts)
    if n is None or n <= 0: return None
    try: return datetime.fromtimestamp(n,timezone.utc).strftime('%Y-%m-%d')
    except (ValueError,OverflowError,OSError): return None


def percentile_middle(values: list[float]) -> float | None:
    return round(statistics.median(values),4) if values else None


def analyze_wallet(record: dict, *, profile_label='') -> dict:
    wallet=str(record.get('wallet') or '')
    datasets=record.get('datasets') or {}
    if not isinstance(datasets,dict): datasets={}
    trades=source_rows(datasets,'trades')
    positions=source_rows(datasets,'closed')
    activity=source_rows(datasets,'activity')
    stats={'wallet':wallet,'name':profile_label,'trade_rows':len(trades),'closed_position_rows':len(positions),
           'trade_history_exhausted':bool((datasets.get('trades') or {}).get('exhausted')),
           'closed_history_exhausted':bool((datasets.get('closed') or {}).get('exhausted')),
           'data_errors':', '.join(sorted((record.get('failures') or {}).keys())),
           'interpretation':'OBSERVATIONS UNIQUEMENT — aucune stratégie prouvée, aucun signal de copiabilité validé'}
    buys,sells=0,0
    prices=[]; buy_prices=[]
    buy_value=0.; sell_value=0.
    volume_observed=0.
    unknown_price_size=0
    by_token:dict[str,set[str]]=defaultdict(set)
    by_event=Counter(); by_category=Counter(); cash_by_category=defaultdict(float)
    hour_counts=Counter(); weekday_counts=Counter(); daily=Counter()
    for t in trades:
        side=str(t.get('side') or '').upper()
        condition=str(t.get('condition_id') or '')
        token=str(t.get('token_id') or '')
        if token and side in ('BUY','SELL'): by_token[token].add(side)
        if side=='BUY': buys+=1
        elif side=='SELL': sells+=1
        price=number(t.get('price'))
        size=number(t.get('size'))
        valid=price is not None and 0<=price<=1 and size is not None and size>=0
        if valid:
            value=price*size
            prices.append(price); volume_observed+=value
            if side=='BUY':buy_prices.append(price);buy_value+=value
            if side=='SELL':sell_value+=value
        else: unknown_price_size+=1
        ev=str(t.get('event_slug') or condition or t.get('slug') or '')
        if ev: by_event[ev]+=1
        cat=category(t.get('title') or t.get('event_slug') or t.get('slug'))
        by_category[cat]+=1
        if valid: cash_by_category[cat]+=value
        ts=number(t.get('timestamp'))
        if ts is not None and ts>0:
            try:
                dt=datetime.fromtimestamp(ts,timezone.utc)
                hour_counts[dt.hour]+=1
                weekday_counts[dt.weekday()]+=1
                daily[dt.strftime('%Y-%m-%d')]+=1
            except (ValueError,OSError,OverflowError):pass
    effective=buys+sells
    stats.update(buy_count=buys,sell_count=sells,buy_share_pct=pct(buys,effective),
                 sell_share_pct=pct(sells,effective),
                 observed_gross_trade_value_usdc=round(volume_observed,2) if prices else None,
                 observed_buy_value_usdc=round(buy_value,2) if prices else None,
                 observed_sell_value_usdc=round(sell_value,2) if prices else None,
                 trades_missing_valid_price_size=unknown_price_size,
                 median_execution_price=percentile_middle(prices),
                 median_buy_price=percentile_middle(buy_prices),
                 distinct_events_observed=len(by_event),
                 bidirectional_token_count=sum(len(v)==2 for v in by_token.values()),
                 bidirectional_token_share_pct=pct(sum(len(v)==2 for v in by_token.values()),len(by_token)),
                 max_event_trade_share_pct=pct(max(by_event.values(),default=0),len(trades)),
                 days_active_observed=len(daily),
                 trades_per_active_day=round(len(trades)/len(daily),1) if daily else None,
                 peak_utc_hour=max(hour_counts,key=hour_counts.get) if hour_counts else None,
                 categories_tagged_by='regex indicative sur le titre / slug, pas taxonomie Gamma')
    stats['category_counts']=[{'categorie':k,'transactions':n,'part_pct':pct(n,len(trades)),
                              'notional_observe_usdc':round(cash_by_category[k],2)}
                              for k,n in by_category.most_common()]
    stats['daily_activity']=[{'date':k,'transactions':n} for k,n in sorted(daily.items())]
    stats['utc_hours']=[{'heure_utc':i,'transactions':hour_counts.get(i,0)} for i in range(24)]
    stats['price_distribution']=[{'probabilite':label,'achats':sum(low<=p<hi for p in buy_prices),
                                  'trades':sum(low<=p<hi for p in prices)}
                                  for label,low,hi in PRICE_BUCKETS]
    grouped:dict[str,dict]= {}
    duration=[]
    per_closed_cat=defaultdict(lambda:{'positions':0,'pnl':0.,'events':set()})
    dates_known=0
    for p in positions:
        pnl=number(p.get('realized_pnl'))
        ev=str(p.get('event_id') or p.get('event_slug') or p.get('condition_id') or '')
        if not ev: continue
        title=str(p.get('title') or p.get('event_slug') or p.get('slug') or '')
        cat=category(title)
        grp=grouped.setdefault(ev,{'event':ev,'title':title,'categorie_indicative':cat,'pnl_realise_usdc':0., 'positions':0})
        grp['positions']+=1
        if pnl is not None:
            grp['pnl_realise_usdc']+=pnl
            per_closed_cat[cat]['pnl']+=pnl
        per_closed_cat[cat]['positions']+=1
        per_closed_cat[cat]['events'].add(ev)
        entry=number(p.get('first_entry_at'))
        last=number(p.get('last_event_at'))
        if entry is not None and last is not None and last>=entry>0:
            dates_known+=1
            duration.append((last-entry)/3600)
    event_rows=[]
    for k in grouped:
        g=grouped[k].copy()
        g['pnl_realise_usdc']=round(g['pnl_realise_usdc'],2)
        event_rows.append(g)
    event_rows.sort(key=lambda x:x['pnl_realise_usdc'], reverse=True)
    stats.update(closed_event_groups=len(event_rows),
                 closed_event_winning_groups=sum(x['pnl_realise_usdc']>0 for x in event_rows),
                 closed_group_win_share_pct=pct(sum(x['pnl_realise_usdc']>0 for x in event_rows),len(event_rows)),
                 median_position_activity_span_hours_proxy=round(statistics.median(duration),2) if duration else None,
                 position_activity_span_count=dates_known,
                 closed_event_pnl_total_usdc=round(sum(r['pnl_realise_usdc'] for r in event_rows),2) if event_rows else None,
                 event_details=event_rows,
                 category_closed_pnl=[{'categorie':name,'positions':obj['positions'],'events':len(obj['events']),
                                       'pnl_realise_usdc':round(obj['pnl'],2)}
                                       for name,obj in sorted(per_closed_cat.items(),key=lambda x:x[1]['pnl'],reverse=True)])
    activity_counts=Counter(str(a.get('type') or 'INCONNU').upper() for a in activity)
    stats['activity_types']=[{'type':k,'nombre':v} for k,v in activity_counts.most_common()]
    pnl_series=datasets.get('pnl_series')
    points=pnl_series.get('points',[]) if isinstance(pnl_series,dict) else []
    last=points[-1] if isinstance(points,list) and points and isinstance(points[-1],dict) else {}
    stats['wallet_income_usdc_cumul']=number(last.get('wallet_income'))
    stats['realized_lp_pnl_usdc_cumul']=number(last.get('realized_lp_pnl'))
    stats['reward_income_usdc_cumul']=number(last.get('reward_income'))
    hypotheses=[]
    def suggest(name, evidence, test, level='Faible'):
        hypotheses.append({'hypothese':name,'indices':evidence,'test_manquant':test,'niveau':'Indication descriptive' if level=='Descriptif' else 'Hypothèse faible'})
    if len(trades)>=30 and stats['sell_share_pct'] is not None and stats['sell_share_pct'] >= 25 and stats['bidirectional_token_count']>=3:
        suggest('Trading bidirectionnel actif', f"{buys} achats, {sells} ventes ; {stats['bidirectional_token_count']} tokens avec les deux sens.",
                'Distinguer market making, arbitrage, réduction de risque et changement de conviction ; carnets, maker/taker et séquences nécessaires.')
    if len(trades)>=20 and stats['median_buy_price'] is not None and stats['median_buy_price']<=.20:
        suggest('Achats sur issues à faible probabilité implicite', f"Prix médian des achats observés : {stats['median_buy_price']:.3f}.",
                'Comparer prix et probabilité juste estimée, résolutions et pertes asymétriques ; le prix bas ne prouve pas une value bet.', 'Descriptif')
    if len(trades)>=20 and stats['median_buy_price'] is not None and stats['median_buy_price']>=.80:
        suggest('Achats sur issues à forte probabilité implicite', f"Prix médian des achats observés : {stats['median_buy_price']:.3f}.",
                'Contrôler frais, timing, capital immobilisé et risque de résolution inattendue.', 'Descriptif')
    if len(trades)>=20 and stats['max_event_trade_share_pct'] is not None and stats['max_event_trade_share_pct']>=35:
        suggest('Forte concentration des opérations', f"Un seul événement représente {stats['max_event_trade_share_pct']:.1f} % des fills observés.",
                'Vérifier que le bénéfice ne dépend pas d’un seul événement et que les tickets ne sont pas des fills fractionnés.', 'Descriptif')
    if dates_known>=15 and stats['median_position_activity_span_hours_proxy'] is not None:
        hours=stats['median_position_activity_span_hours_proxy']
        if hours<=6:
            suggest('Activité sur positions à horizon court',f'Médiane des intervalles première entrée→dernier événement : {hours:.1f} h (proxy, n={dates_known}).',
                    'Dernier événement économique ≠ sortie certaine. Reconstruire inventaire et trades chronologiques.')
        elif hours>=168:
            suggest('Activité sur positions à horizon long',f'Médiane des intervalles première entrée→dernier événement : {hours/24:.1f} j (proxy, n={dates_known}).',
                    'Ce n’est pas la durée de détention ; vérifier les dates effectives de vente ou résolution.')
    if stats['wallet_income_usdc_cumul'] is not None and abs(stats['wallet_income_usdc_cumul'])>0:
        suggest('Revenus externes aux positions observés',f"Wallet income cumulée de {stats['wallet_income_usdc_cumul']:.2f} USDC dans la série PnL.",
                'Ventiler rebates, rewards, LP, yield et vérifier leur reproductibilité pour le copieur.', 'Descriptif')
    if not hypotheses:
        hypotheses.append({'hypothese':'Aucun comportement suffisamment caractérisé','indices':'Échantillon insuffisant ou signaux descriptifs peu marqués.',
                           'test_manquant':'Collecter davantage de marchés/trades ; enrichir Gamma et reconstruire les positions.', 'niveau':'Indéterminé'})
    stats['hypotheses']=hypotheses
    caveats=[]
    if not stats['trade_history_exhausted']: caveats.append('Historique des transactions non épuisé ou non disponible.')
    if not stats['closed_history_exhausted']: caveats.append('Historique des positions clôturées non épuisé ou non disponible.')
    if stats['data_errors']: caveats.append('Erreur(s) API : '+stats['data_errors'])
    if len(trades)<30: caveats.append('Moins de 30 fills : très peu d’observations.')
    if stats['trades_missing_valid_price_size']: caveats.append('Trades avec prix/taille manquants ou invalides.')
    if not event_rows: caveats.append('Impossible de relier une performance à des événements clôturés.')
    caveats.append('La catégorie est estimée depuis le texte. Elle n’est pas vérifiée par les tags Gamma.')
    caveats.append('Ni fill aggressor, ni ordres non exécutés, ni meilleures offres historiques : impossible de valider arbitrage, market making ou copie rentable.')
    stats['caveats']=caveats
    stats['data_coverage_flag']='PARTIEL' if caveats and (not stats['trade_history_exhausted'] or not stats['closed_history_exhausted'] or stats['data_errors']) else 'TECHNIQUEMENT COUVERT (NON AUDITÉ)' 
    return stats


def make_csv(path:Path,rows:list[dict],columns:list[str]):
    path.parent.mkdir(exist_ok=True,parents=True)
    with path.open('w',newline='',encoding='utf-8-sig') as f:
        w=csv.DictWriter(f,fieldnames=columns,extrasaction='ignore');w.writeheader()
        for row in rows:
            w.writerow({k:"'"+v if isinstance(v,str) and v.startswith(('=','+','-','@')) else v for k,v in row.items()})


def analyze_run(folder:Path)->dict:
    """Recompute from existing snapshots; do not touch the original JSON or transactions."""
    folder=Path(folder)
    manifest=folder/'manifest.json'
    if not manifest.is_file(): raise FileNotFoundError('Manifest introuvable pour cette collecte.')
    data=json.loads(manifest.read_text(encoding='utf-8'))
    candidates=data.get('selected_candidates',[])
    public=[]; full=[]; events=[]
    for item in candidates:
        wallet=str(item.get('wallet') or '')
        if not re.fullmatch(r'0x[0-9a-fA-F]{40}',wallet): continue
        path=folder/'wallets'/(wallet+'.json')
        if not path.is_file():continue
        try:
            record=json.loads(path.read_text(encoding='utf-8'))
            prof=analyze_wallet(record,profile_label=item.get('name') or '')
        except (OSError,ValueError,TypeError) as ex:
            public.append({'wallet':wallet,'name':item.get('name') or '', 'error':str(ex)[:180]})
            continue
        full.append(prof)
        public.append({k:v for k,v in prof.items() if not isinstance(v,(list,dict))})
        for evt in prof['event_details']:
            events.append({'wallet':wallet,**evt})
    topcols=['wallet','name','trade_rows','closed_event_groups','observed_gross_trade_value_usdc','buy_share_pct','sell_share_pct',
             'median_execution_price','median_buy_price','bidirectional_token_share_pct','max_event_trade_share_pct',
             'median_position_activity_span_hours_proxy','closed_event_pnl_total_usdc','trade_history_exhausted','closed_history_exhausted','data_coverage_flag','error']
    make_csv(folder/'strategy_wallet_profiles.csv',public,topcols)
    make_csv(folder/'strategy_events.csv',events,['wallet','event','title','categorie_indicative','positions','pnl_realise_usdc'])
    output={'generated_utc':datetime.now(timezone.utc).isoformat(),'wallets_analyzed':len(full),
            'wallets_error':sum(bool(r.get('error')) for r in public),
            'profiles':full,'disclaimer':'Observations descriptives, catégories heuristiques, profils non prouvés, aucune preuve de profitabilité du copy trading.'}
    target=folder/'strategy_report.json'
    temporary=target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    temporary.replace(target)
    return output
