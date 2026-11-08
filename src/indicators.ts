export function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  return w.reduce((a, b) => a + b, 0) / n;
}

// Deviazione standard dei rendimenti logaritmici giornalieri sugli ultimi n giorni.
export function dailyVol(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const w = closes.slice(-(n + 1));
  const r: number[] = [];
  for (let i = 1; i < w.length; i++) if (w[i - 1]! > 0 && w[i]! > 0) r.push(Math.log(w[i]! / w[i - 1]!));
  if (r.length < 2) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
}

// RSI di Wilder a n periodi sulle chiusure (RSI(2) per la mean reversion di Connors).
export function rsi(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  const rs = gain / n / (loss / n);
  return 100 - 100 / (1 + rs);
}

export function momentum(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const a = closes[closes.length - 1 - n]!;
  return a > 0 ? closes[closes.length - 1]! / a - 1 : null;
}

export interface Indicator {
  sma50: number | null;
  sopraMedia: boolean | null;
  sma200: number | null;
  sopraMedia200: boolean | null;
  volGiornaliera: number | null;
  momentum20: number | null;
  momentum120: number | null;
}

export function indicatorsFor(closes: Record<string, number[]>, prices: Record<string, number>, smaDays: number, volDays: number, longSmaDays = 200, rankDays = 120): Record<string, Indicator> {
  const out: Record<string, Indicator> = {};
  for (const [sym, c] of Object.entries(closes)) {
    const m = sma(c, smaDays);
    const l = sma(c, longSmaDays);
    const p = prices[sym] ?? c[c.length - 1];
    out[sym] = {
      sma50: m,
      sopraMedia: m === null || p === undefined ? null : p > m,
      sma200: l,
      sopraMedia200: l === null || p === undefined ? null : p > l,
      volGiornaliera: dailyVol(c, volDays),
      momentum20: momentum(c, 20),
      momentum120: momentum(c, rankDays),
    };
  }
  return out;
}

// Il trend si giudica sulle chiusure complete, non sul prezzo di metà seduta: una sola lettura al giorno, meno rumore.
export function trendOf(closes: number[] | undefined, smaDays: number, longSmaDays: number): { close: number; sma: number; long: number } | null {
  if (!closes || closes.length === 0) return null;
  const m = sma(closes, smaDays);
  const l = sma(closes, longSmaDays);
  return m === null || l === null ? null : { close: closes[closes.length - 1]!, sma: m, long: l };
}
