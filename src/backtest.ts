import type { ProposedOrder } from "./brain/types.ts";
import type { Position } from "./broker/types.ts";
import { evaluateBreaker, type BreakerFile } from "./breaker.ts";
import { applyCage, maxWeightFor } from "./cage.ts";
import { LIMITS, UNIVERSE } from "./config.ts";
import { momentum, trendOf } from "./indicators.ts";
import { MIX } from "./benchmark.ts";
import { activeLessons, emptyLessons, learnFromStopLoss } from "./lessons.ts";
import { addTradingDays } from "./slots.ts";

export interface BacktestResult {
  days: number;
  totalReturn: number;
  spyReturn: number;
  mixReturn: number; // 60/40 SPY/TLT comprato e tenuto
  maxDrawdown: number;
  trades: number;
  stopOuts: number;
  trendExits: number;
  blockedByLessons: number;
  breakerTrips: number;
  rejectedByCage: Record<string, number>;
}

// Il metodo dichiarato, scritto in codice: fa le veci del modello nel backtest, così si prova la gabbia, non il modello.
// Le vendite non servono: uscita di trend e stop le fa la gabbia.
export function methodProposals(day: number, closes: Record<string, number[]>, positions: Map<string, { qty: number; avg: number }>, equity: number): ProposedOrder[] {
  const out: ProposedOrder[] = [];
  const hist = (s: string) => closes[s]!.slice(0, day + 1);
  const candidates = UNIVERSE.filter((s) => closes[s] && closes[s]!.length > day)
    .map((s) => ({ s, h: hist(s) }))
    .filter(({ h }) => {
      const t = trendOf(h, LIMITS.trendSmaDays, LIMITS.longSmaDays);
      return t !== null && t.close > t.sma && t.close > t.long;
    })
    .sort((a, b) => (momentum(b.h, LIMITS.rankMomentumDays) ?? 0) - (momentum(a.h, LIMITS.rankMomentumDays) ?? 0))
    .slice(0, LIMITS.maxPositions);
  for (const { s, h } of candidates) {
    const price = h.at(-1)!;
    const target = maxWeightFor(h).max * 0.98 * equity;
    const have = (positions.get(s)?.qty ?? 0) * price;
    const qty = Math.floor((target - have) / price);
    if (qty >= 1 && (target - have) / equity > 0.02) out.push({ symbol: s, side: "buy", qty, why: "trend" });
  }
  return out;
}

// Rigioca la gabbia giorno per giorno sulle chiusure. Gli ordini si eseguono alla chiusura e lo stop
// loss si controlla una volta al giorno: è più ottimista della realtà sui buchi intraday.
// Il calendario di Fed e trimestrali non ha storico: nel backtest quel blocco non scatta.
// breakerResetDays simula te che riarmi l'interruttore dopo tanti giorni di borsa (null = mai, come prima).
export function runBacktest(closes: Record<string, number[]>, startEquity = 100_000, startDate = "2026-01-05", breakerResetDays: number | null = null): BacktestResult {
  const len = Math.min(...UNIVERSE.filter((s) => closes[s]).map((s) => closes[s]!.length));
  const positions = new Map<string, { qty: number; avg: number }>();
  let cash = startEquity;
  let lastEquity = startEquity;
  let breaker: BreakerFile | null = null;
  const lessons = emptyLessons();
  const r: BacktestResult = { days: 0, totalReturn: 0, spyReturn: 0, mixReturn: 0, maxDrawdown: 0, trades: 0, stopOuts: 0, trendExits: 0, blockedByLessons: 0, breakerTrips: 0, rejectedByCage: {} };
  let trippedDay: number | null = null;
  let peak = startEquity;
  let date = startDate;
  const first = LIMITS.longSmaDays;

  for (let day = first; day < len; day++, date = addTradingDays(date, 1)) {
    const prices: Record<string, number> = {};
    for (const s of UNIVERSE) if (closes[s]) prices[s] = closes[s]![day]!;
    const equity = cash + [...positions].reduce((a, [s, p]) => a + p.qty * prices[s]!, 0);
    if (breakerResetDays !== null && trippedDay !== null && day - trippedDay >= breakerResetDays) {
      breaker = null;
      trippedDay = null;
    }
    const ev = evaluateBreaker(breaker, equity, lastEquity, date);
    breaker = ev.file;
    if (ev.newlyTripped) {
      r.breakerTrips++;
      trippedDay = day;
    }
    const pos: Position[] = [...positions].map(([symbol, p]) => ({ symbol, qty: p.qty, avgEntryPrice: p.avg, currentPrice: prices[symbol]!, marketValue: p.qty * prices[symbol]! }));
    const hist: Record<string, number[]> = {};
    for (const s of UNIVERSE) if (closes[s]) hist[s] = closes[s]!.slice(0, day + 1);
    const cage = applyCage({
      today: date,
      events: [],
      slotKind: "open",
      marketOpen: true,
      latenessMin: 0,
      account: { equity, lastEquity, cash, status: "ACTIVE" },
      positions: pos,
      prices,
      closes: hist,
      recentOrders: [],
      lessons: activeLessons(lessons, date),
      buyBlock: ev.buyBlock,
      proposals: methodProposals(day, closes, positions, equity),
    });
    for (const x of cage.rejected) {
      const k = x.reason.split(":")[0]!.replace(/[0-9.,%$]+/g, "#").slice(0, 60);
      r.rejectedByCage[k] = (r.rejectedByCage[k] ?? 0) + 1;
      if (x.reason.startsWith("lezione")) r.blockedByLessons++;
    }
    for (const o of cage.orders) {
      const price = prices[o.symbol]!;
      const p = positions.get(o.symbol) ?? { qty: 0, avg: 0 };
      if (o.side === "buy") {
        p.avg = (p.avg * p.qty + price * o.qty) / (p.qty + o.qty);
        p.qty += o.qty;
        cash -= o.qty * price;
      } else {
        p.qty -= o.qty;
        cash += o.qty * price;
        if (o.source === "uscita-trend") r.trendExits++;
        if (o.source === "stop-loss") {
          r.stopOuts++;
          learnFromStopLoss(lessons, `bt-${o.symbol}-${date}`, o.symbol, date, o.why);
        }
      }
      if (p.qty > 0) positions.set(o.symbol, p);
      else positions.delete(o.symbol);
      r.trades++;
    }
    const after = cash + [...positions].reduce((a, [s, p]) => a + p.qty * prices[s]!, 0);
    peak = Math.max(peak, after);
    r.maxDrawdown = Math.max(r.maxDrawdown, 1 - after / peak);
    lastEquity = after;
    r.days++;
  }
  r.totalReturn = lastEquity / startEquity - 1;
  const spy = closes.SPY;
  r.spyReturn = spy && len > first ? spy[len - 1]! / spy[first]! - 1 : 0;
  const tlt = closes.TLT;
  r.mixReturn = spy && tlt && len > first ? MIX.spy * r.spyReturn + MIX.tlt * (tlt[len - 1]! / tlt[first]! - 1) : 0;
  return r;
}
