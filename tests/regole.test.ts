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
import { daAdesso, riallinea } from "../src/agents/engine.ts";

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
    const fetcher = async (d: string) => (chiamate++, d === "2026-11-11" ? [{ symbol: "AMD", quando: "dopo" as const }, { symbol: "ZZZZ", quando: "prima" as const }] : []);
    const r = await refreshEarnings(dir, "2026-11-09", ["AMD", "SPY", "BTC/USD"], fetcher, 3);
    expect(r.file!.date).toEqual([{ date: "2026-11-11", symbol: "AMD", quando: "dopo" }]);
    await refreshEarnings(dir, "2026-11-09", ["AMD"], fetcher, 3);
    expect(chiamate).toBe(4); // la seconda volta nello stesso giorno legge il file
    addEarnings(r.file!.date);
    expect(eventBlockFor("AMD", "2026-11-10")).toContain("trimestrale AMD");
    const giu = await refreshEarnings(mkdtempSync(join(tmpdir(), "trim-")), "2026-11-09", ["AMD"], async () => { throw new Error("403"); }, 3);
    expect(giu.problema).toContain("non disponibile");
  });

  test("le proiezioni si riallineano al prezzo di adesso: un rialzo già avvenuto non si compra due volte", () => {
    // Kronos +2% dalla chiusura di 100; il titolo oggi è già a 102,5: da qui l'attesa è circa -0,5%.
    expect(daAdesso(0.02, 100, 102.5)).toBeCloseTo(-0.00488, 4);
    // Calo previsto del 3% già avvenuto in giornata: da qui niente più ribasso.
    expect(daAdesso(-0.03, 100, 97)).toBeCloseTo(0, 9);
    expect(riallinea({ SPY: 0.02, X: 0.01 }, { SPY: { rendimentoPrevisto: 0.02, percorso: [0.02], ultimaChiusura: 100 } } as any, { SPY: 101 })).toEqual({ SPY: (1.02 * 100) / 101 - 1, X: 0.01 });
  });

  test("trimestrale: nell'ultima seduta decide guadagno o perdita rispetto al salto atteso, Kronos sceglie solo tra metà e tutto", async () => {
    const { uscitaTrimestrale } = await import("../src/agents/exits.ts");
    const { addEarnings } = await import("../src/events.ts");
    addEarnings([{ date: "2026-11-12", symbol: "CSCO", quando: "dopo" }, { date: "2026-11-13", symbol: "ORCL", quando: "prima" }]);
    const closes = { CSCO: salita(80), ORCL: salita(200) };
    // Giovedì 12/11, 21:00 a Roma (un'ora alla chiusura): ultima seduta per CSCO (conti dopo la chiusura).
    const v = (gainOggi: string, extra: Partial<AgentView> = {}) => ({ today: gainOggi, now: new Date(`${gainOggi}T21:00:00+01:00`), mercatoAperto: true, chiusuraBorsa: `${gainOggi}T21:00:00Z`, closes, prices: {}, positions: [], account, journal: emptyJournal(), indicators: {}, ...extra }) as unknown as AgentView;
    // Guadagno grande (oltre il salto atteso): metà.
    expect(uscitaTrimestrale(v("2026-11-12"), "CSCO", 0.12, -0.01, false)!.frazione).toBe(0.5);
    // ...e se la metà è già stata venduta, il resto resta.
    expect(uscitaTrimestrale(v("2026-11-12"), "CSCO", 0.12, -0.01, true)!.frazione).toBe(0);
    // Guadagno piccolo e Kronos senza rialzo: tutto. Con Kronos netto: metà.
    expect(uscitaTrimestrale(v("2026-11-12"), "CSCO", 0.01, -0.005, false)!.frazione).toBe(1);
    expect(uscitaTrimestrale(v("2026-11-12"), "CSCO", 0.01, 0.06, false)!.frazione).toBe(0.5);
    // In perdita: tutto, anche con Kronos favorevole se la perdita non è piccola.
    expect(uscitaTrimestrale(v("2026-11-12"), "CSCO", -0.04, 0.06, false)!.frazione).toBe(1);
    // Il giorno prima (non è l'ultima seduta) non si fa nulla; a borsa chiusa nemmeno.
    expect(uscitaTrimestrale(v("2026-11-11"), "CSCO", 0.12, 0, false)).toBeNull();
    expect(uscitaTrimestrale(v("2026-11-12", { mercatoAperto: false }), "CSCO", 0.12, 0, false)).toBeNull();
    // ORCL esce prima dell'apertura del 13: l'ultima seduta utile è il 12.
    expect(uscitaTrimestrale(v("2026-11-12"), "ORCL", -0.02, 0, false)!.frazione).toBe(1);
    // Motore spento nell'ultima seduta: il 13 (conti prima dell'apertura) è tardi, non si fa nulla; per CSCO (dopo la
    // chiusura del 12) il 12 stesso a inizio seduta non è ancora l'ultima ora.
    expect(uscitaTrimestrale(v("2026-11-13"), "ORCL", -0.02, 0, false)).toBeNull();
  });

  test("analisi d'ingresso ogni 15 minuti: negli altri giri niente acquisti nuovi, le uscite restano", () => {
    const sig = (lato: "buy" | "sell", vincolante = false) => ({ agente: "trend", simbolo: "SPY", lato, forza: 1, orizzonteSedute: 60, perche: "x", ...(vincolante ? { vincolante } : {}) });
    const base = { today: "2026-11-09", now: new Date(), prices: { SPY: 600 }, closes: { SPY: salita(600) }, indicators: {}, positions: [], account, journal: emptyJournal(), previsioni: { SPY: 0.03 } } as unknown as AgentView;
    expect(allocate({ ...base, analisi: true }, { trend: { segnali: [sig("buy")] } }, {}).proposte.map((p) => p.side)).toEqual(["buy"]);
    expect(allocate({ ...base, analisi: false }, { trend: { segnali: [sig("buy")] } }, {}).proposte).toEqual([]);
    const conPosizione = { ...base, analisi: false, positions: [{ symbol: "SPY", qty: 10, avgEntryPrice: 600, currentPrice: 600, marketValue: 6000 }] } as AgentView;
    expect(allocate(conPosizione, { uscite: { segnali: [sig("sell", true)] } }, {}).proposte.map((p) => p.side)).toEqual(["sell"]);
  });
});
