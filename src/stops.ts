import { BrokerError, DuplicateOrderError, arrotondaPrezzo, intere, isProtectiveStop, nove, prezzoStringa, type Broker, type Order, type Position } from "./broker/types.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, LIMITS, isCrypto } from "./config.ts";
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

export const stopPriceFor = (p: Position, closes?: number[], fixedPct?: number) => arrotondaPrezzo(p.symbol, p.avgEntryPrice * (1 - (fixedPct ?? stopPctFor(closes))));

// Le parti di una posizione da coprire con uno stop su Alpaca.
// - Crypto: tutta la quantità, uno stop GTC (salvo le briciole sotto il minimo negoziabile).
// - Titoli a azioni intere: tutta la quantità, uno stop GTC.
// - Titoli con una frazione (es. 12,37): le 12 intere con uno stop GTC (vale anche a PC spento, per giorni) e la frazione
//   0,37 con uno stop «day» (Alpaca non accetta frazioni GTC), che scade alla chiusura e si rimette al primo giro a borsa
//   aperta del giorno dopo. Una frazione sotto frazioni.minimoUsd non si copre su Alpaca: la protegge lo stop del motore.
export interface ParteStop { qty: number; giornaliero: boolean }
export function partiStop(p: Position): { parti: ParteStop[]; nota?: string } {
  if (isCrypto(p.symbol)) {
    if (Math.floor(p.qty * 1e6 + 1e-6) <= 0 || p.qty * p.currentPrice < CRYPTO_MIN_NOTIONAL) return { parti: [], nota: "briciola, nessuno stop" };
    return { parti: [{ qty: p.qty, giornaliero: false }] };
  }
  const n = intere(p.qty);
  const fr = nove(p.qty - n);
  const parti: ParteStop[] = [];
  if (n >= 1) parti.push({ qty: n, giornaliero: false });
  if (fr > 1e-9) {
    if (fr * p.currentPrice >= AGENTS.frazioni.minimoUsd) parti.push({ qty: fr, giornaliero: true });
    else return { parti, nota: `frazione ${fr} sotto ${AGENTS.frazioni.minimoUsd} $: la protegge lo stop del motore` };
  }
  return parti.length ? { parti } : { parti, nota: "briciola, nessuno stop" };
}

// Stop «day» di una frazione rifiutati da Alpaca oggi (simbolo|giorno): non si riprovano a ogni giro (sarebbe un
// allarme ogni 5 minuti); fino a domani la frazione la protegge lo stop del motore (gabbia e uscite intraday).
const frazioneRifiutata = new Map<string, string>();
export const azzeraRifiutiFrazioni = () => frazioneRifiutata.clear();

const stessaQty = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const descr = (p: Position, parte: ParteStop, prezzo: number) => `${p.symbol} ${nove(parte.qty)}${parte.giornaliero ? " (frazione, stop day)" : ""} @ ${prezzoStringa(p.symbol, prezzo)}`;

// Ogni posizione ha i suoi stop su Alpaca, per tutta la quantità (in una o due parti, vedi partiStop), alla distanza di
// stopPctFor. Così la protezione vale anche tra un giro e l'altro e a macchina spenta.
export async function manageStops(broker: Broker, runId: string, positions: Position[], openOrders: Order[], log: Logger, closes: Record<string, number[]> = {}, fixedPct?: number, now: Date = new Date()): Promise<StopsReport> {
  const r: StopsReport = { ok: [], placed: [], cancelled: [], errors: [] };
  const oggi = now.toISOString().slice(0, 10);
  const stops = openOrders.filter(isProtectiveStop);
  const bySymbol = new Map<string, Order[]>();
  for (const o of stops) bySymbol.set(o.symbol, [...(bySymbol.get(o.symbol) ?? []), o]);

  for (const p of positions.filter((x) => x.qty > 0)) {
    const existing = bySymbol.get(p.symbol) ?? [];
    bySymbol.delete(p.symbol);
    const { parti, nota } = partiStop(p);
    if (nota) r.ok.push(`${p.symbol} ${nove(p.qty)}: ${nota}`);
    // Senza storico la distanza non si può ricalcolare: gli stop già giusti per quantità restano dove sono, e una parte
    // mancante (la frazione scaduta ieri) si rimette allo stesso prezzo delle intere.
    const prezzoEsistente = existing.find((o) => o.stopPrice && parti.some((pt) => stessaQty(o.qty, pt.qty)))?.stopPrice ?? null;
    const senzaStorico = fixedPct === undefined && !closes[p.symbol] && prezzoEsistente !== null;
    const want = senzaStorico ? prezzoEsistente! : stopPriceFor(p, closes[p.symbol], fixedPct);
    // Ogni parte tiene lo stop che c'è già se ha la stessa quantità, lo stesso prezzo (entro un millesimo o un centesimo;
    // senza storico qualunque prezzo) e la durata giusta (le intere non su uno stop «day»).
    const usati = new Set<string>();
    const mancanti: ParteStop[] = [];
    for (const parte of parti) {
      const o = existing.find((x) => !usati.has(x.id) && stessaQty(x.qty, parte.qty) && (senzaStorico || Math.abs((x.stopPrice ?? 0) - want) < Math.min(0.01, want * 0.001)) && (parte.giornaliero || x.tif !== "day"));
      if (o) {
        usati.add(o.id);
        r.ok.push(`${descr(p, parte, o.stopPrice ?? want)}${senzaStorico ? " (storico non disponibile: stop lasciato com'era)" : ""}`);
      } else mancanti.push(parte);
    }
    const daTogliere = existing.filter((o) => !usati.has(o.id));
    if (!mancanti.length && !daTogliere.length) continue;
    try {
      // Prima si tolgono gli stop vecchi (liberano la quantità), poi si mettono quelli che mancano.
      for (const o of daTogliere) {
        await broker.cancelOrder(o.id);
        r.cancelled.push(`${p.symbol} ${o.qty} @ ${o.stopPrice === null ? "?" : prezzoStringa(p.symbol, o.stopPrice)}`);
      }
      for (const parte of mancanti) {
        const chiave = `${p.symbol}|${oggi}`;
        if (parte.giornaliero && frazioneRifiutata.has(chiave)) {
          r.ok.push(`${p.symbol} ${nove(parte.qty)}: frazione senza stop su Alpaca oggi (${frazioneRifiutata.get(chiave)}): la protegge lo stop del motore`);
          continue;
        }
        try {
          await placeStop(broker, runId, p.symbol, parte.qty, want, parte.giornaliero);
          r.placed.push(descr(p, parte, want));
          log.info(`stop su Alpaca: ${descr(p, parte, want)}`);
        } catch (e) {
          // Uno stop sulla frazione rifiutato in modo definitivo (non un errore di rete): non si riprova fino a domani e
          // non è un allarme; le intere restano coperte dal loro stop GTC.
          if (parte.giornaliero && e instanceof BrokerError && !e.transient) {
            frazioneRifiutata.set(chiave, e.message);
            r.ok.push(`${p.symbol} ${nove(parte.qty)}: Alpaca non accetta lo stop sulla frazione (${e.message}): la protegge lo stop del motore`);
            log.warn(`stop sulla frazione di ${p.symbol} rifiutato da Alpaca: ${e.message}; la frazione la protegge lo stop del motore fino a domani`);
            continue;
          }
          throw e;
        }
      }
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

// L'ID resta deterministico; se quello base è già usato (giro rifatto) si prova con un suffisso. La frazione ha il suo
// (stopfr), così nello stesso giro convivono lo stop delle intere e quello della frazione.
async function placeStop(broker: Broker, runId: string, symbol: string, qty: number, stopPrice: number, giornaliero = false) {
  for (let n = 1; n <= 5; n++) {
    const id = `${runId}-${symbol.replace("/", "")}-stop${giornaliero ? "fr" : ""}${n > 1 ? `-${n}` : ""}`;
    try {
      return await broker.submitStopOrder({ symbol, qty, stopPrice, clientOrderId: id, ...(giornaliero ? { giornaliero: true } : {}) });
    } catch (e) {
      if (!(e instanceof DuplicateOrderError)) throw e;
    }
  }
  throw new Error("troppi stop con lo stesso ID in questo giro");
}
