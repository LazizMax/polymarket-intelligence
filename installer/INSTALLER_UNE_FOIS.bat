@echo off
setlocal
cd /d "%~dp0"
title Polymarket Intelligence - Installation unique
echo Installation permanente de Polymarket Intelligence...
where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%~dp0install_once.py"
) else (
    python "%~dp0install_once.py"
)
if errorlevel 1 (
    echo.
    echo Installation interrompue : verifie Python 3.10+.
    pause
    exit /b 1
)
echo.
echo Installation terminee. Le raccourci Polymarket Intelligence est sur ton Bureau si Windows l'autorise.
pause
