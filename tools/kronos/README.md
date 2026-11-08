# Prova di Kronos sui dati Alpaca

Script usati per la valutazione in `docs/valutazione-kronos-agenti-dashboard.md`. Non fanno parte dell'agente:
servono a misurare se le previsioni di Kronos (modello open source per candele OHLCV, MIT) hanno valore sul nostro universo.

```sh
cd tools/kronos
git clone --depth 1 https://github.com/shiyu-coder/Kronos kronos-src   # codice del modello (solo torch, nessuna rete)
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
export ALPACA_KEY_ID=... ALPACA_SECRET_KEY=...
./venv/bin/python fetch_alpaca.py                   # scrive data/*.csv: giornaliere dell'universo, 5 min SPY NVDA AAPL, crypto 1h
./venv/bin/python eval_kronos.py --csv data/SPY_1d.csv --model mini --lookback 400 --pred_len 5 --tests 150 --samples 3
```

`eval_kronos.py` scorre le ultime `--tests` barre, per ognuna chiede a Kronos i prossimi `--pred_len` passi usando
`--lookback` barre di storia, e per ogni orizzonte misura: accuratezza di direzione (contro la costante migliore),
correlazione di rango tra rendimento previsto e reale, errore assoluto contro "non cambia nulla",
e il rendimento medio di chi seguisse il segno della previsione. I pesi si scaricano da Hugging Face alla prima esecuzione
(`NeoQuasar/Kronos-mini` 4,1M parametri con `Kronos-Tokenizer-2k`; `Kronos-small` 24,7M e `Kronos-base` 102M con `Kronos-Tokenizer-base`).

## Sidecar per il motore degli agenti

```sh
./venv/bin/python server.py --model small --port 8765     # resta acceso; chiavi Alpaca nell'ambiente
bun run agents --kronos http://127.0.0.1:8765              # l'agente "kronos" si accende solo così
```

`POST /forecast` con `{"symbols": [...], "horizon": 5}` risponde con il rendimento previsto della chiusura a `horizon`
sedute per ogni simbolo (solo sedute finite, 400 barre di storia, 3 campioni). L'agente tiene solo il 25% di previsioni
più nette e solo se concordano col trend di lungo periodo; senza sidecar il motore lavora senza di lui.
