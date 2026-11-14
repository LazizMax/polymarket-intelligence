"""Subprocess launcher for the prospective monitor, keeping UI responsive."""
import argparse
import json
from pathlib import Path
from live_monitor import run
from price_study import atomic_write

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--monitor-dir',required=True);a=p.parse_args()
    folder=Path(a.monitor_dir).resolve()
    try:
        cfg=json.loads((folder/'pending_config.json').read_text(encoding='utf-8'))
        run(cfg,folder)
    except Exception as exc:
        previous={}
        try:previous=json.loads((folder/'live_status.json').read_text(encoding='utf-8'))
        except Exception:pass
        atomic_write(folder/'live_status.json',{**previous,'state':'failed','detail':str(exc)[:280]})
        raise
