# Sidecar Kronos per il motore degli agenti. POST /forecast {"symbols":[...], "horizon":5} ->
# {"forecasts": {"SPY": {"pred_ret": 0.012, "path": [..]}}}. Scarica le barre giornaliere da Alpaca (chiavi
# in ALPACA_KEY_ID / ALPACA_SECRET_KEY), chiede a Kronos i prossimi `horizon` giorni e risponde con il rendimento
# previsto della chiusura. Solo libreria standard + torch/pandas; nessun ordine parte da qui.
# Uso: ./venv/bin/python server.py [--model small] [--port 8765] [--lookback 400] [--samples 3]
import argparse, json, os, sys, datetime as dt, urllib.request, urllib.parse, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np, pandas as pd, torch
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kronos-src"))
from model import Kronos, KronosTokenizer, KronosPredictor

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="small", choices=["mini", "small", "base"])
ap.add_argument("--port", type=int, default=8765)
ap.add_argument("--lookback", type=int, default=400)
ap.add_argument("--samples", type=int, default=3)
ap.add_argument("--T", type=float, default=1.0)
ap.add_argument("--top_p", type=float, default=0.9)
a = ap.parse_args()
TOK = {"mini": "NeoQuasar/Kronos-Tokenizer-2k", "small": "NeoQuasar/Kronos-Tokenizer-base", "base": "NeoQuasar/Kronos-Tokenizer-base"}
CTX = {"mini": 2048, "small": 512, "base": 512}
tokenizer = KronosTokenizer.from_pretrained(TOK[a.model])
model = Kronos.from_pretrained(f"NeoQuasar/Kronos-{a.model}")
predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=min(CTX[a.model], a.lookback))
K, S = os.environ.get("ALPACA_KEY_ID", ""), os.environ.get("ALPACA_SECRET_KEY", "")
if not K or not S: sys.exit("servono ALPACA_KEY_ID e ALPACA_SECRET_KEY nell'ambiente")

def bars(symbols, days):
    start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(days * 1.6) + 30)).strftime("%Y-%m-%dT00:00:00Z")
    end = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {s: [] for s in symbols}; tok = None
    while True:
        q = {"symbols": ",".join(symbols), "timeframe": "1Day", "start": start, "end": end, "limit": 10000, "feed": "iex", "adjustment": "split"}
        if tok: q["page_token"] = tok
        req = urllib.request.Request("https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(q), headers={"APCA-API-KEY-ID": K, "APCA-API-SECRET-KEY": S})
        with urllib.request.urlopen(req, timeout=30) as r: d = json.load(r)
        for s, bs in d.get("bars", {}).items(): out[s].extend(bs)
        tok = d.get("next_page_token")
        if not tok: break
    return out

def to_df(bs):
    df = pd.DataFrame([{"timestamps": b["t"], "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": b["v"], "amount": b["v"] * b["vw"]} for b in bs])
    df["timestamps"] = pd.to_datetime(df["timestamps"])
    return df

def forecast(symbols, horizon):
    data = bars(symbols, a.lookback)
    out = {}
    for s in symbols:
        bs = data.get(s, [])
        today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
        bs = [b for b in bs if b["t"][:10] < today]  # solo sedute finite
        if len(bs) < 60: continue
        df = to_df(bs[-a.lookback:])
        last_ts = df["timestamps"].iloc[-1]
        y_ts = pd.Series(pd.bdate_range(last_ts + pd.Timedelta(days=1), periods=horizon))
        t0 = time.time()
        pred = predictor.predict(df=df[["open", "high", "low", "close", "volume", "amount"]], x_timestamp=df["timestamps"], y_timestamp=y_ts, pred_len=horizon, T=a.T, top_p=a.top_p, sample_count=a.samples, verbose=False)
        last = float(df["close"].iloc[-1])
        path = [float(x) / last - 1 for x in pred["close"].values]
        out[s] = {"pred_ret": path[-1], "path": path, "last_close": last, "seconds": round(time.time() - t0, 2)}
    return out

class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self._json(200, {"ok": True, "model": a.model, "lookback": a.lookback})
    def do_POST(self):
        if self.path != "/forecast": return self._json(404, {"error": "non trovato"})
        try:
            n = int(self.headers.get("content-length", "0")); body = json.loads(self.rfile.read(n) or b"{}")
            symbols = [str(x) for x in body.get("symbols", [])][:30]; horizon = max(1, min(20, int(body.get("horizon", 5))))
            self._json(200, {"model": a.model, "horizon": horizon, "forecasts": forecast(symbols, horizon)})
        except Exception as e:
            self._json(500, {"error": str(e)})
    def log_message(self, fmt, *args): print(time.strftime("%H:%M:%S"), fmt % args)

print(f"Kronos-{a.model} pronto su http://127.0.0.1:{a.port} (lookback {a.lookback}, {a.samples} campioni)")
ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
