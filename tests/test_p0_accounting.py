import pathlib,sys,tempfile,json
from datetime import datetime,timezone
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'app'))
from historical_db import open_db,merge_wallet
from historical_intelligence import wallet_roi_report
from accounting_audit import wallet_accounting_audit
from historical_worker import fetch_wallet
W='0x'+'a'*40

def position(name,status,pnl,cost=100, token='1',realized=0):
    return dict(token_id=token,condition_id=name,event_slug=name,outcome='Yes',
                realized_pnl=pnl if status=='CLOSED' else realized,
                total_pnl=pnl,total_cost_usdc=cost,status=status)

def feed(rows=(),complete=True):return dict(rows=list(rows),exhausted=complete)

def record(closed=(),open=(),complete=True,activity=(),at=None,activity_complete=True):
    return dict(wallet=W,collected_utc=at or datetime.now(timezone.utc).isoformat(),
        trade_start=1,datasets={
          'trades':feed([]),
          'closed':feed(closed,complete),
          'open':dict(**feed(open,complete),complete_lifecycle=complete),
          'activity':feed(activity,activity_complete),
          'pnl_series':{'points':[dict(timestamp=1760000000,position_pnl=18,economic_pnl=20,realized_pnl=18)]}})

def test_partial_refresh_does_not_erase_exhaustive_closed_or_held_data():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'db.sqlite')
        full=record([position('win','CLOSED',40)],[position('hold','OPEN',-20,token='2')],at='2026-11-14T15:00:00+00:00')
        merge_wallet(db,full)
        after=record([position('new_only','CLOSED',999)],[position('new_hold','OPEN',100,token='3')],complete=False,at='2026-11-14T15:05:00+00:00')
        merge_wallet(db,after)
        assert [r['event_key'] for r in db.execute('SELECT event_key FROM positions')]==['win']
        assert [r['event_key'] for r in db.execute('SELECT event_key FROM open_positions')]==['hold']
        meta=db.execute('SELECT closed_exhausted,open_states_complete,closed_snapshot_at,open_snapshot_at FROM wallets').fetchone()
        assert (meta['closed_exhausted'],meta['open_states_complete'])==(1,1)
        assert meta['closed_snapshot_at']=='2026-11-14T15:00:00+00:00'

def test_open_positions_realized_partial_sales_do_not_create_fake_global_roi():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'db.sqlite')
        # Trader sold 900$ of shares and left only a 10$ position; a 1000% ROI is spurious.
        open_position=position('partial_sale','OPEN',100,10,realized=105)
        merge_wallet(db,record([position('closed','CLOSED',5)], [open_position]))
        result=wallet_roi_report(db,W)[0]
        assert result['roi_mises_global_pct'] is None
        assert result['roi_capital_reel_pct'] is None
        assert result['roi_mises_cloturees_pct']==5.

def test_activity_types_and_pending_positions_are_audited():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'db.sqlite')
        rows=[position('red','REDEEMABLE',30,token='9'),position('loss','REDEEMABLE_LOST',-5,token='8')]
        activity=[{'type':'DEPOSIT','amount':1000,'timestamp':123},
                  {'type':'WITHDRAWAL','amount':50,'timestamp':124},
                  {'type':'REWARD','amount':5,'timestamp':125}]
        merge_wallet(db,record([],rows,activity=activity))
        audit=wallet_accounting_audit(db,W)
        assert audit['held_statuses']=={'REDEEMABLE':1,'REDEEMABLE_LOST':1}
        assert audit['activity_types']['REWARD']==1
        assert audit['deposit_withdrawal_amounts_observed']=={'DEPOSIT':1000.,'WITHDRAWAL':50.}
        assert audit['capital_roi_pct'] is None
        assert audit['status']=='A_RECONCILIER'
        merge_wallet(db,record([],rows,activity=activity))
        assert db.execute('SELECT COUNT(*) FROM activity_events').fetchone()[0]==3

def test_legacy_open_snapshot_is_not_lifecycle_complete():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'db.sqlite')
        r=record([], [position('still','OPEN',1)])
        del r['datasets']['open']['complete_lifecycle']
        merge_wallet(db,r)
        audit=wallet_accounting_audit(db,W)
        assert audit['lifecycle_complete'] is False
        assert any('REDEEMABLE' in issue for issue in audit['reasons'])

def test_worker_collects_pending_states_and_wallet_flows_in_full_mode():
    calls=[]
    def fake_fetch(self,path,**params): return ({},None)
    def fake_pages(self,path,params,**kwargs):
        calls.append((path,dict(params)))
        status=params.get('status')
        mapping={
          'OPEN':[position('same','OPEN',3,token='3')],
          'REDEEMABLE':[position('same','REDEEMABLE',3,token='3')],
          'REDEEMABLE_LOST':[position('lost','REDEEMABLE_LOST',-50,token='4')]
        }
        return feed(mapping.get(status,[]))
    with patch('historical_worker.API.fetch',fake_fetch),patch('historical_worker.API.pages',fake_pages):
        result=fetch_wallet(W,None,False,mode='approfondi',pages=8)
    assert result['datasets']['open']['complete_lifecycle'] is True
    assert len(result['datasets']['open']['rows'])==2
    assert any(p=='/v2/activity' and a.get('exclude_deposits_withdrawals') is False for p,a in calls)
    assert result['datasets']['open']['exhausted'] is True

def test_failed_pending_status_cannot_mark_held_inventory_complete():
    def fake_fetch(self,path,**params):return ({},None)
    def fake_pages(self,path,params,**kwargs):
        if params.get('status')=='REDEEMABLE_LOST':raise RuntimeError('server down')
        return feed([])
    with patch('historical_worker.API.fetch',fake_fetch),patch('historical_worker.API.pages',fake_pages):
        result=fetch_wallet(W,None,False,mode='approfondi',pages=8)
    assert result['datasets']['open'].get('complete_lifecycle') is not True
    assert 'open_lifecycle' in result['failures']
