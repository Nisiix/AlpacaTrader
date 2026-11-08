# Accuratezza di direzione quando si agisce solo sulle previsioni più nette (|rendimento previsto| nel top 25% / 10%).
# Uso: python selectivity.py docs/kronos-risultati/rows_SPY_1d_small.csv
import sys, pandas as pd, numpy as np
r = pd.read_csv(sys.argv[1])
print("orizz. | tutte: dir base | top 25%: dir n | top 10%: dir n | previsto 'sale': dir n | previsto 'scende': dir n")
for h, g in r.groupby("h"):
    pr, rr = g.pred_ret.values, g.real_ret.values
    ok = np.sign(pr) == np.sign(rr)
    base = max((rr > 0).mean(), (rr <= 0).mean())
    m75 = np.abs(pr) >= np.quantile(np.abs(pr), 0.75); m90 = np.abs(pr) >= np.quantile(np.abs(pr), 0.90)
    up, dn = pr > 0, pr < 0
    print(f"h{h} | {ok.mean()*100:.0f}% {base*100:.0f}% | {ok[m75].mean()*100:.0f}% {m75.sum()} | {ok[m90].mean()*100:.0f}% {m90.sum()} | {ok[up].mean()*100:.0f}% {up.sum()} | {ok[dn].mean()*100:.0f}% {dn.sum()}")
