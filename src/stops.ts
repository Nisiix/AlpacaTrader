import { DuplicateOrderError, isProtectiveStop, type Broker, type Order, type Position } from "./broker/types.ts";
import { LIMITS } from "./config.ts";
import { dailyVol } from "./indicators.ts";
import type { Logger } from "./log.ts";

export interface StopsReport {
  ok: string[];
  placed: string[];
  cancelled: string[];
  errors: string[];
}

// Distanza dello stop dal prezzo di carico. Con 2,5 × vol × √5 il rumore di una settimana normale non lo tocca:
// esce solo un crollo. Mezzo punto di arrotondamento, così lo stop non si sposta per ogni decimale di volatilità.
export function stopPctFor(closes: number[] | undefined): number {
  const { volMultiple, horizonDays, minPct, maxPct } = LIMITS.stop;
  const v = (closes ? dailyVol(closes, LIMITS.volLookbackDays) : null) ?? LIMITS.fallbackDailyVol;
  const raw = Math.round(volMultiple * v * Math.sqrt(horizonDays) * 200) / 200;
  return Math.min(maxPct, Math.max(minPct, raw));
}

export const stopPriceFor = (p: Position, closes?: number[]) => Math.round(p.avgEntryPrice * (1 - stopPctFor(closes)) * 100) / 100;

// Ogni posizione ha uno e un solo stop su Alpaca, per tutta la quantità, alla distanza di stopPctFor.
// Così la protezione vale anche tra una sveglia e l'altra e a macchina spenta.
export async function manageStops(broker: Broker, runId: string, positions: Position[], openOrders: Order[], log: Logger, closes: Record<string, number[]> = {}): Promise<StopsReport> {
  const r: StopsReport = { ok: [], placed: [], cancelled: [], errors: [] };
  const stops = openOrders.filter(isProtectiveStop);
  const bySymbol = new Map<string, Order[]>();
  for (const o of stops) bySymbol.set(o.symbol, [...(bySymbol.get(o.symbol) ?? []), o]);

  for (const p of positions.filter((x) => x.qty > 0)) {
    const existing = bySymbol.get(p.symbol) ?? [];
    bySymbol.delete(p.symbol);
    // Senza storico la distanza non si può ricalcolare: uno stop già giusto per quantità resta dov'è.
    if (!closes[p.symbol] && existing.length === 1 && existing[0]!.qty === p.qty && existing[0]!.stopPrice) {
      r.ok.push(`${p.symbol} ${p.qty} @ ${existing[0]!.stopPrice.toFixed(2)} (storico non disponibile: stop lasciato com'era)`);
      continue;
    }
    const want = stopPriceFor(p, closes[p.symbol]);
    if (existing.length === 1 && existing[0]!.qty === p.qty && Math.abs((existing[0]!.stopPrice ?? 0) - want) < 0.01) {
      r.ok.push(`${p.symbol} ${p.qty} @ ${want.toFixed(2)}`);
      continue;
    }
    try {
      for (const o of existing) {
        await broker.cancelOrder(o.id);
        r.cancelled.push(`${p.symbol} ${o.qty} @ ${o.stopPrice?.toFixed(2)}`);
      }
      await placeStop(broker, runId, p.symbol, p.qty, want);
      r.placed.push(`${p.symbol} ${p.qty} @ ${want.toFixed(2)}`);
      log.info(`stop su Alpaca: ${p.symbol} ${p.qty} @ ${want.toFixed(2)}`);
    } catch (e) {
      r.errors.push(`${p.symbol}: ${(e as Error).message}`);
      log.error(`stop su ${p.symbol} non piazzato: ${(e as Error).message}`);
    }
  }
  // Stop rimasti senza posizione (venduta): via.
  for (const [sym, list] of bySymbol) {
    for (const o of list) {
      try {
        await broker.cancelOrder(o.id);
        r.cancelled.push(`${sym} ${o.qty} @ ${o.stopPrice?.toFixed(2)} (posizione chiusa)`);
      } catch (e) {
        r.errors.push(`${sym}: ${(e as Error).message}`);
      }
    }
  }
  return r;
}

// L'ID resta deterministico; se quello base è già usato (sveglia rifatta) si prova con un suffisso.
async function placeStop(broker: Broker, runId: string, symbol: string, qty: number, stopPrice: number) {
  for (let n = 1; n <= 5; n++) {
    const id = `${runId}-${symbol}-stop${n > 1 ? `-${n}` : ""}`;
    try {
      return await broker.submitStopOrder({ symbol, qty, stopPrice, clientOrderId: id });
    } catch (e) {
      if (!(e instanceof DuplicateOrderError)) throw e;
    }
  }
  throw new Error("troppi stop con lo stesso ID in questa sveglia");
}
