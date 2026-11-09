import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/agents/bus.ts";
import { emptyCache, runTick, type EngineDeps } from "../src/agents/engine.ts";
import type { Agent, AgentReport, AgentView } from "../src/agents/types.ts";
import { qtyString } from "../src/broker/alpaca.ts";
import { giornalieroScaduto } from "../src/broker/fake.ts";
import { aFrazioni, azzeraFrazionabili, roundQty, segnaFrazionabili, type Position } from "../src/broker/types.ts";
import { applyCage, type CageInput } from "../src/cage.ts";
import { AGENTS } from "../src/config.ts";
import { Logger, Redactor } from "../src/log.ts";
import { join } from "node:path";
import { azzeraRifiutiFrazioni, manageStops, partiStop } from "../src/stops.ts";
import { makeEnv, openStopsFor, ordersFor } from "./helpers.ts";

AGENTS.puntaIntraday = false;
AGENTS.intraday.riporto.enabled = false;

const pos = (symbol: string, qty: number, prezzo = 100): Position => ({ symbol, qty, avgEntryPrice: prezzo, currentPrice: prezzo, marketValue: qty * prezzo });
const log = (dir: string) => new Logger(join(dir, "prova.log"), new Redactor([]), false);

describe("frazioni di azione", () => {
  test("roundQty: intere se il titolo non è frazionabile (o non si sa); frazioni a 6 decimali se lo è, intere se lo scarto è piccolo", () => {
    segnaFrazionabili({ FRZ1: true, NOFR: false });
    expect(roundQty("SCONOSCIUTO", 0.37)).toBe(0); // Alpaca non ha detto nulla: come prima, solo intere
    expect(roundQty("NOFR", 2.7)).toBe(2);
    expect(roundQty("FRZ1", 0.0917431193)).toBe(0.091743);
    expect(roundQty("FRZ1", 1.5)).toBe(1.5); // 1 sola intera toglierebbe il 33%
    expect(roundQty("FRZ1", 12.4)).toBe(12); // 12 intere: il 3% in meno, la posizione resta tutta sotto lo stop GTC
    expect(roundQty("FRZ1", 2.9999999999)).toBe(3); // rumore della virgola mobile
    expect(roundQty("FRZ1", 0)).toBe(0);
    expect(roundQty("FRZ1", -1)).toBe(0);
    expect(roundQty("BTC/USD", 0.1234567891)).toBe(0.123456);
    // Forzato: metà di una posizione già frazionaria si vende a frazioni anche se il registro non lo sa.
    expect(roundQty("SCONOSCIUTO", 0.37 / 2, true)).toBe(0.185);
    const prima = AGENTS.frazioni.enabled;
    AGENTS.frazioni.enabled = false;
    expect(aFrazioni("FRZ1")).toBe(false);
    expect(roundQty("FRZ1", 0.5)).toBe(0);
    AGENTS.frazioni.enabled = prima;
  });

  test("qtyString: al massimo 9 decimali, niente rumore né zeri in coda; la quantità di Alpaca torna identica", () => {
    expect(qtyString("NVDA", 3)).toBe("3");
    expect(qtyString("NVDA", 0.1 + 0.2)).toBe("0.3");
    expect(qtyString("NVDA", 0.091743119)).toBe("0.091743119");
    expect(qtyString("NVDA", Number("12.370000001"))).toBe("12.370000001");
    expect(qtyString("NVDA", 2.9999999999)).toBe("3");
    expect(qtyString("BTC/USD", 0.12345678)).toBe("0.123456");
  });

  test("partiStop: intere con stop GTC, frazione con stop day; frazione sotto 1 $ lasciata allo stop del motore", () => {
    expect(partiStop(pos("NVDA", 12.37)).parti).toEqual([{ qty: 12, giornaliero: false }, { qty: 0.37, giornaliero: true }]);
    expect(partiStop(pos("NVDA", 3)).parti).toEqual([{ qty: 3, giornaliero: false }]);
    expect(partiStop(pos("NVDA", 0.09)).parti).toEqual([{ qty: 0.09, giornaliero: true }]);
    const b = partiStop(pos("NVDA", 5.004)); // 0,004 × 100 $ = 0,40 $
    expect(b.parti).toEqual([{ qty: 5, giornaliero: false }]);
    expect(b.nota).toContain("sotto 1 $");
    expect(partiStop(pos("NVDA", 0.004)).parti).toEqual([]);
    expect(partiStop(pos("BTC/USD", 0.01, 76_000)).parti).toEqual([{ qty: 0.01, giornaliero: false }]);
  });

  test("ordini day: scadono alla chiusura di New York (16:00), non prima", () => {
    const messo = "2026-09-24T14:00:00Z"; // 10:00 a New York
    expect(giornalieroScaduto(messo, new Date("2026-09-24T19:59:00Z"))).toBe(false); // 15:59
    expect(giornalieroScaduto(messo, new Date("2026-09-24T20:00:00Z"))).toBe(true); // 16:00
    expect(giornalieroScaduto(messo, new Date("2026-09-25T14:00:00Z"))).toBe(true); // il giorno dopo
  });

  test("stop su Alpaca di una posizione frazionaria: intere GTC + frazione day; il giorno dopo si rimette solo la frazione", async () => {
    azzeraRifiutiFrazioni();
    const env = makeEnv(new Date("2026-09-24T15:00:00Z")); // 11:00 a New York
    env.setFake((s) => { s.prices.NVDA = 180; s.positions.NVDA = { qty: 12.37, avgEntryPrice: 180 }; });
    const posizioni = async () => (await env.broker.getPositions());
    const r1 = await manageStops(env.broker, "g1", await posizioni(), await env.broker.getOpenOrders(), log(env.logsDir), {}, 0.05, env.deps().now());
    expect(r1.errors).toEqual([]);
    expect(r1.placed).toHaveLength(2);
    const stops = openStopsFor(env, "NVDA");
    expect(stops.map((o) => [o.qty, o.tif]).sort()).toEqual([[0.37, "day"], [12, "gtc"]]);
    expect(stops.every((o) => o.stopPrice === 171)).toBe(true);
    // Stesso giorno: niente da cambiare.
    const r2 = await manageStops(env.broker, "g2", await posizioni(), await env.broker.getOpenOrders(), log(env.logsDir), {}, 0.05, env.deps().now());
    expect(r2.placed).toEqual([]);
    expect(r2.cancelled).toEqual([]);
    // Il giorno dopo lo stop day è scaduto: si rimette solo quello, lo stop GTC delle intere resta lo stesso.
    const gtc = stops.find((o) => o.tif === "gtc")!.id;
    env.clock.t = new Date("2026-09-25T14:00:00Z").getTime();
    expect(openStopsFor(env, "NVDA").map((o) => o.qty)).toEqual([12]);
    const r3 = await manageStops(env.broker, "g3", await posizioni(), await env.broker.getOpenOrders(), log(env.logsDir), {}, 0.05, env.deps().now());
    expect(r3.cancelled).toEqual([]);
    expect(r3.placed).toEqual(["NVDA 0.37 (frazione, stop day) @ 171.00"]);
    expect(openStopsFor(env, "NVDA").map((o) => o.id)).toContain(gtc);
  });

  test("uno stop vecchio unico su tutta la posizione frazionaria si sostituisce con i due giusti; il broker rifiuta frazioni GTC", async () => {
    azzeraRifiutiFrazioni();
    const env = makeEnv(new Date("2026-09-24T15:00:00Z"));
    env.setFake((s) => { s.prices.NVDA = 180; s.positions.NVDA = { qty: 2.5, avgEntryPrice: 180 }; });
    // Come su Alpaca, una frazione GTC non passa.
    await expect(env.broker.submitStopOrder({ symbol: "NVDA", qty: 2.5, stopPrice: 170, clientOrderId: "x" })).rejects.toThrow("DAY");
    await env.broker.submitStopOrder({ symbol: "NVDA", qty: 2.5, stopPrice: 171, clientOrderId: "vecchio", giornaliero: true });
    const r = await manageStops(env.broker, "g1", await env.broker.getPositions(), await env.broker.getOpenOrders(), log(env.logsDir), {}, 0.05, env.deps().now());
    expect(r.errors).toEqual([]);
    expect(r.cancelled).toHaveLength(1);
    expect(openStopsFor(env, "NVDA").map((o) => [o.qty, o.tif]).sort()).toEqual([[0.5, "day"], [2, "gtc"]]);
  });

  test("Alpaca rifiuta lo stop sulla frazione: niente allarme, niente nuovi tentativi fino a domani; le intere restano coperte", async () => {
    azzeraRifiutiFrazioni();
    const env = makeEnv(new Date("2026-09-24T15:00:00Z"));
    env.setFake((s) => { s.prices.NVDA = 180; s.positions.NVDA = { qty: 3.4, avgEntryPrice: 180 }; s.faults.rifiutaStopFrazione = ["NVDA"]; });
    const giro = async (id: string) => manageStops(env.broker, id, await env.broker.getPositions(), await env.broker.getOpenOrders(), log(env.logsDir), {}, 0.05, env.deps().now());
    const r1 = await giro("g1");
    expect(r1.errors).toEqual([]);
    expect(r1.placed).toEqual(["NVDA 3 @ 171.00"]);
    expect(r1.ok.join(" ")).toContain("la protegge lo stop del motore");
    const ordiniPrima = env.broker.load().orders.length;
    const r2 = await giro("g2");
    expect(r2.errors).toEqual([]);
    expect(r2.placed).toEqual([]);
    expect(env.broker.load().orders.length).toBe(ordiniPrima);
  });

  test("gabbia: frazioni in acquisto solo sui titoli frazionabili e da 1 $; in vendita sempre, mai oltre la posizione", () => {
    azzeraFrazionabili();
    segnaFrazionabili({ NVDA: true, MSFT: false });
    const base: CageInput = { today: "2026-09-24", marketOpen: true, account: { equity: 1_000, lastEquity: 1_000, cash: 1_000, status: "ACTIVE" }, positions: [pos("AAPL", 0.37, 250)], prices: { NVDA: 180, MSFT: 50, AAPL: 250, QQQ: 40 }, closes: {}, recentOrders: [], lessons: [], buyBlock: null, proposals: [] };
    const prova = (p: CageInput["proposals"][number]) => applyCage({ ...base, proposals: [p] });
    const compra = (symbol: string, qty: number) => prova({ symbol, side: "buy", qty, why: "prova", confidence: "media", expect: "", intraday: true });
    expect(compra("NVDA", 0.09).orders).toHaveLength(1);
    expect(compra("MSFT", 0.5).rejected[0]!.reason).toContain("non frazionabile");
    expect(compra("QQQ", 0.5).rejected[0]!.reason).toContain("non ha ancora detto");
    expect(compra("NVDA", 0.004).rejected[0]!.reason).toContain("sotto il minimo di 1 $");
    expect(compra("MSFT", 1).orders).toHaveLength(1); // intere: sempre
    const vendi = (qty: number) => prova({ symbol: "AAPL", side: "sell", qty, why: "prova", confidence: "media", expect: "" });
    expect(vendi(0.37).orders).toHaveLength(1);
    expect(vendi(0.38).rejected[0]!.reason).toContain("niente short");
  });

  test("motore vero su un conto da 1.000 $: compra NVDA a frazioni, mette lo stop day, vende tutta la frazione senza resti", async () => {
    azzeraRifiutiFrazioni();
    // Giovedì 24 settembre 2026, 17:00 a Roma = 11:00 a New York: borsa aperta.
    const env = makeEnv(new Date("2026-09-24T15:00:00Z"));
    env.setFake((s) => { s.cash = 1_000; s.lastEquity = 1_000; s.prices.NVDA = 180; s.clock = "open"; });
    let vendi = false;
    // Un agente di prova: vota l'acquisto intraday di NVDA (taglia massima 5%: 50 $, meno di un'azione da 180 $), poi la vendita.
    const agente: Agent = {
      name: "intraday",
      async observe(v: AgentView): Promise<AgentReport> {
        const held = v.positions.find((p) => p.symbol === "NVDA" && p.qty > 0);
        if (vendi && held) return { segnali: [{ agente: "intraday", simbolo: "NVDA", lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, intraday: true, perche: "prova: obiettivo raggiunto" }] };
        if (held) return { segnali: [] };
        return { segnali: [{ agente: "intraday", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.05, perche: "prova: ingresso intraday" }] };
      },
    };
    const d = env.deps();
    const deps: EngineDeps = { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [agente], bus: new EventBus(d.stateDir, d.now), echo: false };
    const cache = emptyCache();
    const r1 = await runTick(deps, cache);
    const acquisto = ordersFor(env, "NVDA").find((o) => o.side === "buy");
    expect(acquisto, JSON.stringify({ rifiuti: r1.status_file?.rifiuti, attesa: r1.status_file?.inAttesa })).toBeDefined();
    expect(Number.isInteger(acquisto!.qty)).toBe(false);
    expect(acquisto!.qty * 180).toBeGreaterThan(10);
    expect(acquisto!.qty * 180).toBeLessThanOrEqual(50.01);
    const q = env.broker.load().positions.NVDA!.qty;
    expect(q).toBeCloseTo(acquisto!.qty, 9);
    // Stop su Alpaca: solo la frazione (nessuna azione intera), «day».
    expect(openStopsFor(env, "NVDA").map((o) => [o.qty, o.tif])).toEqual([[q, "day"]]);
    // Vendita: tutta la frazione, lo stop si toglie prima, nessun resto.
    vendi = true;
    env.clock.t += 5 * 60_000;
    await runTick(deps, cache);
    expect(ordersFor(env, "NVDA").some((o) => o.side === "sell" && o.status === "filled" && Math.abs(o.qty - q) < 1e-12)).toBe(true);
    expect(env.broker.load().positions.NVDA).toBeUndefined();
    expect(openStopsFor(env, "NVDA")).toEqual([]);
    // Il diario chiude il trade per intero.
    const { readJournal } = await import("../src/journal.ts");
    const t = readJournal(env.stateDir, env.deps().now()).file.trade.find((x) => x.simbolo === "NVDA")!;
    expect(t.stato).toBe("chiuso");
  });

  test("motore vero, titolo non frazionabile: niente acquisto, e il perché è in attesa", async () => {
    const env = makeEnv(new Date("2026-09-24T15:00:00Z"));
    env.setFake((s) => { s.cash = 1_000; s.lastEquity = 1_000; s.prices.NVDA = 180; s.clock = "open"; s.faults.nonFrazionabili = ["NVDA"]; });
    segnaFrazionabili({ NVDA: false });
    const agente: Agent = { name: "intraday", async observe() { return { segnali: [{ agente: "intraday", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.05, perche: "prova" }] }; } };
    const d = env.deps();
    const r = await runTick({ broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [agente], bus: new EventBus(d.stateDir, d.now), echo: false }, emptyCache());
    expect(ordersFor(env, "NVDA")).toEqual([]);
    expect(r.status_file!.inAttesa.find((x) => x.simbolo === "NVDA")?.motivo).toContain("non è frazionabile");
    segnaFrazionabili({ NVDA: true });
  });
});
