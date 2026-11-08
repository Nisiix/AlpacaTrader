// Le regole della revisione di strategia di ottobre 2026: stop legato alla volatilità, uscita di trend nel codice,
// media a 200 giorni, ingressi solo all'apertura, calendario di Fed e trimestrali, 60/40, voto a maggioranza.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareWithBenchmarks } from "../src/benchmark.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage, type CageInput } from "../src/cage.ts";
import { eventBlockFor, type MarketEvent } from "../src/events.ts";
import { stopPctFor } from "../src/stops.ts";

const PRICES: Record<string, number> = { SPY: 600, QQQ: 520, IWM: 230, AAPL: 250, MSFT: 480, NVDA: 180, GLD: 380, TLT: 90 };
const EV: MarketEvent[] = [
  { date: "2026-10-28", kind: "fed", confirmed: true },
  { date: "2026-10-28", kind: "trimestrale", symbol: "MSFT", confirmed: true },
  { date: "2026-11-02", kind: "trimestrale", symbol: "AAPL", confirmed: true },
];
const base = (over: Partial<CageInput> = {}): CageInput => ({
  today: "2026-09-24",
  events: EV,
  marketOpen: true,
  account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" },
  positions: [],
  prices: PRICES,
  closes: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, syntheticCloses(v, 0.01, 260)])),
  recentOrders: [],
  lessons: [],
  buyBlock: null,
  proposals: [],
  ...over,
});
const buy = (symbol: string, qty = 1) => ({ symbol, side: "buy", qty, why: "prova" });
const day = (date: string, rome: string) => new Date(`${date}T${rome}:00+02:00`);

describe("stop di protezione legato alla volatilità", () => {
  test("2,5 × volatilità × √5, al mezzo punto, tra 5% e 10%", () => {
    expect(stopPctFor(syntheticCloses(100, 0.005, 260))).toBe(0.05); // ETF calmo: il minimo
    expect(stopPctFor(syntheticCloses(100, 0.012, 260))).toBe(0.07);
    expect(stopPctFor(syntheticCloses(100, 0.03, 260))).toBe(0.1); // titolo nervoso: il massimo
    expect(stopPctFor(undefined)).toBe(0.1); // senza storico: il più largo, non uno stop a caso
  });
  test("-4% non vende più: il rumore normale non chiude la posizione", () => {
    const pos = [{ symbol: "MSFT", qty: 20, avgEntryPrice: 500, currentPrice: 480, marketValue: 9_600 }];
    expect(applyCage(base({ positions: pos, prices: { ...PRICES, MSFT: 480 } })).orders).toEqual([]);
  });
});

describe("uscita di trend fatta dal codice", () => {
  const falling = Array.from({ length: 260 }, (_, i) => (i < 230 ? 400 + i : 630 - (i - 229) * 8)); // sale, poi scende sotto la media a 50
  const pos = [{ symbol: "MSFT", qty: 20, avgEntryPrice: 470, currentPrice: 480, marketValue: 9_600 }];
  test("all'apertura, chiusura sotto la media a 50 giorni: vende tutto anche se il modello tace", () => {
    const r = applyCage(base({ positions: pos, closes: { ...base().closes, MSFT: falling } }));
    expect(r.orders.map((o) => `${o.symbol} ${o.side} ${o.qty} ${o.source}`)).toEqual(["MSFT sell 20 uscita-trend"]);
  });
  test("a borsa chiusa l'uscita di trend dei titoli aspetta l'apertura", () => {
    expect(applyCage(base({ marketOpen: false, positions: pos, closes: { ...base().closes, MSFT: falling } })).orders).toEqual([]);
  });
  test("sopra la media resta in mano", () => {
    expect(applyCage(base({ positions: pos })).orders).toEqual([]);
  });
});

describe("filtro di lungo periodo", () => {
  test("sopra la media a 50 ma sotto quella a 200: non si compra", () => {
    // scende per 200 giorni, poi rimbalza: sopra la 50, ancora sotto la 200 (come TLT a ottobre 2026)
    const tlt = Array.from({ length: 260 }, (_, i) => (i < 200 ? 150 - i * 0.35 : 80 + (i - 200) * 0.2));
    const r = applyCage(base({ closes: { ...base().closes, TLT: tlt }, prices: { ...PRICES, TLT: tlt.at(-1)! }, proposals: [buy("TLT", 10)] }));
    expect(r.rejected[0]!.reason).toContain("sotto la media a 200 giorni");
  });
  test("chiusura sopra le medie ma prezzo crollato in giornata sotto la 50: non si compra", () => {
    const r = applyCage(base({ prices: { ...PRICES, SPY: 500 }, proposals: [buy("SPY", 10)] }));
    expect(r.rejected[0]!.reason).toContain("in giornata");
  });
});

describe("niente sveglie: a borsa aperta la gabbia ammette acquisti e vendite in ogni momento", () => {
  test("acquisti e vendite passano insieme; a borsa chiusa i titoli si fermano", () => {
    const pos = [{ symbol: "SPY", qty: 10, avgEntryPrice: 600, currentPrice: 600, marketValue: 6_000 }];
    const r = applyCage(base({ positions: pos, proposals: [buy("GLD", 5), { symbol: "SPY", side: "sell", qty: 4, why: "" }] }));
    expect(r.orders.map((o) => o.symbol).sort()).toEqual(["GLD", "SPY"]);
    const chiuso = applyCage(base({ marketOpen: false, positions: pos, proposals: [buy("GLD", 5), { symbol: "SPY", side: "sell", qty: 4, why: "" }] }));
    expect(chiuso.orders).toEqual([]);
    expect(chiuso.rejected.map((x) => x.reason)).toEqual(["mercato chiuso", "mercato chiuso"]);
  });
});

describe("calendario di Fed e trimestrali", () => {
  test("giorno della Fed: niente acquisti nuovi, nemmeno di ETF", () => {
    expect(eventBlockFor("SPY", "2026-10-28", EV)).toContain("decisione della Fed");
    expect(applyCage(base({ today: "2026-10-28", proposals: [buy("SPY")] })).rejected[0]!.reason).toContain("Fed");
  });
  test("trimestrale: blocco dai 2 giorni di borsa prima al giorno stesso, solo per quel titolo", () => {
    expect(eventBlockFor("AAPL", "2026-10-29", EV)).toContain("trimestrale AAPL");
    expect(eventBlockFor("AAPL", "2026-11-02", EV)).toContain("trimestrale AAPL");
    expect(eventBlockFor("AAPL", "2026-11-03", EV)).toBeNull();
    expect(eventBlockFor("AAPL", "2026-10-27", EV)).toBeNull();
    expect(eventBlockFor("SPY", "2026-10-30", EV)).toBeNull();
    expect(eventBlockFor("MSFT", "2026-10-26", EV)).toContain("trimestrale MSFT");
    expect(eventBlockFor("MSFT", "2026-10-23", EV)).toBeNull();
  });
});

describe("confronto con il 60/40", () => {
  test("file vecchio con solo SPY: riceve TLT e il 60/40 parte da oggi", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-"));
    writeFileSync(join(dir, "benchmark.json"), JSON.stringify({ versione: 1, dal: "2026-10-25", patrimonio: 100_000, spy: 600 }));
    const first = compareWithBenchmarks(dir, "2026-10-26", 100_000, 600, 80);
    expect(first.cmp!.misto).toEqual({ dal: "2026-10-26", conto: 0, rendimento: 0 });
    const later = compareWithBenchmarks(dir, "2026-11-26", 102_000, 660, 72);
    expect(later.cmp!.spy).toBeCloseTo(0.1);
    expect(later.cmp!.misto!.rendimento).toBeCloseTo(0.6 * 0.1 + 0.4 * -0.1);
    expect(later.cmp!.misto!.conto).toBeCloseTo(0.02);
    expect(JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")).tlt).toBe(80);
  });
});


describe("solo giornate concluse", () => {
  test("la seduta di New York è conclusa dalle 16:15 locali, la candela crypto a mezzanotte UTC", async () => {
    const { limitiSedute } = await import("../src/sedute.ts");
    // Martedì 00:05 a Roma = lunedì 18:05 a New York: la seduta di lunedì è conclusa ed entra (prima restava fuori fino a mercoledì).
    expect(limitiSedute(new Date("2026-11-10T00:05:00+01:00"))).toEqual({ azioni: "2026-11-10", crypto: "2026-11-09", chiave: "2026-11-10|2026-11-09" });
    // Lunedì 21:00 a Roma = 15:00 a New York: seduta in corso, l'ultima conclusa è venerdì (il limite è lunedì, escluso).
    expect(limitiSedute(new Date("2026-11-09T21:00:00+01:00")).azioni).toBe("2026-11-09");
    // Alle 01:05 di Roma la candela crypto di ieri (UTC) è conclusa: la chiave cambia e Kronos ricalcola le crypto.
    expect(limitiSedute(new Date("2026-11-10T01:05:00+01:00")).crypto).toBe("2026-11-10");
  });
  test("Alpaca: la barra non ancora conclusa non entra nello storico", async () => {
    const { AlpacaBroker } = await import("../src/broker/alpaca.ts");
    const { limitiSedute } = await import("../src/sedute.ts");
    const inCorso = limitiSedute(new Date()).azioni;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ bars: { SPY: [{ t: "2020-01-02T05:00:00Z", c: 100 }, { t: "2020-01-03T05:00:00Z", c: 101 }, { t: `${inCorso}T04:00:00Z`, c: 90 }] } }), { status: 200 })) as unknown as typeof fetch;
    try {
      expect(await new AlpacaBroker("k", "s").getDailyCloses(["SPY"], 10)).toEqual({ SPY: [100, 101] });
    } finally {
      globalThis.fetch = real;
    }
  });
});
