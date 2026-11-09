import { describe, expect, test } from "bun:test";
import { allocate } from "../src/agents/allocator.ts";
import { guadagniAperti, quotaBudget } from "../src/agents/budget.ts";
import type { AgentView, Signal } from "../src/agents/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal } from "../src/journal.ts";

const conQuota = (q: number, fn: () => void) => { const prima = AGENTS.intraday.budget.quota; AGENTS.intraday.budget.quota = q; try { fn(); } finally { AGENTS.intraday.budget.quota = prima; } };

const intra = (simbolo: string, peso: number): Signal => ({ agente: "intraday", simbolo, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: peso, perche: "prova" });
const simboli = ["NVDA", "SPY", "GLD", "TLT"];
const view = (extra: Record<string, unknown> = {}) => ({ today: "2026-09-24", now: new Date("2026-09-24T15:00:00Z"), prices: Object.fromEntries(simboli.map((s) => [s, 100])), closes: Object.fromEntries(simboli.map((s) => [s, syntheticCloses(100, 0.015, 260)])), indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: true, ...extra }) as unknown as AgentView;
const totale = (a: ReturnType<typeof allocate>) => a.proposte.reduce((t, x) => t + x.qty * 100, 0);
const quattro = { intraday: { segnali: simboli.map((s) => intra(s, 0.2)) } };

describe("profitto reinvestito nel budget intraday", () => {
  test("con il budget di serie al 100% il profitto è già tutto investito: la quota resta 100%", () => {
    expect(quotaBudget(1100, 1000).quota).toBe(1);
    expect(quotaBudget(900, 1000).quota).toBe(1);
  });

  test("al capitale di partenza vale il 50%; il profitto incassato si aggiunge tutto", () => {
    expect(quotaBudget(1000, 1000, 0.5)).toEqual({ quota: 0.5, reinvestito: 0 });
    const q = quotaBudget(1100, 1000, 0.5);
    expect(q.quota * 1100).toBeCloseTo(600, 6);
    expect(q.reinvestito).toBeCloseTo(100, 6);
  });

  test("i guadagni ancora aperti non contano come profitto; le perdite aperte sì", () => {
    expect(quotaBudget(1100, 1000, 0.5, 100).quota).toBe(0.5);
    expect(quotaBudget(1100, 1000, 0.5, 40).quota * 1100).toBeCloseTo(560, 6);
    // Sotto il capitale di partenza: il 50% del conto che c'è (si riduce con il conto).
    expect(quotaBudget(900, 1000, 0.5).quota * 900).toBeCloseTo(450, 6);
    expect(guadagniAperti([{ symbol: "A", qty: 2, avgEntryPrice: 10, currentPrice: 15, marketValue: 30 }, { symbol: "B", qty: 1, avgEntryPrice: 10, currentPrice: 5, marketValue: 5 }])).toBe(10);
  });

  test("con molto profitto il budget si ferma al tetto (80%); spento o senza capitale di partenza resta il 50%", () => {
    expect(quotaBudget(5000, 1000, 0.5).quota).toBe(AGENTS.intraday.budget.reinvesti.tetto);
    expect(quotaBudget(1100, undefined, 0.5).quota).toBe(0.5);
    AGENTS.intraday.budget.reinvesti.enabled = false;
    try { expect(quotaBudget(1100, 1000, 0.5).quota).toBe(0.5); } finally { AGENTS.intraday.budget.reinvesti.enabled = true; }
    // Mai meno della quota personale (una persona con quota più alta non viene ridotta).
    expect(quotaBudget(1100, 1000, 0.6).quota).toBeGreaterThanOrEqual(0.6);
  });

  test("allocatore (budget al 50%): 20.000 $ di profitto incassato portano il budget da 50.000 a 60.000 $", () => conQuota(0.5, () => {
    setCryptoUniverse(["BTC/USD"]);
    const senza = allocate(view(), quattro, { intraday: 1 });
    expect(totale(senza)).toBeLessThanOrEqual(50_000 + 1);
    expect(totale(senza)).toBeGreaterThan(49_000);
    const con = allocate(view({ capitaleBase: 80_000 }), quattro, { intraday: 1 });
    expect(totale(con)).toBeLessThanOrEqual(60_000 + 1);
    expect(totale(con)).toBeGreaterThan(59_000);
    // Una singola operazione resta al massimo al 25% del conto.
    for (const p of con.proposte) expect(p.qty * 100).toBeLessThanOrEqual(25_000 + 1);
  }));

  test("allocatore (budget al 50%): lo stesso patrimonio fatto di guadagni ancora aperti non allarga il budget", () => conQuota(0.5, () => {
    setCryptoUniverse(["BTC/USD"]);
    // 20.000 $ di guadagno aperto su una posizione di più giorni: il patrimonio è 100.000 $ ma il profitto incassato è zero.
    const v = view({ capitaleBase: 80_000, positions: [{ symbol: "XOM", qty: 200, avgEntryPrice: 100, currentPrice: 200, marketValue: 40_000 }], prices: { ...Object.fromEntries(simboli.map((s) => [s, 100])), XOM: 200 }, account: { equity: 100_000, lastEquity: 100_000, cash: 60_000, status: "ACTIVE" } });
    const a = allocate(v, quattro, { intraday: 1 });
    expect(a.proposte.filter((x) => simboli.includes(x.symbol)).reduce((t, x) => t + x.qty * 100, 0)).toBeLessThanOrEqual(50_000 + 1);
  }));
});

describe("coerenza con la gabbia", () => {
  test("un segnale intraday oltre il 25% (peso personale alto) viene ridotto al 25%, non scartato dalla gabbia", () => {
    setCryptoUniverse(["BTC/USD"]);
    const a = allocate(view(), { intraday: { segnali: [intra("NVDA", 0.375)] } }, { intraday: 1 });
    const p = a.proposte.find((x) => x.symbol === "NVDA")!;
    expect(p.qty * 100).toBeLessThanOrEqual(25_000 + 1);
    expect(p.qty * 100).toBeGreaterThan(24_000);
  });
});
