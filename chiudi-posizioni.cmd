@echo off
rem Chiude tutte le posizioni del conto paper (toglie gli stop, vende a mercato) per ripartire da zero con gli agenti.
cd /d "%~dp0"
bun run chiudi-posizioni
echo.
pause
