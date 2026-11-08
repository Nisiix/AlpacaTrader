import { describe, expect, test } from "bun:test";
import { applyLessons, coffeeBreak, teamLessons } from "../src/agents/caffe.ts";
import { explore, readEsplorazione, scoutVotes, technicalGate } from "../src/agents/esplorazione.ts";
import { AGENTS } from "../src/config.ts";
import { SQUADRA_CUSTODI, applyGuidance, kronosOf, regolaSuperata, review } from "../src/agents/capo.ts";
import type { CustodeStato } from "../src/agents/custode.ts";
import type { AgentReport } from "../src/agents/types.ts";
import { emptyJournal, type JournalFile, type Trade } from "../src/journal.ts";

// Un trade chiuso: aperto un giorno, chiuso qualche giorno dopo (salvo indicato), con agenti, motivo e risultato.
function trade(i: number, simbolo: string, risultato: number, agenti: string[], perche: string, o: { kronos?: number; stessoGiorno?: boolean; uscita?: string } = {}): Trade {
  const aperto = `2026-10-${String(1 + i).padStart(2, "0")}T14:00:00Z`;
  const chiuso = o.stessoGiorno ? `2026-10-${String(1 + i).padStart(2, "0")}T15:00:00Z` : `2026-10-${String(4 + i).padStart(2, "0")}T14:00:00Z`;
  return {
    id: `t${i}`, simbolo, stato: "chiuso", apertoIl: aperto, chiusoIl: chiuso, comprate: 10, costo: 1000, vendute: 10, incassato: 1000 * (1 + risultato), quantita: 0, risultato, motivoUscita: o.uscita ?? "stop di protezione",
    contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche, agenti, ...(o.kronos !== undefined ? { kronos: o.kronos } : {}) },
  };
}
const journalOf = (ts: Trade[]): JournalFile => ({ ...emptyJournal(), trade: ts });
const custode = (simbolo: string, fase: CustodeStato["fase"], prob = 0.55): CustodeStato => ({
  simbolo, agente: `custode ${simbolo}`, fase, tesi: "", piano: "", rischio: "", stato: "", dalle: "2026-11-01",
  livelli: { prezzo: 1, media20: 1, media50: 1, media200: 1, stop: null, carico: null },
  numeri: { momentum3m: null, momentum12m: null, distanzaMedia50: null, volGiornaliera: null, guadagno: null },
  dossier: { aggiornato: "2026-11-08T10:00:00Z", probabilita: prob, tecnica: { punteggio: 0.6, pattern: ["sopra la media a 200"] }, kronos: { punteggio: 0.5, nota: "+0.4% a 5 sedute" }, notizie: { punteggio: 0.6, titoli: [], nota: "leggermente positive" }, contesto: { punteggio: 0.2, nota: "crypto sfavorevole" }, memoria: { trade: 0, vinti: 0, media: null, daStop: 0, giorniMedi: null, ultimo: null, ingressoMigliore: null, lezione: "", fattore: 1, pesoMassimo: null } as any, prossimaAzione: "aspettare" },
});

describe("capo ufficio", () => {
  test("legge Kronos anche dal motivo dei trade vecchi e non giudica le uscite in giornata della regola superata", () => {
    expect(kronosOf({ contesto: { perche: "kronos: Kronos anticipa 12.9% a 5 sedute" } as Trade["contesto"] })).toBeCloseTo(0.129, 6);
    expect(kronosOf({ contesto: { perche: "trend", kronos: 0.02 } as Trade["contesto"] })).toBe(0.02);
    const vecchi = [0, 1, 2, 3].map((i) => trade(i, "AAVE/USD", -0.005, ["custode AAVE/USD"], "custode: rialzo anticipato da Kronos", { stessoGiorno: true, uscita: "uscita di trend del codice" }));
    expect(regolaSuperata(vecchi[0]!)).toBe(true);
    const r = review(journalOf(vecchi), new Date("2026-11-08T17:00:00Z"));
    expect(r.esclusi).toBe(4);
    expect(r.valutazioni).toEqual([]);
    expect(r.sintesi).toContain("dalla vecchia uscita in giornata");
  });

  test("la squadra dei custodi si giudica insieme: con 3 trade persi (uno per custode) scatta il richiamo e vale per tutti i custodi", () => {
    const ts = ["SOL/USD", "LTC/USD", "AVAX/USD"].map((s, i) => trade(i, s, -0.02, [`custode ${s}`], `custode ${s}: rialzo anticipato da Kronos`, { kronos: 0.012 }));
    const r = review(journalOf(ts), new Date("2026-11-08T17:00:00Z"));
    const sq = r.valutazioni.find((v) => v.agente === SQUADRA_CUSTODI)!;
    expect(sq.giudizio).toBe("richiamato");
    expect(r.valutazioni.find((v) => v.agente === "custode SOL/USD")!.giudizio).toBe("nuovo");
    // Un custode nuovo (DOT) eredita il richiamo della squadra: voto sotto la soglia scartato, sopra con forza ridotta.
    const reports: Record<string, AgentReport> = { custodi: { segnali: [
      { agente: "custode DOT/USD", simbolo: "DOT/USD", lato: "buy", forza: 1, orizzonteSedute: 5, kronos: 0.004, perche: "x" },
      { agente: "custode ADA/USD", simbolo: "ADA/USD", lato: "buy", forza: 1, orizzonteSedute: 5, kronos: 0.04, perche: "y" },
    ] } };
    const note = applyGuidance(reports, r, undefined);
    expect(note[0]).toContain("custode DOT/USD");
    expect(reports.custodi!.segnali.map((s) => [s.simbolo, s.forza])).toEqual([["ADA/USD", 0.6]]);
  });
});

describe("sala caffè", () => {
  const perdenti = ["SOL/USD", "LTC/USD", "AVAX/USD"].map((s, i) => trade(i, s, -0.02, [`custode ${s}`], `custode ${s}: rialzo anticipato da Kronos`, { kronos: 0.015 }));
  const vincenti = ["SPY", "QQQ", "GLD"].map((s, i) => trade(10 + i, s, 0.03, ["rientro"], "rientro: RSI(2) ipervenduto, vicino alla media", { kronos: 0.02 }));

  test("lezioni di squadra dal diario: prudenza dove si perde, fiducia dove si vince, almeno 3 trade", () => {
    const l = teamLessons(journalOf([...perdenti, ...vincenti]));
    const crypto = l.find((x) => x.tema === "settore" && x.chiave === "crypto")!;
    expect(crypto).toMatchObject({ trade: 3, vinti: 0, effetto: "prudenza" });
    expect(crypto.testo).toContain("0 vinti su 3");
    expect(l.find((x) => x.tema === "ingresso" && x.chiave === "rientro sulla media a 20")!.effetto).toBe("fiducia");
    // Con 2 trade soli nessuna lezione.
    expect(teamLessons(journalOf(perdenti.slice(0, 2)))).toEqual([]);
  });

  test("le lezioni correggono i voti d'acquisto simili, con limiti; vendite e regole vincolanti no", () => {
    const l = teamLessons(journalOf([...perdenti, ...vincenti]));
    const reports: Record<string, AgentReport> = {
      custodi: { segnali: [{ agente: "custode DOT/USD", simbolo: "DOT/USD", lato: "buy", forza: 1, orizzonteSedute: 5, kronos: 0.015, perche: "rialzo anticipato da Kronos" }] },
      rientro: { segnali: [{ agente: "rientro", simbolo: "SPY", lato: "buy", forza: 0.7, orizzonteSedute: 5, perche: "RSI(2) ipervenduto, vicino alla media" }] },
      uscite: { segnali: [{ agente: "uscite", simbolo: "SOL/USD", lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, perche: "stop" }] },
    };
    const note = applyLessons(reports, l, { SPY: 0.02 });
    const dot = reports.custodi!.segnali[0]!;
    expect(dot.forza).toBeGreaterThanOrEqual(0.7);
    expect(dot.forza).toBeLessThan(1);
    expect(dot.perche).toContain("sala caffè: prudenza");
    expect(reports.rientro!.segnali[0]!.forza).toBeGreaterThan(0.7);
    expect(reports.rientro!.segnali[0]!.forza).toBeLessThanOrEqual(0.7 * 1.15 + 1e-9);
    expect(reports.uscite!.segnali[0]!.forza).toBe(1);
    expect(note.some((n) => n.includes("DOT/USD") && n.includes("più prudente"))).toBe(true);
  });

  test("chi non ha niente da fare va in sala caffè; chi ha un trade da aprire o una posizione torna alla scrivania; si scambiano i loro dati", () => {
    const reports: Record<string, AgentReport> = {
      trend: { segnali: [] },
      regime: { segnali: [], rischio: 0.75 },
      kronos: { segnali: [] },
      custodi: {
        segnali: [{ agente: "custode ETH/USD", simbolo: "ETH/USD", lato: "buy", forza: 0.8, orizzonteSedute: 5, perche: "rialzo" }],
        custodi: [custode("BTC/USD", "attende", 0.42), custode("ETH/USD", "attende"), custode("SOL/USD", "osserva", 0.51), custode("AAPL", "in posizione")],
      },
      intraday: { segnali: [], intraday: [{ simbolo: "DOT/USD", candela: "5Min", fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: 1, motivo: "prudenza: giornaliero sotto le medie" }] },
    };
    const lezioni = teamLessons(journalOf(perdenti));
    const c = coffeeBreak({ now: new Date("2026-11-08T17:00:00Z"), reports, held: new Set(["AAPL"]), previsioni: { NVDA: 0.047, "DOT/USD": 0.04, AAPL: -0.14 }, scartate: ["PEPE/USD"], lezioni, capo: null, applicati: [], giro: 1 });
    const qui = c.presenti.map((p) => p.chiave).sort();
    expect(qui).toEqual(["a:kronos", "a:trend", "c:BTC/USD", "c:SOL/USD", "i:DOT/USD"]);
    const op = Object.fromEntries(c.operativi.map((o) => [o.chiave, o.perche]));
    expect(op["c:ETH/USD"]).toBe("trade da aprire su ETH/USD");
    expect(op["c:AAPL"]).toBe("segue la posizione");
    expect(op["a:regime"]).toContain("75%");
    const testi = c.scambi.map((s) => s.testo).join("\n");
    expect(testi).toContain("BTC/USD: 42% favorevole");
    expect(testi).toContain("DOT/USD su candele 5Min");
    expect(testi).toContain("NVDA +4.7%");
    expect(testi).toContain("non fidatevi di PEPE/USD");
    expect(testi).toContain("0 vinti su 3");
    // ETH non era in pausa al giro prima: non "torna". Se c'era, lo dice.
    expect(c.scambi.some((s) => s.tema === "rientro")).toBe(false);
    const c2 = coffeeBreak({ now: new Date("2026-11-08T17:05:00Z"), reports, held: new Set(["AAPL"]), previsioni: undefined, scartate: [], lezioni: [], capo: null, applicati: [], giro: 2, primaInPausa: new Set(["c:ETH/USD"]) });
    expect(c2.scambi.find((s) => s.tema === "rientro")).toMatchObject({ da: "c:ETH/USD", testo: "Torno alla scrivania: trade da aprire su ETH/USD." });
    // I pareri dei custodi vanno a un collega in sala (preferibilmente dello stesso settore), mai a se stessi.
    for (const s of c.scambi.filter((s) => s.tema === "parere")) expect(s.a).not.toBe(s.da);
  });
});

describe("esplorazione dalla sala caffè", () => {
  const rising = (base: number, n = 300) => Array.from({ length: n }, (_, i) => base * (1 + 0.003 * i + 0.01 * Math.sin(i / 7)));
  const barsOf = (closes: number[]) => closes.map((c, i) => ({ date: `d${i}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }));
  const presenti = [{ chiave: "c:BTC/USD", nome: "custode BTC/USD", perche: "aspetta" }, { chiave: "c:AAPL", nome: "custode AAPL", perche: "aspetta" }, { chiave: "a:orizzonte", nome: "orizzonte", perche: "nessun voto" }];

  test("filtro tecnico del motore: sopra la 200 e in ordine passa; in calo no", () => {
    expect(technicalGate(rising(100)).ok).toBe(true);
    const g = technicalGate(rising(100).reverse());
    expect(g.ok).toBe(false);
    expect(g.motivo).toContain("sotto la media a 200");
  });

  test("un giro: titoli del radar, filtro, Kronos; chi trova torna alla scrivania; al massimo un giro ogni mezz'ora", async () => {
    const f = readEsplorazione("/nonexistent-dir", "2026-11-09");
    const now = new Date("2026-11-09T15:00:00Z");
    const r = await explore({
      now, today: "2026-11-09", file: f, presenti, universe: ["SPY", "AAPL"], cryptoFuori: [],
      getBars: async (syms) => Object.fromEntries(syms.map((s) => [s, barsOf(s === "AVGO" ? rising(100).reverse() : rising(100))])),
      forecast: async (syms) => Object.fromEntries(syms.map((s) => [s, s === "AMD" ? 0.03 : s === "GOOGL" ? 0.4 : -0.01])),
    });
    expect(r!.esaminati).toHaveLength(AGENTS.esplorazione.perGiro);
    const amd = r!.nuove.find((n) => n.simbolo === "AMD")!;
    // AMD è tecnologia: la trova il custode di AAPL (stesso settore), che vota come "custode AAPL".
    expect(amd).toMatchObject({ scopritore: "c:AAPL", agente: "custode AAPL", stato: "attiva", settore: "tecnologia" });
    // AVGO è sotto la 200: lo si guarda lo stesso (contro tendenza), ma Kronos non vede un rialzo.
    expect(r!.scartati.find((x) => x.simbolo === "AVGO")!.motivo).toContain("nessun rialzo");
    expect(r!.scartati.find((x) => x.simbolo === "GOOGL")!.motivo).toContain("fuori misura");
    expect(r!.nuove.some((n) => n.simbolo === "GOOGL")).toBe(false);
    // Mezz'ora non è passata: niente secondo giro.
    expect(await explore({ now: new Date(now.getTime() + 10 * 60_000), today: "2026-11-09", file: f, presenti, universe: [], cryptoFuori: [], getBars: async () => ({}), forecast: null })).toBeNull();
    // Senza nessuno in pausa nessuno esplora.
    expect(await explore({ now: new Date(now.getTime() + 60 * 60_000), today: "2026-11-09", file: f, presenti: [], universe: [], cryptoFuori: [], getBars: async () => ({}), forecast: null })).toBeNull();
  });

  test("lo scopritore vota la scoperta finché regge; comprata, svanita o scaduta non si vota più", () => {
    const sc = (simbolo: string, validaFino = "2026-11-11") => ({ simbolo, settore: "tecnologia", scopritore: "c:AAPL", agente: "custode AAPL", trovata: "2026-11-09T15:00:00Z", validaFino, kronos: 0.03, tecnica: { punteggio: 0.8, pattern: [] }, motivo: "sopra la media a 200; Kronos anticipa +3.0% a 5 sedute", stato: "attiva" as const });
    const f = { versione: 1 as const, giorno: "2026-11-10", ultimoGiro: null, esaminati: [], ultimoEsito: null, scoperte: [sc("AMD"), sc("META"), sc("ORCL"), sc("CRM", "2026-11-09")] };
    const closes = Object.fromEntries(["AMD", "META", "ORCL", "CRM"].map((s) => [s, rising(100)]));
    const prices = Object.fromEntries(Object.entries(closes).map(([s, c]) => [s, c.at(-1)!]));
    const v = { today: "2026-11-10", now: new Date("2026-11-10T15:00:00Z"), prices, closes, indicators: {}, positions: [{ symbol: "META", qty: 3, avgEntryPrice: 1, currentPrice: 1, marketValue: 3 }], account: { equity: 1, lastEquity: 1, cash: 1, status: "ACTIVE" }, journal: emptyJournal(), previsioni: { AMD: 0.025, ORCL: 0.001 } } as any;
    const reports: Record<string, AgentReport> = { custodi: { segnali: [] } };
    const r = scoutVotes(f, v, reports);
    expect(reports.custodi!.segnali).toHaveLength(1);
    expect(reports.custodi!.segnali[0]).toMatchObject({ agente: "custode AAPL", simbolo: "AMD", lato: "buy", kronos: 0.025 });
    expect(reports.custodi!.segnali[0]!.perche).toContain("esplorazione dalla sala caffè");
    expect(f.scoperte.map((x) => [x.simbolo, x.stato])).toEqual([["AMD", "attiva"], ["META", "comprata"], ["ORCL", "svanita"], ["CRM", "scaduta"]]);
    expect(r.esploratori.get("c:AAPL")).toContain("AMD");
    // Nella sala caffè il custode di AAPL risulta alla scrivania, al lavoro su AMD.
    const c = coffeeBreak({ now: v.now, reports: { custodi: { segnali: reports.custodi!.segnali, custodi: [] } }, held: new Set(), previsioni: undefined, scartate: [], lezioni: [], capo: null, applicati: [], giro: 1, esploratori: r.esploratori });
    expect(c.operativi.find((o) => o.chiave === "c:AAPL")!.perche).toContain("opera su AMD");
  });
});
