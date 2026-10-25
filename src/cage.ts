import type { ProposedOrder } from "./brain/types.ts";
import type { Account, Order, Position, Side } from "./broker/types.ts";
import { isOpenOrder, isProtectiveStop } from "./broker/types.ts";
import { ENTRY_SLOT, LIMITS, MAX_LATENESS_MIN, UNIVERSE, type SlotKind } from "./config.ts";
import { EVENTS, eventBlockFor, type MarketEvent } from "./events.ts";
import { dailyVol, indicatorsFor, sma, trendOf } from "./indicators.ts";
import { setupOf } from "./journal.ts";
import type { Lesson } from "./lessons.ts";
import { stopPctFor } from "./stops.ts";

function setupOfSymbol(i: CageInput, symbol: string): string {
  const c = i.closes[symbol];
  return c ? setupOf(indicatorsFor({ [symbol]: c }, i.prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays)[symbol]) : "dati insufficienti";
}

export interface PlannedOrder {
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  source: OrderSource;
}

// stop-loss = protezione contro i crolli; uscita-trend = l'uscita normale del metodo, decisa dal codice.
export type OrderSource = "modello" | "stop-loss" | "uscita-trend";

export interface Rejection {
  symbol: string;
  side: string;
  qty: number;
  reason: string;
  source: OrderSource;
}

export interface CageInput {
  today: string; // YYYY-MM-DD, per il calendario degli eventi
  events?: MarketEvent[]; // di serie il calendario di events.ts
  slotKind: SlotKind;
  marketOpen: boolean;
  latenessMin: number;
  account: Account;
  positions: Position[];
  prices: Record<string, number>;
  closes: Record<string, number[]>;
  recentOrders: Order[];
  lessons: Lesson[]; // solo quelle attive
  buyBlock: string | null; // interruttore sulla perdita
  proposals: ProposedOrder[];
}

export interface CageResult {
  orders: PlannedOrder[];
  rejected: Rejection[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function lossPct(p: Position): number {
  return p.avgEntryPrice > 0 ? (p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice : 0;
}

export function tradingBlockReason(i: Pick<CageInput, "slotKind" | "marketOpen" | "latenessMin" | "account">): string | null {
  if (i.slotKind === "briefing") return "briefing: nessun ordine";
  if (!i.marketOpen) return "mercato chiuso";
  if (i.latenessMin > MAX_LATENESS_MIN) return `sveglia in ritardo di ${i.latenessMin} minuti: l'ordine non ha più senso`;
  if (i.account.equity <= 0) return "conto senza patrimonio";
  return null;
}

// Peso massimo di un titolo: 20% del conto, meno se è nervoso (valore × volatilità ≤ rischio giornaliero ammesso).
export function maxWeightFor(closes: number[] | undefined): { max: number; vol: number; estimated: boolean } {
  const v = closes ? dailyVol(closes, LIMITS.volLookbackDays) : null;
  const vol = v ?? LIMITS.fallbackDailyVol;
  return { max: Math.min(LIMITS.maxPositionPct, LIMITS.dailyRiskPerPositionPct / vol), vol, estimated: v === null };
}

// Il modello propone, la gabbia dispone. Tutte le regole stanno qui, non nel prompt.
export function applyCage(i: CageInput): CageResult {
  const orders: PlannedOrder[] = [];
  const rejected: Rejection[] = [];
  const universe = new Set<string>(UNIVERSE);
  const held = new Map(i.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const stopLoss = i.positions.filter((p) => p.qty > 0 && lossPct(p) <= -stopPctFor(i.closes[p.symbol]));

  const block = tradingBlockReason(i);
  if (block) {
    for (const p of stopLoss) rejected.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "stop-loss", reason: `stop loss scattato (${pct(lossPct(p))}) ma ${block}: vendo alla prossima sveglia utile` });
    for (const p of i.proposals) rejected.push({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello", reason: block });
    return { orders, rejected };
  }

  const seen = new Set<string>();
  for (const p of stopLoss) {
    orders.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "stop-loss", why: `stop loss: ${pct(lossPct(p))} dal prezzo di carico` });
    seen.add(`${p.symbol}-sell`);
  }
  const stopped = new Set(stopLoss.map((p) => p.symbol));

  // Uscita di trend: alla sveglia di apertura, chi ha chiuso ieri sotto la media a 50 giorni esce tutto.
  // È il codice a farla, come lo stop: il metodo non dipende dal modello che se ne ricordi.
  if (i.slotKind === ENTRY_SLOT) {
    for (const p of i.positions) {
      if (p.qty <= 0 || stopped.has(p.symbol)) continue;
      const c = i.closes[p.symbol];
      const m = c ? sma(c, LIMITS.trendSmaDays) : null;
      const last = c?.[c.length - 1];
      if (m === null || last === undefined || last >= m) continue;
      orders.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "uscita-trend", why: `uscita di trend: chiusura ${last.toFixed(2)} sotto la media a ${LIMITS.trendSmaDays} giorni (${m.toFixed(2)})` });
      seen.add(`${p.symbol}-sell`);
      stopped.add(p.symbol);
    }
  }

  // Gli stop di protezione su Alpaca sono ordini aperti per scelta nostra: non contano come doppioni.
  const openOrders = i.recentOrders.filter((o) => isOpenOrder(o) && !isProtectiveStop(o));
  let cash = i.account.cash;
  for (const o of openOrders) if (o.side === "buy") cash -= (o.qty - o.filledQty) * (i.prices[o.symbol] ?? 0);
  const symbols = new Set([...held.keys(), ...openOrders.filter((o) => o.side === "buy").map((o) => o.symbol)]);
  const valueOf = (s: string) => (held.get(s)?.qty ?? 0) * (i.prices[s] ?? held.get(s)?.currentPrice ?? 0) + (added.get(s) ?? 0);
  const added = new Map<string, number>();

  const sorted = [...i.proposals].sort((a, b) => (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1));
  for (const p of sorted) {
    const reject = (reason: string) => rejected.push({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello", reason });
    if (p.side !== "buy" && p.side !== "sell") { reject(`lato non valido "${p.side}"`); continue; }
    if (!universe.has(p.symbol)) { reject("fuori universo"); continue; }
    if (!Number.isInteger(p.qty) || p.qty < 1) { reject("solo azioni intere e quantità positiva"); continue; }
    const key = `${p.symbol}-${p.side}`;
    if (seen.has(key)) { reject(stopped.has(p.symbol) && p.side === "sell" ? "già venduto dal codice (stop o uscita di trend)" : "doppione nella stessa sveglia"); continue; }
    if (p.side === "buy" && stopped.has(p.symbol)) { reject("in uscita in questa sveglia (stop o trend)"); continue; }
    const lesson = i.lessons.find((l) => l.lato === p.side && (l.simbolo === p.symbol || (l.simbolo === "*" && l.setup !== undefined && l.setup === setupOfSymbol(i, p.symbol))));
    if (lesson) { reject(`lezione dal registro degli errori: ${lesson.motivo} (fino al ${lesson.finoAl})`); continue; }
    if (openOrders.some((o) => o.symbol === p.symbol && o.side === p.side)) { reject("c'è già un ordine aperto uguale"); continue; }

    if (p.side === "sell") {
      const q = held.get(p.symbol)?.qty ?? 0;
      if (p.qty > q) { reject(`niente short: in portafoglio ce ne sono ${q}`); continue; }
    } else {
      if (i.buyBlock) { reject(i.buyBlock); continue; }
      if (i.slotKind !== ENTRY_SLOT) { reject("gli acquisti si fanno solo alla sveglia di apertura, sulle chiusure di ieri"); continue; }
      const ev = eventBlockFor(p.symbol, i.today, i.events ?? EVENTS);
      if (ev) { reject(ev); continue; }
      const price = i.prices[p.symbol];
      if (!price || price <= 0) { reject("prezzo non disponibile"); continue; }
      const cost = p.qty * price;
      const share = (valueOf(p.symbol) + cost) / i.account.equity;
      if (share > LIMITS.maxPositionPct) { reject(`porterebbe il titolo al ${pct(share)} del conto (massimo ${pct(LIMITS.maxPositionPct)})`); continue; }
      if (!symbols.has(p.symbol) && symbols.size >= LIMITS.maxPositions) { reject(`massimo ${LIMITS.maxPositions} titoli in portafoglio`); continue; }
      const group = LIMITS.groups.find((g) => g.symbols.includes(p.symbol));
      if (group) {
        const g = (group.symbols.reduce((a, s) => a + valueOf(s), 0) + cost) / i.account.equity;
        if (g > group.maxPct) { reject(`porterebbe il gruppo ${group.name} al ${pct(g)} del conto (massimo ${pct(group.maxPct)}): sono titoli che si muovono insieme`); continue; }
      }
      const closes = i.closes[p.symbol];
      const t = trendOf(closes, LIMITS.trendSmaDays, LIMITS.longSmaDays);
      if (t === null) { reject(`storico insufficiente per il metodo (servono ${LIMITS.longSmaDays} giorni di chiusure)`); continue; }
      if (t.close <= t.sma) { reject(`chiusura ${t.close.toFixed(2)} sotto la media a ${LIMITS.trendSmaDays} giorni (${t.sma.toFixed(2)}): il metodo compra solo in trend`); continue; }
      if (t.close <= t.long) { reject(`chiusura ${t.close.toFixed(2)} sotto la media a ${LIMITS.longSmaDays} giorni (${t.long.toFixed(2)}): trend di lungo periodo negativo`); continue; }
      if (price <= t.sma) { reject(`prezzo ${price.toFixed(2)} sceso sotto la media a ${LIMITS.trendSmaDays} giorni (${t.sma.toFixed(2)}) in giornata`); continue; }
      const w = maxWeightFor(closes);
      if (share > w.max) { reject(`con volatilità giornaliera ${pct(w.vol)}${w.estimated ? " (stimata)" : ""} il massimo è ${pct(w.max)} del conto, qui si arriverebbe al ${pct(share)}`); continue; }
      if (cost > cash) { reject("niente leva: contanti insufficienti"); continue; }
      cash -= cost;
      symbols.add(p.symbol);
      added.set(p.symbol, (added.get(p.symbol) ?? 0) + cost);
    }
    seen.add(key);
    orders.push({ symbol: p.symbol, side: p.side, qty: p.qty, why: p.why, source: "modello" });
  }
  return { orders, rejected };
}
