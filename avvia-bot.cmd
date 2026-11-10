@echo off
rem Avvia il motore degli agenti (paper) con dashboard su http://127.0.0.1:8787 - Ctrl-C per fermarlo.
rem Se il motore esce con codice 75 (riavvio chiesto dalla dashboard) riparte da solo: cosi il codice e le chiavi nuove entrano in uso.
rem Se si chiude per un errore (codice diverso da 0, 2 e 75: per esempio memoria finita sul PC) riparte da solo dopo 30 secondi.
rem Codice 0 = chiusura chiesta, codice 2 = errore di avvio (chiavi, configurazione): li si ferma e si legge il messaggio.
cd /d "%~dp0"
title Agentics sniper
:loop
bun run agents
set codice=%errorlevel%
if "%codice%"=="75" (
  echo Riavvio del motore...
  timeout /t 3 /nobreak >nul
  goto loop
)
if "%codice%"=="0" goto fermo
if "%codice%"=="2" goto fermo
echo.
echo Il motore si e' chiuso con codice %codice% (vedi logs\agenti-*.log): riparto tra 30 secondi. Chiudi la finestra per fermarlo.
timeout /t 30 /nobreak >nul
goto loop
:fermo
echo.
echo Il motore si e' fermato.
pause
