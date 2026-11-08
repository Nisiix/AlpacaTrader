// Il diario dei trade: raccoglie, misura, e solo a raccolta finita insegna (stringendo, mai allargando).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProposedOrder } from "../src/ordini.ts";
import type { Order } from "../src/broker/types.ts";
import { applyCage } from "../src/cage.ts";
import { applyFills, dailyPnl, emptyJournal, statsOf, type JournalFile, type Trade } from "../src/journal.ts";
import { emptyLessons } from "../src/lessons.ts";
import { addDays } from "../src/slots.ts";

const day = (date: string, rome: string) => new Date(`${date}T${rome}:00+02:00`);
const order = (side: "buy" | "sell", symbol: string, qty: number, price: number, id: string): ProposedOrder => ({ symbol, side, qty, why: `prova ${id}`, confidence: "alta", expect: "sale" });
const journalOf = (stateDir: string): JournalFile => JSON.parse(readFileSync(join(stateDir, "journal.json"), "utf8"));

const fill = (id: string, side: "buy" | "sell", symbol: string, qty: number, price: number, at: string, type = "market"): Order => ({ id, clientOrderId: `c-${id}`, symbol, side, qty, filledQty: qty, status: "filled", submittedAt: at, type, stopPrice: null, filledAvgPrice: price, filledAt: at });

// N trade chiusi su un titolo, con i risultati dati, a partire da una data.
function journalWith(results: number[], symbol = "NVDA", from = "2026-01-05", setup = "momentum forte · volatilità alta"): JournalFile {
  const j = emptyJournal();
  results.forEach((r, i) => {
    const d = addDays(from, i % 20);
    const t: Trade = { id: `t${i}`, simbolo: symbol, stato: "chiuso", apertoIl: `${d}T14:00:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: 100 * (1 + r), quantita: 0, contesto: { setup, momentum20: 0.05, volGiornaliera: 0.02, distanzaMedia: 0.03, fiducia: "alta", attesa: "", perche: "" }, chiusoIl: `${d}T15:00:00Z`, prezzoIngresso: 100, prezzoUscita: 100 * (1 + r), risultato: r, giorni: 3, motivoUscita: "scelta del modello" };
    j.trade.push(t);
  });
  return j;
}

describe("diario dei trade", () => {




  test("una vendita senza ingresso nel diario non inventa un trade", () => {
    const j = emptyJournal();
    const r = applyFills(j, [fill("1", "sell", "MSFT", 5, 500, "2026-09-24T14:00:00Z")]);
    expect(r.closed).toHaveLength(0);
    expect(j.trade).toHaveLength(0);
  });

  test("ingressi in più volte e uscite parziali: il risultato usa i prezzi medi", () => {
    const j = emptyJournal();
    applyFills(j, [fill("1", "buy", "GLD", 10, 100, "2026-09-21T14:00:00Z"), fill("2", "buy", "GLD", 10, 110, "2026-09-22T14:00:00Z"), fill("3", "sell", "GLD", 5, 120, "2026-09-23T14:00:00Z")]);
    expect(j.trade[0]!.stato).toBe("aperto");
    const r = applyFills(j, [fill("4", "sell", "GLD", 15, 100, "2026-09-24T14:00:00Z")]);
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0]!.risultato).toBeCloseTo(((5 * 120 + 15 * 100) / 20) / 105 - 1, 6);
    expect(r.closed[0]!.giorni).toBe(3);
  });
});

describe("profitto e perdita del giorno", () => {
  test("ogni vendita di oggi vale (prezzo - carico) × quantità; le parziali e le chiusure si distinguono; gli agenti ricevono il conto", () => {
    const j = emptyJournal();
    j.intenzioni.push({ id: "c-1", simbolo: "GLD", lato: "buy", origine: "agenti", data: "2026-09-21", contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "trend", agenti: ["trend", "rientro"] } });
    j.intenzioni.push({ id: "c-10", simbolo: "NVDA", lato: "buy", origine: "agenti", data: "2026-09-22", contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "trend", agenti: ["trend"] } });
    // GLD: 10 @ 100 e 10 @ 110 (carico medio 105), ieri; oggi vende 5 @ 120 (parziale) e poi 15 @ 100 (chiude).
    applyFills(j, [fill("1", "buy", "GLD", 10, 100, "2026-09-21T14:00:00Z"), fill("2", "buy", "GLD", 10, 110, "2026-09-22T14:00:00Z"), fill("10", "buy", "NVDA", 2, 180, "2026-09-22T14:00:00Z")]);
    applyFills(j, [fill("3", "sell", "GLD", 5, 120, "2026-09-24T14:00:00Z"), fill("4", "sell", "GLD", 15, 100, "2026-09-24T19:00:00Z"), fill("11", "buy", "NVDA", 1, 190, "2026-09-24T14:05:00Z")]);
    const p = dailyPnl(j, "2026-09-24");
    expect(p.vendite).toHaveLength(2);
    expect(p.vendite[0]).toMatchObject({ simbolo: "GLD", quantita: 5, carico: 105, prezzo: 120, chiuso: false, agenti: ["trend", "rientro"] });
    expect(p.vendite[0]!.pnl).toBeCloseTo(75, 6);
    expect(p.vendite[1]).toMatchObject({ quantita: 15, chiuso: true });
    expect(p.vendite[1]!.pnl).toBeCloseTo(-75, 6);
    expect(p.realizzato).toBeCloseTo(0, 6);
    expect(p.tradeChiusi).toBe(1);
    expect(p.perAgente.trend).toEqual({ pnl: 0, operazioni: 2 });
    expect(p.perAgente.rientro!.operazioni).toBe(2);
    // L'aggiunta di oggi su NVDA si elenca tra gli acquisti; quella di ieri no.
    expect(p.acquisti).toEqual([{ simbolo: "NVDA", quantita: 1, prezzo: 190, agenti: ["trend"], ora: "2026-09-24T14:05:00Z" }]);
    // Ieri: nessuna vendita, solo gli acquisti del 22 (ora di Roma).
    const ieri = dailyPnl(j, "2026-09-22");
    expect(ieri.vendite).toHaveLength(0);
    expect(ieri.acquisti.map((a) => a.simbolo).sort()).toEqual(["GLD", "NVDA"]);
  });

  test("crypto: la moneta trattenuta come commissione entra nel conto di oggi (stesso numero del capo ufficio)", () => {
    const j = emptyJournal();
    // 10 AAVE comprate, Alpaca ne accredita 9,975 (0,25% di commissione in moneta): si vende tutto quello che c'è.
    applyFills(j, [fill("1", "buy", "AAVE/USD", 10, 100, "2026-09-24T08:00:00Z"), fill("2", "sell", "AAVE/USD", 9.975, 100, "2026-09-24T12:00:00Z")]);
    expect(j.trade[0]!.stato).toBe("chiuso");
    const p = dailyPnl(j, "2026-09-24");
    expect(p.vendite).toHaveLength(1);
    expect(p.vendite[0]!.pnl).toBeCloseTo(-2.5, 6); // prezzo invariato: si perde solo la commissione
    expect(p.realizzato).toBeCloseTo(j.trade[0]!.incassato - j.trade[0]!.costo, 6);
    // Gli orari: acquisto (apertura del trade) e vendita.
    expect(p.vendite[0]).toMatchObject({ aperto: "2026-09-24T08:00:00Z", ora: "2026-09-24T12:00:00Z" });
    expect(p.acquisti[0]!.ora).toBe("2026-09-24T08:00:00Z");
  });

  test("un trade chiuso oggi da un diario vecchio, senza elenco vendite, conta col saldo incassato - costo", () => {
    const j = journalWith([0.05], "SPY", "2026-09-24");
    j.trade[0]!.chiusoIl = "2026-09-24T15:00:00Z";
    const p = dailyPnl(j, "2026-09-24");
    expect(p.vendite).toHaveLength(1);
    expect(p.vendite[0]!.pnl).toBeCloseTo(5, 6);
    expect(p.vendite[0]!.chiuso).toBe(true);
    expect(p.perAgente["senza agente"]!.pnl).toBeCloseTo(5, 6);
  });
});

describe("statistiche oneste", () => {
  test("tanti trade vinti con una perdita grossa: il risultato medio è negativo e si vede", () => {
    const s = statsOf(journalWith([0.01, 0.01, 0.01, 0.01, -0.1]).trade);
    expect(s.percVinti).toBe(0.8);
    expect(s.attesa!).toBeLessThan(0);
    expect(s.attesa!).toBeCloseTo(-0.012, 9);
    expect(s.campione).toBe("troppo piccolo");
  });
});



describe("commissioni crypto", () => {
  test("Alpaca trattiene la commissione in moneta: venduto il 99,7% di quanto comprato, il trade è chiuso", () => {
    const j = emptyJournal();
    applyFills(j, [fill("1", "buy", "AAVE/USD", 44.6, 130, "2026-11-08T14:31:00Z"), fill("2", "sell", "AAVE/USD", 44.4885, 132, "2026-11-08T14:36:00Z")]);
    expect(j.trade[0]!.stato).toBe("chiuso");
    expect(j.trade[0]!.risultato!).toBeCloseTo(132 / 130 - 1, 6);
  });
});
