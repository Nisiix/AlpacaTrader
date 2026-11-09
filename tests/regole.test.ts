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


// Soglie del coordinatore dell'apprendimento abbassate per i test con pochi trade (si ripristinano alla fine).
function sogliePiccole() {
  const a = { ...AGENTS.apprendimento }, f = AGENTS.formazione.minTrade, c = AGENTS.calibrazione.minTrade;
  Object.assign(AGENTS.apprendimento, { minTradePersona: 5, minTradeSquadra: 3 });
  AGENTS.formazione.minTrade = 5; AGENTS.calibrazione.minTrade = 5;
  return () => { Object.assign(AGENTS.apprendimento, a); AGENTS.formazione.minTrade = f; AGENTS.calibrazione.minTrade = c; };
}
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
    // Alessandro (staff) lavora ora su AAPL: la sua soglia personale vale lì.
    await Bun.write(join(dir, "persone.json"), JSON.stringify({ versione: 2, staff: { Alessandro: { reparto: "trading", simbolo: "AAPL", dal: "2026-11-09T09:00:00Z" } }, vecchi: {} }));
    const t = (i: number, agenti: string[], vinto: boolean, quando = `2026-11-09T10:${String(i).padStart(2, "0")}:00Z`) => ({ id: `t${i}`, simbolo: "ETH/USD", stato: "chiuso", apertoIl: "2026-11-09T09:00:00Z", chiusoIl: quando, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 101 : 99, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti, ...(agenti[0]?.startsWith("custode ") ? { persone: ["p:Alessandro"] } : {}) } }) as any;
    const j = { ...emptyJournal(), trade: [...Array.from({ length: 6 }, (_, i) => t(i, ["intraday"], i < 2)), ...Array.from({ length: 5 }, (_, i) => t(20 + i, ["custode AAPL"], i < 1))] };
    const ripristina = sogliePiccole();
    applyAgentSettings(dir);
    const base = AGENTS.intraday.kronos.minProb;
    const note = aggiornaCalibrazione(dir, j, new Date("2026-11-09T11:00:00Z"));
    expect(note.some((n) => n.includes("intraday"))).toBe(true);
    const righe = applicaCalibrazione(dir);
    expect(AGENTS.intraday.kronos.minProb).toBeCloseTo(base + 0.025, 6);
    expect(righe.find((r) => r.agente === "intraday")!.passi).toBe(1);
    // Il trading agent di AAPL (1 su 5) ha la sua soglia personale, sopra quella della squadra (anch'essa salita: 1 su 5).
    const { preparaProfili, valore } = await import("../src/agents/profili.ts");
    preparaProfili(dir);
    expect(valore("AGENTS.custodi.minProbabilita", "AAPL")).toBeGreaterThan(AGENTS.custodi.minProbabilita);
    expect(valore("AGENTS.custodi.minProbabilita", "MSFT")).toBe(AGENTS.custodi.minProbabilita);
    // Gli stessi trade non contano due volte: senza trade nuovi niente altro passo.
    expect(aggiornaCalibrazione(dir, j, new Date("2026-11-09T12:00:00Z"))).toEqual([]);
    // Cinque trade nuovi tutti vinti: un passo indietro, verso la base.
    j.trade.push(...Array.from({ length: 5 }, (_, i) => t(40 + i, ["intraday"], true, `2026-11-09T13:0${i}:00Z`)));
    aggiornaCalibrazione(dir, j, new Date("2026-11-09T14:00:00Z"));
    applyAgentSettings(dir); applicaCalibrazione(dir);
    expect(AGENTS.intraday.kronos.minProb).toBeCloseTo(base, 6);
    applyAgentSettings(dir);
    ripristina();
  });
});

import { nomeBreve } from "../src/nomi-titoli.ts";
test("nomi dei titoli: forma breve per la dashboard", () => {
  expect(nomeBreve("Apple Inc. Common Stock")).toBe("Apple Inc.");
  expect(nomeBreve("Bitcoin  / US Dollar")).toBe("Bitcoin");
  expect(nomeBreve("SPDR S&P 500 ETF Trust")).toBe("SPDR S&P 500 ETF Trust");
  expect(nomeBreve("Alphabet Inc. Class A Common Stock")).toBe("Alphabet Inc.");
});

describe("persone e formazione in sala caffè", () => {
  const t = (i: number, sym: string, agenti: string[], persone: string[], vinto: boolean, kronos: number, extra: any = {}) => ({ id: `f${i}`, simbolo: sym, stato: "chiuso", apertoIl: "2026-11-09T09:00:00Z", chiusoIl: `2026-11-09T10:${String(i).padStart(2, "0")}:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 102 : 98, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "Kronos anticipa", agenti, persone, kronos, ...extra } }) as any;
  const voto = (sym: string, kronos: number) => ({ agente: `custode ${sym}`, simbolo: sym, lato: "buy", forza: 1, orizzonteSedute: 5, perche: "x", kronos });
  const staff = (dir: string, membri: Record<string, any>) => Bun.write(join(dir, "persone.json"), JSON.stringify({ versione: 2, staff: membri, vecchi: {} }));

  test("le occasioni vanno alle persone libere, la più brava per prima; chi è in attesa resta in sala caffè; una posizione tiene la sua persona", async () => {
    const { assegnaPersone } = await import("../src/agents/persone.ts");
    const dir = mkdtempSync(join(tmpdir(), "staff-"));
    await staff(dir, { Anna: { reparto: "trading", simbolo: "AAPL", dal: "2026-11-09T08:00:00Z" }, Bruno: { reparto: "trading", simbolo: null, dal: "2026-11-09T08:00:00Z" }, Carlo: { reparto: "trading", simbolo: null, dal: "2026-11-09T07:00:00Z" }, Diana: { reparto: "intraday", simbolo: null, dal: "2026-11-09T06:00:00Z" } });
    const a = assegnaPersone({ stateDir: dir, now: new Date("2026-11-09T11:00:00Z"), sospesi: [], punteggio: (p) => (p === "p:Bruno" ? 0.8 : 0.5), rientro: () => null,
      bisogni: { trading: [{ simbolo: "AAPL", tiene: true, voto: false }, { simbolo: "BTC/USD", tiene: false, voto: true }], intraday: [{ simbolo: "SOL/USD", tiene: false, voto: true }] } });
    expect(a.chi["c:AAPL"]).toBe("p:Anna"); // resta sulla sua posizione
    expect(a.chi["c:BTC/USD"]).toBe("p:Bruno"); // il più bravo dei liberi
    expect(a.chi["i:SOL/USD"]).toBe("p:Diana"); // lo staff è uno: la prende chi aspetta da più tempo (anche per l'intraday)
    expect(a.reg.staff.Carlo!.simbolo).toBeNull(); // niente occasione: in sala caffè
    // Giro dopo: AAPL chiusa, BTC/USD solo «in attesa» (non è più un bisogno): Anna e Bruno tornano liberi.
    const b = assegnaPersone({ stateDir: dir, now: new Date("2026-11-09T11:05:00Z"), sospesi: [], punteggio: () => 0.5, rientro: () => null, bisogni: { trading: [], intraday: [] } });
    expect(Object.keys(b.chi)).toEqual([]);
    expect(b.reg.staff.Anna!.simbolo).toBeNull();
  });

  test("chi lavora male va in sala caffè e non lavora; rientra con un'occasione approvata dal capo o se alla scrivania servono persone; poi usa il bagaglio", async () => {
    const ripristina = sogliePiccole();
    const { aggiornaFormazione, applicaFormazione, provaRientro } = await import("../src/agents/formazione.ts");
    const { assegnaPersone } = await import("../src/agents/persone.ts");
    const dir = mkdtempSync(join(tmpdir(), "form-"));
    await staff(dir, { Anna: { reparto: "trading", simbolo: null, dal: "2026-11-09T08:00:00Z" }, Bruno: { reparto: "trading", simbolo: null, dal: "2026-11-09T08:00:00Z" } });
    const j = { ...emptyJournal(), trade: [
      ...Array.from({ length: 5 }, (_, i) => t(i, "AAPL", ["custode AAPL"], ["p:Anna"], i === 0, 0.01)), // 1 su 5, in perdita
      ...Array.from({ length: 4 }, (_, i) => t(10 + i, "MSFT", ["custode MSFT"], ["p:Bruno"], i < 3, 0.03)), // 3 su 4, in guadagno
    ] };
    const now = new Date("2026-11-09T11:00:00Z");
    const r = aggiornaFormazione(dir, j, ["p:Anna", "p:Bruno"], now);
    expect(r.inFormazione.map((x) => x.chiave)).toEqual(["p:Anna"]);
    expect(r.inFormazione[0]!.mentori).toEqual(["p:Bruno"]);
    // Due occasioni: Bruno prende la prima; per la seconda c'è solo Anna in formazione. Kronos +2% sotto il +3% imparato
    // e alla scrivania 1 persona su un minimo di 10: rientra per necessità, forza ridotta.
    const reports: any = { custodi: { segnali: [voto("NVDA", 0.05), voto("AMZN", 0.02)] } };
    const dimensione = AGENTS.persone.totale; AGENTS.persone.totale = 2; // staff al completo: nessuna nuova assunzione
    const a = assegnaPersone({ stateDir: dir, now, sospesi: ["p:Anna"], punteggio: () => 0.5, bisogni: { trading: [{ simbolo: "NVDA", tiene: false, voto: true }, { simbolo: "AMZN", tiene: false, voto: true }], intraday: [] },
      rientro: (p, desk, _rep, scrivania) => provaRientro(dir, r, p, reports.custodi.segnali.filter((s: any) => `c:${s.simbolo}` === desk), {}, scrivania, 10, now) });
    expect(a.chi["c:NVDA"]).toBe("p:Bruno");
    expect(a.chi["c:AMZN"]).toBe("p:Anna");
    expect(r.rientri["p:Anna"]).toBe("necessità");
    AGENTS.persone.totale = dimensione;
    applicaFormazione(dir, reports, r, {}, a.chi, new Set(a.senzaPersona), now);
    expect(reports.custodi.segnali.find((s: any) => s.simbolo === "AMZN").forza).toBeCloseTo(0.8, 6);
    // Nuova formazione dopo 5 trade persi; con il minimo di persone soddisfatto (0) l'occasione debole non basta...
    const dopo = new Date("2026-11-09T12:00:00Z");
    j.trade.push(...Array.from({ length: 5 }, (_, i) => ({ ...t(30 + i, "AAPL", ["custode AAPL"], ["p:Anna"], false, 0.01), chiusoIl: `2026-11-09T11:3${i}:00Z` })));
    const r2 = aggiornaFormazione(dir, j, ["p:Anna", "p:Bruno"], dopo);
    expect(r2.inFormazione.map((x) => x.chiave)).toEqual(["p:Anna"]);
    expect(provaRientro(dir, r2, "p:Anna", [voto("AMZN", 0.02) as any], {}, 5, 0, dopo)).toBeNull();
    // ...un'occasione che passa il bagaglio (Kronos +3,5% ≥ +3%) sì: il capo la approva.
    expect(provaRientro(dir, r2, "p:Anna", [voto("AMZN", 0.035) as any], {}, 5, 0, dopo)).toContain("approva");
    // Col bagaglio i voti sotto il Kronos imparato non valgono.
    const r3 = aggiornaFormazione(dir, j, ["p:Anna", "p:Bruno"], new Date("2026-11-09T12:10:00Z"));
    expect(r3.conBagaglio.find((x) => x.chiave === "p:Anna")!.bagaglio.kronosMin).toBeCloseTo(0.03, 6);
    const rep3: any = { custodi: { segnali: [voto("AMZN", 0.02), voto("META", 0.035)] } };
    applicaFormazione(dir, rep3, r3, {}, { "c:AMZN": "p:Anna", "c:META": "p:Anna" }, new Set(), new Date("2026-11-09T12:10:00Z"));
    expect(rep3.custodi.segnali.map((s: any) => s.kronos)).toEqual([0.035]);
    ripristina();
  });

  test("a fine formazione si torna disponibili anche senza occasioni", async () => {
    const ripristina = sogliePiccole();
    const { aggiornaFormazione } = await import("../src/agents/formazione.ts");
    const dir = mkdtempSync(join(tmpdir(), "form3-"));
    const j = { ...emptyJournal(), trade: Array.from({ length: 6 }, (_, i) => t(i, "ETH/USD", ["intraday"], ["p:Diana"], i === 0, 0.01, { livelli: { candela: "5Min", obiettivo: 1, stop: 1 } })) };
    expect(aggiornaFormazione(dir, j, ["p:Diana"], new Date("2026-11-09T11:00:00Z")).inFormazione.length).toBe(1);
    const r = aggiornaFormazione(dir, j, ["p:Diana"], new Date("2026-11-10T11:01:00Z"));
    expect(r.inFormazione).toEqual([]);
    expect(r.note[0]).toContain("formazione finita");
    ripristina();
  });

  test("intraday agents: basta una persona alla scrivania; senza nessuno, chi è in formazione rientra con un'occasione", async () => {
    const ripristina = sogliePiccole();
    const { provaRientro, aggiornaFormazione } = await import("../src/agents/formazione.ts");
    const dir = mkdtempSync(join(tmpdir(), "form4-"));
    const j = { ...emptyJournal(), trade: Array.from({ length: 6 }, (_, i) => t(i, "SOL/USD", ["intraday"], ["p:Diana"], i === 0, 0.01, { livelli: { candela: "5Min", obiettivo: 1, stop: 1 } })) };
    const now = new Date("2026-11-09T11:00:00Z");
    const v = { agente: "intraday", simbolo: "SOL/USD", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.1, perche: "SOL/USD intraday su candele 15Min: x" } as any;
    const r = aggiornaFormazione(dir, j, ["p:Diana"], now);
    expect(provaRientro(dir, r, "p:Diana", [v], {}, 1, 1, now)).toBeNull(); // un collega è già alla scrivania
    expect(provaRientro(dir, r, "p:Diana", [v], {}, 0, 1, now)).toContain("almeno 1 persona");
    ripristina();
  });
});

describe("profili personali", () => {
  const staff = (dir: string, membri: Record<string, any>) => Bun.write(join(dir, "persone.json"), JSON.stringify({ versione: 2, staff: membri, vecchi: {} }));
  test("le impostazioni della persona valgono sul titolo su cui lavora; gli altri titoli restano di serie", async () => {
    const { preparaProfili, salvaImpostazioni, valore, impostazioniDi } = await import("../src/agents/profili.ts");
    const dir = mkdtempSync(join(tmpdir(), "prof-"));
    await staff(dir, { Anna: { reparto: "trading", simbolo: "AAPL", dal: "" }, Bruno: { reparto: "intraday", simbolo: "SOL/USD", dal: "" } });
    expect(salvaImpostazioni(dir, "p:Anna", { "LIMITS.trendSmaDays": 40 }).ok).toBe(false); // le medie sono del motore, non personali
    expect(salvaImpostazioni(dir, "p:Anna", { "AGENTS.exit.stopPct": 0.1 }).ok).toBe(false);
    expect(salvaImpostazioni(dir, "p:Anna", { "AGENTS.custodi.minProbabilita": 0.7, "AGENTS.pullback.rsiEntry": 6, "AGENTS.intraday.maxWeight": 0.1 }, 0.12)).toEqual({ ok: true }); // fa anche intraday
    preparaProfili(dir);
    expect(valore("AGENTS.custodi.minProbabilita", "AAPL")).toBe(0.7);
    expect(valore("AGENTS.custodi.minProbabilita", "MSFT")).toBe(AGENTS.custodi.minProbabilita);
    expect(impostazioniDi(dir, "p:Anna").obiettivo.attuale).toBe(0.12);
    expect(impostazioniDi(dir, "p:Bruno").parametri.map((p) => p.chiave)).toContain("AGENTS.intraday.kronos.minProb");
    expect(impostazioniDi(dir, "p:Bruno").parametri.map((p) => p.chiave)).toContain("AGENTS.custodi.minProbabilita"); // ognuno ha entrambe le serie
  });

  test("obiettivo del giorno personale: difesa sotto metà dopo averlo toccato; il giorno dopo sale col successo, scende col fallimento", async () => {
    const { giornataPersone, impostazioniDi } = await import("../src/agents/profili.ts");
    const dir = mkdtempSync(join(tmpdir(), "obj-"));
    await staff(dir, { Anna: { reparto: "trading", simbolo: "AAPL", dal: "" } });
    const t = { id: "a", simbolo: "AAPL", stato: "aperto", apertoIl: "2026-11-09T09:00:00Z", comprate: 1, costo: 100, vendute: 0, incassato: 0, quantita: 1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", persone: ["p:Anna"] } } as any;
    const j = { ...emptyJournal(), trade: [t] };
    const g = (iso: string) => iso.slice(0, 10);
    expect(giornataPersone(dir, j, { AAPL: 111 }, "2026-11-09", g).perPersona["p:Anna"]!.raggiunto).toBe(true); // +11% ≥ 10%
    const d = giornataPersone(dir, j, { AAPL: 104 }, "2026-11-09", g);
    expect(d.difesa.AAPL).toContain("Anna");
    giornataPersone(dir, j, { AAPL: 104 }, "2026-11-10", g);
    expect(impostazioniDi(dir, "p:Anna").obiettivo.attuale).toBeCloseTo(0.11, 6); // successo: +1 punto
    giornataPersone(dir, j, { AAPL: 95 }, "2026-11-10", g);
    giornataPersone(dir, j, { AAPL: 95 }, "2026-11-11", g);
    expect(impostazioniDi(dir, "p:Anna").obiettivo.attuale).toBeCloseTo(0.1, 6); // fallimento: −1 punto
  });

  test("in sala caffè ci si ricalibra: verso le impostazioni dei bravi, o sui dati se sono tutte uguali", async () => {
    const { ricalibrazione } = await import("../src/agents/formazione.ts");
    const { salvaImpostazioni, impostazioniDi } = await import("../src/agents/profili.ts");
    const dir = mkdtempSync(join(tmpdir(), "ric-"));
    await staff(dir, { Anna: { reparto: "trading", simbolo: null, dal: "" }, Bruno: { reparto: "trading", simbolo: null, dal: "" } });
    // Tutti uguali: ricalibrazione sui dati, più selettiva (contesto sfavorevole: due passi).
    // Le impostazioni ricalibrate non valgono subito: vanno in prova in ombra.
    const r1 = ricalibrazione(dir, "p:Anna", ["p:Bruno"], new Map(), "sfavorevole", new Date());
    expect(r1.motivo).toContain("sui dati");
    expect(impostazioniDi(dir, "p:Anna").parametri.find((p) => p.chiave === "AGENTS.custodi.minProbabilita")!.attuale).toBe(AGENTS.custodi.minProbabilita);
    expect(impostazioniDi(dir, "p:Anna").prova!.valori["AGENTS.custodi.minProbabilita"]).toBeCloseTo(Math.min(0.8, AGENTS.custodi.minProbabilita + 0.1), 6);
    // Bruno (bravo) ha un RSI d'ingresso di 6: la proposta per Anna va a metà strada.
    salvaImpostazioni(dir, "p:Bruno", { "AGENTS.pullback.rsiEntry": 6 });
    const r2 = ricalibrazione(dir, "p:Anna", ["p:Bruno"], new Map(), "neutro", new Date());
    expect(r2.motivo).toContain("Bruno");
    expect(impostazioniDi(dir, "p:Anna").prova!.valori["AGENTS.pullback.rsiEntry"]).toBe(Math.round(AGENTS.pullback.rsiEntry + (6 - AGENTS.pullback.rsiEntry) / 2));
  });

  test("un titolo, una persona: se trading e intraday lo vogliono entrambi, lo tiene chi ha la posizione", async () => {
    const { assegnaPersone } = await import("../src/agents/persone.ts");
    const dir = mkdtempSync(join(tmpdir(), "uno-"));
    await staff(dir, { Anna: { reparto: "trading", simbolo: null, dal: "" }, Elio: { reparto: "intraday", simbolo: null, dal: "" } });
    const a = assegnaPersone({ stateDir: dir, now: new Date(), sospesi: [], punteggio: () => 0.5, rientro: () => null, bisogni: { trading: [{ simbolo: "SOL/USD", tiene: false, voto: true }], intraday: [{ simbolo: "SOL/USD", tiene: true, voto: false }] } });
    expect(Object.keys(a.chi)).toEqual(["i:SOL/USD"]);
    expect(a.bloccati["c:SOL/USD"]).toContain("una sola posizione");
  });
});

test("il team è fisso a 20: nessuno esce; con tutti occupati una nuova occasione resta senza persona", async () => {
  const { assegnaPersone } = await import("../src/agents/persone.ts");
  const dir = mkdtempSync(join(tmpdir(), "team-"));
  const staff: Record<string, any> = {};
  for (let i = 0; i < 20; i++) staff[`P${i}`] = { reparto: "trading", simbolo: `S${i}`, dal: "2026-11-09T08:00:00Z" };
  await Bun.write(join(dir, "persone.json"), JSON.stringify({ versione: 2, staff, vecchi: {} }));
  const bisogni = { trading: [...Array.from({ length: 20 }, (_, i) => ({ simbolo: `S${i}`, tiene: true, voto: false })), { simbolo: "NEW", tiene: false, voto: true }], intraday: [] };
  const a = assegnaPersone({ stateDir: dir, now: new Date(), sospesi: [], punteggio: () => 0.5, rientro: () => null, bisogni });
  expect(Object.keys(a.reg.staff).length).toBe(20);
  expect(a.senzaPersona).toEqual(["c:NEW"]);
});

describe("apprendimento verificato", () => {
  const tr = (i: number, vinto: boolean, extra: any = {}) => ({ id: `s${i}`, simbolo: "AAPL", stato: "chiuso", apertoIl: "2026-10-01T14:00:00Z", chiusoIl: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T18:${String(i % 60).padStart(2, "0")}:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 103 : 98, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", ...extra } }) as any;

  test("coordinatore: sotto il campione minimo non si giudica; con pochi trade la persona si avvicina alla squadra", async () => {
    const { campione, daStringere } = await import("../src/agents/apprendimento.ts");
    const pochi = Array.from({ length: 5 }, (_, i) => tr(i, i === 0));
    expect(daStringere(campione(pochi, null, AGENTS.apprendimento.minTradePersona))).toBe(false); // 5 trade: non basta
    const squadra = Array.from({ length: 30 }, (_, i) => tr(100 + i, i % 3 !== 0)); // la squadra vince 2 su 3
    const c = campione(pochi, squadra, 5);
    expect(c.q).toBeCloseTo(0.2, 6);
    expect(c.qS).toBeGreaterThan(0.45); // 1 su 5 pesa poco contro 10 trade «virtuali» della squadra
  });

  test("prova in ombra: le nuove soglie si adottano solo se sui trade successivi avrebbero fatto meglio", async () => {
    const { proponiProva, valutaProve, impostazioniDi } = await import("../src/agents/profili.ts");
    const dir = mkdtempSync(join(tmpdir(), "ombra-"));
    await Bun.write(join(dir, "persone.json"), JSON.stringify({ versione: 2, staff: { Anna: { reparto: "trading", simbolo: null, dal: "" } }, vecchi: {} }));
    const dal = new Date("2026-10-01T00:00:00Z");
    proponiProva(dir, "p:Anna", { "AGENTS.custodi.minProbabilita": 0.7 }, "test", dal);
    // Dopo: i trade con probabilità 0,62 perdono, quelli con 0,75 vincono → con la soglia 0,7 si sarebbe fatto meglio.
    const j = { ...emptyJournal(), trade: Array.from({ length: 16 }, (_, i) => tr(i, i % 2 === 0, { misure: { probabilita: i % 2 === 0 ? 0.75 : 0.62 }, tipo: "trading" })) };
    const note = valutaProve(dir, j, new Date("2026-10-30T00:00:00Z"));
    expect(note[0]).toContain("adottate");
    expect(impostazioniDi(dir, "p:Anna").parametri.find((p) => p.chiave === "AGENTS.custodi.minProbabilita")!.attuale).toBe(0.7);
    // Il contrario: con la soglia alta si sarebbero persi i trade buoni → scartate.
    proponiProva(dir, "p:Anna", { "AGENTS.custodi.minProbabilita": 0.8 }, "test", dal);
    const j2 = { ...emptyJournal(), trade: Array.from({ length: 16 }, (_, i) => tr(i, true, { misure: { probabilita: 0.72 }, tipo: "trading" })) };
    expect(valutaProve(dir, j2, new Date("2026-10-30T00:00:00Z"))[0]).toContain("scartate");
  });

  test("calibrazione delle probabilità e meta-modello: attivi solo con abbastanza trade e se migliorano sui più recenti; Kelly ferma l'aspettativa negativa", async () => {
    const { aggiornaProbabilita, calibraP, aggiornaMeta, pesoKelly, estraiBetaMedia } = await import("../src/agents/statistica.ts").then(async (m) => ({ ...m, estraiBetaMedia: (await import("../src/agents/casuale.ts")).estraiBeta }));
    const poco = { ...emptyJournal(), trade: Array.from({ length: 10 }, (_, i) => tr(i, true, { misure: { probabilita: 0.6 } })) };
    expect(aggiornaProbabilita(poco).trading.attiva).toBe(false);
    expect(calibraP("trading", 0.6)).toBe(0.6);
    // 200 trade: la stima dice 0,7 ma si vince il 40% delle volte → la calibrazione impara a correggerla.
    let seme = 7; const rnd = () => ((seme = (seme * 16807) % 2147483647) / 2147483647);
    const molti = { ...emptyJournal(), trade: Array.from({ length: 200 }, (_, i) => tr(i, rnd() < 0.4, { misure: { probabilita: 0.65 + 0.1 * rnd() }, kronos: 0.02 })) };
    const st = aggiornaProbabilita(molti);
    expect(st.trading.n).toBe(200);
    if (st.trading.attiva) expect(calibraP("trading", 0.7)).toBeLessThan(0.6);
    expect(aggiornaMeta(poco).attivo).toBe(false);
    expect(pesoKelly(0.4, 1, 0.05)).toBeNull(); // aspettativa negativa: non si entra
    expect(pesoKelly(0.6, 1.5, 0.05)!).toBeGreaterThan(0.1);
    let somma = 0; for (let i = 0; i < 2000; i++) somma += estraiBetaMedia(9, 3, rnd);
    expect(somma / 2000).toBeCloseTo(0.75, 1); // Beta(9, 3) ha media 0,75
    aggiornaProbabilita(emptyJournal());
  });
});
