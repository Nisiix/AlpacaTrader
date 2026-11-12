# Sidecar Kronos per il motore degli agenti. POST /forecast con
#   {"series": {"SPY": [{"t": "2026-01-02", "o":..,"h":..,"l":..,"c":..,"v":..}, ...]}, "horizon": 5}   (barre dal motore)
#   oppure {"symbols": [...], "horizon": 5}   (le barre le scarica il sidecar da Alpaca: servono ALPACA_KEY_ID/SECRET)
# -> {"forecasts": {"SPY": {"pred_ret": 0.012, "path": [..], "last_close": .., "modelli": {"kronos": [..], "chronos2": [..]}}}}:
# rendimento previsto della chiusura a `horizon` passi e il percorso passo per passo (di Kronos, il modello principale), più
# il percorso di ogni modello caricato. Il motore li combina pesandoli per i risultati che ognuno ha avuto davvero.
# Con "percorsi": true anche "campioni": i singoli percorsi di Kronos (rendimenti), da cui il motore conta quanti chiudono
# sopra i costi (la probabilità) e quanto scendono i peggiori (lo stop).
# Modelli (--modelli, separati da virgola): kronos (sempre; candele OHLCV, addestrato sui mercati), chronos2 (Amazon
# Chronos-2, Apache 2.0) e timesfm (Google TimesFM 2.5, Apache 2.0): generici, sulla serie delle chiusure. Quelli non
# installati si saltano. Nessun ordine parte da qui.
# Uso: ./venv/bin/python server.py [--model small] [--port 8765] [--lookback 400] [--samples 3] [--modelli kronos,chronos2,timesfm]
import argparse, json, os, sys, datetime as dt, urllib.request, urllib.parse, time, threading, gc
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
ap.add_argument("--modelli", default="kronos")
a = ap.parse_args()
VOLUTI = {x.strip() for x in a.modelli.split(",") if x.strip()}
TOK = {"mini": "NeoQuasar/Kronos-Tokenizer-2k", "small": "NeoQuasar/Kronos-Tokenizer-base", "base": "NeoQuasar/Kronos-Tokenizer-base"}
CTX = {"mini": 2048, "small": 512, "base": 512}
tokenizer = KronosTokenizer.from_pretrained(TOK[a.model])
model = Kronos.from_pretrained(f"NeoQuasar/Kronos-{a.model}")
predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=min(CTX[a.model], a.lookback))
# Modelli generici facoltativi: se il pacchetto o i pesi mancano si lavora con quelli che ci sono.
EXTRA = {}
if "chronos2" in VOLUTI:
    try:
        from chronos import BaseChronosPipeline
        EXTRA["chronos2"] = BaseChronosPipeline.from_pretrained("amazon/chronos-2", device_map="cpu")
        print("Chronos-2 pronto")
    except Exception as e:
        print(f"Chronos-2 non disponibile ({e}): installa con installa-kronos")
if "timesfm" in VOLUTI:
    try:
        import timesfm
        # Pesi 2.5 (Apache 2.0): quelli di TimesFM 3 sono solo per uso non commerciale.
        _tf = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
        _tf.compile(timesfm.ForecastConfig(max_context=512, max_horizon=64, normalize_inputs=True, use_continuous_quantile_head=True, fix_quantile_crossing=True))
        EXTRA["timesfm"] = _tf
        print("TimesFM 2.5 pronto")
    except Exception as e:
        print(f"TimesFM 2.5 non disponibile ({e}): installa con installa-kronos")
CARICATI = ["kronos", *EXTRA.keys()]

def generici(chiusure, horizon):
    """Percorsi dei modelli generici per un gruppo di serie di chiusure: {modello: [percorso in prezzi, ...]}."""
    out = {}
    if not chiusure: return out
    if "chronos2" in EXTRA:
        try:
            _, mean = EXTRA["chronos2"].predict_quantiles([torch.tensor(c, dtype=torch.float32) for c in chiusure], prediction_length=horizon, quantile_levels=[0.5])
            out["chronos2"] = [np.asarray(m.float().reshape(-1).numpy())[:horizon] for m in mean]
        except Exception as e:
            print(f"Chronos-2: {e}")
    if "timesfm" in EXTRA:
        try:
            pts, _ = EXTRA["timesfm"].forecast(horizon=horizon, inputs=[np.asarray(c, dtype=np.float32) for c in chiusure])
            out["timesfm"] = [np.asarray(p, dtype=np.float64)[:horizon] for p in pts]
        except Exception as e:
            print(f"TimesFM: {e}")
    return out

K, S = os.environ.get("ALPACA_KEY_ID", ""), os.environ.get("ALPACA_SECRET_KEY", "")
if not K or not S: print("senza ALPACA_KEY_ID/SECRET il sidecar accetta solo barre inviate dal motore (campo series)")

def bars(symbols, days):
    if not K or not S: raise RuntimeError("barre non inviate e chiavi Alpaca assenti")
    start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(days * 1.6) + 30)).strftime("%Y-%m-%dT00:00:00Z")
    end = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {s: [] for s in symbols}
    groups = [("https://data.alpaca.markets/v2/stocks/bars", [s for s in symbols if "/" not in s], {"feed": "iex", "adjustment": "split"}),
              ("https://data.alpaca.markets/v1beta3/crypto/us/bars", [s for s in symbols if "/" in s], {})]
    for base, syms, extra in groups:
        if not syms: continue
        tok = None
        while True:
            q = {"symbols": ",".join(syms), "timeframe": "1Day", "start": start, "end": end, "limit": 10000, **extra}
            if tok: q["page_token"] = tok
            req = urllib.request.Request(base + "?" + urllib.parse.urlencode(q), headers={"APCA-API-KEY-ID": K, "APCA-API-SECRET-KEY": S})
            with urllib.request.urlopen(req, timeout=30) as r: d = json.load(r)
            for s, bs in d.get("bars", {}).items(): out.setdefault(s, []).extend(bs)
            tok = d.get("next_page_token")
            if not tok: break
    return out

def to_df(bs):
    df = pd.DataFrame([{"timestamps": b["t"], "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": b.get("v", 0) or 0, "amount": (b.get("v", 0) or 0) * (b.get("vw") or b["c"])} for b in bs])
    df["timestamps"] = pd.to_datetime(df["timestamps"])
    return df

def memoria_mb():
    """Memoria del processo in MB: privata (quella che cresce con le perdite) e in uso. Il motore la legge da GET / per
    riavviare il sidecar prima che il PC resti senza memoria (10/11/2026: «not enough memory» e motore chiuso)."""
    try:
        import psutil
        m = psutil.Process().memory_info()
        return {"privata": round(getattr(m, "private", m.rss) / 1e6), "uso": round(m.rss / 1e6)}
    except Exception:
        pass
    try:
        if os.name == "nt":
            import ctypes, ctypes.wintypes as w
            class PMC(ctypes.Structure):
                _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            c = PMC(); c.cb = ctypes.sizeof(c)
            k32 = ctypes.WinDLL("kernel32"); psapi = ctypes.WinDLL("psapi")
            k32.GetCurrentProcess.restype = w.HANDLE
            psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb)
            return {"privata": round(c.PagefileUsage / 1e6), "uso": round(c.WorkingSetSize / 1e6)}
        import resource
        return {"privata": None, "uso": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)}
    except Exception:
        return {"privata": None, "uso": None}

# Un solo lavoro di Kronos alla volta: due richieste insieme (agenti e grafici della dashboard) si contendono i core della
# CPU e rallentano tutte e due più che in fila.
LAVORO = threading.Lock()
# Quante sequenze per chiamata al modello (titoli × campioni): abbastanza per sfruttare la CPU, non troppe per la memoria.
LOTTO = 48

def campioni_kronos(voci, horizon, n_samples):
    """voci: [(simbolo, df, y_ts)]. Per ogni simbolo i percorsi di chiusura dei singoli campioni (n_samples × horizon).
    Kronos con sample_count > 1 restituisce solo la media dei percorsi: qui ogni campione è una riga del lotto (stessa serie
    ripetuta, sample_count=1), così si sa anche quanti percorsi salgono e quanto scendono nel peggiore dei casi; e più titoli
    vanno nella stessa chiamata (le serie di un lotto si tagliano alla stessa lunghezza, la più corta del lotto)."""
    out = {}
    per = max(1, LOTTO // n_samples)
    voci = sorted(voci, key=lambda x: len(x[1]), reverse=True)
    cols = ["open", "high", "low", "close", "volume", "amount"]
    for i in range(0, len(voci), per):
        grp = voci[i:i + per]
        L = min(len(x[1]) for x in grp)
        dfs, xts, yts = [], [], []
        for _, df, y in grp:
            d = df.iloc[-L:].reset_index(drop=True)
            for _ in range(n_samples):
                dfs.append(d[cols]); xts.append(d["timestamps"]); yts.append(y)
        preds = predictor.predict_batch(dfs, xts, yts, pred_len=horizon, T=a.T, top_p=a.top_p, sample_count=1, verbose=False)
        for j, (s, _, _) in enumerate(grp):
            out[s] = np.stack([p["close"].to_numpy(dtype=np.float64) for p in preds[j * n_samples:(j + 1) * n_samples]])
    return out

def forecast(symbols, horizon, series=None, step_minutes=None, samples=None, percorsi=False):
    # Campioni: quanti percorsi Kronos genera per ogni serie. Più campioni = media più stabile (l'errore casuale scende con
    # la radice del numero), ma tempo proporzionale. Il motore li sceglie richiesta per richiesta. Con `percorsi` si
    # restituiscono anche i singoli percorsi (rendimenti), per la probabilità e lo stop dai campioni.
    n_samples = max(1, min(128, int(samples or a.samples)))
    data = series if series is not None else bars(symbols, a.lookback)
    voci = []
    for s in symbols:
        bs = data.get(s, [])
        if not step_minutes and series is None:
            # Barre scaricate qui: solo sedute finite. Quelle mandate dal motore sono già solo giornate concluse.
            today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
            bs = [b for b in bs if str(b["t"])[:10] < today]
        if len(bs) < 60: continue
        df = to_df(bs[-a.lookback:])
        last_ts = df["timestamps"].iloc[-1]
        # Candele intraday (step_minutes): le prossime `horizon` candele dello stesso passo; altrimenti giorni di borsa.
        if step_minutes:
            y_ts = pd.Series(pd.date_range(last_ts + pd.Timedelta(minutes=step_minutes), periods=horizon, freq=f"{int(step_minutes)}min"))
        else:
            y_ts = pd.Series(pd.bdate_range(last_ts + pd.Timedelta(days=1), periods=horizon))
        voci.append((s, df, y_ts))
    out = {}
    t0 = time.time()
    with LAVORO, torch.inference_mode():
        try:
            tutti = campioni_kronos(voci, horizon, n_samples)
        except Exception as e:
            # Lotto non riuscito (versione di Kronos senza predict_batch, memoria): una serie alla volta, solo la media.
            print(f"lotto non riuscito ({e}): una serie alla volta")
            tutti = None
        for s, df, y_ts in voci:
            last = float(df["close"].iloc[-1])
            if tutti is not None and s in tutti:
                camp = tutti[s] / last - 1
                path = [float(x) for x in camp.mean(axis=0)]
            else:
                pred = predictor.predict(df=df[["open", "high", "low", "close", "volume", "amount"]], x_timestamp=df["timestamps"], y_timestamp=y_ts, pred_len=horizon, T=a.T, top_p=a.top_p, sample_count=n_samples, verbose=False)
                camp = None
                path = [float(x) / last - 1 for x in pred["close"].values]
            out[s] = {"pred_ret": path[-1], "path": path, "last_close": last, "modelli": {"kronos": path}, "_c": df["close"].to_numpy(dtype=np.float64)}
            if percorsi and camp is not None: out[s]["campioni"] = [[round(float(x), 6) for x in r] for r in camp]
        # I modelli generici in un colpo solo su tutte le serie (le chiusure, non le candele intere).
        nomi = list(out.keys())
        for modello, pp_tutti in generici([out[s]["_c"] for s in nomi], horizon).items():
            for s, pp in zip(nomi, pp_tutti):
                last = out[s]["last_close"]
                if len(pp) and np.all(np.isfinite(pp)) and last > 0: out[s]["modelli"][modello] = [float(x) / last - 1 for x in pp]
    for s in nomi:
        del out[s]["_c"]
        out[s]["seconds"] = round((time.time() - t0) / max(1, len(nomi)), 2)
    # I tensori dei lotti grandi (titoli × campioni × lookback) si liberano subito, non al prossimo giro del garbage collector.
    gc.collect()
    return out

class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self._json(200, {"ok": True, "model": a.model, "lookback": a.lookback, "pronto": True, "modelli": CARICATI, "percorsi": True, "memoria": memoria_mb()})
    def do_POST(self):
        if self.path != "/forecast": return self._json(404, {"error": "non trovato"})
        try:
            n = int(self.headers.get("content-length", "0")); body = json.loads(self.rfile.read(n) or b"{}")
            series = body.get("series")
            symbols = [str(x) for x in (body.get("symbols") or (list(series.keys()) if isinstance(series, dict) else []))][:60]
            horizon = max(1, min(20, int(body.get("horizon", 5))))
            samples = body.get("samples")
            t0 = time.time()
            out = forecast(symbols, horizon, series if isinstance(series, dict) else None, body.get("step_minutes"), samples, bool(body.get("percorsi")))
            secs = round(time.time() - t0, 2)
            print(f"previsione: {len(out)} serie, {samples or a.samples} campioni, passo {body.get('step_minutes') or 'giorno'}, {secs} s")
            self._json(200, {"model": a.model, "horizon": horizon, "samples": samples or a.samples, "secondi": secs, "forecasts": out})
        except Exception as e:
            self._json(500, {"error": str(e)})
    def log_message(self, fmt, *args): print(time.strftime("%H:%M:%S"), fmt % args)

print(f"Kronos-{a.model} pronto su http://127.0.0.1:{a.port} (lookback {a.lookback}, {a.samples} campioni; modelli: {', '.join(CARICATI)})")
ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
