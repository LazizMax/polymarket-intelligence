import pathlib,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'app'))
import tempfile
from historical_db import open_db, merge_wallet
from quality_metrics import wallet_metrics,sector_metrics,MIN_EVIDENCE_EVENTS
from historical_worker import fetch_wallet,execute,atomic_json
from unittest.mock import patch

W='0x'+'a'*40

def record(n=5,closed=True,opened=True,missing_cost=False):
    rows=[{'event_slug':f'event-{i}','condition_id':f'c{i}', 'token_id':str(i),
           'title':f'Event {i}', 'realized_pnl':10.,
           'total_cost_usdc':None if missing_cost and i==0 else 100.} for i in range(n)]
    return {'wallet':W,'datasets':{'closed':{'rows':rows,'exhausted':closed},
             'open':{'rows':[],'exhausted':opened},'trades':{'rows':[],'exhausted':True}}}

def test_suppresses_unreliable_winrate_and_no_fake_full_roi():
    with tempfile.TemporaryDirectory() as p:
        db=open_db(pathlib.Path(p)/'x.sqlite')
        merge_wallet(db,record(5,False))
        r=wallet_metrics(db)[0]
        assert r['winrate_pct'] is None
        assert r['roi_closed_pct'] is None
        assert r['roi_global_pct'] is None
        assert r['partial_roi_pct']==10.
        assert r['data_status']=='À auditer'
        db.close()

def test_complete_roi_weighted_and_sector():
    with tempfile.TemporaryDirectory() as p:
        db=open_db(pathlib.Path(p)/'x.sqlite')
        merge_wallet(db,record(40,True,True))
        r=wallet_metrics(db)[0]
        assert r['events']==40
        assert r['roi_closed_pct']==10.
        assert r['roi_global_pct']==10.
        assert r['winning_events']==40
        assert r['data_status']=='Historique exploitable'
        sec=sector_metrics(db,[r]);assert sec
        db.close()

def test_missing_cost_prevents_verified_roi():
    with tempfile.TemporaryDirectory() as p:
        db=open_db(pathlib.Path(p)/'x.sqlite')
        merge_wallet(db,record(40,True,True,missing_cost=True))
        r=wallet_metrics(db)[0]
        assert r['roi_closed_pct'] is None
        assert r['missing_closed_costs']>0
        assert r['partial_roi_pct'] is not None
        db.close()

def test_workers_parallel_and_db_sequential():
    with tempfile.TemporaryDirectory() as p:
        base=pathlib.Path(p);db=open_db(base/'x.sqlite')
        progress={'state':'running'}
        def fake_fetch(w,ts,complete,**kwargs):
            rec=record(1);rec['wallet']=w
            return rec
        with patch('historical_worker.fetch_wallet',side_effect=fake_fetch) as m:
            execute(db,[W],status=base/'status.json',stop=base/'stop',mode='rapide',pages=4,
                    workers=3,progress=progress,messages=[])
            assert m.call_count==1
            assert progress['completed']==1
            assert db.execute('SELECT COUNT(*) FROM wallets').fetchone()[0]==1
        db.close()
