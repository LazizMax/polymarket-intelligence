"""Isolated background read-only price study with visible status and cancellation."""
from __future__ import annotations
from datetime import datetime,timezone
from pathlib import Path
import argparse
import json
import sys
import traceback
from price_study import run_study, atomic_write


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('--run-dir',required=True)
    parser.add_argument('--wallet',action='append',required=True)
    parser.add_argument('--max-signals',type=int,default=30)
    args=parser.parse_args(argv)
    folder=Path(args.run_dir).resolve()
    if not 1<=args.max_signals<=250:
        parser.error('max-signals must be in [1,250]')
    status_path=folder/'price_status.json'
    stop_path=folder/'price_stop.requested'
    if stop_path.exists():stop_path.unlink()
    state={'state':'running','created_utc':utc_now(),'updated_utc':utc_now(),'wallets':args.wallet,
           'completed_windows':0,'total_windows':0,'detail':'Préparation','error':None}
    atomic_write(status_path,state)
    def update(index,total,detail):
        state.update(updated_utc=utc_now(),completed_windows=max(0,index-1),total_windows=total,detail=detail)
        atomic_write(status_path,state)
    try:
        report=run_study(folder,args.wallet,args.max_signals,progress=update,cancel=stop_path.exists)
        state.update(state='completed',completed_windows=state['total_windows'],updated_utc=utc_now(),
                     detail=f"{report['signals_analyzed']} signaux · {report['api_calls']} appels API · {len(report['price_errors'])} erreurs")
        atomic_write(status_path,state)
        return 0
    except InterruptedError as e:
        state.update(state='canceled',updated_utc=utc_now(),detail=str(e))
        atomic_write(status_path,state)
        return 2
    except Exception as e:
        state.update(state='failed',updated_utc=utc_now(),error=str(e),detail='Analyse interrompue')
        atomic_write(status_path,state)
        with (folder/'price_errors.log').open('a',encoding='utf-8') as f:
            f.write(traceback.format_exc()+'\n')
        return 1


if __name__=='__main__':
    sys.exit(main())
