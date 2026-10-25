import type { ProposedOrder } from "./brain/types.ts";
import type { Account, Order, Position, Side } from "./broker/types.ts";
import { isOpenOrder } from "./broker/types.ts";
import { LIMITS, MAX_LATENESS_MIN, UNIVERSE, type SlotKind } from "./config.ts";

export interface PlannedOrder {
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  source: "modello" | "stop-loss";
}

export interface Rejection {
  symbol: string;
  side: string;
  qty: number;
  reason: string;
  source: "modello" | "stop-loss";
}

export interface CageInput {
  slotKind: SlotKind;
  marketOpen: boolean;
  latenessMin: number;
  account: Account;
  positions: Position[];
  prices: Record<string, number>;
  recentOrders: Order[];
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

function tradingBlockReason(i: CageInput): string | null {
  if (i.slotKind === "briefing") return "briefing: nessun ordine";
  if (!i.marketOpen) return "mercato chiuso";
  if (i.latenessMin > MAX_LATENESS_MIN) return `sveglia in ritardo di ${i.latenessMin} minuti: l'ordine non ha più senso`;
  if (i.account.equity <= 0) return "conto senza patrimonio";
  return null;
}

// Il modello propone, la gabbia dispone. Tutte le regole stanno qui, non nel prompt.
export function applyCage(i: CageInput): CageResult {
  const orders: PlannedOrder[] = [];
  const rejected: Rejection[] = [];
  const universe = new Set<string>(UNIVERSE);
  const held = new Map(i.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const stopLoss = i.positions.filter((p) => p.qty > 0 && lossPct(p) <= -LIMITS.stopLossPct);

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

  const openOrders = i.recentOrders.filter(isOpenOrder);
  let cash = i.account.cash;
  for (const o of openOrders) if (o.side === "buy") cash -= (o.qty - o.filledQty) * (i.prices[o.symbol] ?? 0);
  const symbols = new Set([...held.keys(), ...openOrders.filter((o) => o.side === "buy").map((o) => o.symbol)]);
  const qtyHeld = (s: string) => held.get(s)?.qty ?? 0;
  const addedValue = new Map<string, number>();

  // Prima le vendite, poi gli acquisti. I soldi delle vendite non si contano: non sono ancora incassati.
  const sorted = [...i.proposals].sort((a, b) => (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1));
  for (const p of sorted) {
    const reject = (reason: string) => rejected.push({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello", reason });
    if (p.side !== "buy" && p.side !== "sell") { reject(`lato non valido "${p.side}"`); continue; }
    if (!universe.has(p.symbol)) { reject("fuori universo"); continue; }
    if (!Number.isInteger(p.qty) || p.qty < 1) { reject("solo azioni intere e quantità positiva"); continue; }
    const key = `${p.symbol}-${p.side}`;
    if (seen.has(key)) { reject(stopped.has(p.symbol) && p.side === "sell" ? "già venduto dallo stop loss" : "doppione nella stessa sveglia"); continue; }
    if (p.side === "buy" && stopped.has(p.symbol)) { reject("stop loss attivo su questo titolo"); continue; }
    if (openOrders.some((o) => o.symbol === p.symbol && o.side === p.side)) { reject("c'è già un ordine aperto uguale"); continue; }

    if (p.side === "sell") {
      const q = qtyHeld(p.symbol);
      if (p.qty > q) { reject(`niente short: in portafoglio ce ne sono ${q}`); continue; }
    } else {
      const price = i.prices[p.symbol];
      if (!price || price <= 0) { reject("prezzo non disponibile"); continue; }
      const cost = p.qty * price;
      const value = qtyHeld(p.symbol) * price + (addedValue.get(p.symbol) ?? 0) + cost;
      const share = value / i.account.equity;
      if (share > LIMITS.maxPositionPct) { reject(`porterebbe il titolo al ${pct(share)} del conto (massimo ${pct(LIMITS.maxPositionPct)})`); continue; }
      if (!symbols.has(p.symbol) && symbols.size >= LIMITS.maxPositions) { reject(`massimo ${LIMITS.maxPositions} titoli in portafoglio`); continue; }
      if (cost > cash) { reject("niente leva: contanti insufficienti"); continue; }
      cash -= cost;
      symbols.add(p.symbol);
      addedValue.set(p.symbol, (addedValue.get(p.symbol) ?? 0) + cost);
    }
    seen.add(key);
    orders.push({ symbol: p.symbol, side: p.side, qty: p.qty, why: p.why, source: "modello" });
  }
  return { orders, rejected };
}
