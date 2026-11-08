# Valutazione zero-shot di Kronos su barre Alpaca: previsione rolling, accuratezza di direzione, IC, MAE, tempo.
import argparse, sys, time, json, os
import numpy as np, pandas as pd, torch
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kronos-src"))
from model import Kronos, KronosTokenizer, KronosPredictor

ap = argparse.ArgumentParser()
ap.add_argument("--csv", required=True)
ap.add_argument("--model", default="mini", choices=["mini", "small", "base"])
ap.add_argument("--lookback", type=int, default=400)
ap.add_argument("--pred_len", type=int, default=5)
ap.add_argument("--tests", type=int, default=60)
ap.add_argument("--step", type=int, default=1)
ap.add_argument("--samples", type=int, default=3)
ap.add_argument("--T", type=float, default=1.0)
ap.add_argument("--top_p", type=float, default=0.9)
ap.add_argument("--out", default=None)
ap.add_argument("--rows", default=None)
a = ap.parse_args()

TOK = {"mini": "NeoQuasar/Kronos-Tokenizer-2k", "small": "NeoQuasar/Kronos-Tokenizer-base", "base": "NeoQuasar/Kronos-Tokenizer-base"}
CTX = {"mini": 2048, "small": 512, "base": 512}
torch.manual_seed(0); np.random.seed(0)
t0 = time.time()
tokenizer = KronosTokenizer.from_pretrained(TOK[a.model])
model = Kronos.from_pretrained(f"NeoQuasar/Kronos-{a.model}")
predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=min(CTX[a.model], a.lookback))
load_s = time.time() - t0
nparams = sum(p.numel() for p in model.parameters())

df = pd.read_csv(a.csv)
df["timestamps"] = pd.to_datetime(df["timestamps"])
df = df.reset_index(drop=True)
cols = ["open", "high", "low", "close", "volume", "amount"]
n = len(df)
starts = list(range(n - a.pred_len - a.tests * a.step, n - a.pred_len, a.step))
rows = []
tp = []
for end in starts:  # end = indice dell'ultima barra nota (esclusa dalla previsione)
    lo = end - a.lookback + 1
    if lo < 0: continue
    x_df = df.loc[lo:end, cols]
    x_ts = df.loc[lo:end, "timestamps"]
    y_ts = df.loc[end + 1:end + a.pred_len, "timestamps"]
    t1 = time.time()
    pred = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=a.pred_len, T=a.T, top_p=a.top_p, sample_count=a.samples, verbose=False)
    tp.append(time.time() - t1)
    last = float(df.loc[end, "close"])
    for h in range(1, a.pred_len + 1):
        pc = float(pred["close"].iloc[h - 1]); ac = float(df.loc[end + h, "close"])
        rows.append({"t": str(df.loc[end, "timestamps"]), "h": h, "pred_ret": pc / last - 1, "real_ret": ac / last - 1})
r = pd.DataFrame(rows)
def summarize(g):
    pr, rr = g["pred_ret"].values, g["real_ret"].values
    ok = np.sign(pr) == np.sign(rr)
    up = (rr > 0).mean()
    ic = pd.Series(pr).rank().corr(pd.Series(rr).rank()) if len(pr) > 2 else float("nan")
    return {"n": int(len(g)), "dir_acc": float(ok.mean()), "base_rate_up": float(up), "best_const": float(max(up, 1 - up)),
            "spearman_ic": float(ic), "mae_pred": float(np.abs(pr - rr).mean()), "mae_zero": float(np.abs(rr).mean()),
            # strategia ingenua: long se previsto >0, short se <0, su ogni orizzonte
            "mean_ret_if_follow": float(np.mean(np.sign(pr) * rr)), "mean_abs_real": float(np.abs(rr).mean())}
out = {"csv": os.path.basename(a.csv), "model": a.model, "params": nparams, "lookback": a.lookback, "pred_len": a.pred_len, "tests": len(starts), "samples": a.samples,
       "load_s": round(load_s, 1), "sec_per_forecast": round(float(np.mean(tp)), 2), "by_horizon": {int(h): summarize(g) for h, g in r.groupby("h")}}
print(json.dumps(out, indent=1))
if a.rows: r.to_csv(a.rows, index=False)
if a.out:
    with open(a.out, "w") as f: json.dump(out, f, indent=1)
