import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocate } from "../src/agents/allocator.ts";
import { RegimeAgent } from "../src/agents/regime.ts";
import type { AgentView } from "../src/agents/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage } from "../src/cage.ts";
import { AGENTS, LIMITS } from "../src/config.ts";
import { refreshEarnings } from "../src/earnings.ts";
import { EVENTS, addEarnings, eventBlockFor } from "../src/events.ts";
import { emptyJournal } from "../src/journal.ts";

const account = { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" };
const salita = (p: number) => syntheticCloses(p, 0.01, 260);

describe("regole del primo motore riviste", () => {
  test("tetto per settore anche sulle crypto, che si muovono insieme", () => {
    const pos = ["BTC/USD", "ETH/USD", "SOL/USD"].map((s) => ({ symbol: s, qty: 1, avgEntryPrice: 10_000, currentPrice: 10_000, marketValue: 10_000 }));
    const prices = { "BTC/USD": 10_000, "ETH/USD": 10_000, "SOL/USD": 10_000, "XRP/USD": 10_000 };
    const closes = Object.fromEntries(Object.keys(prices).map((s) => [s, salita(10_000)]));
    AGENTS.universe.push("XRP/USD");
    const r = applyCage({ today: "2026-11-09", marketOpen: true, account, positions: pos, prices, closes, recentOrders: [], lessons: [], buyBlock: null, proposals: [{ symbol: "XRP/USD", side: "buy", qty: 0.8, why: "x", kronos: 0.05 }] });
    AGENTS.universe.splice(AGENTS.universe.indexOf("XRP/USD"), 1);
    expect(r.rejected[0]!.reason).toContain(`settore crypto al 38.0% del conto (massimo ${(LIMITS.groupMaxPct * 100).toFixed(1)}%)`);
  });

  test("il giorno della Fed blocca azioni ed ETF, non le crypto", () => {
    const fed = EVENTS.find((e) => e.kind === "fed")!.date;
    expect(eventBlockFor("SPY", fed)).toContain("Fed");
    expect(eventBlockFor("BTC/USD", fed)).toBeNull();
  });

  test("regime per classe: SPY per le azioni, BTC per le crypto; con il contesto vale la riduzione più forte", () => {
    const giu = syntheticCloses(100, 0.01, 260).reverse(); // in discesa: sotto la media a 200
    const v = { today: "2026-11-09", now: new Date(), prices: { SPY: 600, "BTC/USD": giu.at(-1)! }, closes: { SPY: salita(600), "BTC/USD": giu }, indicators: {}, positions: [], account, journal: emptyJournal() } as unknown as AgentView;
    const reg = new RegimeAgent().observe(v);
    expect(reg.rischio).toBe(1);
    expect(reg.rischioCrypto).toBe(AGENTS.regime.bearScale);
    const sig = (simbolo: string) => ({ agente: "trend", simbolo, lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "x" });
    const a = allocate({ ...v, prices: { SPY: 600 }, closes: { SPY: salita(600) } } as AgentView, { regime: reg, contesto: { segnali: [], rischio: 0.75 }, trend: { segnali: [sig("SPY")] } }, {});
    expect(a.rischio).toBe(0.75); // min(1, 0,75), non 0,75 × altro
  });

  test("trimestrali dal calendario automatico: solo i titoli seguiti, una lettura al giorno, poi nel calendario", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trim-"));
    let chiamate = 0;
    const fetcher = async (d: string) => (chiamate++, d === "2026-11-11" ? ["AMD", "ZZZZ"] : []);
    const r = await refreshEarnings(dir, "2026-11-09", ["AMD", "SPY", "BTC/USD"], fetcher, 3);
    expect(r.file!.date).toEqual([{ date: "2026-11-11", symbol: "AMD" }]);
    await refreshEarnings(dir, "2026-11-09", ["AMD"], fetcher, 3);
    expect(chiamate).toBe(4); // la seconda volta nello stesso giorno legge il file
    addEarnings(r.file!.date);
    expect(eventBlockFor("AMD", "2026-11-10")).toContain("trimestrale AMD");
    const giu = await refreshEarnings(mkdtempSync(join(tmpdir(), "trim-")), "2026-11-09", ["AMD"], async () => { throw new Error("403"); }, 3);
    expect(giu.problema).toContain("non disponibile");
  });
});
