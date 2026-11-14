"""One-time Windows installer: installs source code in a stable location and keeps data."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
from update_manager import apply_update, local_version

HERE=Path(__file__).resolve().parent

def home():
    return Path(os.environ.get('LOCALAPPDATA') or Path.home()/'AppData'/'Local')/'PolymarketIntelligence'

def shortcut(base):
    # Uses Windows known Desktop location, including OneDrive-redirected Desktops.
    script=("$desktop=[Environment]::GetFolderPath('Desktop');"
            "if (-not $desktop) {throw 'Dossier Bureau introuvable'};"
            "$path=Join-Path $desktop 'Polymarket Intelligence.lnk';"
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($path);"
            "$s.TargetPath=$env:POLY_TARGET; $s.WorkingDirectory=$env:POLY_HOME;"
            "$s.Description='Polymarket Intelligence'; $s.Save()")
    env=os.environ.copy();env.update(POLY_TARGET=str(base/'POLYMARKET.bat'),POLY_HOME=str(base))
    try:
        p=subprocess.run(['powershell','-NoProfile','-Command',script],env=env,capture_output=True,text=True,timeout=15)
        if p.returncode:return 'Impossible de créer le raccourci automatiquement : '+p.stderr.strip()[:180]
        return 'Raccourci créé sur le Bureau.'
    except Exception as ex:return 'Raccourci optionnel non créé : '+str(ex)

def main():
    if sys.version_info<(3,10):raise RuntimeError('Python 3.10 ou plus récent requis')
    base=home();base.mkdir(parents=True,exist_ok=True)
    for dirname in ('runs','live_sessions','historical','updates','logs'):(base/dirname).mkdir(exist_ok=True)
    for name in ('update_manager.py','start_app.py','POLYMARKET.bat','MAJ_MANUELLE.bat'):
        shutil.copy2(HERE/name,base/name)
    appdir=HERE/'app'
    if not appdir.is_dir():raise FileNotFoundError('Dossier app/ introuvable dans le paquet')
    # Install using the same validated updater as future releases.
    if not (base/'app'/'version.json').is_file():
        shutil.copytree(appdir,base/'app',dirs_exist_ok=True)
    else:
        current=local_version(base)
        from update_manager import version_tuple
        new=__import__('json').loads((appdir/'version.json').read_text(encoding='utf-8'))['version']
        if version_tuple(new)>version_tuple(current):
            backup=base/'app_backup'
            if backup.exists():shutil.rmtree(backup)
            (base/'app').rename(backup)
            try:shutil.copytree(appdir,base/'app')
            except Exception:
                if (base/'app').exists():shutil.rmtree(base/'app')
                backup.rename(base/'app');raise
            print('Code mis à jour : '+new)
        else:print('Application déjà installée, données et environnement conservés.')
    print('Dossier permanent :',base)
    print('Base historique conservée :',base/'historique.sqlite')
    print(shortcut(base))
    print('Installation prête. Utilise POLYMARKET.bat ou le raccourci bureau pour les prochains lancements.')

if __name__=='__main__':
    try:main()
    except Exception as ex:print('ERREUR :',ex);sys.exit(1)
