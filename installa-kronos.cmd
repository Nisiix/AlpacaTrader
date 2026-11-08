@echo off
rem Installa il sidecar Kronos (modello di previsione per candele) usato dal motore degli agenti.
rem Serve Python 3.10+ (python.org, con "Add to PATH") e git. Scarica il codice del modello, crea un ambiente
rem Python separato in tools\kronos\venv e installa torch per CPU (~200 MB). I pesi del modello arrivano al primo avvio.
setlocal
cd /d "%~dp0tools\kronos"
where python >nul 2>nul || (echo Manca Python: installalo da https://www.python.org/downloads/ con "Add python.exe to PATH" e rilancia. & pause & exit /b 1)
where git >nul 2>nul || (echo Manca git: installalo da https://git-scm.com/download/win e rilancia. & pause & exit /b 1)
if not exist kronos-src (
  echo Scarico il codice di Kronos...
  git clone --depth 1 https://github.com/shiyu-coder/Kronos kronos-src || (echo Download fallito. & pause & exit /b 1)
)
if not exist venv (
  echo Creo l ambiente Python...
  python -m venv venv || (echo Creazione venv fallita. & pause & exit /b 1)
)
echo Installo torch per CPU e le dipendenze (qualche minuto)...
venv\Scripts\python -m pip install --upgrade pip >nul
venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu || (echo Installazione di torch fallita. & pause & exit /b 1)
venv\Scripts\python -m pip install -r requirements.txt || (echo Installazione dipendenze fallita. & pause & exit /b 1)
venv\Scripts\python -c "import sys; sys.path.insert(0, \"kronos-src\"); from model import Kronos; print(\"Kronos importato: ok\")" || (echo Il modello non si importa. & pause & exit /b 1)
echo.
echo Kronos installato. Da ora avvia-bot.cmd accende il sidecar da solo (i pesi del modello si scaricano al primo avvio, 1-2 minuti).
pause
