import pathlib,sys,tempfile
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'app'))
from roi_screening import lower_roi_by_event
from historical_db import open_db, merge_wallet
from quality_metrics import wallet_metrics
from historical_intelligence import event_ledger
from historical_worker import fetch_wallet
from position_integrity import check_position

W='0x'+'b'*40

def ev(i,pnl,cost=100):
    return {'event_key':f'event-{i}','basis_usdc':cost,'pnl_usdc':pnl,'basis_coverage_complete':True}

def make_record(n=40, missing_event=False, inconsistent=False, complete=True):
    rows=[]
    for i in range(n):
        p={'token_id':str(i+1),'condition_id':f'market-{i}',
           'realized_pnl':5.,'total_cost_usdc':100.,'status':'CLOSED'}
        if not missing_event:p['event_slug']=f'event-{i}'
        if inconsistent and i==0:p.update(entry_cost_usdc=10.,entry_fees_usdc=1.)
        rows.append(p)
    return {'wallet':W,'datasets':{
        'closed':{'rows':rows,'exhausted':complete},
        'open':{'rows':[],'exhausted':True,'complete_lifecycle':True},
        'trades':{'rows':[],'exhausted':True}}}

def test_positive_stable_return_is_screened():
    v=lower_roi_by_event([ev(i,5.) for i in range(50)],wallet=W)
    assert v['roi_closed_cost_weighted_pct']==5.
    assert v['roi_event_bootstrap_low_5pct']==5.
    assert v['events']==50

def test_one_big_win_does_not_imply_positive_lower_bound():
    values=[ev(i,-2.) for i in range(49)]+[ev(49,500.)]
    v=lower_roi_by_event(values,wallet=W)
    assert v['roi_closed_cost_weighted_pct']>0
    assert v['roi_event_bootstrap_low_5pct']<0
    assert v['largest_win_share_pct']==100.

def test_no_bootstrap_on_missing_cost_or_too_few_events():
    assert lower_roi_by_event([ev(i,3.) for i in range(29)]) is None
    values=[ev(i,3.) for i in range(35)];values[0]['basis_coverage_complete']=False
    assert lower_roi_by_event(values) is None
    values=[ev(i,3.) for i in range(35)];values[1]['event_key']=values[0]['event_key']
    assert lower_roi_by_event(values) is None

def test_capital_weighted_not_average_of_percentages():
    values=[ev(i,10.,1000.) for i in range(15)]+[ev(i,-4.,10.) for i in range(15,30)]
    v=lower_roi_by_event(values,wallet=W)
    assert v['roi_closed_cost_weighted_pct']>0
    assert sum(100*e['pnl_usdc']/e['basis_usdc'] for e in values)/30<0

def test_unreliable_event_identifier_excluded_from_screening():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'test.sqlite')
        merge_wallet(db,make_record(missing_event=True))
        assert not any(r['event_identifier_valid'] for r in event_ledger(db,W))
        q=wallet_metrics(db)[0]
        assert q['roi_robust_lower_pct'] is None
        assert q['events']==0
        db.close()

def test_complete_stable_wallet_has_exploratory_bound():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'test.sqlite')
        merge_wallet(db,make_record())
        q=wallet_metrics(db)[0]
        assert q['roi_closed_pct']==5.
        assert q['roi_robust_lower_pct']==5.
        assert q['screening_quality']=='A examiner hors échantillon'
        db.close()

def test_bad_cost_components_block_documented_roi():
    with tempfile.TemporaryDirectory() as tmp:
        db=open_db(pathlib.Path(tmp)/'test.sqlite')
        merge_wallet(db,make_record(inconsistent=True))
        q=wallet_metrics(db)[0]
        assert q['roi_closed_pct'] is None
        assert q['roi_robust_lower_pct'] is None
        assert q['inconsistent_closed_rows']==1
        assert any('contradictions' in reason for reason in q['reasons'])
        db.close()

def test_position_arithmetic_validated_when_components_present():
    row={'total_cost_usdc':105.,'entry_cost_usdc':100.,'entry_fees_usdc':5.,
         'total_pnl':12.,'realized_pnl':2.,'unrealized_pnl':10.,
         'current_size':50.,'total_size':100.,'current_price':.8,'current_value':40.}
    assert check_position(row)==[]
    row['total_pnl']=120.
    assert 'pnl_components_mismatch' in check_position(row)
    row['current_size']=120.
    assert 'current_shares_exceed_total_bought' in check_position(row)

def test_full_import_requests_archived_and_dust_floor_for_held_states():
    calls=[]
    def fake_fetch(self,path,**params):return ({},None)
    def fake_pages(self,path,params,**kwargs):
        calls.append((path,dict(params)))
        return {'rows':[],'exhausted':True}
    with patch('historical_worker.API.fetch',fake_fetch),patch('historical_worker.API.pages',fake_pages):
        result=fetch_wallet(W,None,False,mode='approfondi',pages=4)
    assert result['datasets']['open']['complete_lifecycle'] is True
    for path,params in calls:
        if path=='/v2/positions' and params.get('status')!='CLOSED':
            assert params.get('include_archived') is True
            assert params.get('filter_amount')==0
