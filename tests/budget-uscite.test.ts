import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocate } from "../src/agents/allocator.ts";
import { IntradayAgent } from "../src/agents/intraday.ts";
import { aggiornaProposte } from "../src/agents/proposte.ts";
import type { AgentView, Signal } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage } from "../src/cage.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

AGENTS.intraday.riporto.enabled = false;
const intra = (simbolo: string, peso: number): Signal => ({ agente: "intraday", simbolo, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: peso, perche: "prova" });
const view = (extra: Record<string, unknown> = {}) => {
  const simboli = ["NVDA", "AAPL", "MSFT", "SPY", "GLD", "IWM", "BTC/USD", "ETH/USD", "SOL/USD"];
  return { today: "2026-09-24", now: new Date("2026-09-24T15:00:00Z"), prices: Object.fromEntries(simboli.map((s) => [s, 100])), closes: Object.fromEntries(simboli.map((s) => [s, syntheticCloses(100, 0.015, 260)])), indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: true, ...extra } as unknown as AgentView;
};
const valore = (a: ReturnType<typeof allocate>, s: string) => (a.proposte.find((x) => x.symbol === s)?.qty ?? 0) * 100;

describe("budget dell'intraday", () => {
  test("le occasioni intraday insieme non superano il budget (50%); si divide, non si scarta", () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD", "SOL/USD"]);
    const a = allocate(view(), { intraday: { segnali: [intra("NVDA", 0.2), intra("SPY", 0.2), intra("GLD", 0.2)] } }, { intraday: 1 });
    const tot = valore(a, "NVDA") + valore(a, "SPY") + valore(a, "GLD");
    expect(AGENTS.intraday.budget.quota).toBe(0.5);
    expect(tot).toBeLessThanOrEqual(50_000 + 1);
    expect(tot).toBeGreaterThan(48_000);
    for (const s of ["NVDA", "SPY", "GLD"]) expect(valore(a, s)).toBeGreaterThan(15_000);
    // Tre titoli dello stesso settore: il budget si divide prima, poi il tetto per settore (35%) taglia il resto.
    const t = allocate(view(), { intraday: { segnali: [intra("NVDA", 0.2), intra("AAPL", 0.2), intra("MSFT", 0.2)] } }, { intraday: 1 });
    const tech = valore(t, "NVDA") + valore(t, "AAPL") + valore(t, "MSFT");
    expect(tech).toBeLessThanOrEqual(35_000 + 1);
    for (const s of ["NVDA", "AAPL", "MSFT"]) expect(valore(t, s)).toBeGreaterThan(10_000);
  });

  test("con il 45% già investito in intraday resta il 5%; le crypto al massimo il 20%", () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD", "SOL/USD"]);
    const aperto: JournalFile = { ...emptyJournal(), trade: [{ id: "t", simbolo: "IWM", stato: "aperto", apertoIl: "2026-09-24T14:00:00Z", comprate: 450, costo: 45_000, vendute: 0, incassato: 0, quantita: 450, contesto: { agenti: ["intraday"], livelli: { candela: "1Hour", obiettivo: 101, stop: 99 } } } as any] };
    const a = allocate(view({ journal: aperto, positions: [{ symbol: "IWM", qty: 450, avgEntryPrice: 100, currentPrice: 100, marketValue: 45_000 }], account: { equity: 100_000, lastEquity: 100_000, cash: 55_000, status: "ACTIVE" } }), { intraday: { segnali: [intra("AAPL", 0.2)] } }, { intraday: 1 });
    expect(valore(a, "AAPL")).toBeLessThanOrEqual(5_000 + 1);
    expect(valore(a, "AAPL")).toBeGreaterThan(4_900);
    const c = allocate(view(), { intraday: { segnali: [intra("BTC/USD", 0.15), intra("ETH/USD", 0.15), intra("SOL/USD", 0.15)] } }, { intraday: 1 });
    expect(valore(c, "BTC/USD") + valore(c, "ETH/USD") + valore(c, "SOL/USD")).toBeLessThanOrEqual(20_000 + 1);
  });

  test("gabbia: un'operazione intraday può arrivare al 25% del conto; una di più giorni resta al 10%", () => {
    const base = { today: "2026-09-24", marketOpen: true, account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, positions: [], prices: { NVDA: 100 }, closes: { NVDA: syntheticCloses(100, 0.03, 260) }, recentOrders: [], lessons: [], buyBlock: null };
    expect(applyCage({ ...base, proposals: [{ symbol: "NVDA", side: "buy", qty: 200, why: "", intraday: true }] }).orders).toHaveLength(1);
    expect(applyCage({ ...base, proposals: [{ symbol: "NVDA", side: "buy", qty: 260, why: "", intraday: true }] }).rejected[0]!.reason).toContain("massimo 25");
    expect(applyCage({ ...base, proposals: [{ symbol: "NVDA", side: "buy", qty: 200, why: "" }] }).rejected).toHaveLength(1);
  });

  test("il 50% è la regola di serie: il capo non propone più il budget, né in su né in giù", () => {
    const diario = (n: number, r: (i: number) => number): JournalFile => {
      const j = emptyJournal();
      const t0 = Date.parse("2026-10-01T10:00:00Z");
      for (let i = 0; i < n; i++) j.trade.push({ id: `t${i}`, simbolo: "NVDA", stato: "chiuso", apertoIl: new Date(t0 + i * 3_600_000).toISOString(), chiusoIl: new Date(t0 + i * 3_600_000 + 1_800_000).toISOString(), comprate: 1, costo: 1000, vendute: 1, incassato: 1000 * (1 + r(i)), quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], tipo: "intraday", misure: { probabilita: 0.62 }, livelli: { candela: "1Hour", obiettivo: 1010, stop: 996 } } } as any);
      return j;
    };
    for (const r of [(i: number) => (i % 5 < 3 ? 0.006 : -0.004), (i: number) => (i % 5 < 2 ? 0.004 : -0.005)]) {
      const p = aggiornaProposte(mkdtempSync(join(tmpdir(), "bud-")), diario(40, r), new Date("2026-11-01T10:00:00Z"));
      expect(p.nuove.some((x) => x.chiave === "AGENTS.intraday.budget.quota")).toBe(false);
    }
  });
});

// ---------- Lascia correre ----------
const now = new Date("2026-09-27T21:00:00+02:00");
const ORA = 3_600_000;
function salita(fine: number, finoA: Date, passo: number, n = 120): IntradayBar[] {
  const end = Math.floor(finoA.getTime() / passo) * passo;
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const c = fine * (1 - 0.0015 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
    const o = i ? out[i - 1]!.close : c;
    out.push({ t: new Date(end - (k + 1) * passo).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1_000 });
  }
  const k = fine / out.at(-1)!.close;
  return out.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
}

describe("lascia correre i trade in guadagno", () => {
  // BTC comprato a 100 su candele da 1 ora (obiettivo 101, stop 99); la candela di controllo è la stessa (1 ora).
  const giornale = (stop = 99): JournalFile => ({ ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: now.toISOString(), comprate: 1, costo: 100, vendute: 0, incassato: 0, quantita: 1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], tipo: "intraday", livelli: { candela: "1Hour", obiettivo: 101, stop, sopraMedia: false, orizzonteMin: 600 } } } as any] });
  const giro = (agente: IntradayAgent, prezzo: number, quando: Date, j: JournalFile) => agente.observe({ today: "2026-09-27", now: quando, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 1, avgEntryPrice: 100, currentPrice: prezzo, marketValue: prezzo }], account: { equity: 100_000, lastEquity: 100_000, cash: 99_900, status: "ACTIVE" }, journal: j, analisi: false, mercatoAperto: false } as unknown as AgentView);

  test("obiettivo raggiunto e Kronos che vede un piccolo calo: prima lo stop blocca metà del guadagno, poi si esce solo se resta così per 2 candele", async () => {
    setCryptoUniverse(["BTC/USD"]);
    AGENTS.intraday.lasciaCorrere.enabled = true;
    let barre = salita(102, now, ORA);
    const agente = new IntradayAgent(async (syms, tf) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, barre])) : {}), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, () => (step === 60 ? -0.003 : 0))])), () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 }));
    const j = giornale();
    // +2% (oltre l'obiettivo dell'1%): non si vende, lo stop sale a tenere almeno metà del guadagno.
    const r1 = await giro(agente, 102, now, j);
    expect(r1.segnali.filter((x) => x.lato === "sell")).toEqual([]);
    const st1 = r1.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(st1.motivo).toContain("in attesa di conferma (1 di 2 candele 1Hour)");
    expect(st1.stop!).toBeGreaterThanOrEqual(101 - 1e-9);
    expect(j.trade[0]!.contesto!.livelli!.stop).toBe(st1.stop!);
    // Stessa candela, 5 minuti dopo: ancora in attesa (si conta per candele, non per giri).
    const r2 = await giro(agente, 102, new Date(now.getTime() + 5 * 60_000), j);
    expect(r2.segnali.filter((x) => x.lato === "sell")).toEqual([]);
    // Candela nuova, la ragione resta: si esce, in guadagno.
    barre = [...barre, { ...barre.at(-1)!, t: new Date(Date.parse(barre.at(-1)!.t) + ORA).toISOString() }];
    const r3 = await giro(agente, 102, new Date(now.getTime() + 65 * 60_000), j);
    expect(r3.segnali.find((x) => x.lato === "sell")?.perche).toContain("confermato su 2 candele 1Hour");
  });

  test("dopo il pareggio lo stop segue il massimo; con poco guadagno l'uscita morbida resta immediata", async () => {
    setCryptoUniverse(["BTC/USD"]);
    AGENTS.intraday.lasciaCorrere.enabled = true;
    const barre = salita(103, now, ORA);
    const sale = new IntradayAgent(async (syms, tf) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, barre])) : {}), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, (_, i) => (step === 60 ? 0.003 * (i + 1) : 0))])), () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 }));
    // Stop già in pareggio (100,2) e prezzo a 103 (massimo): lo stop sale a 103 − 2 ATR, sopra il pareggio.
    const j = giornale(100.2);
    const r = await sale.observe({ today: "2026-09-27", now, prices: { "BTC/USD": 103 }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 1, avgEntryPrice: 100, currentPrice: 103, marketValue: 103 }], account: { equity: 100_000, lastEquity: 100_000, cash: 99_900, status: "ACTIVE" }, journal: j, analisi: false, mercatoAperto: false } as unknown as AgentView);
    const st = r.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(st.stop!).toBeGreaterThan(100.2);
    expect(st.stop!).toBeLessThan(103);
    expect(j.trade[0]!.contesto!.livelli!.massimo).toBe(103);
    // Guadagno piccolo (+0,5%, meno di 2 volte i costi crypto) e orizzonte scaduto: si esce subito, come prima.
    const scade = new IntradayAgent(async (syms, tf) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, salita(100.5, now, ORA)])) : {}), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, () => 0)])), () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 }));
    const j2: JournalFile = { ...emptyJournal(), trade: [{ ...giornale().trade[0]!, apertoIl: new Date(now.getTime() - 10 * ORA).toISOString(), contesto: { ...giornale().trade[0]!.contesto!, livelli: { candela: "1Hour", obiettivo: 102, stop: 99, sopraMedia: false, orizzonteMin: 60 } } } as any] };
    const r2 = await scade.observe({ today: "2026-09-27", now, prices: { "BTC/USD": 100.5 }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 1, avgEntryPrice: 100, currentPrice: 100.5, marketValue: 100.5 }], account: { equity: 100_000, lastEquity: 100_000, cash: 99_900, status: "ACTIVE" }, journal: j2, analisi: false, mercatoAperto: false } as unknown as AgentView);
    expect(r2.segnali.find((x) => x.lato === "sell")?.perche).toContain("orizzonte di Kronos scaduto");
  });
});

describe("lascia correre: nuovi massimi", () => {
  test("se nel frattempo il prezzo fa un massimo nuovo, la conferma riparte: si esce quando smette di salire", async () => {
    setCryptoUniverse(["BTC/USD"]);
    AGENTS.intraday.lasciaCorrere.enabled = true;
    let barre = salita(102, now, ORA);
    const agente = new IntradayAgent(async (syms, tf) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, barre])) : {}), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, () => (step === 60 ? -0.003 : 0))])), () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 }));
    const j: JournalFile = { ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: now.toISOString(), comprate: 1, costo: 100, vendute: 0, incassato: 0, quantita: 1, contesto: { agenti: ["intraday"], tipo: "intraday", livelli: { candela: "1Hour", obiettivo: 101, stop: 99, sopraMedia: false, orizzonteMin: 600 } } } as any] };
    const giro = (prezzo: number, min: number) => agente.observe({ today: "2026-09-27", now: new Date(now.getTime() + min * 60_000), prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 1, avgEntryPrice: 100, currentPrice: prezzo, marketValue: prezzo }], account: { equity: 100_000, lastEquity: 100_000, cash: 99_900, status: "ACTIVE" }, journal: j, analisi: false, mercatoAperto: false } as unknown as AgentView);
    const nuova = () => { barre = [...barre, { ...barre.at(-1)!, t: new Date(Date.parse(barre.at(-1)!.t) + ORA).toISOString() }]; };
    expect((await giro(102, 0)).segnali.filter((x) => x.lato === "sell")).toEqual([]);
    nuova();
    // Candela nuova ma prezzo a un massimo nuovo (103): si riparte da 1, niente vendita.
    const r2 = await giro(103, 65);
    expect(r2.segnali.filter((x) => x.lato === "sell")).toEqual([]);
    expect(r2.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("(1 di 2");
    nuova();
    // Candela dopo, nessun massimo nuovo: conferma, si vende.
    expect((await giro(102.9, 125)).segnali.find((x) => x.lato === "sell")?.perche).toContain("confermato su 2 candele");
  });
});
