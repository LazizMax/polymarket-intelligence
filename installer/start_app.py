"""Permanent launcher. Shares one virtualenv across all future versions."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import venv
import webbrowser
from update_manager import apply_pending, apply_update, check_and_prepare, local_version, read_settings

BASE=Path(__file__).resolve().parent
LOGS=BASE/'logs'
LOGS.mkdir(parents=True,exist_ok=True)
MAINLOG=LOGS/'lancement.log'
SERVERLOG=LOGS/'serveur.log'

def say(msg):
    print(msg,flush=True)
    with MAINLOG.open('a',encoding='utf-8') as f:f.write(msg+'\n')

def cmd_run(cmd):
    with MAINLOG.open('a',encoding='utf-8') as log:
        p=subprocess.Popen(cmd,cwd=BASE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                           text=True,encoding='utf-8',errors='replace')
        for line in p.stdout:
            print(line,end='',flush=True);log.write(line)
        if p.wait():raise RuntimeError('Installation des dépendances échouée. Voir logs/lancement.log')

def python_venv():
    return BASE/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')

def ensure_deps():
    p=python_venv()
    if not p.is_file():
        say('Première installation des bibliothèques Python (une seule fois)...')
        venv.create(BASE/'.venv',with_pip=True)
    requirements=BASE/'app'/'requirements.txt'
    fingerprint=hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker=BASE/'.venv'/'requirements.sha256'
    if not marker.is_file() or marker.read_text(encoding='utf-8').strip()!=fingerprint:
        say('Vérification des bibliothèques : uniquement si elles ont changé...')
        cmd_run([str(p),'-m','pip','install','--disable-pip-version-check','-r',str(requirements)])
        verify=subprocess.run([str(p),'-c','import streamlit,pandas,plotly,requests'],
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if verify.returncode:raise RuntimeError('Bibliothèques non importables après installation')
        marker.write_text(fingerprint,encoding='utf-8')
    else:say('Bibliothèques déjà installées : aucune réinstallation.')
    return p

def free_port():
    for port in range(8501,8531):
        with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as sock:
            try:sock.bind(('127.0.0.1',port));return port
            except OSError:continue
    raise RuntimeError('Aucun port disponible entre 8501 et 8530')

def healthy(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/_stcore/health',timeout=1) as res:return res.status==200
    except (OSError,urllib.error.URLError,ValueError):return False

def acquire_lock():
    """Simple Windows process-lifetime lock so updates do not overwrite running code."""
    f=(BASE/'application.lock').open('a+b')
    f.seek(0)
    f.write(b'0');f.flush();f.seek(0)
    try:
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        f.close();raise RuntimeError('Polymarket Intelligence est déjà en cours. Ferme l’ancienne fenêtre avant de relancer.')
    return f

def launch():
    if sys.version_info<(3,10):raise RuntimeError('Python 3.10 ou plus récent est nécessaire.')
    lock=acquire_lock()
    try:
        for d in ('runs','live_sessions','historical','updates','logs'):(BASE/d).mkdir(exist_ok=True)
        if not (BASE/'app'/'dashboard.py').is_file():raise RuntimeError('Installation incomplète, lance INSTALLER_UNE_FOIS.bat.')
        updated=False
        try:
            result=apply_pending(BASE)
            if result:say('Mise à jour installée : v'+result);updated=True
        except Exception as ex:say('Mise à jour en attente refusée : '+str(ex))
        settings=read_settings(BASE)
        if settings.get('auto_update') and settings.get('manifest_url'):
            try:
                version=check_and_prepare(BASE)
                if version:
                    result=apply_pending(BASE)
                    say('Mise à jour automatique installée : v'+str(result));updated=True
            except Exception as ex:say('Impossible de vérifier les mises à jour (application lancée normalement) : '+str(ex))
        p=ensure_deps()
        say('Version active : '+local_version(BASE))
        port=free_port();url=f'http://127.0.0.1:{port}'
        cmd=[str(p),'-m','streamlit','run',str(BASE/'app'/'dashboard.py'),
             '--server.address=127.0.0.1',f'--server.port={port}',
             '--server.headless=true','--browser.gatherUsageStats=false']
        env=os.environ.copy();env['POLYMARKET_DATA_DIR']=str(BASE)
        with SERVERLOG.open('w',encoding='utf-8') as f:
            proc=subprocess.Popen(cmd,cwd=BASE/'app',env=env,stdout=f,stderr=subprocess.STDOUT)
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            if healthy(port):
                say('✓ Application prête : '+url)
                webbrowser.open(url)
                try:return proc.wait()
                except KeyboardInterrupt:
                    proc.terminate()
                    try:proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:proc.kill()
                    return 0
            if proc.poll() is not None:
                lines=SERVERLOG.read_text(encoding='utf-8',errors='replace').splitlines()
                for l in lines[-25:]:print(l)
                return 1
            time.sleep(.5)
        proc.terminate();say('Le serveur ne répond pas. Consulte logs/serveur.log');return 1
    finally:
        lock.close()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--apply',help='ZIP contenant une nouvelle version du code app/')
    args=parser.parse_args()
    if args.apply:
        lock=acquire_lock()
        try:print('Mise à jour installée :',apply_update(BASE,Path(args.apply)))
        finally:lock.close()
    else:return launch()
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as ex:
        say('ERREUR : '+str(ex));sys.exit(1)
