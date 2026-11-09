@echo off
rem Avvia il motore degli agenti (paper) con dashboard su http://127.0.0.1:8787 - Ctrl-C per fermarlo.
rem Se il motore esce con codice 75 (riavvio chiesto dalla dashboard) riparte da solo: cosi il codice e le chiavi nuove entrano in uso.
cd /d "%~dp0"
title Agentics sniper
:loop
bun run agents
if %errorlevel%==75 (
  echo Riavvio del motore...
  timeout /t 3 /nobreak >nul
  goto loop
)
echo.
echo Il motore si e' fermato.
pause
