import { describe, expect, test } from "bun:test";
import { allocate } from "../src/agents/allocator.ts";
import type { Signal } from "../src/agents/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage } from "../src/cage.ts";
import { AGENTS, LIMITS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal } from "../src/journal.ts";
import { TETTI_SERIE, TETTI_STORICI } from "./setup.ts";

// Crypto fino al 100% del conto (12/11/2026, scelta dell'utente): i valori di serie di src/config.ts. Il preload dei test
// rimette i tetti storici; qui si provano quelli nuovi e poi si ripristinano.
const NUOVI = TETTI_SERIE;
const conTetti = (t: typeof NUOVI, fn: () => void) => {
  const b = AGENTS.intraday.budget, c = AGENTS.intraday.crypto;
  b.quota = t.quota; b.maxCrypto = t.maxCrypto; AGENTS.intraday.maxWeight = t.maxWeight; c.maxIngressiGiro = t.maxIngressiGiro; c.maxAperte = t.maxAperte;
  LIMITS.groupMaxBySector = t === NUOVI ? { ...TETTI_SERIE.gruppi } : {};
  try { fn(); } finally {
    b.quota = TETTI_STORICI.quota; b.maxCrypto = TETTI_STORICI.maxCrypto; AGENTS.intraday.maxWeight = TETTI_STORICI.maxWeight;
    c.maxIngressiGiro = TETTI_STORICI.maxIngressiGiro; c.maxAperte = TETTI_STORICI.maxAperte; LIMITS.groupMaxBySector = {};
  }
};
const C = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "LINK/USD"];
const intra = (simbolo: string, peso: number, prob: number): Signal => ({ agente: "intraday", simbolo, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: peso, probIngresso: prob, perche: "prova" } as Signal);
const view = () => ({ today: "2026-11-12", now: new Date("2026-11-12T01:00:00Z"), prices: Object.fromEntries(C.map((s) => [s, 100])), closes: Object.fromEntries(C.map((s) => [s, syntheticCloses(100, 0.02, 260)])), indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal() }) as never;
const investito = (a: ReturnType<typeof allocate>) => a.proposte.filter((x) => x.side === "buy").reduce((s, x) => s + x.qty * 100, 0);
const segnali = () => ({ intraday: { segnali: C.map((s, i) => intra(s, 0.3 - i * 0.02, 0.75 - i * 0.03)) } });

describe("crypto fino al 100% del conto", () => {
  test("cinque occasioni crypto che chiedono il 130% del conto: si investe quasi tutto, non il 20%", () => conTetti(NUOVI, () => {
    setCryptoUniverse(C);
    const nuovo = investito(allocate(view(), segnali(), { intraday: 1 }));
    expect(nuovo).toBeGreaterThan(90_000);
    expect(nuovo).toBeLessThanOrEqual(100_000 + 1);
  }));

  test("con i tetti storici le stesse occasioni si fermavano al 20% (prova che il cambio è quello che sblocca)", () => conTetti({ ...TETTI_STORICI, gruppi: {} }, () => {
    setCryptoUniverse(C);
    expect(investito(allocate(view(), segnali(), { intraday: 1 }))).toBeLessThanOrEqual(20_000 + 1);
  }));

  test("gabbia: il settore crypto può superare il 35% e una crypto intraday arrivare al 40%, non oltre", () => conTetti(NUOVI, () => {
    setCryptoUniverse(C);
    const pos = ["BTC/USD", "ETH/USD", "SOL/USD"].map((s) => ({ symbol: s, qty: 200, avgEntryPrice: 100, currentPrice: 100, marketValue: 20_000 }));
    const base = { today: "2026-11-12", marketOpen: true, account: { equity: 100_000, lastEquity: 100_000, cash: 40_000, status: "ACTIVE" }, positions: pos, prices: Object.fromEntries(C.map((s) => [s, 100])), closes: Object.fromEntries(C.map((s) => [s, syntheticCloses(100, 0.02, 260)])), recentOrders: [], lessons: [], buyBlock: null } as never as Parameters<typeof applyCage>[0];
    const ok = applyCage({ ...base, proposals: [{ symbol: "XRP/USD", side: "buy", qty: 350, why: "", intraday: true }] });
    expect(ok.rejected).toEqual([]);
    const troppo = applyCage({ ...base, account: { ...base.account, cash: 100_000 }, positions: [], proposals: [{ symbol: "XRP/USD", side: "buy", qty: 450, why: "", intraday: true }] });
    expect(troppo.rejected[0]!.reason).toContain("massimo 40");
  }));
});
