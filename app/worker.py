"""Reliable on-disk progress wrapper for read-only Polymarket research CLI.

Runs on the user's own machine. Does not place trades.
"""
from __future__ import annotations
import argparse
from collections import deque
from datetime import datetime, timezone
import json
import queue
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from typing import Any

BOARD_RE = re.compile(r'^Board\s+(\S+)')
WALLET_RE = re.compile(r'^\[(\d+)/(\d+)\] Wallet\s+(0x[0-9a-fA-F]{40})')

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def update_json(path: Path, data: dict[str, Any]):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)

def progress_from_message(state: dict, line: str):
    """Parse known CLI progress markers; do not pretend a wallet is done until next step."""
    line = line.strip()
    board = BOARD_RE.match(line)
    wallet = WALLET_RE.match(line)
    if board:
        state['phase'] = 'Classements publics'
        state['detail'] = board.group(1)
        state['boards_seen'] = max(state.get('boards_seen', 0), min(4, len(set(state.get('board_labels', []) + [board.group(1)]))))
        state['board_labels'] = list(dict.fromkeys(state.get('board_labels', []) + [board.group(1)]))
    elif wallet:
        index, total, address = int(wallet.group(1)), int(wallet.group(2)), wallet.group(3)
        state['phase'] = 'Audit des wallets'
        state['wallet_current'] = index
        state['wallet_total'] = total
        state['detail'] = address
    return state

def run(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--run-dir', required=True)
    p.add_argument('--wallets', type=int, default=10)
    p.add_argument('--controls', type=int, default=3)
    p.add_argument('--board-pages', type=int, default=1)
    p.add_argument('--trade-pages', type=int, default=8)
    p.add_argument('--activity-pages', type=int, default=8)
    p.add_argument('--position-pages', type=int, default=5)
    p.add_argument('--combo-pages', type=int, default=3)
    p.add_argument('--control-pages', type=int, default=2)
    p.add_argument('--page-size', type=int, default=500)
    args = p.parse_args(argv)
    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    stop_path, status_path = run_dir/'stop.requested', run_dir/'status.json'
    if stop_path.exists():
        stop_path.unlink()
    state = {
        'state': 'running', 'started_utc': now(), 'updated_utc': now(),
        'phase': 'Préparation', 'detail': 'Connexion à Polymarket',
        'boards_seen': 0, 'wallet_current': 0,
        'wallet_total': args.wallets + args.controls,
        'messages': [], 'code': None, 'run_dir': str(run_dir),
        'configuration': vars(args),
    }
    update_json(status_path, state)
    command = [sys.executable, '-u', str(Path(__file__).parent/'research.py'), 'collect',
        '--wallets', str(args.wallets), '--active-controls', str(args.controls),
        '--board-pages', str(args.board_pages), '--trade-pages', str(args.trade_pages),
        '--activity-pages', str(args.activity_pages), '--position-pages', str(args.position_pages),
        '--combo-pages', str(args.combo_pages), '--control-pages', str(args.control_pages),
        '--page-size', str(args.page_size), '--output', str(run_dir)]
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace', bufsize=1)
    except Exception as exc:
        state.update(state='failed', phase='Erreur de démarrage', detail=str(exc), updated_utc=now())
        update_json(status_path, state)
        return 1
    messages = deque(maxlen=100)
    incoming = queue.Queue()
    def reader():
        assert proc.stdout is not None
        with proc.stdout as stream:
            for message in stream:
                incoming.put(message.rstrip()[:500])

    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()
    canceled = False
    last_update = 0.0
    log_path = run_dir/'journal.txt'
    # Logging only the bounded last 100 messages is enough for UI but file holds the whole run.
    with log_path.open('a', encoding='utf-8') as log:
        while proc.poll() is None or reader_thread.is_alive():
            if stop_path.exists() and proc.poll() is None:
                canceled = True
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill()
            unprocessed = []
            while not incoming.empty():
                unprocessed.append(incoming.get_nowait())
            for line in unprocessed:
                messages.append(line)
                log.write(line + '\n')
                progress_from_message(state, line)
            if unprocessed: log.flush()
            if time.monotonic() - last_update > 1:
                state['updated_utc'] = now()
                state['messages'] = list(messages)[-20:]
                update_json(status_path, state)
                last_update = time.monotonic()
            time.sleep(.3)
        reader_thread.join(timeout=2)
        unprocessed = []
        while not incoming.empty():
            unprocessed.append(incoming.get_nowait())
        for line in unprocessed:
            messages.append(line)
            log.write(line + '\n')
            progress_from_message(state, line)
        log.flush()
    state['updated_utc'] = now()
    state['messages'] = list(messages)[-20:]
    state['code'] = proc.returncode
    state['state'] = 'canceled' if canceled else 'completed' if proc.returncode == 0 else 'failed'
    state['phase'] = {'completed':'Collecte terminée', 'failed':'Collecte interrompue par une erreur', 'canceled':'Collecte annulée'}[state['state']]
    state['detail'] = {'completed':'Les rapports sont disponibles', 'failed':'Consulte le journal pour comprendre le problème', 'canceled':'La collecte a été arrêtée'}[state['state']]
    update_json(status_path, state)
    return proc.returncode or (2 if canceled else 0)

if __name__ == '__main__':
    sys.exit(run())
