// Il diario dei trade: raccoglie, misura, e solo a raccolta finita insegna (stringendo, mai allargando).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain, BrainInput, Decision } from "../src/brain/types.ts";
import type { Order } from "../src/broker/types.ts";
import { applyCage } from "../src/cage.ts";
import { applyFills, dailyPnl, emptyJournal, learnFromJournal, learningStatus, statsOf, type JournalFile, type Trade } from "../src/journal.ts";
import { emptyLessons } from "../src/lessons.ts";
import { statsLine } from "../src/report.ts";
import { addDays } from "../src/slots.ts";
import { runWake } from "../src/wake.ts";
import { brainSaying, makeEnv } from "./helpers.ts";

const day = (date: string, rome: string) => new Date(`${date}T${rome}:00+02:00`);
const order = (side: "buy" | "sell", symbol: string, qty: number, price: number, id: string): Decision["orders"][number] => ({ symbol, side, qty, why: `prova ${id}`, confidence: "alta", expect: "sale" });
const saying = (...orders: Decision["orders"]) => brainSaying({ orders, reasoning: "Prova.", plan_next: "" });
const journalOf = (stateDir: string): JournalFile => JSON.parse(readFileSync(join(stateDir, "journal.json"), "utf8"));

// Cervello che si ricorda cosa ha visto.
class SpyBrain implements Brain {
  readonly name = "spia";
  seen: BrainInput[] = [];
  constructor(private d: Decision) {}
  async decide(input: BrainInput) {
    this.seen.push(input);
    return structuredClone(this.d);
  }
}

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
  test("un acquisto apre un trade con il suo contesto, la vendita lo chiude con il risultato", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(order("buy", "SPY", 10, 0, "a")));
    await runWake(env.deps());
    const open = journalOf(env.stateDir).trade;
    expect(open).toHaveLength(1);
    expect(open[0]!.stato).toBe("aperto");
    expect(open[0]!.contesto?.fiducia).toBe("alta");
    expect(open[0]!.contesto?.setup).toContain("momentum");

    env.setFake((s) => (s.prices.SPY = 612));
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const res = await runWake(env.deps({ brain: saying(order("sell", "SPY", 10, 0, "b")) }));
    const t = journalOf(env.stateDir).trade[0]!;
    expect(t.stato).toBe("chiuso");
    expect(t.risultato).toBeCloseTo(0.02, 5);
    expect(t.motivoUscita).toBe("scelta del modello");
    expect(res.witness!.tradeChiusi).toEqual([{ simbolo: "SPY", risultato: t.risultato!, giorni: 0, uscita: "scelta del modello" }]);
    expect(env.outbox()).toContain("Trade chiuso: SPY +2.00%");
  });

  test("gli stessi ordini rivisti a ogni sveglia non contano due volte", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(order("buy", "SPY", 10, 0, "a")));
    await runWake(env.deps());
    env.clock.t = day("2026-09-24", "18:31").getTime();
    await runWake(env.deps({ brain: saying() }));
    env.clock.t = day("2026-09-24", "21:41").getTime();
    await runWake(env.deps({ brain: saying() }));
    const j = journalOf(env.stateDir);
    expect(j.trade).toHaveLength(1);
    expect(j.trade[0]!.comprate).toBe(10);
  });

  test("uno stop eseguito da Alpaca nel weekend chiude il trade alla sveglia di lunedì", async () => {
    const env = makeEnv(day("2026-09-25", "15:41"), saying(order("buy", "SPY", 10, 0, "a")));
    env.setFake((s) => (s.clock = "open"));
    await runWake(env.deps());
    env.clock.t = day("2026-09-25", "21:55").getTime();
    env.setFake((s) => (s.prices.SPY = 560)); // sotto lo stop a 567, scatta venerdì sera
    env.broker.load();
    env.clock.t = day("2026-09-28", "09:01").getTime(); // lunedì, oltre le 48 ore
    env.setFake((s) => (s.clock = "auto"));
    const res = await runWake(env.deps({ brain: saying() }));
    expect(res.witness!.tradeChiusi?.[0]?.uscita).toBe("stop su Alpaca");
    expect(res.witness!.tradeChiusi?.[0]?.risultato).toBeCloseTo(560 / 600 - 1, 5);
  });

  test("un diario rotto si mette da parte, si dice, e la sveglia va avanti", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(order("buy", "SPY", 10, 0, "a")));
    env.setFake(() => {});
    writeFileSync(join(env.stateDir, "journal.json"), '{"versione":1,"trade":[');
    const res = await runWake(env.deps());
    expect(res.status).toBe("done");
    expect(env.outbox()).toContain("Diario dei trade illeggibile");
    expect(readdirSync(env.stateDir).some((f) => f.startsWith("journal.json.illeggibile-"))).toBe(true);
    expect(journalOf(env.stateDir).trade).toHaveLength(1);
  });

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
    expect(p.acquisti).toEqual([{ simbolo: "NVDA", quantita: 1, prezzo: 190, agenti: ["trend"] }]);
    // Ieri: nessuna vendita, solo gli acquisti del 22 (ora di Roma).
    const ieri = dailyPnl(j, "2026-09-22");
    expect(ieri.vendite).toHaveLength(0);
    expect(ieri.acquisti.map((a) => a.simbolo).sort()).toEqual(["GLD", "NVDA"]);
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
    expect(statsLine(s)).toContain("risultato medio -1.20%");
    expect(s.campione).toBe("troppo piccolo");
  });
});

describe("prima la raccolta, poi l'apprendimento", () => {
  const losing = Array.from({ length: 30 }, (_, i) => (i % 4 === 0 ? 0.01 : -0.02));

  test("durante l'osservazione il modello non vede il diario e non nasce nessun blocco", async () => {
    const brain = new SpyBrain({ orders: [], reasoning: "Prova.", plan_next: "" });
    const env = makeEnv(day("2026-09-24", "15:41"), brain);
    env.setFake(() => {});
    writeFileSync(join(env.stateDir, "journal.json"), JSON.stringify(journalWith(losing, "NVDA", "2026-08-01")));
    const res = await runWake(env.deps());
    expect(brain.seen[0]!.journal).toBeNull();
    expect(res.witness!.diario!.stato).toContain("solo raccolta dati");
    expect(res.witness!.lezioniNuove).toEqual([]);
  });

  test("troppo pochi trade anche dopo mesi: si continua a raccogliere", () => {
    const j = journalWith(losing.slice(0, 12), "NVDA", "2026-01-05");
    expect(learningStatus(j, "2026-09-24").attivo).toBe(false);
    expect(learnFromJournal(emptyLessons(), j, "2026-09-24")).toEqual([]);
  });

  test("a raccolta finita: il modello vede il diario e titolo e tipo di ingresso perdenti vengono bloccati", async () => {
    const brain = new SpyBrain({ orders: [order("buy", "NVDA", 2, 0, "x")], reasoning: "Prova.", plan_next: "" });
    const env = makeEnv(day("2026-09-24", "15:41"), brain);
    env.setFake(() => {});
    writeFileSync(join(env.stateDir, "journal.json"), JSON.stringify(journalWith(losing, "NVDA", "2026-01-05")));
    const first = await runWake(env.deps());
    expect(brain.seen[0]!.journal?.statistiche.trade).toBe(30);
    const kinds = first.witness!.lezioniNuove!.filter((l) => l.tipo === "statistica");
    expect(kinds.map((l) => l.simbolo).sort()).toEqual(["*", "NVDA"]);

    env.clock.t = day("2026-09-24", "18:31").getTime();
    const second = await runWake(env.deps());
    expect(second.witness!.ordiniRifiutati.find((r) => r.simbolo === "NVDA")?.motivo).toContain("30 trade chiusi");
    // Nessun blocco doppio sullo stesso gruppo senza trade nuovi.
    expect(second.witness!.lezioniNuove!.filter((l) => l.tipo === "statistica")).toEqual([]);
  });

  test("dopo la scadenza lo stesso blocco torna solo con trade nuovi", () => {
    const j = journalWith(losing, "NVDA", "2026-01-05");
    const lessons = emptyLessons();
    expect(learnFromJournal(lessons, j, "2026-09-01")).toHaveLength(2);
    expect(learnFromJournal(lessons, j, "2026-10-30")).toHaveLength(0);
    j.trade.push({ ...j.trade[1]!, id: "nuovo" });
    expect(learnFromJournal(lessons, j, "2026-10-30")).toHaveLength(2);
  });

  test("le lezioni del diario possono solo stringere: un titolo vincente non supera le regole fisse", () => {
    const winning = journalWith(Array.from({ length: 30 }, () => 0.03), "SPY", "2026-01-05");
    expect(learnFromJournal(emptyLessons(), winning, "2026-09-24")).toEqual([]);
    const closes = Array.from({ length: 260 }, (_, i) => 500 + i);
    const cage = applyCage({ today: "2026-09-24", slotKind: "open", marketOpen: true, latenessMin: 0, account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, positions: [], prices: { SPY: 600 }, closes: { SPY: closes }, recentOrders: [], lessons: [], buyBlock: null, proposals: [{ symbol: "SPY", side: "buy", qty: 70, why: "vince sempre" }] });
    expect(cage.orders).toEqual([]);
    expect(cage.rejected[0]!.reason).toContain("massimo 20");
  });
});

describe("riepilogo del venerdì", () => {
  test("il venerdì alla chiusura arriva il riepilogo con percentuale, medie e stato del diario", async () => {
    const env = makeEnv(day("2026-09-25", "21:41"), saying());
    env.setFake(() => {});
    writeFileSync(join(env.stateDir, "journal.json"), JSON.stringify(journalWith([0.02, -0.01], "GLD", "2026-09-20")));
    const j = journalOf(env.stateDir);
    j.trade.forEach((t) => (t.chiusoIl = "2026-09-24T15:00:00Z"));
    writeFileSync(join(env.stateDir, "journal.json"), JSON.stringify(j));
    await runWake(env.deps());
    const out = env.outbox();
    expect(out).toContain("Riepilogo della settimana");
    expect(out).toContain("2 trade chiusi, 1 vinti (50%)");
    expect(out).toContain("solo raccolta dati");
    expect(existsSync(join(env.stateDir, "journal.json"))).toBe(true);
  });

  test("gli altri giorni niente riepilogo", async () => {
    const env = makeEnv(day("2026-09-24", "21:41"), saying());
    await runWake(env.deps());
    expect(env.outbox()).not.toContain("Riepilogo della settimana");
  });
});
