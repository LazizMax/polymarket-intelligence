"""Safe code-only updater. No user SQLite, runs, live sessions or keys are in archives.

Manifest (hosted at a user-configured HTTPS address):
{"version":"1.9.1","url":"https://github.com/OWNER/REPO/releases/download/v1.9.1/polymarket-code.zip","sha256":"..."}

The ZIP must contain app/dashboard.py, app/requirements.txt and app/version.json.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import urllib.request
import zipfile

MAX_ZIP = 30 * 1024 * 1024
ALLOWED_EXT = {'.py','.md','.txt','.toml','.json'}
REQUIRED = {'dashboard.py','requirements.txt','version.json','historical_db.py'}
VERSION = re.compile(r'^\d+(?:\.\d+){1,3}$')


def version_tuple(version: str) -> tuple[int,...]:
    if not isinstance(version,str) or not VERSION.fullmatch(version):
        raise ValueError('Numéro de version invalide')
    return tuple(int(p) for p in version.split('.'))


def local_version(base: Path) -> str:
    try:
        v=json.loads((base/'app'/'version.json').read_text(encoding='utf-8'))['version']
        version_tuple(v)
        return v
    except (OSError,KeyError,ValueError,TypeError):
        return '0.0.0'


def read_settings(base: Path) -> dict:
    try:
        content=json.loads((base/'settings.json').read_text(encoding='utf-8'))
        return content if isinstance(content,dict) else {}
    except (OSError, ValueError): return {}


def save_settings(base:Path, settings:dict)->None:
    base.mkdir(parents=True,exist_ok=True)
    path=base/'settings.json'
    tmp=base/'settings.json.tmp'
    tmp.write_text(json.dumps(settings,ensure_ascii=False,indent=2),encoding='utf-8')
    tmp.replace(path)


def https_url(url: str) -> str:
    if not isinstance(url,str) or not url.startswith('https://') or any(ch.isspace() for ch in url):
        raise ValueError('Seules les URLs HTTPS sont autorisées')
    return url


def fetch_manifest(url:str)->dict:
    url=https_url(url)
    req=urllib.request.Request(url,headers={'User-Agent':'Polymarket-Intelligence-Updater/1.9'})
    with urllib.request.urlopen(req,timeout=15) as response:
        raw=response.read(64_000+1)
    if len(raw)>64_000:raise ValueError('Manifest trop volumineux')
    data=json.loads(raw.decode('utf-8'))
    version_tuple(data['version'])
    https_url(data['url'])
    if not re.fullmatch(r'[a-fA-F0-9]{64}',data.get('sha256','')):
        raise ValueError('Empreinte SHA-256 invalide')
    return data


def download_release(manifest:dict, base:Path)->Path:
    base=Path(base); (base/'updates').mkdir(parents=True,exist_ok=True)
    target=base/'updates'/'pending.zip'
    tmp=base/'updates'/'downloading.part'
    sha=hashlib.sha256();total=0
    try:
        req=urllib.request.Request(https_url(manifest['url']),headers={'User-Agent':'Polymarket-Intelligence-Updater/1.9'})
        with urllib.request.urlopen(req,timeout=35) as response, tmp.open('wb') as f:
            while True:
                chunk=response.read(64*1024)
                if not chunk:break
                total+=len(chunk)
                if total>MAX_ZIP:raise ValueError('Archive trop volumineuse')
                sha.update(chunk);f.write(chunk)
        if sha.hexdigest().lower()!=manifest['sha256'].lower():
            raise ValueError('Empreinte SHA-256 incorrecte : téléchargement refusé')
        tmp.replace(target)
        (base/'updates'/'pending.json').write_text(json.dumps({'version':manifest['version'],'sha256':manifest['sha256']}),encoding='utf-8')
        return target
    finally:
        tmp.unlink(missing_ok=True)


def prepare_update(base:Path, zip_path:Path, *, check_version=True) -> tuple[Path,str]:
    base=Path(base);zip_path=Path(zip_path)
    if not zip_path.is_file() or zip_path.stat().st_size>MAX_ZIP:
        raise ValueError('Archive absente ou trop volumineuse')
    stage=Path(tempfile.mkdtemp(prefix='poly_stage_',dir=base))
    try:
        dest=stage/'app';dest.mkdir()
        names=set()
        total_uncompressed=0
        with zipfile.ZipFile(zip_path) as zf:
            if len(zf.infolist())>500:raise ValueError('Archive contenant trop de fichiers')
            for info in zf.infolist():
                raw=info.filename.replace('\\','/')
                path=PurePosixPath(raw)
                if path.is_absolute() or '..' in path.parts:raise ValueError('Chemin non autorisé dans le ZIP')
                if raw.startswith('app/'):path=PurePosixPath(*path.parts[1:])
                elif raw.startswith('./app/'):path=PurePosixPath(*path.parts[2:])
                else:raise ValueError('Le ZIP doit contenir un dossier app/')
                if not path.parts or raw.endswith('/'):continue
                if path.suffix not in ALLOWED_EXT:raise ValueError('Fichier non autorisé : '+str(path))
                if any(p in {'..','.venv','runs','historical','live_sessions','logs','updates'} for p in path.parts):
                    raise ValueError('Dossier utilisateur interdit dans une mise à jour')
                # Unix symlinks inside archives are disallowed.
                if stat.S_IFMT(info.external_attr>>16)==stat.S_IFLNK:
                    raise ValueError('Liens symboliques interdits')
                if str(path) in names:raise ValueError('Doublon dans le ZIP')
                names.add(str(path))
                total_uncompressed+=info.file_size
                if total_uncompressed>100*1024*1024:raise ValueError('Archive décompressée trop volumineuse')
                filepath=dest.joinpath(*path.parts); filepath.parent.mkdir(parents=True,exist_ok=True)
                with zf.open(info,'r') as r,filepath.open('wb') as w:shutil.copyfileobj(r,w)
        if not REQUIRED.issubset(names):raise ValueError('Archive incomplète : fichiers essentiels manquants')
        v=json.loads((dest/'version.json').read_text(encoding='utf-8'))['version']
        if check_version and version_tuple(v)<=version_tuple(local_version(base)):
            raise ValueError('La version choisie n’est pas plus récente que la version installée')
        return stage,v
    except Exception:
        shutil.rmtree(stage,ignore_errors=True)
        raise


def apply_update(base:Path, zip_path:Path)->str:
    """Code-only swap with rollback on error, preserving all base-level user data."""
    base=Path(base);base.mkdir(parents=True,exist_ok=True)
    stage,ver=prepare_update(base,zip_path)
    app=base/'app';previous=base/'app_backup'
    had_app=app.exists();moved=False
    try:
        if previous.exists():shutil.rmtree(previous)
        if had_app:app.rename(previous);moved=True
        try:(stage/'app').rename(app)
        except Exception:
            if moved and previous.exists():previous.rename(app)
            raise
        return ver
    finally:
        shutil.rmtree(stage,ignore_errors=True)


def apply_pending(base:Path)->str|None:
    pending=base/'updates'/'pending.zip';meta=base/'updates'/'pending.json'
    if not pending.is_file():return None
    if not meta.is_file():raise ValueError('Mise à jour en attente sans métadonnées de vérification')
    info=json.loads(meta.read_text(encoding='utf-8'))
    if hashlib.sha256(pending.read_bytes()).hexdigest().lower()!=info['sha256'].lower():
        raise ValueError('Archive en attente modifiée : mise à jour refusée')
    ver=apply_update(base,pending)
    pending.unlink(missing_ok=True);meta.unlink(missing_ok=True)
    return ver


def check_and_prepare(base:Path)->str|None:
    settings=read_settings(base)
    if not settings.get('auto_update') or not settings.get('manifest_url'):return None
    manifest=fetch_manifest(settings['manifest_url'])
    if version_tuple(manifest['version'])<=version_tuple(local_version(base)):return None
    download_release(manifest,base)
    return manifest['version']
