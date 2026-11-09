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

  test("biblioteca: regola del 2% per costruzione, niente medie al ribasso (Livermore)", async () => {
    const { BIBLIOTECA } = await import("../src/agents/biblioteca.ts");
    expect(LIMITS.maxPositionPct * LIMITS.stop.maxPct).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(BIBLIOTECA.filter((p) => p.applicato).length).toBeGreaterThanOrEqual(10);
    const sig = { agente: "trend", simbolo: "SPY", lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "x" };
    const base = { today: "2026-11-09", now: new Date(), prices: { SPY: 570 }, closes: { SPY: salita(600) }, indicators: {}, account, journal: emptyJournal(), previsioni: { SPY: 0.03 }, analisi: true } as unknown as AgentView;
    const inPerdita = allocate({ ...base, positions: [{ symbol: "SPY", qty: 5, avgEntryPrice: 600, currentPrice: 570, marketValue: 2850 }] } as AgentView, { trend: { segnali: [sig] } }, {});
    expect(inPerdita.proposte).toEqual([]);
    expect(inPerdita.inAttesa[0]!.motivo).toContain("non si media al ribasso");
  });
});

describe("calibrazione del capo ufficio", () => {
  test("sotto il 51% di vittorie un agente diventa più selettivo di un passo, mai oltre i limiti; tornato a vincere si riavvicina alla base", async () => {
    const { aggiornaCalibrazione, applicaCalibrazione } = await import("../src/agents/calibrazione.ts");
    const { applyAgentSettings } = await import("../src/agent-settings.ts");
    const dir = mkdtempSync(join(tmpdir(), "cal-"));
    const t = (i: number, agenti: string[], vinto: boolean, quando = `2026-11-09T10:${String(i).padStart(2, "0")}:00Z`) => ({ id: `t${i}`, simbolo: "ETH/USD", stato: "chiuso", apertoIl: "2026-11-09T09:00:00Z", chiusoIl: quando, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 101 : 99, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti } }) as any;
    const j = { ...emptyJournal(), trade: [...Array.from({ length: 6 }, (_, i) => t(i, ["intraday"], i < 2)), ...Array.from({ length: 5 }, (_, i) => t(20 + i, ["custode AAPL"], i < 1))] };
    applyAgentSettings(dir);
    const base = AGENTS.intraday.kronos.minProb;
    const note = aggiornaCalibrazione(dir, j, new Date("2026-11-09T11:00:00Z"));
    expect(note.some((n) => n.includes("intraday"))).toBe(true);
    const righe = applicaCalibrazione(dir);
    expect(AGENTS.intraday.kronos.minProb).toBeCloseTo(base + 0.025, 6);
    expect(righe.find((r) => r.agente === "intraday")!.passi).toBe(1);
    // Il trading agent di AAPL (1 su 5) ha la sua soglia personale, sopra quella della squadra (anch'essa salita: 1 su 5).
    expect(AGENTS.custodi.minProbabilitaPer.AAPL).toBeGreaterThan(AGENTS.custodi.minProbabilita);
    // Gli stessi trade non contano due volte: senza trade nuovi niente altro passo.
    expect(aggiornaCalibrazione(dir, j, new Date("2026-11-09T12:00:00Z"))).toEqual([]);
    // Cinque trade nuovi tutti vinti: un passo indietro, verso la base.
    j.trade.push(...Array.from({ length: 5 }, (_, i) => t(40 + i, ["intraday"], true, `2026-11-09T13:0${i}:00Z`)));
    aggiornaCalibrazione(dir, j, new Date("2026-11-09T14:00:00Z"));
    applyAgentSettings(dir); applicaCalibrazione(dir);
    expect(AGENTS.intraday.kronos.minProb).toBeCloseTo(base, 6);
    applyAgentSettings(dir);
    AGENTS.custodi.minProbabilitaPer = {};
  });
});

import { nomeBreve } from "../src/nomi-titoli.ts";
test("nomi dei titoli: forma breve per la dashboard", () => {
  expect(nomeBreve("Apple Inc. Common Stock")).toBe("Apple Inc.");
  expect(nomeBreve("Bitcoin  / US Dollar")).toBe("Bitcoin");
  expect(nomeBreve("SPDR S&P 500 ETF Trust")).toBe("SPDR S&P 500 ETF Trust");
  expect(nomeBreve("Alphabet Inc. Class A Common Stock")).toBe("Alphabet Inc.");
});

describe("formazione in sala caffè", () => {
  test("chi lavora male va in sala caffè e non vota; torna con un'occasione approvata dal capo o se servono persone alla scrivania; a fine formazione col bagaglio", async () => {
    const { aggiornaFormazione, applicaFormazione } = await import("../src/agents/formazione.ts");
    const dir = mkdtempSync(join(tmpdir(), "form-"));
    const t = (i: number, sym: string, agenti: string[], vinto: boolean, kronos: number) => ({ id: `f${i}`, simbolo: sym, stato: "chiuso", apertoIl: "2026-11-09T09:00:00Z", chiusoIl: `2026-11-09T10:${String(i).padStart(2, "0")}:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 102 : 98, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "Kronos anticipa", agenti, kronos } }) as any;
    const j = { ...emptyJournal(), trade: [
      ...Array.from({ length: 5 }, (_, i) => t(i, "AAPL", ["custode AAPL"], i === 0, 0.01)), // 1 su 5, in perdita
      ...Array.from({ length: 4 }, (_, i) => t(10 + i, "MSFT", ["custode MSFT"], i < 3, 0.03)), // 3 su 4, in guadagno
    ] };
    const tutti = Array.from({ length: 12 }, (_, i) => `c:S${i}`).concat(["c:AAPL", "c:MSFT"]);
    const now = new Date("2026-11-09T11:00:00Z");
    const voto = (kronos: number) => ({ agente: "custode AAPL", simbolo: "AAPL", lato: "buy", forza: 1, orizzonteSedute: 5, perche: "x", kronos });
    const r = aggiornaFormazione(dir, j, tutti, now);
    expect(r.inFormazione.map((x) => x.chiave)).toEqual(["c:AAPL"]);
    expect(r.inFormazione[0]!.mentori).toEqual(["c:MSFT"]);
    // Occasione debole (Kronos +2% sotto il +3% dei colleghi bravi) con 12 persone alla scrivania: resta in sala caffè.
    const rep: any = { custodi: { segnali: [voto(0.02), { agente: "custode AAPL", simbolo: "AAPL", lato: "sell", forza: 1, orizzonteSedute: 5, perche: "y" }] } };
    applicaFormazione(dir, rep, r, {}, { trading: 12, intraday: 0 }, now);
    expect(rep.custodi.segnali.map((s: any) => s.lato)).toEqual(["sell"]);
    expect(r.inFormazione.length).toBe(1);
    // Stessa occasione debole ma solo 9 alla scrivania: torna per necessità, con forza ridotta.
    const r9 = aggiornaFormazione(dir, j, tutti, now);
    const rep9: any = { custodi: { segnali: [voto(0.02)] } };
    applicaFormazione(dir, rep9, r9, {}, { trading: 9, intraday: 5 }, now);
    expect(rep9.custodi.segnali[0].forza).toBeCloseTo(0.8, 6);
    expect(r9.inFormazione).toEqual([]);
    // Nuova formazione (5 trade persi dopo il rientro), poi un'occasione valida: il capo la approva e torna subito.
    const dopo = new Date("2026-11-09T12:00:00Z");
    j.trade.push(...Array.from({ length: 5 }, (_, i) => ({ ...t(30 + i, "AAPL", ["custode AAPL"], false, 0.01), chiusoIl: `2026-11-09T11:3${i}:00Z` })));
    const r2 = aggiornaFormazione(dir, j, tutti, dopo);
    expect(r2.inFormazione.map((x) => x.chiave)).toEqual(["c:AAPL"]);
    const rep2: any = { custodi: { segnali: [voto(0.035)] } };
    applicaFormazione(dir, rep2, r2, {}, { trading: 12, intraday: 0 }, dopo);
    expect(rep2.custodi.segnali.length).toBe(1);
    expect(r2.inFormazione).toEqual([]);
    // Col bagaglio: i voti sotto il Kronos imparato non valgono.
    const r3 = aggiornaFormazione(dir, j, tutti, new Date("2026-11-09T12:10:00Z"));
    expect(r3.conBagaglio.find((x) => x.chiave === "c:AAPL")!.bagaglio.kronosMin).toBeCloseTo(0.03, 6);
    const rep3: any = { custodi: { segnali: [voto(0.02), voto(0.035)] } };
    applicaFormazione(dir, rep3, r3, {}, { trading: 12, intraday: 0 }, new Date("2026-11-09T12:10:00Z"));
    expect(rep3.custodi.segnali.map((s: any) => s.kronos)).toEqual([0.035]);
  });
  test("a fine formazione si torna alla scrivania anche senza occasioni", async () => {
    const { aggiornaFormazione } = await import("../src/agents/formazione.ts");
    const dir = mkdtempSync(join(tmpdir(), "form3-"));
    const t = (i: number, vinto: boolean) => ({ id: `g${i}`, simbolo: "ETH/USD", stato: "chiuso", apertoIl: "2026-11-09T09:00:00Z", chiusoIl: `2026-11-09T10:0${i}:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 101 : 99, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], livelli: { candela: "5Min", obiettivo: 1, stop: 1 } } }) as any;
    const j = { ...emptyJournal(), trade: Array.from({ length: 6 }, (_, i) => t(i, i === 0)) };
    expect(aggiornaFormazione(dir, j, ["i:ETH/USD"], new Date("2026-11-09T11:00:00Z")).inFormazione.length).toBe(1);
    const r = aggiornaFormazione(dir, j, ["i:ETH/USD"], new Date("2026-11-10T11:01:00Z"));
    expect(r.inFormazione).toEqual([]);
    expect(r.note[0]).toContain("formazione finita");
  });
  test("sala intraday: basta un operatore alla scrivania; se non c'è nessuno, chi ha un'occasione rientra per primo (zero se non c'è niente da fare)", async () => {
    const { aggiornaFormazione, applicaFormazione } = await import("../src/agents/formazione.ts");
    const dir = mkdtempSync(join(tmpdir(), "form4-"));
    const t = (i: number, vinto: boolean) => ({ id: `h${i}`, simbolo: "ETH/USD", stato: "chiuso", apertoIl: "2026-11-09T09:00:00Z", chiusoIl: `2026-11-09T10:0${i}:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 101 : 99, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], livelli: { candela: "5Min", obiettivo: 1, stop: 1 } } }) as any;
    const j = { ...emptyJournal(), trade: Array.from({ length: 6 }, (_, i) => t(i, i === 0)) };
    const now = new Date("2026-11-09T11:00:00Z");
    const voto = () => ({ agente: "intraday", simbolo: "ETH/USD", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.1, perche: "ETH/USD intraday su candele 15Min: x" });
    const r = aggiornaFormazione(dir, j, ["i:ETH/USD"], now);
    const a: any = { intraday: { segnali: [voto()] } };
    applicaFormazione(dir, a, r, {}, { trading: 20, intraday: 1 }, now);
    expect(a.intraday.segnali).toEqual([]);
    const b: any = { intraday: { segnali: [voto()] } };
    applicaFormazione(dir, b, r, {}, { trading: 20, intraday: 0 }, now);
    expect(b.intraday.segnali[0].pesoMassimo).toBeCloseTo(0.07, 6);
  });
});
