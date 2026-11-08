@echo off
rem Doppio clic dopo aver scritto /start al bot su Telegram: ricava il chat id e lo scrive in secrets.ts.
cd /d "%~dp0"
bun run telegram-chat-id --scrivi
echo.
pause
