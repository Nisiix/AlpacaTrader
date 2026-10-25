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

export function momentum(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const a = closes[closes.length - 1 - n]!;
  return a > 0 ? closes[closes.length - 1]! / a - 1 : null;
}

export interface Indicator {
  sma50: number | null;
  sopraMedia: boolean | null;
  volGiornaliera: number | null;
  momentum20: number | null;
}

export function indicatorsFor(closes: Record<string, number[]>, prices: Record<string, number>, smaDays: number, volDays: number): Record<string, Indicator> {
  const out: Record<string, Indicator> = {};
  for (const [sym, c] of Object.entries(closes)) {
    const m = sma(c, smaDays);
    const p = prices[sym] ?? c[c.length - 1];
    out[sym] = { sma50: m, sopraMedia: m === null || p === undefined ? null : p > m, volGiornaliera: dailyVol(c, volDays), momentum20: momentum(c, 20) };
  }
  return out;
}
