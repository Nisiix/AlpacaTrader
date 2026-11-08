@echo off
rem Avvia il motore degli agenti (paper) con dashboard su http://127.0.0.1:8787 - Ctrl-C per fermarlo.
cd /d "%~dp0"
title Bot alpaca agents
bun run agents
echo.
echo Il motore si e' fermato.
pause
