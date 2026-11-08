#!/usr/bin/env bash
# Installa il sidecar Kronos (Linux/macOS): codice del modello, venv in tools/kronos/venv, torch per CPU.
set -e
cd "$(dirname "$0")/tools/kronos"
command -v python3 >/dev/null || { echo "Manca python3 (3.10+)"; exit 1; }
command -v git >/dev/null || { echo "Manca git"; exit 1; }
[ -d kronos-src ] || git clone --depth 1 https://github.com/shiyu-coder/Kronos kronos-src
[ -d venv ] || python3 -m venv venv
./venv/bin/python -m pip install --upgrade pip >/dev/null
./venv/bin/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
./venv/bin/python -m pip install -r requirements.txt
./venv/bin/python -c 'import sys; sys.path.insert(0, "kronos-src"); from model import Kronos; print("Kronos importato: ok")'
# Modelli che affiancano Kronos (Chronos-2, TimesFM 2.5): facoltativi, senza il motore usa il solo Kronos.
./venv/bin/python -m pip install -r requirements-modelli.txt && ./venv/bin/python -c 'import chronos, timesfm; print("Chronos-2 e TimesFM importati: ok")' || echo "Modelli aggiuntivi non installati: si lavora con il solo Kronos."
echo "Kronos installato: bun run agents accende il sidecar da solo."
