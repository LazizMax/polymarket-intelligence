@echo off
setlocal
cd /d "%~dp0"
title Polymarket Intelligence
where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%~dp0start_app.py"
) else (
    python "%~dp0start_app.py"
)
if errorlevel 1 (
    echo.
    echo Le lancement a echoue. Verifie les logs dans ce dossier.
    pause
)
