@echo off
setlocal
cd /d "%~dp0"
echo Ferme Polymarket Intelligence avant de mettre a jour le code.
echo.
echo Depose ici le chemin complet d'une archive de mise a jour, puis appuie sur Entree.
set /p "ZIP=Fichier ZIP : "
set "ZIP=%ZIP:"=%"
if "%ZIP%"=="" exit /b 1
where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%~dp0start_app.py" --apply "%ZIP%"
) else (
    python "%~dp0start_app.py" --apply "%ZIP%"
)
pause
