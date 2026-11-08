import type { IntradayBar } from "../broker/types.ts";
import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { dailyVol, trendOf } from "../indicators.ts";
import { romeTime } from "../slots.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// L'agente intraday: operazioni che nascono e muoiono nella stessa giornata, solo nel verso del trend giornaliero.
// Sceglie da solo la candela dalla volatilità del titolo (nervoso → 5 minuti, medio → 15, calmo → 4 ore), entra su una
// rottura dei massimi delle ultime 20 candele o su un rientro sulla media a 20 candele con RSI non tirato, e porta a
// casa: obiettivo di profitto (percentuale o 1,5 ATR, il maggiore), stop a 1,2 ATR, uscita se il prezzo rompe al ribasso
// la media a 20 candele, e comunque chiusura prima della fine della giornata. Le uscite sono regole vincolanti.
export type BarFetcher = (symbols: string[], timeframe: string, count: number) => Promise<Record<string, IntradayBar[]>>;

export interface IntradayStato {
  simbolo: string;
  candela: string; // "5Min" | "15Min" | "4Hour"
  fase: "in posizione" | "cerca ingresso" | "fuori orario" | "fermo";
  ingresso: number | null;
  obiettivo: number | null;
  stop: number | null;
  prezzo: number | null;
  motivo: string;
}

const tfMinutes = (tf: string) => (tf.endsWith("Min") ? Number(tf.replace("Min", "")) : tf.endsWith("Hour") ? Number(tf.replace("Hour", "")) * 60 : 1440);
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const num = (x: number) => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toFixed(5));

export function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

export function atr(bars: IntradayBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!, prev = bars[i - 1]!;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  }
  return sum / n;
}

export function rsiOf(values: number[], n = 14): number | null {
  if (values.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// La candela giusta per il titolo: dalla volatilità giornaliera.
export function timeframeFor(closes: number[] | undefined): string {
  const v = closes ? dailyVol(closes, LIMITS.volLookbackDays) : null;
  const c = AGENTS.intraday;
  if (v === null) return c.timeframes.mid;
  return v >= c.volFast ? c.timeframes.fast : v >= c.volMid ? c.timeframes.mid : c.timeframes.slow;
}

// Lettura di una serie di candele: ingresso (rottura o rientro), livelli di obiettivo e stop.
export function readBars(bars: IntradayBar[], price: number, crypto: boolean): { entra: boolean; pattern: string; ema20: number | null; atr: number | null; rsi: number | null; targetPct: number; stopPct: number } {
  const c = AGENTS.intraday;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const a = atr(bars, 14);
  const r = rsiOf(closes, 14);
  const base = { ema20: e20, atr: a, rsi: r };
  const minTarget = crypto ? c.target.crypto : c.target.stocks;
  if (e20 === null || a === null || bars.length < 22) return { ...base, entra: false, pattern: "candele insufficienti", targetPct: minTarget, stopPct: c.minStopPct };
  const targetPct = Math.max(minTarget, (c.targetAtr * a) / price);
  const stopPct = Math.max(c.minStopPct, (c.stopAtr * a) / price);
  const last = bars[bars.length - 1]!, prev = bars[bars.length - 2]!;
  const prevHigh = Math.max(...bars.slice(-21, -1).map((b) => b.high));
  // Rottura: chiusura sopra i massimi delle 20 candele precedenti, con un movimento vero (almeno mezzo ATR).
  const breakout = last.close > prevHigh && last.close > e20 && last.close - prev.close >= 0.5 * a;
  // Rientro: trend sulla candela già in corso (le 6 candele prima del rientro chiuse sopra la media), la candela precedente
  // tocca la media (entro 0,2%) e l'ultima riparte chiudendo sopra il massimo di quella del rientro.
  const before = bars.slice(-8, -2);
  const trendOnTf = before.length === 6 && before.every((b) => b.close > e20);
  const pullback = trendOnTf && prev.low <= e20 * 1.002 && prev.low >= e20 * 0.99 && last.close > prev.high && last.close > e20 && last.close - prev.low >= 0.5 * a;
  // Troppo esteso: oltre 3 ATR sopra il livello di rottura (o la media a 20) si insegue, non si entra.
  const ext = (last.close - Math.max(prevHigh, e20)) / a;
  const tired = ext > c.maxExtensionAtr;
  const pattern = tired ? `${ext.toFixed(1)} ATR sopra la media a 20: troppo esteso per entrare` : breakout ? `rottura dei massimi delle ultime 20 candele (${num(prevHigh)}) sopra la media a 20 (${num(e20)})` : pullback ? `rientro sulla media a 20 candele (${num(e20)}) e ripartenza` : "nessun ingresso: né rottura né rientro";
  return { ...base, entra: !tired && (breakout || pullback), pattern, targetPct, stopPct };
}

interface Operazione {
  simbolo: string;
  candela: string;
  giorno: string;
  ingresso: number;
  obiettivo: number;
  stop: number;
}

export class IntradayAgent implements Agent {
  readonly name = "intraday";
  private operazioni = new Map<string, Operazione>();
  private entrateOggi = new Map<string, string>(); // simbolo -> giorno dell'ultimo ingresso
  constructor(private fetchBars: BarFetcher) {}

  async observe(v: AgentView): Promise<AgentReport> {
    const c = AGENTS.intraday;
    const rt = romeTime(v.now);
    const segnali: Signal[] = [];
    const note: string[] = [];
    const stati: IntradayStato[] = [];
    const held = new Map(v.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
    // Le mie operazioni aperte: dal diario (trade aperti votati da "intraday") e dalla memoria del processo.
    const mine = new Set<string>();
    for (const t of v.journal.trade) if (t.stato === "aperto" && t.contesto?.agenti?.includes(this.name) && held.has(t.simbolo)) mine.add(t.simbolo);
    for (const s of this.operazioni.keys()) if (held.has(s)) mine.add(s);
    for (const s of [...this.operazioni.keys()]) if (!held.has(s)) this.operazioni.delete(s);
    // Ingressi di oggi già fatti (anche dal diario, se il processo è ripartito).
    for (const t of v.journal.trade) if (t.apertoIl && romeTime(new Date(t.apertoIl)).date === v.today && t.contesto?.agenti?.includes(this.name)) this.entrateOggi.set(t.simbolo, v.today);

    const inWindow = (s: string) => {
      const w = isCrypto(s) ? c.entry.crypto : c.entry.stocks;
      return rt.minutes >= minutesOf(w.from) && rt.minutes <= minutesOf(w.to) && (isCrypto(s) || (rt.weekday >= 1 && rt.weekday <= 5));
    };
    const mustClose = (s: string) => rt.minutes >= minutesOf(isCrypto(s) ? c.closeBy.crypto : c.closeBy.stocks);
    const closeByOf = (s: string) => minutesOf(isCrypto(s) ? c.closeBy.crypto : c.closeBy.stocks);

    // Candidate: universo in trend giornaliero, non in portafoglio, non già comprate oggi, contesto che non chiede di aspettare.
    const candidates: string[] = [];
    const open = [...mine].length;
    for (const s of AGENTS.universe) {
      if (held.has(s) || this.entrateOggi.get(s) === v.today) continue;
      if (!inWindow(s)) continue;
      const t = trendOf(v.closes[s], LIMITS.trendSmaDays, LIMITS.longSmaDays);
      const p = v.prices[s];
      if (!t || !p || p <= t.sma || t.close <= t.long) continue;
      if (v.contesto?.attendi[s]) continue;
      // Kronos anticipa: niente ingressi intraday contro una proiezione di ribasso.
      const fc = v.previsioni?.[s];
      if (fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia / 2) continue;
      candidates.push(s);
    }
    // Prima i titoli con la proiezione migliore.
    candidates.sort((a, b) => (v.previsioni?.[b] ?? 0) - (v.previsioni?.[a] ?? 0));
    const byTf = new Map<string, string[]>();
    const tfOf = new Map<string, string>();
    for (const s of [...mine, ...candidates]) {
      const tf = this.operazioni.get(s)?.candela ?? timeframeFor(v.closes[s]);
      tfOf.set(s, tf);
      byTf.set(tf, [...(byTf.get(tf) ?? []), s]);
    }
    const bars: Record<string, IntradayBar[]> = {};
    for (const [tf, syms] of byTf) {
      try {
        Object.assign(bars, await this.fetchBars(syms, tf, c.bars));
      } catch (e) {
        note.push(`candele ${tf} non disponibili: ${(e as Error).message}`);
      }
    }

    // Uscite, vincolanti: obiettivo, stop, media a 20 candele persa, fine giornata.
    for (const s of mine) {
      const p = held.get(s)!;
      const price = v.prices[s] ?? p.currentPrice;
      const tf = tfOf.get(s)!;
      const b = bars[s] ?? [];
      const read = b.length ? readBars(b, price, isCrypto(s)) : null;
      let op = this.operazioni.get(s);
      if (!op) {
        // Processo ripartito: livelli ricostruiti dal carico e dalle candele di adesso.
        const entry = p.avgEntryPrice;
        op = { simbolo: s, candela: tf, giorno: v.today, ingresso: entry, obiettivo: entry * (1 + (read?.targetPct ?? (isCrypto(s) ? c.target.crypto : c.target.stocks))), stop: entry * (1 - (read?.stopPct ?? c.minStopPct * 2)) };
        this.operazioni.set(s, op);
      }
      const why = (m: string) => `${s} intraday (${tf}): ${m}`;
      let motivo: string | null = null;
      if (price >= op.obiettivo) motivo = `obiettivo raggiunto: ${num(price)} ≥ ${num(op.obiettivo)} (${pct(price / op.ingresso - 1)} dall'ingresso)`;
      else if (price <= op.stop) motivo = `stop intraday: ${num(price)} ≤ ${num(op.stop)} (${pct(price / op.ingresso - 1)})`;
      else if (mustClose(s)) motivo = `chiusura di giornata alle ${isCrypto(s) ? c.closeBy.crypto : c.closeBy.stocks}: ${pct(price / op.ingresso - 1)} dall'ingresso`;
      else if (read?.ema20 && b.length >= 2 && b[b.length - 1]!.close < read.ema20 && b[b.length - 2]!.close < read.ema20) motivo = `due candele chiuse sotto la media a 20 (${num(read.ema20)}): il movimento è finito (${pct(price / op.ingresso - 1)})`;
      if (motivo) segnali.push({ agente: this.name, simbolo: s, lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, intraday: true, perche: why(motivo) });
      stati.push({ simbolo: s, candela: tf, fase: "in posizione", ingresso: op.ingresso, obiettivo: op.obiettivo, stop: op.stop, prezzo: price, motivo: motivo ?? `in corsa: obiettivo ${num(op.obiettivo)}, stop ${num(op.stop)}, ${pct(price / op.ingresso - 1)}` });
    }

    // Ingressi.
    let slots = c.maxOpen - open;
    for (const s of candidates) {
      const tf = tfOf.get(s)!;
      const price = v.prices[s]!;
      const b = bars[s];
      if (!b || b.length < 22) {
        stati.push({ simbolo: s, candela: tf, fase: "fermo", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: "candele insufficienti" });
        continue;
      }
      const read = readBars(b, price, isCrypto(s));
      // Resta tempo per arrivare all'obiettivo? Movimento atteso ≈ ATR × √(candele rimaste).
      const remainingBars = Math.max(0, (closeByOf(s) - rt.minutes) / tfMinutes(tf));
      const expected = read.atr !== null ? (read.atr * Math.sqrt(Math.max(1, remainingBars))) / price : 0;
      const reward = read.targetPct / read.stopPct;
      let motivo: string;
      if (slots <= 0) motivo = `già ${c.maxOpen} operazioni intraday aperte`;
      else if (!read.entra) motivo = read.pattern;
      else if (reward < 1.2) motivo = `rapporto obiettivo/stop ${reward.toFixed(2)} troppo basso`;
      else if (expected < read.targetPct * 0.8) motivo = `obiettivo ${pct(read.targetPct)} non raggiungibile entro la chiusura (atteso ${pct(expected)})`;
      else {
        slots--;
        const target = price * (1 + read.targetPct), stop = price * (1 - read.stopPct);
        this.operazioni.set(s, { simbolo: s, candela: tf, giorno: v.today, ingresso: price, obiettivo: target, stop });
        this.entrateOggi.set(s, v.today);
        segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: c.maxWeight, perche: `${s} intraday su candele ${tf}: ${read.pattern}; obiettivo ${num(target)} (${pct(read.targetPct)}), stop ${num(stop)} (${pct(-read.stopPct)}), chiusura entro le ${isCrypto(s) ? c.closeBy.crypto : c.closeBy.stocks}` });
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: price, obiettivo: target, stop, prezzo: price, motivo: `ingresso votato: ${read.pattern}` });
        continue;
      }
      stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo });
    }
    const n = segnali.filter((x) => x.lato === "buy").length;
    note.unshift(`${[...mine].length} operazioni aperte, ${candidates.length} candidate, ${n} ingressi votati${candidates.length ? ` · candele: ${[...byTf].map(([tf, ss]) => `${tf} ${ss.join(" ")}`).join("; ")}` : ""}`);
    return { segnali, note, intraday: stati };
  }
}
