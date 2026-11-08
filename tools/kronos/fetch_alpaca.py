# Scarica barre da Alpaca (IEX / crypto) in CSV con colonne timestamps,open,high,low,close,volume,amount.
import json, os, sys, urllib.request, urllib.parse, csv, datetime as dt
K, S = os.environ["ALPACA_KEY_ID"], os.environ["ALPACA_SECRET_KEY"]
def get(url):
    req = urllib.request.Request(url, headers={"APCA-API-KEY-ID": K, "APCA-API-SECRET-KEY": S})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
def bars(symbols, timeframe, start, end, crypto=False):
    out = {s: [] for s in symbols}
    base = "https://data.alpaca.markets/v1beta3/crypto/us/bars" if crypto else "https://data.alpaca.markets/v2/stocks/bars"
    tok = None
    while True:
        q = {"symbols": ",".join(symbols), "timeframe": timeframe, "start": start, "end": end, "limit": 10000}
        if not crypto: q.update({"feed": "iex", "adjustment": "split"})
        if tok: q["page_token"] = tok
        d = get(base + "?" + urllib.parse.urlencode(q))
        for s, bs in d.get("bars", {}).items(): out[s].extend(bs)
        tok = d.get("next_page_token")
        if not tok: break
    return out
def save(name, bs):
    os.makedirs("data", exist_ok=True)
    with open(f"data/{name}.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["timestamps", "open", "high", "low", "close", "volume", "amount"])
        for b in bs: w.writerow([b["t"], b["o"], b["h"], b["l"], b["c"], b["v"], round(b["v"] * b["vw"], 2)])
    print(name, len(bs), bs[0]["t"] if bs else None, bs[-1]["t"] if bs else None)
now = dt.datetime.now(dt.timezone.utc)
end = (now - dt.timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
uni = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"]
d = bars(uni, "1Day", "2016-01-01", end)
for s, bs in d.items(): save(f"{s}_1d", bs)
d = bars(["SPY", "NVDA", "AAPL"], "5Min", "2026-07-01T00:00:00Z", end)
for s, bs in d.items(): save(f"{s}_5m", bs)
d = bars(["BTC/USD", "ETH/USD"], "1Hour", "2025-01-01T00:00:00Z", end, crypto=True)
for s, bs in d.items(): save(f"{s.replace('/', '')}_1h", bs)
