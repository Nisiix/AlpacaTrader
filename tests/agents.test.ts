import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allocate, scoreSignals } from "../src/agents/allocator.ts";
import { ClaudeMacro, ContextAgent } from "../src/agents/context.ts";
import { CustodiAgent, newsScore } from "../src/agents/custode.ts";
import { ExitAgent } from "../src/agents/exits.ts";
import { IntradayAgent, orizzonti, readBars, timeframeFor } from "../src/agents/intraday.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { selectPairs } from "../src/agents/universe.ts";
import { EventBus, readEvents } from "../src/agents/bus.ts";
import { emptyCache, inEntryWindow, runTick, stockEntryOpen, statusPath, summaryText, usableForecasts, type AgentsStatus, type EngineDeps } from "../src/agents/engine.ts";
import { HorizonAgent } from "../src/agents/horizon.ts";
import { KronosAgent } from "../src/agents/kronos.ts";
import { PullbackAgent } from "../src/agents/pullback.ts";
import { RegimeAgent } from "../src/agents/regime.ts";
import { TakeProfitAgent } from "../src/agents/takeprofit.ts";
import { TrendAgent } from "../src/agents/trend.ts";
import type { Agent, AgentView } from "../src/agents/types.ts";
import { evaluateBreaker } from "../src/breaker.ts";
import { applyCage } from "../src/cage.ts";
import { caloNetto, controTendenza, livelloMedie } from "../src/agents/fiducia.ts";
import { FAKE_VOL, syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, LIMITS, UNIVERSE, enableCrypto, setCryptoUniverse } from "../src/config.ts";
import { stopPctFor } from "../src/stops.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { indicatorsFor } from "../src/indicators.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

// Soglie del coordinatore dell'apprendimento abbassate per i test con pochi trade (si ripristinano alla fine).
function sogliePiccole() {
  const a = { ...AGENTS.apprendimento }, f = AGENTS.formazione.minTrade, c = AGENTS.calibrazione.minTrade;
  Object.assign(AGENTS.apprendimento, { minTradePersona: 5, minTradeSquadra: 3 });
  AGENTS.formazione.minTrade = 5; AGENTS.calibrazione.minTrade = 5;
  return () => { Object.assign(AGENTS.apprendimento, a); AGENTS.formazione.minTrade = f; AGENTS.calibrazione.minTrade = c; };
}
import { makeEnv, ordersFor, openStopsFor, type TestEnv } from "./helpers.ts";

// Questi test provano anche il metodo di più giorni e la promozione: il motore che punta all'intraday (e il riporto al
// giorno dopo) ha i suoi test, che lo riaccendono.
AGENTS.puntaIntraday = false;
AGENTS.intraday.riporto.enabled = false;

const day = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+02:00`);
const PRICES: Record<string, number> = { SPY: 600, QQQ: 520, IWM: 230, AAPL: 250, MSFT: 480, NVDA: 180, GLD: 380, TLT: 90 };

// Una vista degli agenti costruita a mano: storico sintetico in salita per tutti, salvo dove indicato.
const salitaDi = (p: number) => syntheticCloses(p, 0.01, 260);
function view(over: Partial<AgentView> & { falling?: string[]; journal?: JournalFile } = {}): AgentView {
  const closes: Record<string, number[]> = {};
  for (const s of UNIVERSE) {
    const rising = syntheticCloses(PRICES[s]!, 0.01, 260);
    closes[s] = over.falling?.includes(s) ? rising.map((x, i, a) => a[a.length - 1 - i]! * 0.9).map((x) => x) : rising;
  }
  const prices = { ...PRICES };
  for (const s of over.falling ?? []) prices[s] = closes[s]!.at(-1)! * 0.99;
  const v: AgentView = {
    today: "2026-09-24",
    now: day("2026-09-24", "15:41"),
    prices,
    closes,
    indicators: indicatorsFor(closes, prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays),
    positions: [],
    account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" },
    journal: emptyJournal(),
    ...over,
  };
  return v;
}

describe("interruttore con riarmo automatico", () => {
  test("scatta a -5% e dopo 5 giorni di borsa si riarma da solo ripartendo dal patrimonio corrente", () => {
    let r = evaluateBreaker(null, 100_000, 100_000, "2026-09-01T10:00:00Z");
    r = evaluateBreaker(r.file, 94_000, 100_000, "2026-09-02T10:00:00Z");
    expect(r.newlyTripped).toContain("6.0%");
    expect(r.buyBlock).toContain("Si riarma da solo il 2026-09-09");
    r = evaluateBreaker(r.file, 94_500, 94_000, "2026-09-08T10:00:00Z");
    expect(r.buyBlock).toContain("interruttore scattato");
    r = evaluateBreaker(r.file, 94_500, 94_000, "2026-09-09T10:00:00Z");
    expect(r.buyBlock).toBeNull();
    expect(r.file.scattato).toBeNull();
    expect(r.file.massimo).toBe(94_500);
  });
});

describe("agenti", () => {
  test("trend: compra chi è sopra le medie, in ordine di momentum, al massimo 5; vende chi ha in mano sotto la 50", () => {
    const v = view({ falling: ["TLT"], positions: [{ symbol: "TLT", qty: 10, avgEntryPrice: 95, currentPrice: 80, marketValue: 800 }] });
    const r = new TrendAgent().observe(v);
    const buys = r.segnali.filter((s) => s.lato === "buy");
    expect(buys.length).toBe(LIMITS.maxPositions);
    expect(buys[0]!.forza).toBe(1);
    expect(buys.at(-1)!.forza).toBeCloseTo(0.5, 5);
    expect(buys.every((s) => s.orizzonteSedute === 60)).toBe(true);
    expect(r.segnali.find((s) => s.lato === "sell")?.simbolo).toBe("TLT");
  });

  test("rientro (Connors): RSI(2) sotto 10 sopra la media a 200 compra con taglia ridotta; esce a RSI sopra 70 o dopo 5 sedute", () => {
    // Trend in salita, poi due sedute di calo: RSI(2) a zero, prezzo ancora sopra la media a 200.
    const c = syntheticCloses(100, 0, 260);
    c[258] = c[257]! * 0.99;
    c[259] = c[258]! * 0.99;
    const v = view();
    v.closes.SPY = c;
    v.prices.SPY = c[259]!;
    const r = new PullbackAgent().observe(v);
    const sig = r.segnali.find((s) => s.simbolo === "SPY")!;
    expect(sig.lato).toBe("buy");
    expect(sig.pesoMassimo).toBe(0.05);
    expect(sig.orizzonteSedute).toBe(5);
    // Niente rientro se il titolo sale: RSI alto.
    expect(new PullbackAgent().observe(view()).segnali.filter((s) => s.lato === "buy")).toEqual([]);
    // Trade aperto dal solo rientro: con RSI(2) tornato alto esce (vincolante); quello del trend no.
    const j = emptyJournal();
    j.trade.push({ id: "r", simbolo: "QQQ", stato: "aperto", apertoIl: "2026-09-22T14:00:00Z", comprate: 1, costo: 500, vendute: 0, incassato: 0, quantita: 1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["rientro"] } });
    j.trade.push({ id: "t", simbolo: "AAPL", stato: "aperto", apertoIl: "2026-09-22T14:00:00Z", comprate: 1, costo: 240, vendute: 0, incassato: 0, quantita: 1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["trend"] } });
    const pos = [{ symbol: "QQQ", qty: 1, avgEntryPrice: 500, currentPrice: 520, marketValue: 520 }, { symbol: "AAPL", qty: 1, avgEntryPrice: 240, currentPrice: 250, marketValue: 250 }];
    const vq = view({ journal: j, positions: pos });
    const q = syntheticCloses(520, 0, 260);
    q[258] = q[257]! * 1.01;
    q[259] = q[258]! * 1.01; // due rialzi: RSI(2) a 100
    vq.closes.QQQ = q;
    vq.prices.QQQ = q[259]! * 1.01;
    const out = new PullbackAgent().observe(vq);
    expect(out.segnali.filter((s) => s.lato === "sell").map((s) => s.simbolo)).toEqual(["QQQ"]);
    expect(out.segnali[0]!.vincolante).toBe(true);
    // Dopo 5 sedute esce comunque.
    const j2 = emptyJournal();
    j2.trade.push({ ...j.trade[0]!, apertoIl: "2026-09-10T14:00:00Z" });
    const v2 = view({ journal: j2, positions: [pos[0]!] });
    v2.closes.QQQ = (() => { const q = syntheticCloses(520, 0, 260); q[258] = 515; q[259] = 510; return q; })();
    v2.prices.QQQ = 510;
    expect(new PullbackAgent().observe(v2).segnali[0]!.perche).toContain("5 sedute");
  });

  test("regime: SPY sotto la media a 200 dimezza il rischio, sopra lo lascia intero", () => {
    expect(new RegimeAgent().observe(view()).rischio).toBe(1);
    const r = new RegimeAgent().observe(view({ falling: ["SPY"] }));
    expect(r.rischio).toBe(0.5);
    expect(r.note?.[0]).toContain("sotto la media a 200");
  });

  test("orizzonte: a 60 sedute dall'ingresso chiede di uscire solo se lo slancio è finito; se il trend regge tace", () => {
    const j = emptyJournal();
    j.trade.push({ id: "x", simbolo: "AAPL", stato: "aperto", apertoIl: "2026-06-01T14:00:00Z", comprate: 10, costo: 2400, vendute: 0, incassato: 0, quantita: 10, contesto: null });
    j.trade.push({ id: "y", simbolo: "MSFT", stato: "aperto", apertoIl: "2026-09-01T14:00:00Z", comprate: 10, costo: 4800, vendute: 0, incassato: 0, quantita: 10, contesto: null });
    const pos = [
      { symbol: "AAPL", qty: 10, avgEntryPrice: 240, currentPrice: 250, marketValue: 2500 },
      { symbol: "MSFT", qty: 10, avgEntryPrice: 480, currentPrice: 480, marketValue: 4800 },
    ];
    expect(new HorizonAgent().observe(view({ journal: j, positions: pos })).segnali).toEqual([]); // AAPL in trend: si tiene
    const tired = new HorizonAgent().observe(view({ journal: j, positions: pos, falling: ["AAPL", "MSFT"] }));
    expect(tired.segnali.map((s) => s.simbolo)).toEqual(["AAPL"]); // MSFT è entrato da 17 sedute: non è ancora il momento
    expect(tired.segnali[0]!.forza).toBe(0.8);
  });

  test("kronos: senza proiezioni tace; con proiezioni tiene solo le più nette e nel verso del trend", async () => {
    const r0 = await new KronosAgent().observe(view());
    expect(r0.segnali).toEqual([]);
    expect(r0.note?.[0]).toContain("nessuna proiezione");
    const previsioni = Object.fromEntries(UNIVERSE.map((s, i) => [s, s === "NVDA" ? 0.05 : s === "GLD" ? -0.04 : 0.001 * (i + 1)]));
    const r = await new KronosAgent().observe(view({ previsioni, positions: [{ symbol: "GLD", qty: 5, avgEntryPrice: 370, currentPrice: 380, marketValue: 1900 }] }));
    expect(r.segnali.map((s) => `${s.lato} ${s.simbolo}`).sort()).toEqual(["buy NVDA", "sell GLD"]);
    // La forza del rialzo cresce con la proiezione (0,5 + 5 × rendimento), il ribasso resta 0,5.
    expect(r.segnali.find((s) => s.simbolo === "NVDA")!.forza).toBeCloseTo(0.75, 6);
    expect(r.segnali.find((s) => s.simbolo === "GLD")!.forza).toBe(0.5);
  });
});

describe("allocatore", () => {
  test("comparto a taglia ridotta: solo il rientro vota → peso al 5%; se vota anche il trend il limite cade", () => {
    const only = allocate(view(), { r: { segnali: [{ agente: "r", simbolo: "SPY", lato: "buy", forza: 0.7, orizzonteSedute: 5, pesoMassimo: 0.05, perche: "" }] } }, { r: 1 });
    expect(only.proposte[0]!.qty).toBe(8); // 5% di 100.000 $ a 600 $
    const both = allocate(view(), { r: { segnali: [{ agente: "r", simbolo: "SPY", lato: "buy", forza: 0.7, orizzonteSedute: 5, pesoMassimo: 0.05, perche: "" }] }, t: { segnali: [{ agente: "t", simbolo: "SPY", lato: "buy", forza: 1, orizzonteSedute: 60, perche: "" }] } }, { r: 1, t: 1 });
    expect(both.proposte[0]!.qty).toBe(33); // 20%
  });

  test("volatilità di portafoglio (se attiva): cinque posizioni piene supererebbero il 12% annuo, le taglie si riducono in proporzione", () => {
    const wasOn = AGENTS.volTarget.enabled;
    AGENTS.volTarget.enabled = true;
    try {
    const sig = (s: string) => ({ agente: "t", simbolo: s, lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "" });
    // Titoli nervosi (3% al giorno): il tetto per titolo è 8,3%, cinque insieme farebbero ~16% annuo: si scende a 12%.
    const v = view();
    for (const s of ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"]) v.closes[s] = syntheticCloses(PRICES[s]!, 0.03, 260);
    const a = allocate(v, { t: { segnali: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"].map(sig) } }, { t: 1 });
    expect(a.proposte.length).toBe(5);
    expect(a.proposte.every((p) => p.expect!.includes("ridotto per la volatilità di portafoglio"))).toBe(true);
    const total = a.proposte.reduce((x, p) => x + p.qty * PRICES[p.symbol]!, 0) / 100_000;
    expect(total).toBeLessThan(0.36);
    expect(total).toBeGreaterThan(0.25);
    // Con titoli tranquilli (0,5% al giorno: cinque al 20% fanno ~6% annuo) non si riduce.
    const vc = view();
    for (const s of ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"]) vc.closes[s] = syntheticCloses(PRICES[s]!, 0.005, 260);
    const calm = allocate(vc, { t: { segnali: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"].map(sig) } }, { t: 1 });
    expect(calm.proposte.some((p) => p.expect!.includes("ridotto"))).toBe(false);
    } finally {
      AGENTS.volTarget.enabled = wasOn;
    }
  });

  test("somma i segnali pesati; vende sotto -0,5, compra sopra 0,5 con il peso obiettivo ridotto dal rischio", () => {
    const v = view({ positions: [{ symbol: "TLT", qty: 100, avgEntryPrice: 95, currentPrice: 90, marketValue: 9000 }] });
    const reports = {
      trend: { segnali: [{ agente: "trend", simbolo: "SPY", lato: "buy" as const, forza: 1, orizzonteSedute: 20, perche: "in trend" }, { agente: "trend", simbolo: "TLT", lato: "sell" as const, forza: 1, orizzonteSedute: 20, perche: "sotto la 50" }] },
      rientro: { segnali: [{ agente: "rientro", simbolo: "SPY", lato: "buy" as const, forza: 0.7, orizzonteSedute: 20, perche: "rientro" }] },
      regime: { segnali: [], rischio: 0.5 },
    };
    const a = allocate(v, reports, { trend: 1, rientro: 1, regime: 1 });
    expect(a.rischio).toBe(0.5);
    const spy = a.punteggi.find((p) => p.simbolo === "SPY")!;
    expect(spy.punteggio).toBeCloseTo(1.7, 5);
    expect(spy.agenti).toEqual(["trend", "rientro"]);
    const sell = a.proposte.find((p) => p.side === "sell")!;
    expect(sell.symbol).toBe("TLT");
    expect(sell.qty).toBe(100);
    const buy = a.proposte.find((p) => p.side === "buy")!;
    expect(buy.symbol).toBe("SPY");
    // Peso massimo di SPY (volatilità 1% → 20%) × rischio 0,5 = 10% del conto = 10.000 $ → 16 azioni a 600.
    expect(buy.qty).toBe(16);
    expect(buy.confidence).toBe("alta");
  });

  test("un segnale debole da solo non compra; una piccola aggiunta sotto il 2% non vale l'ordine", () => {
    const weak = allocate(view(), { k: { segnali: [{ agente: "k", simbolo: "SPY", lato: "buy", forza: 0.4, orizzonteSedute: 5, perche: "" }] } }, { k: 1 });
    expect(weak.proposte).toEqual([]);
    const v = view({ positions: [{ symbol: "SPY", qty: 33, avgEntryPrice: 590, currentPrice: 600, marketValue: 19_800 }] });
    const full = allocate(v, { t: { segnali: [{ agente: "t", simbolo: "SPY", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }] } }, { t: 1 });
    expect(full.proposte).toEqual([]);
  });

});

function engineDeps(env: TestEnv, agents: Agent[] = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent()]): EngineDeps {
  const d = env.deps();
  return { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents, bus: new EventBus(d.stateDir, d.now), echo: false };
}

describe("motore", () => {
  test("gli acquisti di azioni seguono l'orologio di Alpaca: tutta la seduta fino a 5 minuti dalla chiusura", () => {
    const now = new Date("2026-11-09T14:35:00Z"); // 15:35 a Roma, borsa appena aperta (ora solare)
    expect(stockEntryOpen({ isOpen: true, nextClose: "2026-11-09T21:00:00Z" }, now)).toBe(true);
    expect(stockEntryOpen({ isOpen: true, nextClose: "2026-11-09T21:00:00Z" }, new Date("2026-11-09T20:57:00Z"))).toBe(false);
    expect(stockEntryOpen({ isOpen: false }, now)).toBe(false);
    // Nelle settimane in cui l'ora legale non coincide (borsa aperta alle 14:30 di Roma) l'orario vero vale lo stesso.
    expect(stockEntryOpen({ isOpen: true, nextClose: "2026-03-09T20:00:00Z" }, new Date("2026-03-09T13:40:00Z"))).toBe(true);
  });

  test("finestra di ingresso: lun-ven per tutta la seduta (15:35-21:55 ora di Roma)", () => {
    expect(inEntryWindow(day("2026-09-24", "15:41"))).toBe(true);
    expect(inEntryWindow(day("2026-09-24", "17:31"))).toBe(true);
    expect(inEntryWindow(day("2026-09-24", "21:50"))).toBe(true);
    expect(inEntryWindow(day("2026-09-24", "21:58"))).toBe(false);
    expect(inEntryWindow(day("2026-09-24", "09:00"))).toBe(false);
    expect(inEntryWindow(day("2026-09-26", "16:00"))).toBe(false); // sabato
  });

  test("nella finestra compra i titoli in trend, scrive stato ed eventi, mette gli stop; un secondo giro non raddoppia; fuori finestra non compra", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const deps = engineDeps(env);
    const cache = emptyCache();
    const r1 = await runTick(deps, cache);
    expect(r1.status).toBe("fatto");
    const st = r1.status_file!;
    expect(st.finestraIngressi).toBe(true);
    expect(st.ordini.filter((o) => o.lato === "buy").length).toBeGreaterThanOrEqual(3);
    expect(st.ordini.every((o) => o.esito.startsWith("inviato"))).toBe(true);
    expect(st.posizioni.length).toBe(st.ordini.length);
    expect(st.rischio).toBe(1);
    expect(Object.keys(st.agenti).sort()).toEqual(["orizzonte", "regime", "rientro", "trend"]);
    expect(existsSync(statusPath(env.stateDir))).toBe(true);
    const saved = JSON.parse(readFileSync(statusPath(env.stateDir), "utf8")) as AgentsStatus;
    expect(saved.giro).toBe("agenti-2026-09-24-1541");
    const events = readEvents(env.stateDir, "2026-09-24");
    const kinds = new Set(events.map((e) => e.tipo));
    for (const k of ["tick", "conto", "prezzi", "agente", "segnale", "rischio", "allocazione", "ordine", "stop", "trade"]) expect(kinds.has(k as never)).toBe(true);
    for (const p of st.posizioni) expect(openStopsFor(env, p.simbolo).length).toBe(1);
    // Il diario sa quali agenti hanno votato.
    const journal = JSON.parse(readFileSync(join(env.stateDir, "journal.json"), "utf8")) as JournalFile;
    expect(journal.trade.length).toBe(st.ordini.length);
    expect(journal.trade[0]!.contesto?.agenti).toContain("trend");
    expect(env.outbox()).toContain("COMPRA");
    // Stesso giorno, dieci minuti dopo: posizioni già al peso obiettivo, nessun ordine nuovo.
    env.clock.t = day("2026-09-24", "15:51").getTime();
    const r2 = await runTick(deps, cache);
    expect(r2.status_file!.ordini).toEqual([]);
    expect(ordersFor(env, st.ordini[0]!.simbolo).length).toBe(1);
    // Alle 18:31 la seduta è ancora aperta: un titolo uscito dal portafoglio si ricompra (ID del giorno: lo stesso ordine non si duplica).
    env.setFake((s) => {
      delete s.positions.GLD;
      s.cash += 1_000_000;
    });
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const r3 = await runTick(deps, cache);
    expect(r3.status_file!.ordini.filter((o) => o.lato === "buy" && o.simbolo === "GLD").length + r3.status_file!.rifiuti.filter((x) => x.symbol === "GLD").length).toBeGreaterThanOrEqual(1);
    // A borsa chiusa (22:30) nessun acquisto di titoli.
    env.clock.t = day("2026-09-24", "22:30").getTime();
    const r4 = await runTick(deps, cache);
    expect(r4.status_file!.ordini.filter((o) => o.lato === "buy" && !o.simbolo.includes("/"))).toEqual([]);
    expect(readdirSync(join(env.logsDir)).some((f) => f.startsWith("agenti-2026-09-24"))).toBe(true);
  });

  test("broker giù: nessun ordine, allarme nel registro, lock rilasciato", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    env.setFake((s) => {
      s.faults.failMethods = ["getAccount"];
    });
    const deps = engineDeps(env);
    const r = await runTick(deps);
    expect(r.status).toBe("broker-giu");
    expect(readEvents(env.stateDir, "2026-09-24").some((e) => e.tipo === "allarme")).toBe(true);
    expect(existsSync(join(env.stateDir, "run.lock"))).toBe(false);
  });

  test("regime debole dimezza la taglia degli acquisti", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    env.setFake((s) => {
      // Discesa lenta da 700 a 600: SPY sotto la media a 200 senza volatilità alta (quella dimezzerebbe di nuovo).
      s.closes.SPY = Array.from({ length: 260 }, (_, i) => 700 - (100 * i) / 259);
    });
    const r = await runTick(engineDeps(env));
    expect(r.status_file!.rischio).toBe(0.5);
    for (const p of r.status_file!.posizioni) expect(p.valore / r.status_file!.conto!.patrimonio).toBeLessThan(0.105);
  });

  test("dopo le 22:05 manda un riepilogo su Telegram, una volta sola", async () => {
    const env = makeEnv(day("2026-09-24", "22:10"));
    const deps = engineDeps(env);
    const cache = emptyCache();
    await runTick(deps, cache);
    expect(env.outbox()).toContain("riepilogo 2026-09-24");
    expect(env.outbox()).toContain("Profitto e perdita del 2026-09-24");
    expect(env.outbox()).toContain("Nessuna operazione oggi");
    env.clock.t = day("2026-09-24", "22:20").getTime();
    await runTick(deps, cache);
    expect(env.outbox().split("riepilogo 2026-09-24").length).toBe(2);
  });

  test("il riepilogo elenca il profitto e la perdita di ogni vendita del giorno, il totale e il conto per agente", () => {
    const base = { versione: 1 as const, aggiornato: "2026-09-24T20:10:00.000Z", giro: "g", mercatoAperto: false, finestraIngressi: false, conto: null, posizioni: [], prezzi: {}, rischio: 1, pesi: {}, agenti: {}, segnali: [], punteggi: [], ordini: [], rifiuti: [], contesto: null, inAttesa: [], stopSuAlpaca: null, acquistiBloccati: null, lezioniAttive: [], allarmi: [], diario: { stato: "x", statistiche: { trade: 0, vinti: 0, percVinti: null, percCapitaleVinti: null, mediaVincita: null, mediaPerdita: null, attesa: null, campione: "nessuno" as const } }, confronto: null, ultimoRiepilogo: null, tradeChiusiOggi: [], custodi: [], intraday: [], universo: { titoli: [], crypto: [], fonteCrypto: null, aggiornatoCrypto: null }, kronos: { stato: "non configurato", proiezioniDel: null, simboli: 0 }, giornata: { pnlPct: 0, obiettivoPct: 0.01, pavimentoPct: 0.005, picco: 0, perditaMaxPct: 0.02, obiettivoRaggiunto: false, difesa: false, perditaOltre: false }, simulazioni: [] , capo: { aggiornato: "", sintesi: "", migliori: [], valutazioni: [], sogliaKronos: null, ingressoMigliore: null } };
    const st: AgentsStatus = {
      ...base,
      pnlOggi: {
        data: "2026-09-24",
        vendite: [
          { simbolo: "GLD", quantita: 5, carico: 105, prezzo: 120, pnl: 75, risultato: 120 / 105 - 1, motivo: "agenti: presa di profitto", agenti: ["trend", "profitto"], chiuso: false },
          { simbolo: "NVDA", quantita: 2, carico: 180, prezzo: 171, pnl: -18, risultato: -0.05, motivo: "stop su Alpaca", agenti: ["trend"], chiuso: true },
        ],
        acquisti: [{ simbolo: "AAPL", quantita: 3, prezzo: 250, agenti: ["trend"] }],
        realizzato: 57,
        tradeChiusi: 1,
        perAgente: { trend: { pnl: 57, operazioni: 2 }, profitto: { pnl: 75, operazioni: 1 } },
        nonRealizzato: -12.5,
      },
    };
    const text = summaryText(st);
    expect(text).toContain("Realizzato +57.00 $ su 2 vendite (1 trade chiuso, 1 parziale)");
    expect(text).toContain("GLD 5 × 105.00 → 120.00: +75.00 $ (+14.29%) parziale · agenti: presa di profitto · agenti trend, profitto");
    expect(text).toContain("NVDA 2 × 180.00 → 171.00: -18.00 $ (-5.00%) · stop su Alpaca · agenti trend");
    expect(text).toContain("Per agente: profitto +75.00 $ (1 op.), trend +57.00 $ (2 op.)");
    expect(text).toContain("Acquisti di oggi: AAPL 3 @ 250.00 (trend)");
    expect(text).toContain("Non realizzato sulle posizioni aperte -12.50 $ · totale giornata +44.50 $");
  });
});

describe("dashboard", () => {
  test("serve la pagina, lo stato, gli eventi e spinge gli eventi nuovi via websocket", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const deps = engineDeps(env);
    await runTick(deps);
    const d = startDashboard({ port: 0, stateDir: env.stateDir, bus: deps.bus });
    try {
      const page = await (await fetch(`${d.url}/`)).text();
      expect(page).toContain("Agentics sniper");
      const st = (await (await fetch(`${d.url}/api/status`)).json()) as AgentsStatus;
      expect(st.giro).toBe("agenti-2026-09-24-1541");
      const ev = (await (await fetch(`${d.url}/api/events?n=5&tipi=ordine`)).json()) as { giorno: string; eventi: { tipo: string }[] };
      expect(ev.giorno).toBe("2026-09-24");
      expect(ev.eventi.every((e) => e.tipo === "ordine")).toBe(true);
      const got = new Promise<string>((resolve) => {
        const ws = new WebSocket(`${d.url.replace("http", "ws")}/ws`);
        ws.onopen = () => deps.bus.emit("nota", { testo: "ciao" });
        ws.onmessage = (m) => {
          resolve(String(m.data));
          ws.close();
        };
      });
      expect(JSON.parse(await got).testo).toBe("ciao");
    } finally {
      d.stop();
    }
  });
});


describe("uscite (regole vincolanti)", () => {
  const pos = (symbol: string, avg: number, price: number) => ({ symbol, qty: 10, avgEntryPrice: avg, currentPrice: price, marketValue: price * 10 });
  const openTrade = (simbolo: string, massimo?: number) => ({ id: simbolo, simbolo, stato: "aperto" as const, apertoIl: "2026-09-23T14:00:00Z", comprate: 10, costo: 1000, vendute: 0, incassato: 0, quantita: 10, contesto: null, massimo });

  test("difesa del guadagno della persona: toccato il suo obiettivo e tornata a metà si vendono solo i suoi trade non favorevoli; il picco resta dopo un riavvio", async () => {
    const j = emptyJournal();
    j.trade.push(openTrade("AAPL"), openTrade("MSFT"));
    const v = view({ positions: [pos("AAPL", 100, 102), pos("MSFT", 100, 101)], journal: j, previsioni: { AAPL: -0.004, MSFT: 0.03 } });
    v.prices.AAPL = 102; v.prices.MSFT = 101;
    const ex = new ExitAgent(AGENTS.exit);
    expect(ex.observe(v).segnali.filter((x) => /difesa/.test(x.perche))).toEqual([]);
    // La persona che lavora su AAPL e MSFT ha toccato il suo obiettivo ed è tornata sotto metà.
    const difesa = ex.observe({ ...v, difesaPersonale: { AAPL: "Anna ha toccato il suo obiettivo", MSFT: "Anna ha toccato il suo obiettivo" } });
    const vendite = difesa.segnali.filter((x) => /difesa del guadagno/.test(x.perche));
    expect(vendite.map((x) => x.simbolo)).toEqual(["AAPL"]); // MSFT: Kronos +3%, resta
    const { registraPicco } = await import("../src/agents/engine.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "picco-"));
    expect(registraPicco(dir, "2026-11-09", 0.11)).toBe(0.11);
    expect(registraPicco(dir, "2026-11-09", 0.05)).toBe(0.11);
    expect(registraPicco(dir, "2026-11-10", 0.01)).toBe(0.01);
  });

  const OLD = { ...AGENTS.exit, mode: "obiettivo" as const, stopMode: "fisso" as const };

  test("politica a obiettivo: stop fisso -3% vende; sotto l'obiettivo tace; a +3% senza proiezione incassa", () => {
    const j = emptyJournal();
    j.trade.push(openTrade("AAPL"), openTrade("MSFT"), openTrade("SPY"));
    const v = view({ positions: [pos("AAPL", 100, 96.9), pos("MSFT", 100, 101), pos("SPY", 100, 103.1)], journal: j });
    v.prices.AAPL = 96.9; v.prices.MSFT = 101; v.prices.SPY = 103.1;
    const r = new ExitAgent(OLD).observe(v);
    expect(r.segnali.map((s) => s.simbolo).sort()).toEqual(["AAPL", "SPY"]);
    // MSFT ha obiettivo +4%: a +3,5% non incassa ancora.
    const j4 = emptyJournal();
    j4.trade.push(openTrade("MSFT"));
    const v4 = view({ positions: [pos("MSFT", 100, 103.5)], journal: j4 });
    v4.prices.MSFT = 103.5;
    expect(new ExitAgent(OLD).observe(v4).segnali).toEqual([]);
    v4.prices.MSFT = 104.1;
    v4.positions[0]!.currentPrice = 104.1;
    expect(new ExitAgent(OLD).observe(v4).segnali.length).toBe(1);
    expect(r.segnali.every((s) => s.vincolante && s.lato === "sell")).toBe(true);
    expect(r.segnali.find((s) => s.simbolo === "AAPL")!.perche).toContain("oltre lo stop");
    expect(r.segnali.find((s) => s.simbolo === "SPY")!.perche).toContain("si incassa");
  });

  test("con proiezione positiva oltre l'obiettivo lascia correre e vende solo se restituisce il 2% dal massimo (mai sotto carico + 0,5%)", () => {
    const j = emptyJournal();
    j.trade.push(openTrade("SPY", 106));
    const run = view({ positions: [pos("SPY", 100, 104.5)], journal: j, previsioni: { SPY: 0.01 } });
    run.prices.SPY = 104.5; // dal massimo 106 ha restituito l'1,4%: si tiene
    expect(new ExitAgent(OLD).observe(run).segnali).toEqual([]);
    run.prices.SPY = 103.8; // restituito il 2,1%: si incassa
    expect(new ExitAgent(OLD).observe(run).segnali[0]?.perche).toContain("prima di restituire");
    const j2 = emptyJournal();
    j2.trade.push(openTrade("SPY", 103.2));
    const low = view({ positions: [pos("SPY", 100, 100.3)], journal: j2, previsioni: { SPY: 0.01 } });
    low.prices.SPY = 100.3; // massimo 103,2 × 0,98 = 101,1 ma il pavimento è carico + 0,5% = 100,5: sotto, si vende
    expect(new ExitAgent(OLD).observe(low).segnali.length).toBe(1);
  });

  test("politica di serie (trend): stop sulla volatilità (5-10%), niente obiettivo né trailing; con trailAtr 3 esce a 3 ATR dal massimo", () => {
    const j = emptyJournal();
    j.trade.push(openTrade("SPY", 110));
    // Di serie: a +6,5% dal carico e 3,2% sotto il massimo non succede niente (esce il trend della gabbia, non qui).
    const v = view({ positions: [pos("SPY", 100, 106.5)], journal: j });
    v.prices.SPY = 106.5;
    expect(new ExitAgent().observe(v).segnali).toEqual([]);
    // Con il trailing a 3 ATR (SPY sintetico ~1% di volatilità: 3%): a 107,5 (2,3% sotto il massimo) si tiene, a 106,5 si esce.
    const TRAIL = { ...AGENTS.exit, trailAtr: 3 };
    v.prices.SPY = 107.5;
    v.positions[0]!.currentPrice = 107.5;
    expect(new ExitAgent(TRAIL).observe(v).segnali).toEqual([]);
    v.prices.SPY = 106.5;
    v.positions[0]!.currentPrice = 106.5;
    expect(new ExitAgent(TRAIL).observe(v).segnali[0]!.perche).toContain("il trend si è girato");
    // Stop: -3% non basta più (stop sulla volatilità almeno 5%); -5,5% sì.
    const j2 = emptyJournal();
    j2.trade.push(openTrade("SPY"));
    const s1 = view({ positions: [pos("SPY", 100, 96.9)], journal: j2 });
    s1.prices.SPY = 96.9;
    expect(new ExitAgent().observe(s1).segnali).toEqual([]);
    s1.prices.SPY = 94.5;
    s1.positions[0]!.currentPrice = 94.5;
    expect(new ExitAgent().observe(s1).segnali[0]!.perche).toContain("scalato sulla volatilità");
  });

  test("proiezione negativa: esce subito, anche in perdita piccola; l'allocatore esegue il vincolo senza voto", () => {
    const j = emptyJournal();
    j.trade.push(openTrade("NVDA"));
    const v = view({ positions: [pos("NVDA", 100, 99.5)], journal: j, previsioni: { NVDA: -0.02 } });
    v.prices.NVDA = 99.5;
    const r = new ExitAgent().observe(v);
    expect(r.segnali[0]!.perche).toContain("proiezione negativa");
    // Il trend vota compra con forza 1 e peso 1,2: senza vincolo terrebbe. Il vincolo vende tutto.
    const a = allocate(v, { uscite: r, trend: { segnali: [{ agente: "trend", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }] } }, { uscite: 1, trend: 1.2 });
    expect(a.proposte).toEqual([{ symbol: "NVDA", side: "sell", qty: 10, why: expect.stringContaining("uscite:"), confidence: "alta", expect: "regola di rischio" }]);
    expect(a.punteggi.find((p) => p.simbolo === "NVDA")!.agenti).toEqual(["trend"]); // il vincolo non entra nei punteggi
  });

  test("nel motore lo stop GTC su Alpaca è scalato sulla volatilità (5-10%) e il massimo visto finisce nel diario", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const r = await runTick(engineDeps(env, [new TrendAgent(), new RegimeAgent(), new ExitAgent()]));
    const sym = r.status_file!.posizioni[0]!.simbolo;
    const stop = openStopsFor(env, sym)[0]!;
    const pct = stopPctFor(syntheticCloses(PRICES[sym]!, FAKE_VOL[sym] ?? 0.02, 320));
    expect(pct).toBeGreaterThanOrEqual(0.05);
    expect(stop.stopPrice).toBeCloseTo(PRICES[sym]! * (1 - pct), 1);
    const journal = JSON.parse(readFileSync(join(env.stateDir, "journal.json"), "utf8")) as JournalFile;
    // Il massimo si aggiorna alla passata successiva, con il prezzo del momento.
    env.setFake((s) => {
      s.prices[sym] = PRICES[sym]! * 1.05;
    });
    env.clock.t = day("2026-09-24", "15:51").getTime();
    await runTick(engineDeps(env, [new TrendAgent(), new RegimeAgent(), new ExitAgent()]));
    const j2 = JSON.parse(readFileSync(join(env.stateDir, "journal.json"), "utf8")) as JournalFile;
    expect(j2.trade.find((t) => t.simbolo === sym)!.massimo).toBeCloseTo(PRICES[sym]! * 1.05, 5);
    void journal;
  });
});

describe("crypto", () => {
  test("la gabbia accetta BTC/USD a mercato chiuso e fuori finestra, con quantità frazionaria sopra i 10 $; rifiuta sotto il minimo", () => {
    const closes: Record<string, number[]> = { "BTC/USD": syntheticCloses(76_000, 0.025, 260) };
    const base = { today: "2026-09-24", marketOpen: false, account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, positions: [], prices: { "BTC/USD": 76_000 }, closes, recentOrders: [], lessons: [], buyBlock: null, events: [] };
    const ok = applyCage({ ...base, proposals: [{ symbol: "BTC/USD", side: "buy", qty: 0.05, why: "trend" }] });
    expect(ok.orders.map((o) => `${o.side} ${o.qty} ${o.symbol}`)).toEqual(["buy 0.05 BTC/USD"]);
    const small = applyCage({ ...base, proposals: [{ symbol: "BTC/USD", side: "buy", qty: 0.0001, why: "trend" }] });
    expect(small.rejected[0]!.reason).toContain("minimo di 10 $");
    // Un titolo nello stesso giro resta bloccato dal mercato chiuso.
    const mixed = applyCage({ ...base, prices: { ...base.prices, SPY: 600 }, proposals: [{ symbol: "SPY", side: "buy", qty: 1, why: "" }, { symbol: "BTC/USD", side: "buy", qty: 0.05, why: "" }] });
    expect(mixed.orders.length).toBe(1);
    expect(mixed.rejected[0]!.reason).toBe("mercato chiuso");
  });

  test("il motore compra crypto anche di domenica sera, con stop_limit su Alpaca al 3% e ID senza barra", async () => {
    enableCrypto(); // scelta esplicita, come --crypto
    const env = makeEnv(day("2026-09-27", "21:00")); // domenica
    // Titoli piatti (non in trend): restano solo le crypto come candidati.
    env.setFake((s) => {
      for (const sym of ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "GLD"]) s.closes[sym] = Array(260).fill(s.prices[sym]!);
    });
    const r = await runTick(engineDeps(env, [new TrendAgent(), new RegimeAgent(), new ExitAgent()]));
    const crypto = r.status_file!.ordini.filter((o) => o.simbolo.includes("/"));
    expect(crypto.length).toBe(2);
    expect(r.status_file!.ordini.some((o) => !o.simbolo.includes("/"))).toBe(false);
    expect(crypto[0]!.id).toMatch(/^agenti-2026-09-27-\d{4}-(BTC|ETH)USD-buy$/);
    const stop = openStopsFor(env, "BTC/USD")[0]!;
    expect(stop.type).toBe("stop_limit");
    expect(stop.stopPrice).toBeLessThan(76_000 * 0.95);
    expect(Number.isInteger(stop.qty)).toBe(false);
  });

  test("gli agenti non comprano IWM e TLT ma sorvegliano una posizione vecchia in TLT", () => {
    const r = new TrendAgent().observe(view({ falling: ["TLT"], positions: [{ symbol: "TLT", qty: 10, avgEntryPrice: 95, currentPrice: 80, marketValue: 800 }] }));
    expect(r.segnali.filter((s) => s.lato === "buy").map((s) => s.simbolo)).not.toContain("IWM");
    expect(r.segnali.find((s) => s.lato === "sell")?.simbolo).toBe("TLT");
  });
});

describe("taglia proporzionale alla fiducia in Kronos (valori di serie: 10% per titolo)", () => {
  test("proiezione netta → peso pieno; incerta → ridotta; assente → quota fissa; mai oltre il 10%", () => {
    const saved = { by: AGENTS.sizing.byKronos, max: LIMITS.maxPositionPct, n: LIMITS.maxPositions };
    AGENTS.sizing.byKronos = true; LIMITS.maxPositionPct = 0.1; LIMITS.maxPositions = 8;
    try {
      const sig = (s: string) => [{ agente: "trend", simbolo: s, lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "" }];
      const weightFor = (s: string, prev?: Record<string, number>) => {
        const v = view({ positions: [], previsioni: prev });
        const a = allocate(v, { trend: { segnali: sig(s) } }, { trend: 1 });
        const p = a.proposte[0]!;
        return (p.qty * v.prices[s]!) / v.account.equity;
      };
      const pieno = weightFor("SPY", { SPY: 0.1 }); // 10% in 5 sedute con volatilità 1%: quasi certo
      const incerto = weightFor("SPY", { SPY: 0.0015 }); // appena sopra i costi (2 × 0,05%), ma incerto
      const senza = weightFor("SPY");
      expect(pieno).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(pieno).toBeGreaterThan(0.09);
      expect(incerto).toBeLessThan(pieno * 0.5);
      expect(incerto).toBeGreaterThan(0.03);
      expect(senza).toBeCloseTo(pieno * AGENTS.sizing.noForecast, 2);
    } finally {
      AGENTS.sizing.byKronos = saved.by; LIMITS.maxPositionPct = saved.max; LIMITS.maxPositions = saved.n;
    }
  });
});

describe("universo crypto e custodi", () => {
  test("selezione: top N per capitalizzazione ∩ coppie Alpaca, stablecoin fuori, ordine di classifica; senza classifica tutte le coppie", () => {
    const pairs = ["BTC/USD", "ETH/USD", "USDT/USD", "USDC/USD", "SOL/USD", "DOGE/USD", "SHIB/USD", "BAT/USD", "ETH/BTC"];
    const top = ["BTC", "ETH", "USDT", "XRP", "SOL", "USDC", "DOGE", "ADA", "SHIB"]; // BAT fuori dalla top
    const sel = selectPairs(pairs, top, 40, 100);
    expect(sel.coppie).toEqual(["BTC/USD", "ETH/USD", "SOL/USD", "DOGE/USD", "SHIB/USD"]);
    expect(sel.classifica["SOL/USD"]).toBe(5);
    expect(sel.scartate.sort()).toEqual(["BAT/USD", "USDC/USD", "USDT/USD"]);
    const capped = selectPairs(pairs, top, 2, 100);
    expect(capped.coppie).toEqual(["BTC/USD", "ETH/USD"]);
    const noTop = selectPairs(pairs, null, 40, 100);
    expect(noTop.coppie).toEqual(["BTC/USD", "ETH/USD", "SOL/USD", "DOGE/USD", "SHIB/USD", "BAT/USD"]);
  });

  test("custodi: uno per crypto in trend o in portafoglio, con tesi, piano, rischio e dossier; vota l'ingresso e l'uscita sotto la media a 50", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD", "SOL/USD"]);
    const a = new CustodiAgent();
    const closes: Record<string, number[]> = {};
    for (const s of UNIVERSE) closes[s] = syntheticCloses(PRICES[s]!, 0.01, 260);
    closes["BTC/USD"] = syntheticCloses(76_000, 0.01, 260); // in trend
    closes["ETH/USD"] = Array.from({ length: 260 }, (_, i) => 3000 - i * 3); // in discesa: niente custode
    closes["SOL/USD"] = syntheticCloses(180, 0.01, 260);
    const prices = { ...PRICES, "BTC/USD": closes["BTC/USD"]!.at(-1)!, "ETH/USD": closes["ETH/USD"]!.at(-1)!, "SOL/USD": closes["SOL/USD"]!.at(-1)! };
    const r = await a.observe(view({ closes, prices, indicators: indicatorsFor(closes, prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays), previsioni: { "BTC/USD": 0.03 } }));
    // Custodi anche sui titoli in trend (tutto l'universo sintetico sale); tra le crypto solo BTC e SOL, ETH scende.
    expect(r.custodi!.map((c) => c.simbolo).filter((x) => x.includes("/")).sort()).toEqual(["BTC/USD", "SOL/USD"]);
    expect(r.custodi!.some((c) => c.simbolo === "SPY")).toBe(true);
    for (const c of r.custodi!) {
      expect(["pronto", "osserva"]).toContain(c.fase);
      expect(c.tesi).toContain(c.simbolo);
      expect(c.piano.length).toBeGreaterThan(20);
      expect(c.rischio).toContain("Stop");
      expect(c.livelli.stop).not.toBeNull();
      expect(c.dossier!.probabilita).toBeGreaterThan(0);
      expect(c.dossier!.probabilita).toBeLessThanOrEqual(1);
      expect(c.dossier!.tecnica.pattern.length).toBeGreaterThan(0);
      expect(c.dossier!.prossimaAzione.length).toBeGreaterThan(10);
    }
    // Kronos positivo su BTC: probabilità di rialzo sopra il 50% e dossier citato nel voto.
    const btcD = r.custodi!.find((c) => c.simbolo === "BTC/USD")!.dossier!;
    expect(btcD.kronos.punteggio!).toBeGreaterThan(0.5);
    expect(r.segnali.find((s) => s.agente === "custode BTC/USD")!.perche).toContain("dossier");
    // Notizie: il tono si legge dai titoli.
    expect(newsScore([{ titolo: "Bitcoin ETF inflows hit record" }, { titolo: "Exchange hack drains funds" }, { titolo: "Quiet day" }])).toBeCloseTo(0.5, 6);
    expect(newsScore([{ titolo: "Solana rally to all-time high" }])!).toBeGreaterThan(0.5);
    expect(newsScore([])).toBeNull();
    // Memoria del titolo: con 3 trade persi su SOL il custode entra con metà taglia e forza ridotta.
    const j = emptyJournal();
    for (let i = 0; i < 3; i++) j.trade.push({ id: `s${i}`, simbolo: "SOL/USD", stato: "chiuso", apertoIl: "2026-08-0" + (i + 1) + "T10:00:00Z", comprate: 1, costo: 100, vendute: 1, incassato: 95, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "SOL/USD in trend, +5% sopra la media a 50: ingresso ordinato", agenti: ["custode SOL/USD"] }, chiusoIl: "2026-08-1" + i + "T10:00:00Z", prezzoIngresso: 100, prezzoUscita: 95, risultato: -0.05, giorni: 7, motivoUscita: "stop su Alpaca" });
    const rm = await new CustodiAgent().observe(view({ closes, prices, indicators: indicatorsFor(closes, prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays), journal: j }));
    const solSig = rm.segnali.find((s) => s.agente === "custode SOL/USD" && s.lato === "buy")!;
    const btcSig = rm.segnali.find((s) => s.agente === "custode BTC/USD" && s.lato === "buy")!;
    expect(solSig.pesoMassimo).toBe(LIMITS.maxPositionPct / 2);
    expect(solSig.forza).toBeLessThan(btcSig.forza);
    expect(solSig.perche).toContain("memoria");
    const memo = rm.custodi!.find((c) => c.simbolo === "SOL/USD")!.dossier!.memoria;
    expect(memo.trade).toBe(3);
    expect(memo.daStop).toBe(3);
    expect(memo.lezione).toContain("metà taglia");
    expect(r.segnali.filter((s) => s.lato === "buy" && s.simbolo.includes("/")).map((s) => s.agente).sort()).toEqual(["custode BTC/USD", "custode SOL/USD"]);
    // In portafoglio e sotto la media a 50: il custode chiede di uscire.
    const down = { ...closes, "BTC/USD": [...closes["BTC/USD"]!.slice(0, -1), 60_000] };
    const p2 = { ...prices, "BTC/USD": 60_000 };
    const r2 = await a.observe(view({ closes: down, prices: p2, positions: [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 70_000, currentPrice: 60_000, marketValue: 6_000 }] }));
    const btc = r2.custodi!.find((c) => c.simbolo === "BTC/USD")!;
    expect(btc.fase).toBe("in uscita");
    expect(r2.segnali.some((s) => s.agente === "custode BTC/USD" && s.lato === "sell")).toBe(true);
    // ETH mai in trend: nessun custode.
    expect(r2.custodi!.some((c) => c.simbolo === "ETH/USD")).toBe(false);
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
  });
});

describe("intraday", () => {
  // Candele sintetiche: `n` candele piatte attorno a `base`, poi la coda data (chiusure) con massimi/minimi coerenti.
  const candles = (base: number, n: number, tail: number[], minutes = 5): IntradayBar[] => {
    const out: IntradayBar[] = [];
    const t0 = Date.parse("2026-09-24T13:30:00Z");
    const closes = [...Array.from({ length: n }, (_, i) => base * (1 + 0.001 * Math.sin(i))), ...tail];
    closes.forEach((c, i) => {
      const o = i ? closes[i - 1]! : c;
      out.push({ t: new Date(t0 + i * minutes * 60_000).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1000 });
    });
    return out;
  };

  test("la candela segue la volatilità: nervoso 5 minuti, medio 15, calmo 4 ore", () => {
    expect(timeframeFor(syntheticCloses(100, 0.04, 60))).toBe("5Min");
    expect(timeframeFor(syntheticCloses(100, 0.02, 60))).toBe("15Min");
    expect(timeframeFor(syntheticCloses(100, 0.005, 60))).toBe("4Hour");
  });

  test("lettura delle candele: la rottura dei massimi a 20 candele sopra la media entra; il piatto no; l'RSI tirato no", () => {
    const flat = candles(100, 40, [100.05, 99.95, 100.02]);
    expect(readBars(flat, 100, false).entra).toBe(false);
    const breakout = candles(100, 40, [100.15, 100.35, 100.6]);
    const r = readBars(breakout, 100.6, false);
    expect(r.entra).toBe(true);
    expect(r.pattern).toContain("rottura");
    expect(r.targetPct).toBeGreaterThanOrEqual(AGENTS.intraday.target.stocks);
    expect(r.stopPct).toBeGreaterThanOrEqual(AGENTS.intraday.minStopPct.stocks);
    // Un balzo di 8 punti su candele da pochi centesimi: oltre 3 ATR dalla media, si insegue e non si entra.
    const tired = candles(100, 40, [100.1, 100.2, 108]);
    expect(readBars(tired, 108, false).entra).toBe(false);
    expect(readBars(tired, 108, false).pattern).toContain("esteso");
  });

  test("l'agente: entra su rottura nel verso del trend con peso ridotto; esce all'obiettivo, allo stop, a fine giornata; non entra contro Kronos", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const fetched: string[] = [];
    const bars: Record<string, IntradayBar[]> = { NVDA: candles(180, 40, [180.2, 180.5, 180.9]), "BTC/USD": candles(76_000, 40, [76_100, 76_250, 76_450]) };
    const a = new IntradayAgent(async (syms, tf) => { fetched.push(`${tf}:${syms.join(",")}`); return Object.fromEntries(syms.filter((x) => bars[x]).map((x) => [x, bars[x]!])); });
    const closes: Record<string, number[]> = {};
    for (const sym of UNIVERSE) closes[sym] = syntheticCloses(PRICES[sym]!, 0.01, 260);
    closes["BTC/USD"] = syntheticCloses(76_000, 0.035, 260);
    closes["ETH/USD"] = syntheticCloses(2_100, 0.035, 260);
    const prices = { ...PRICES, NVDA: 180.9, "BTC/USD": 76_450, "ETH/USD": 2_100 };
    // Martedì 16:30 Roma: dentro la finestra dei titoli e delle crypto.
    const now = day("2026-09-22", "16:30");
    const r = await a.observe(view({ closes, prices, now, today: "2026-09-22", previsioni: { "BTC/USD": 0.02, NVDA: -0.02 } }));
    const buys = r.segnali.filter((x) => x.lato === "buy");
    // BTC entra (rottura, Kronos a favore); NVDA no: Kronos anticipa un ribasso.
    expect(buys.map((x) => x.simbolo)).toEqual(["BTC/USD"]);
    expect(buys[0]!.intraday).toBe(true);
    expect(buys[0]!.pesoMassimo).toBe(AGENTS.intraday.maxWeight);
    expect(buys[0]!.perche).toContain("5Min");
    expect(fetched.some((f) => f.startsWith("5Min:") && f.includes("BTC/USD"))).toBe(true);
    const st = r.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(st.obiettivo!).toBeGreaterThan(76_450);
    expect(st.stop!).toBeLessThan(76_450);
    // In posizione: all'obiettivo vende (vincolante).
    const pos = [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 76_450, currentPrice: st.obiettivo!, marketValue: 7_800 }];
    const r2 = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": st.obiettivo! + 1 }, now: day("2026-09-22", "17:30"), today: "2026-09-22", positions: pos }));
    const sell = r2.segnali.find((x) => x.lato === "sell" && x.simbolo === "BTC/USD")!;
    expect(sell.vincolante).toBe(true);
    expect(sell.perche).toContain("obiettivo raggiunto");
    // Allo stop vende.
    const r3 = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": st.stop! - 1 }, now: day("2026-09-22", "17:35"), today: "2026-09-22", positions: pos }));
    expect(r3.segnali.find((x) => x.lato === "sell")!.perche).toContain("stop intraday");
    // Il prezzo è già arrivato all'obiettivo: lo stop è salito in pareggio (carico + metà margine dei costi), quindi da
    // qui il trade non chiude in perdita. Crypto: nessun orario di chiusura, ma dopo la durata massima (12 ore) si chiude.
    const stPareggio = r3.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(stPareggio.stop!).toBeGreaterThan(76_450);
    const r4a = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": 76_800 }, now: day("2026-09-22", "23:40"), today: "2026-09-22", positions: pos }));
    expect(r4a.segnali.filter((x) => x.lato === "sell" && x.simbolo === "BTC/USD")).toEqual([]);
    const r4 = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": 76_800 }, now: day("2026-09-23", "04:40"), today: "2026-09-23", positions: pos }));
    expect(r4.segnali.find((x) => x.lato === "sell")!.perche).toContain("durata massima");
    // Senza ordine eseguito il voto non blocca il titolo: al giro dopo si riprova (un voto scartato dall'allocatore non lo ferma).
    const fresh = new IntradayAgent(async (syms) => Object.fromEntries(syms.filter((x) => bars[x]).map((x) => [x, bars[x]!])));
    await fresh.observe(view({ closes, prices, now, today: "2026-09-22" }));
    const again = await fresh.observe(view({ closes, prices, now: day("2026-09-22", "16:35"), today: "2026-09-22" }));
    expect(again.segnali.some((x) => x.lato === "buy" && x.simbolo === "BTC/USD")).toBe(true);
    // Stesso giorno, dopo l'uscita (trade di oggi nel diario): niente secondo ingresso su BTC.
    const diario = { versione: 1, trade: [{ simbolo: "BTC/USD", stato: "chiuso", apertoIl: day("2026-09-22", "16:31").toISOString(), contesto: { agenti: ["intraday"] } }] } as unknown as JournalFile;
    const r5 = await a.observe(view({ closes, prices, now: day("2026-09-22", "18:00"), today: "2026-09-22", journal: diario }));
    expect(r5.segnali.filter((x) => x.lato === "buy" && x.simbolo === "BTC/USD")).toEqual([]);
    // Fuori orario per i titoli (22:30): NVDA non è candidata neanche con Kronos favorevole.
    const r6 = await a.observe(view({ closes, prices, now: day("2026-09-22", "22:30"), today: "2026-09-22", previsioni: { NVDA: 0.03 } }));
    expect(r6.segnali.filter((x) => x.simbolo === "NVDA")).toEqual([]);
  });

  test("con Kronos intraday decide la proiezione sulle candele brevi, non la media a 200; grafico più lungo e Kronos a 5 sedute pesano solo sulla taglia", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const bars: Record<string, IntradayBar[]> = { NVDA: candles(180, 40, [180.2, 180.5, 180.9]), "BTC/USD": candles(76_000, 40, [76_100, 76_250, 76_450]) };
    const closes: Record<string, number[]> = {};
    // Tutto sotto la media a 200 giorni: per l'intraday non conta.
    for (const sym of UNIVERSE) closes[sym] = syntheticCloses(PRICES[sym]!, 0.01, 260).reverse();
    closes["BTC/USD"] = syntheticCloses(76_000, 0.035, 260).reverse();
    closes["ETH/USD"] = syntheticCloses(2_100, 0.035, 260).reverse();
    const prices = { ...PRICES, NVDA: 180.9, "BTC/USD": 76_450, "ETH/USD": 2_100 };
    const now = day("2026-09-22", "16:30");
    const asked: string[] = [];
    // BTC +1,3%: l'obiettivo è il rialzo previsto e deve valere almeno 1,2 volte lo stop (1%).
    let kint: Record<string, number> = { "BTC/USD": 0.013, NVDA: 0.006 };
    const a = new IntradayAgent(async (syms) => Object.fromEntries(syms.filter((x) => bars[x]).map((x) => [x, bars[x]!])), async (b, step, h) => { asked.push(`${step}:${h}:${Object.keys(b).join(",")}`); return Object.fromEntries(Object.keys(b).map((x) => [x, kint[x] ?? -0.01])); });
    const r = await a.observe(view({ closes, prices, now, today: "2026-09-22" }));
    const btc = r.segnali.find((x) => x.lato === "buy" && x.simbolo === "BTC/USD")!;
    expect(btc.perche).toMatch(/Kronos a \d+ (min|h) sulle candele/);
    // Una sola chiamata per candela, con la profondità che serve agli orizzonti (5 min: fino a un'ora = 12 candele).
    expect(asked.some((q) => q.startsWith("5:12:") && q.includes("BTC/USD"))).toBe(true);
    // In posizione e in guadagno (+1,2%): Kronos sulle prossime candele vede -2% → protezione del profitto, si vende.
    kint = { "BTC/USD": -0.02 };
    // Una candela nuova: Kronos si richiede (in memoria si tiene una proiezione per candela).
    const lastB = bars["BTC/USD"]!.at(-1)!; bars["BTC/USD"]!.push({ ...lastB, t: new Date(Date.parse(lastB.t) + 5 * 60_000).toISOString(), open: lastB.close, close: 77_367, high: 77_400, low: lastB.close });
    const posB = [{ symbol: "BTC/USD", qty: 0.05, avgEntryPrice: 76_450, currentPrice: 77_367, marketValue: 3_868 }];
    const rp = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": 77_367 }, now: day("2026-09-22", "16:40"), today: "2026-09-22", positions: posB }));
    const prot = rp.segnali.find((x) => x.lato === "sell" && x.simbolo === "BTC/USD")!;
    expect(prot.vincolante).toBe(true);
    expect(prot.perche).toContain("protezione del profitto");
    bars["BTC/USD"]!.pop();
    kint = { "BTC/USD": 0.013, NVDA: 0.006 };
    // Lo stesso ingresso con il Kronos a 5 sedute contrario: si entra lo stesso, ma a taglia ridotta.
    const a2 = new IntradayAgent(async (syms) => Object.fromEntries(syms.filter((x) => bars[x]).map((x) => [x, bars[x]!])), async (b) => Object.fromEntries(Object.keys(b).map((x) => [x, kint[x] ?? -0.01])));
    const rr = await a2.observe(view({ closes, prices, now, today: "2026-09-22", previsioni: { "BTC/USD": -0.03 } }));
    const btc2 = rr.segnali.find((x) => x.lato === "buy" && x.simbolo === "BTC/USD")!;
    expect(btc2.perche).toContain("taglia ridotta");
    expect(btc2.pesoMassimo!).toBeCloseTo(btc.pesoMassimo! / 2, 9);
    // Kronos intraday al ribasso: nessun ingresso, con il motivo.
    kint = { "BTC/USD": -0.004 };
    const b2 = new IntradayAgent(async (syms) => Object.fromEntries(syms.filter((x) => bars[x]).map((x) => [x, bars[x]!])), async (b) => Object.fromEntries(Object.keys(b).map((x) => [x, kint[x] ?? -0.01])));
    const r2 = await b2.observe(view({ closes, prices, now, today: "2026-09-22" }));
    expect(r2.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(r2.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("non basta");
  });

  test("con Kronos si sceglie la candela con la probabilità di successo più alta; la posizione si segue sulla candela più breve", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const bars: Record<string, IntradayBar[]> = { "BTC/USD": candles(76_000, 40, [76_100, 76_250, 76_450]) };
    const closes: Record<string, number[]> = {};
    for (const sym of UNIVERSE) closes[sym] = syntheticCloses(PRICES[sym]!, 0.01, 260);
    closes["BTC/USD"] = syntheticCloses(76_000, 0.035, 260);
    closes["ETH/USD"] = syntheticCloses(2_100, 0.035, 260);
    const prices = { ...PRICES, "BTC/USD": 76_450, "ETH/USD": 2_100 };
    const byStep: Record<number, number> = { 1: 0.004, 5: 0.002, 15: 0.012, 60: 0.004, 240: 0.003 };
    const steps: number[] = [];
    // Candele più lunghe = movimenti più ampi (√ dei minuti): così obiettivo e raggiungibilità sono realistici per ogni candela.
    const mins = (tf: string) => (tf.endsWith("Min") ? Number(tf.replace("Min", "")) : Number(tf.replace("Hour", "")) * 60);
    const scaled = (b: IntradayBar[], tf: string) => { const f = Math.sqrt(mins(tf) / 5); const base = 76_000; const m = (x: number) => base + (x - base) * f; return b.map((x) => ({ ...x, open: m(x.open), high: m(x.high), low: m(x.low), close: m(x.close) })); };
    const a = new IntradayAgent(async (syms, tf) => Object.fromEntries(syms.filter((x) => bars[x]).map((x) => [x, scaled(bars[x]!, tf)])), async (b, step) => { steps.push(step); return Object.fromEntries(Object.keys(b).map((x) => [x, byStep[step] ?? 0])); });
    const r = await a.observe(view({ closes, prices, now: day("2026-09-22", "16:30"), today: "2026-09-22" }));
    const buy = r.segnali.find((x) => x.lato === "buy" && x.simbolo === "BTC/USD")!;
    expect(buy.perche).toContain("su candele 15Min");
    expect(buy.perche).toContain("scelta per probabilità");
    expect(buy.perche).toContain("controllo su candele 5Min");
    // In posizione oltre l'obiettivo: sulla candela più breve (5 min) Kronos vede ancora salire → si lascia correre.
    const st = r.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    const lastB = bars["BTC/USD"]!.at(-1)!; bars["BTC/USD"]!.push({ ...lastB, t: new Date(Date.parse(lastB.t) + 5 * 60_000).toISOString() });
    // Valori credibili per candele da 5 minuti che si muovono di circa lo 0,1% (oltre 4 volte la volatilità è rumore).
    byStep[5] = 0.004;
    const pos = [{ symbol: "BTC/USD", qty: 0.05, avgEntryPrice: 76_450, currentPrice: st.obiettivo! + 50, marketValue: 3_900 }];
    const r2 = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": st.obiettivo! + 50 }, now: day("2026-09-22", "16:40"), today: "2026-09-22", positions: pos }));
    expect(r2.segnali.filter((x) => x.lato === "sell" && x.simbolo === "BTC/USD")).toEqual([]);
    const st2 = r2.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(st2.motivo).toContain("si lascia correre");
    expect(st2.stop!).toBeGreaterThan(76_450); // lo stop è salito sopra il carico
    expect(st2.controllo).toContain("candele 5Min");
    // Ora sulla candela breve Kronos gira al ribasso: oltre l'obiettivo si incassa.
    bars["BTC/USD"]!.push({ ...lastB, t: new Date(Date.parse(lastB.t) + 10 * 60_000).toISOString() });
    byStep[5] = -0.004;
    const r3 = await a.observe(view({ closes, prices: { ...prices, "BTC/USD": st.obiettivo! + 50 }, now: day("2026-09-22", "16:45"), today: "2026-09-22", positions: pos }));
    expect(r3.segnali.find((x) => x.lato === "sell" && x.simbolo === "BTC/USD")!.perche).toMatch(/obiettivo raggiunto|protezione del profitto/);
    bars["BTC/USD"]!.splice(-2);
  });

  test("una proiezione intraday fuori misura (es. prezzi minuscoli) è rumore: niente ingresso", async () => {
    setCryptoUniverse(["PEPE/USD"]);
    const base = 0.00000506;
    const mk = (tf: string) => { const m = tf.endsWith("Min") ? Number(tf.replace("Min", "")) : Number(tf.replace("Hour", "")) * 60; return candles(base, 40, [base * 1.001, base * 1.002, base * 1.004], m); };
    const closes: Record<string, number[]> = { "PEPE/USD": syntheticCloses(base, 0.04, 260) };
    for (const sym of UNIVERSE) closes[sym] = syntheticCloses(PRICES[sym]!, 0.01, 260);
    const a = new IntradayAgent(async (syms, tf) => Object.fromEntries(syms.map((x) => [x, mk(tf)])), async (b) => Object.fromEntries(Object.keys(b).map((x) => [x, 0.2])));
    // Sera (borsa chiusa): candidate solo le crypto.
    const r = await a.observe(view({ closes, prices: { ...PRICES, "PEPE/USD": base * 1.004 }, now: day("2026-09-22", "23:00"), today: "2026-09-22" }));
    expect(r.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(r.intraday!.find((x) => x.simbolo === "PEPE/USD")!.motivo).toContain("fuori misura");
  });

  test("il flusso completo: il voto intraday diventa una proposta intraday e la gabbia la ammette a mercato aperto fuori dalla vecchia finestra", () => {
    const sig = [{ agente: "intraday", simbolo: "NVDA", lato: "buy" as const, forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.1, perche: "rottura" }];
    const sc = scoreSignals(sig, { intraday: 1 });
    expect(sc[0]!.intraday).toBe(true);
    const alloc = allocate(view({ positions: [] }), { intraday: { segnali: sig } }, { intraday: 1 });
    expect(alloc.proposte[0]!.intraday).toBe(true);
    expect(alloc.proposte[0]!.qty * PRICES.NVDA! / 100_000).toBeLessThanOrEqual(0.1 + 1e-9);
    const v = view({});
    const base = { today: "2026-09-24", marketOpen: true, account: v.account, positions: [], prices: v.prices, closes: v.closes, recentOrders: [], lessons: [], buyBlock: null };
    const ok = applyCage({ ...base, proposals: [{ symbol: "NVDA", side: "buy", qty: 10, why: "intraday", intraday: true }] });
    expect(ok.orders.map((o) => o.symbol)).toEqual(["NVDA"]);
    const closed = applyCage({ ...base, marketOpen: false, proposals: [{ symbol: "NVDA", side: "buy", qty: 10, why: "intraday", intraday: true }] });
    expect(closed.rejected[0]!.reason).toBe("mercato chiuso");
    // Crypto dell'universo del giorno: non più "fuori universo".
    setCryptoUniverse(["BTC/USD", "ETH/USD", "SOL/USD"]);
    const c2 = { ...view({}).closes, "SOL/USD": syntheticCloses(180, 0.01, 260) };
    const sol = applyCage({ ...base, closes: c2, prices: { ...v.prices, "SOL/USD": 180 }, proposals: [{ symbol: "SOL/USD", side: "buy", qty: 1, why: "trend" }] });
    expect(sol.rejected.find((r) => r.symbol === "SOL/USD")?.reason).not.toBe("fuori universo");
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
  });
});

describe("capo ufficio", () => {
  test("loda chi vince, richiama chi perde con soglia di Kronos dai trade vincenti, e i richiami filtrano i voti", async () => {
    const { review, applyGuidance } = await import("../src/agents/capo.ts");
    const j = emptyJournal();
    const add = (sym: string, agenti: string[], r: number, kronos: number, i: number) => j.trade.push({ id: `k${i}`, simbolo: sym, stato: "chiuso", apertoIl: `2026-10-${String(i + 1).padStart(2, "0")}T14:00:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: 100 * (1 + r), quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "vicino alla media a 20", agenti, kronos }, chiusoIl: `2026-10-${String(i + 1).padStart(2, "0")}T18:00:00Z`, prezzoIngresso: 100, prezzoUscita: 100 * (1 + r), risultato: r, giorni: 2, motivoUscita: r < 0 ? "stop su Alpaca" : "trend" });
    // Sara (trading agent su SOL/USD) vince con Kronos alto; "trend" perde con Kronos basso.
    [0.04, 0.03, 0.05, 0.02].forEach((r, i) => { add("SOL/USD", ["custode SOL/USD"], r, 0.03, i); j.trade.at(-1)!.contesto!.persone = ["p:Sara"]; });
    [-0.03, -0.02, 0.01, -0.04].forEach((r, i) => add("NVDA", ["trend"], r, 0.002, i + 10));
    const ripristina = sogliePiccole();
    const rep = review(j, new Date("2026-11-08T12:00:00Z"));
    ripristina();
    const sol = rep.valutazioni.find((v) => v.agente === "p:Sara")!;
    const tr = rep.valutazioni.find((v) => v.agente === "trend")!;
    expect(sol.giudizio).toBe("ottimo");
    expect(tr.giudizio).toBe("richiamato");
    expect(tr.kronosMin!).toBeGreaterThanOrEqual(0.01);
    expect(tr.consigli.join(" ")).toContain("Kronos");
    expect(rep.sintesi).toContain("Richiamati: trend");
    const reports = { trend: { segnali: [{ agente: "trend", simbolo: "NVDA", lato: "buy" as const, forza: 1, orizzonteSedute: 20, perche: "x" }, { agente: "trend", simbolo: "QQQ", lato: "buy" as const, forza: 1, orizzonteSedute: 20, perche: "y" }, { agente: "trend", simbolo: "AAPL", lato: "sell" as const, forza: 1, orizzonteSedute: 20, perche: "z" }] } };
    const note = applyGuidance(reports, rep, { NVDA: 0.002, QQQ: 0.05 });
    expect(reports.trend.segnali.map((s) => `${s.lato} ${s.simbolo}`)).toEqual(["buy QQQ", "sell AAPL"]);
    expect(reports.trend.segnali[0]!.forza).toBe(0.6);
    expect(note[0]).toContain("scartato");
  });
});

describe("tenuta minima", () => {
  test("un titolo comprato oggi non si rivende al giro dopo per il trend o per i voti; lo stop e le regole vincolanti restano", () => {
    const v = view({ falling: ["NVDA"] });
    const pos = [{ symbol: "NVDA", qty: 10, avgEntryPrice: v.prices.NVDA!, currentPrice: v.prices.NVDA!, marketValue: 10 * v.prices.NVDA! }];
    const j = emptyJournal();
    j.trade.push({ id: "t1", simbolo: "NVDA", stato: "aperto", apertoIl: "2026-09-24T13:41:00Z", comprate: 10, costo: 10 * v.prices.NVDA!, vendute: 0, incassato: 0, quantita: 10, contesto: null });
    const sell = [{ agente: "trend", simbolo: "NVDA", lato: "sell" as const, forza: 1, orizzonteSedute: 20, perche: "sotto la 50" }];
    const today = allocate(view({ falling: ["NVDA"], positions: pos, journal: j }), { trend: { segnali: sell } }, { trend: 1 });
    expect(today.proposte.filter((p) => p.side === "sell")).toEqual([]);
    const forced = allocate(view({ falling: ["NVDA"], positions: pos, journal: j }), { uscite: { segnali: [{ ...sell[0]!, agente: "uscite", vincolante: true, perche: "stop" }] } }, { uscite: 1 });
    expect(forced.proposte.map((p) => p.side)).toEqual(["sell"]);
    const base = { today: "2026-09-24", marketOpen: true, account: v.account, positions: pos, prices: v.prices, closes: v.closes, recentOrders: [], lessons: [], buyBlock: null, proposals: [] };
    expect(applyCage(base).orders.filter((o) => o.source === "uscita-trend").map((o) => o.symbol)).toEqual(["NVDA"]);
    expect(applyCage({ ...base, apertiOggi: new Set(["NVDA"]) }).orders.filter((o) => o.source === "uscita-trend")).toEqual([]);
  });
});

describe("contesto economico", () => {
  test("regole: con SPY sopra la 200 e settori in trend è favorevole; con SPY sotto la 200 è sfavorevole e tutti aspettano", async () => {
    const ok = await new ContextAgent(null, []).assess(view());
    expect(ok.generale).toBe("favorevole");
    expect(Object.keys(ok.attendi)).toEqual([]);
    expect(ok.fidatiDellaProiezione.NVDA).toBe(true);
    const bad = await new ContextAgent(null, []).assess(view({ falling: ["SPY"] }));
    expect(bad.generale).toBe("sfavorevole");
    expect(bad.attendi.NVDA).toContain("candela successiva");
    // Della proiezione ci si fida anche con contesto brutto: è lei ad anticipare.
    expect(bad.fidatiDellaProiezione.NVDA).toBe(true);
    // Kronos anticipa un rialzo su NVDA: il contesto sfavorevole non la ferma più; su GLD anticipa un ribasso: si aspetta anche se il contesto è buono.
    const kr = await new ContextAgent(null, []).assess(view({ falling: ["SPY"], previsioni: { NVDA: 0.02 } }));
    expect(kr.attendi.NVDA).toBeUndefined();
    expect(kr.attendi.MSFT).toContain("nessun rialzo anticipato");
    const down = await new ContextAgent(null, []).assess(view({ previsioni: { GLD: -0.02 } }));
    expect(down.generale).toBe("favorevole");
    expect(down.attendi.GLD).toContain("Kronos anticipa un ribasso");
  });

  test("settore debole: si aspetta solo in quel settore; la Fed vicina rende tutto neutro e toglie fiducia alla proiezione", async () => {
    const v = view({ falling: ["QQQ", "AAPL", "MSFT", "NVDA"] });
    const c = await new ContextAgent(null, []).assess(v);
    expect(c.settori.tecnologia).toBe("sfavorevole");
    expect(c.attendi.NVDA).toBeDefined();
    expect(c.attendi.GLD).toBeUndefined();
    const fed = await new ContextAgent(null, [{ date: "2026-09-25", kind: "fed", confirmed: true }]).assess(view());
    expect(fed.generale).toBe("neutro");
    expect(fed.fidatiDellaProiezione.SPY).toBe(false);
    expect(fed.attendi.SPY).toBeUndefined(); // neutro: si entra, ma senza fidarsi della proiezione
  });

  test("lettura esterna (claude) peggiora ma non migliora le regole; cache rispettata; l'allocatore non apre sui titoli in attesa", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      return { code: 0, stdout: JSON.stringify({ structured_output: { datiVerificati: true, generale: "neutro", settori: { crypto: "sfavorevole" }, motivo: "dazi e inflazione in salita" } }), stderr: "" };
    };
    const env = makeEnv(day("2026-09-24", "15:41"));
    const macro = new ClaudeMacro(env.stateDir, runner, env.deps().now);
    const agent = new ContextAgent(macro, []);
    const c = await agent.assess(view());
    expect(c.generale).toBe("neutro");
    expect(c.settori.crypto).toBe("sfavorevole");
    expect(c.attendi["BTC/USD"]).toContain("crypto");
    expect(c.motivo).toContain("dazi");
    await agent.assess(view());
    expect(calls).toBe(1); // dalla cache
    const v = view({ contesto: c });
    const a = allocate(v, { trend: { segnali: [{ agente: "trend", simbolo: "BTC/USD", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }, { agente: "trend", simbolo: "SPY", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }] } }, { trend: 1 });
    expect(a.proposte.map((p) => p.symbol)).toEqual(["SPY"]);
    expect(a.inAttesa[0]!.simbolo).toBe("BTC/USD");
  });

  test("lettura senza ricerca web (datiVerificati false): ignorata, restano le regole", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const runner = async () => ({ code: 0, stdout: JSON.stringify({ structured_output: { datiVerificati: false, generale: "neutro", settori: {}, motivo: "ricerca non autorizzata" } }), stderr: "" });
    const c = await new ContextAgent(new ClaudeMacro(env.stateDir, runner, env.deps().now), []).assess(view());
    expect(c.generale).toBe("favorevole");
    expect(c.fonte).toBe("regole");
    expect(c.motivo).toContain("ricerca web non disponibile");
  });

  test("ampiezza: con SPY sopra la 200 ma indici e tecnologia sotto la 50 il clima non è favorevole; oro e obbligazioni non contano", async () => {
    const v = view({ falling: ["QQQ", "AAPL", "MSFT", "NVDA"] });
    // SPY e IWM tra la media a 200 e quella a 50: il trend lungo regge, il breve no.
    for (const s of ["SPY", "IWM"]) {
      const c = v.closes[s]!;
      const avg = (n: number) => c.slice(-n).reduce((a, x) => a + x, 0) / n;
      v.prices[s] = (avg(LIMITS.trendSmaDays) + avg(LIMITS.longSmaDays)) / 2;
    }
    const c = await new ContextAgent(null, []).assess(v);
    expect(c.generale).toBe("sfavorevole");
    expect(c.motivo).toContain("mercati a rischio sopra la media a 50: 0%");
    // Solo i rifugi in calo: il clima resta favorevole.
    expect((await new ContextAgent(null, []).assess(view({ falling: ["GLD", "TLT"] }))).generale).toBe("favorevole");
  });

  test("con Kronos al rialzo la riduzione del contesto non taglia la taglia; senza Kronos sì", () => {
    const buy = { trend: { segnali: [{ agente: "trend", simbolo: "NVDA", lato: "buy" as const, forza: 1, orizzonteSedute: 20, perche: "" }] } };
    const qty = (previsioni: Record<string, number> | undefined, rischioContesto: number | null) =>
      allocate(view({ previsioni }), { ...buy, ...(rischioContesto !== null ? { contesto: { segnali: [], rischio: rischioContesto } } : {}) }, { trend: 1, contesto: 1 }).proposte.find((p) => p.symbol === "NVDA")?.qty ?? 0;
    expect(qty({ NVDA: 0.03 }, 0.5)).toBe(qty({ NVDA: 0.03 }, null));
    expect(qty(undefined, 0.5)).toBeLessThan(qty(undefined, null) * 0.6);
  });

  test("proiezioni fuori misura (oltre ±maxAbs) non arrivano agli agenti né al contesto", () => {
    const r = usableForecasts({ "PEPE/USD": -0.459, NVDA: 0.03, BAD: Number.NaN });
    expect(r.usabili).toEqual({ NVDA: 0.03 });
    expect(r.scartate.sort()).toEqual(["BAD", "PEPE/USD"]);
    expect(usableForecasts(undefined).usabili).toBeUndefined();
    // Entro ±25% ma fuori misura per il titolo: −20% in 5 sedute con volatilità giornaliera dell'1% (quasi 9 deviazioni standard).
    const calmo = Array.from({ length: 60 }, (_, k) => 100 * (1 + (k % 2 ? 0.01 : -0.01)));
    const z = usableForecasts({ V: -0.2, MA: 0.03 }, { V: calmo, MA: calmo });
    expect(z.scartate).toEqual(["V"]);
    expect(z.usabili).toEqual({ MA: 0.03 });
  });

  test("claude in errore: motivo leggibile e nessun nuovo tentativo per un'ora (valgono le regole)", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      return { code: 1, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }), stderr: "" };
    };
    let now = day("2026-09-24", "15:41");
    const env = makeEnv(now);
    const agent = new ContextAgent(new ClaudeMacro(env.stateDir, runner, () => now), []);
    const c1 = await agent.assess(view());
    expect(c1.generale).toBe("favorevole");
    expect(c1.motivo).toContain("Invalid API key");
    now = new Date(now.getTime() + 5 * 60_000);
    const c2 = await agent.assess(view());
    expect(calls).toBe(1);
    expect(c2.motivo).toContain("si riprova tra poco");
    now = new Date(now.getTime() + 61 * 60_000);
    await agent.assess(view());
    expect(calls).toBe(2);
  });

  test("nel motore il contesto viene prima: filtra le proiezioni e finisce nello stato e negli eventi", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const deps = engineDeps(env, [new TrendAgent(), new RegimeAgent(), new ExitAgent(), new ContextAgent(null, [{ date: "2026-09-25", kind: "fed", confirmed: true }])]);
    deps.forecaster = async (symbols) => Object.fromEntries(symbols.map((s) => [s, -0.05]));
    const r = await runTick(deps);
    expect(r.status_file!.contesto?.generale).toBe("neutro");
    expect(r.status_file!.rischio).toBe(0.75);
    // Proiezioni negative su tutto, ma senza fiducia (Fed vicina) non fanno uscire: nessuna vendita vincolante.
    expect(r.status_file!.ordini.filter((o) => o.lato === "sell")).toEqual([]);
    expect(readEvents(env.stateDir, "2026-09-24").some((e) => e.tipo === "contesto")).toBe(true);
    // La sala caffè è nello stato: ogni agente è o alla scrivania o in pausa, mai in tutte e due.
    const caffe = r.status_file!.caffe!;
    const keys = [...caffe.presenti.map((p) => p.chiave), ...caffe.operativi.map((o) => o.chiave)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("a:trend");
  });
});

describe("ingressi contro tendenza guidati da Kronos", () => {
  test("sotto la 200: con Kronos netto e probabilità sufficiente Kronos vota a taglia ridotta, la gabbia ammette fino a metà del peso", () => {
    const v = view({ falling: ["NVDA"], previsioni: { NVDA: 0.04 } });
    expect(controTendenza(v.closes.NVDA, 0.04).ok).toBe(true);
    expect(controTendenza(v.closes.NVDA, 0.015).ok).toBe(false); // sotto il 2%
    expect(controTendenza(v.closes.NVDA, 0.3).ok).toBe(false); // fuori misura
    const r = new KronosAgent().observe(v);
    return r.then((rep) => {
      const s = rep.segnali.find((x) => x.simbolo === "NVDA")!;
      expect(s.lato).toBe("buy");
      expect(s.perche).toContain("contro tendenza");
      expect(s.pesoMassimo).toBeCloseTo(LIMITS.maxPositionPct * 0.5, 9);
      // L'allocatore non va oltre metà del peso massimo.
      const a = allocate(v, { kronos: rep, trend: { segnali: [{ agente: "trend", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }] } }, { kronos: 1, trend: 1 });
      const p = a.proposte.find((x) => x.symbol === "NVDA")!;
      expect((p.qty * v.prices.NVDA!) / v.account.equity).toBeLessThanOrEqual(LIMITS.maxPositionPct * 0.5 + 1e-6);
      // La gabbia: con Kronos netto passa; senza no; oltre metà del peso no.
      const base = { today: "2026-09-24", marketOpen: true, account: v.account, positions: [], prices: v.prices, closes: v.closes, recentOrders: [], lessons: [], buyBlock: null };
      const prop = (qty: number, kronos?: number) => ({ symbol: "NVDA", side: "buy" as const, qty, why: "x", confidence: "alta" as const, expect: "", ...(kronos !== undefined ? { kronos } : {}) });
      const small = Math.floor(((LIMITS.maxPositionPct * 0.5 - 0.01) * v.account.equity) / v.prices.NVDA!);
      expect(applyCage({ ...base, proposals: [prop(small, 0.04)] }).orders).toHaveLength(1);
      expect(applyCage({ ...base, proposals: [prop(small)] }).rejected[0]!.reason).toContain("contro tendenza");
      const big = Math.floor(((LIMITS.maxPositionPct * 0.5 + 0.02) * v.account.equity) / v.prices.NVDA!);
      expect(applyCage({ ...base, proposals: [prop(big, 0.04)] }).rejected[0]!.reason).toContain("contro tendenza il massimo");
    });
  });
});

describe("rimbalzo di breve: la premessa giornaliera (sotto la 50 dopo un calo netto)", () => {
  test("calo netto nell'ultimo giorno sotto la media a 50; senza calo o sopra la 50 no", () => {
    const c = Array.from({ length: 245 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i / 3)));
    for (let i = 1; i <= 14; i++) c.push(100 * (1 - 0.006 * i));
    c.push(c.at(-1)! * 0.94);
    expect(caloNetto("NVDA", c, c.at(-1)!).ok).toBe(true);
    expect(caloNetto("NVDA", c, c.at(-1)!).calo!).toBeCloseTo(-0.06, 6);
    const piatta = [...c.slice(0, -1), c.at(-2)!];
    expect(caloNetto("NVDA", piatta, piatta.at(-1)!).ok).toBe(false);
    expect(caloNetto("BTC/USD", c, c.at(-1)!).ok).toBe(true); // crypto: oltre il 5%
    expect(caloNetto("NVDA", salitaDi(100), 120).ok).toBe(false); // sopra la 50 vale il trend
  });
  test("calo improvviso anche negli ultimi giorni o nelle ultime ore (candele da 1 ora)", () => {
    const c = Array.from({ length: 245 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i / 3)));
    for (let i = 1; i <= 14; i++) c.push(100 * (1 - 0.006 * i));
    const giorni = [...c, c.at(-1)! * 0.98, c.at(-1)! * 0.96, c.at(-1)! * 0.94]; // -2% al giorno: -6% in 3 giorni
    const r = caloNetto("NVDA", giorni, giorni.at(-1)!);
    expect(r.ok).toBe(true);
    expect(r.quando).toBe("negli ultimi 3 giorni");
    const p = c.at(-1)!;
    const ore = Array.from({ length: 12 }, (_, i) => (i < 6 ? p * 1.04 : p)); // -3,8% dal massimo delle ultime 8 ore
    expect(caloNetto("NVDA", [...c, p], p * 0.999, ore).quando).toBe("nelle ultime 8 ore");
    expect(caloNetto("NVDA", [...c, p], p * 0.999).ok).toBe(false);
  });
  test("scaletta delle medie: sopra entrambe, sotto la 50, sotto la 200, sotto entrambe", () => {
    const su = salitaDi(100);
    expect(livelloMedie(su, su.at(-1)! * 1.01)!.livello).toBe("sopra");
    const m50 = su.slice(-50).reduce((a, x) => a + x, 0) / 50, m200 = su.slice(-200).reduce((a, x) => a + x, 0) / 200;
    expect(livelloMedie(su, (m50 + m200) / 2)!.livello).toBe(m200 < m50 ? "sotto50" : "sotto200");
    expect(livelloMedie(su, Math.min(m50, m200) * 0.9)!.livello).toBe("sottoEntrambe");
    expect(AGENTS.prudenzaMedie.piuGiorni.sotto50).toBeGreaterThan(AGENTS.prudenzaMedie.piuGiorni.sotto200);
    expect(AGENTS.prudenzaMedie.piuGiorni.sotto200).toBeGreaterThan(AGENTS.prudenzaMedie.piuGiorni.sottoEntrambe);
  });
});

describe("protezione del profitto", () => {
  test("in guadagno, se Kronos nelle prossime 2 sedute vede un calo che azzera il profitto si vende; se il calo è piccolo si tiene", () => {
    const v = view({ positions: [{ symbol: "NVDA", qty: 10, avgEntryPrice: 170, currentPrice: 180, marketValue: 1800 }] });
    v.prices.NVDA = 173.4; // +2%
    // Percorso: -2,5% domani, poi recupera (+3% a 5 sedute): il calo di domani azzererebbe il +2%.
    v.previsioni = { NVDA: 0.03 }; v.percorsi = { NVDA: [-0.025, -0.01, 0.01, 0.02, 0.03] };
    const r = new ExitAgent().observe(v);
    const s = r.segnali.find((x) => x.simbolo === "NVDA")!;
    expect(s).toMatchObject({ lato: "sell", vincolante: true });
    expect(s.perche).toContain("protezione del profitto");
    // Calo piccolo (-0,5%): il profitto resta, si tiene.
    v.percorsi = { NVDA: [-0.005, 0.01, 0.02, 0.025, 0.03] };
    expect(new ExitAgent().observe(v).segnali.filter((x) => x.simbolo === "NVDA")).toEqual([]);
    // In perdita la regola non c'entra (decidono stop e proiezione).
    v.prices.NVDA = 168; v.percorsi = { NVDA: [-0.025, -0.01, 0.01, 0.02, 0.03] };
    expect(new ExitAgent().observe(v).segnali.filter((x) => x.simbolo === "NVDA" && x.perche.includes("protezione"))).toEqual([]);
  });
});

describe("costi e taglia minima", () => {
  test("una crypto non si compra se Kronos non copre due volte i costi di andata e ritorno; una posizione nuova parte da 100 $", () => {
    const v = view({ previsioni: { "BTC/USD": 0.006 } });
    v.prices["BTC/USD"] = 76_000; v.closes["BTC/USD"] = syntheticCloses(76_000, 0.02, 260);
    const a = allocate(v, { trend: { segnali: [{ agente: "trend", simbolo: "BTC/USD", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }] } }, { trend: 1 });
    expect(a.proposte).toEqual([]);
    expect(a.inAttesa[0]!.motivo).toContain("non copre 2 volte i costi");
    // Con poco capitale disponibile (50 $) nessuna posizione nuova: sotto i 100 $ non vale la pena.
    const w = view({ previsioni: { NVDA: 0.03 } });
    w.account = { ...w.account, cash: 1_050 };
    expect(allocate(w, { trend: { segnali: [{ agente: "trend", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }] } }, { trend: 1 }).proposte).toEqual([]);
  });
});

describe("riparto del capitale", () => {
  test("senza un numero fisso di titoli: se i contanti non bastano si dividono per qualità, senza superare i contanti", () => {
    const v = view({ previsioni: { NVDA: 0.03, GLD: 0.01, SPY: 0.02 } });
    v.account = { ...v.account, cash: 5_000 };
    const votes = { trend: { segnali: ["NVDA", "GLD", "SPY"].map((s, i) => ({ agente: "trend", simbolo: s, lato: "buy" as const, forza: 1 - i * 0.2, orizzonteSedute: 20, perche: "" })) } };
    const a = allocate(v, votes, { trend: 1 });
    const buys = a.proposte.filter((p) => p.side === "buy");
    expect(buys.map((p) => p.symbol).sort()).toEqual(["GLD", "NVDA", "SPY"]);
    const spent = buys.reduce((t, p) => t + p.qty * v.prices[p.symbol]!, 0);
    expect(spent).toBeLessThanOrEqual(5_000);
    expect(buys.every((p) => (p.expect ?? "").includes("riparto del capitale"))).toBe(true);
    // NVDA (voto più forte, Kronos più netto) riceve più di GLD.
    const val = (s: string) => buys.find((p) => p.symbol === s)!.qty * v.prices[s]!;
    expect(val("NVDA")).toBeGreaterThan(val("GLD"));
  });

  test("il tetto per settore si applica già nel riparto: il terzo titolo tecnologico non riceve contanti che la gabbia rifiuterebbe", () => {
    const v = view({ previsioni: { NVDA: 0.03, AAPL: 0.02, MSFT: 0.02 } });
    const votes = { trend: { segnali: ["NVDA", "AAPL", "MSFT"].map((s, i) => ({ agente: "trend", simbolo: s, lato: "buy" as const, forza: 1 - i * 0.1, orizzonteSedute: 20, perche: "" })) } };
    const buys = allocate(v, votes, { trend: 1 }).proposte.filter((p) => p.side === "buy");
    const tech = buys.reduce((t, p) => t + p.qty * v.prices[p.symbol]!, 0);
    expect(tech).toBeLessThanOrEqual(LIMITS.groupMaxPct * v.account.equity);
  });
});

describe("evidenza combinata e prudenza sotto la media a 200", () => {
  const dossier = (p: number) => ({ aggiornato: "", probabilita: p, tecnica: { punteggio: 0.5, pattern: [] }, kronos: { punteggio: 0.5, nota: "" }, notizie: { punteggio: null, titoli: [], nota: "" }, contesto: { punteggio: 0.5, nota: "" }, memoria: {} as any, prossimaAzione: "" });
  const custodiCon = (sym: string, p: number) => ({ segnali: [], custodi: [{ simbolo: sym, dossier: dossier(p) } as any] });
  const buy = (sym: string) => ({ trend: { segnali: [{ agente: "trend", simbolo: sym, lato: "buy" as const, forza: 1, orizzonteSedute: 20, perche: "" }] } });
  test("il dossier (Kronos, grafico, notizie, contesto) ferma l'ingresso sotto il minimo e ne scala la taglia", () => {
    const v = view({ previsioni: { NVDA: 0.03 } });
    const low = allocate(v, { ...buy("NVDA"), custodi: custodiCon("NVDA", 0.42) }, { trend: 1 });
    expect(low.proposte.filter((x) => x.symbol === "NVDA")).toEqual([]);
    expect(low.inAttesa.find((x) => x.simbolo === "NVDA")!.motivo).toContain("evidenza combinata 42,0%");
    const q = (p: number) => allocate(v, { ...buy("NVDA"), custodi: custodiCon("NVDA", p) }, { trend: 1 }).proposte.find((x) => x.symbol === "NVDA")!.qty;
    expect(q(0.62)).toBeLessThan(q(0.85));
  });
  test("a parità di Kronos ed evidenza, sotto la 200 la taglia è più piccola che sopra (metà) e serve un'evidenza più alta", () => {
    const up = view({ previsioni: { NVDA: 0.04 } });
    const down = view({ falling: ["NVDA"], previsioni: { NVDA: 0.04 } });
    const w = (vv: AgentView, p: number) => { const pr = allocate(vv, { ...buy("NVDA"), kronos: { segnali: [] }, custodi: custodiCon("NVDA", p) }, { trend: 1 }).proposte.find((x) => x.symbol === "NVDA"); return pr ? (pr.qty * vv.prices.NVDA!) / vv.account.equity : 0; };
    expect(w(down, 0.7)).toBeGreaterThan(0);
    expect(w(down, 0.7)).toBeLessThanOrEqual(w(up, 0.7) * 0.5 + 0.002);
    expect(w(down, 0.62)).toBe(0); // sotto la 200 serve almeno il 65%
    expect(w(up, 0.62)).toBeGreaterThan(0); // sopra basta il 60%, come per la scrivania
  });
});

describe("esplorazione nel motore", () => {
  test("con un agente in pausa il motore esplora il radar: TSLA passa i criteri, entra nell'universo e al giro dopo lo scopritore la vota", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const deps = engineDeps(env, [new HorizonAgent()]);
    deps.forecaster = async (symbols) => Object.fromEntries(symbols.map((s) => [s, s === "TSLA" ? 0.03 : -0.01]));
    const before = [...AGENTS.universe];
    try {
      const r1 = await runTick(deps);
      expect(r1.status_file!.caffe!.presenti.map((p) => p.chiave)).toEqual([]); // l'orizzonte è tornato alla scrivania: ha trovato TSLA
      const espl = r1.status_file!.esplorazione!;
      expect(espl.attive.map((x) => x.simbolo)).toEqual(["TSLA"]);
      expect(espl.attive[0]!.scopritore).toBe("a:orizzonte");
      expect(AGENTS.universe).toContain("TSLA");
      expect(readEvents(env.stateDir, "2026-09-24").some((e) => e.tipo === "esplorazione")).toBe(true);
      env.clock.t += 5 * 60_000;
      const r2 = await runTick(deps, emptyCache());
      const vote = r2.status_file!.segnali.find((s) => s.simbolo === "TSLA")!;
      expect(vote).toMatchObject({ agente: "orizzonte", lato: "buy" });
      expect(r2.status_file!.caffe!.operativi.find((o) => o.chiave === "a:orizzonte")!.perche).toContain("opera su TSLA");
    } finally {
      AGENTS.universe.splice(0, AGENTS.universe.length, ...before);
    }
  });
});

describe("presa di profitto parziale", () => {
  test("a +5% vende metà una volta sola (vincolante); il resto resta col trend", () => {
    const j = emptyJournal();
    j.trade.push({ id: "t", simbolo: "SPY", stato: "aperto", apertoIl: "2026-09-01T14:00:00Z", comprate: 20, costo: 12_000, vendute: 0, incassato: 0, quantita: 20, contesto: null });
    const v = view({ positions: [{ symbol: "SPY", qty: 20, avgEntryPrice: 600, currentPrice: 631, marketValue: 12_620 }], journal: j });
    v.prices.SPY = 631;
    const r = new TakeProfitAgent(0.05, 0.5).observe(v);
    expect(r.segnali[0]!.frazione).toBe(0.5);
    expect(r.segnali[0]!.vincolante).toBe(true);
    const a = allocate(v, { profitto: r, trend: { segnali: [{ agente: "trend", simbolo: "SPY", lato: "buy", forza: 1, orizzonteSedute: 60, perche: "" }] } }, { profitto: 1, trend: 1 });
    expect(a.proposte).toEqual([{ symbol: "SPY", side: "sell", qty: 10, why: expect.stringContaining("il resto corre col trend"), confidence: "alta", expect: "presa di profitto parziale" }]);
    // Già alleggerito: niente seconda vendita.
    j.trade[0]!.quantita = 10;
    j.trade[0]!.vendute = 10;
    v.positions[0]!.qty = 10;
    expect(new TakeProfitAgent(0.05, 0.5).observe(v).segnali).toEqual([]);
  });
});

describe("ottimizzazioni: intraday separato, soglie simmetriche, costi e contanti impegnati", () => {
  const trade = (simbolo: string, agenti: string[]) => ({ simbolo, stato: "aperto", apertoIl: "2026-09-23T14:00:00.000Z", comprate: 10, quantita: 10, contesto: { agenti } });
  const diario = (...t: ReturnType<typeof trade>[]) => ({ ...emptyJournal(), trade: t }) as unknown as JournalFile;
  const pos = (symbol: string, entry: number, price: number) => [{ symbol, qty: 10, avgEntryPrice: entry, currentPrice: price, marketValue: 10 * price }];

  test("le uscite di più giorni non toccano un'operazione intraday; resta lo stop di emergenza", () => {
    const j = diario(trade("NVDA", ["intraday"]));
    const neg = new ExitAgent().observe(view({ positions: pos("NVDA", 180, 181), journal: j, previsioni: { NVDA: -0.03 } }));
    expect(neg.segnali).toEqual([]);
    const crollo = new ExitAgent().observe(view({ positions: pos("NVDA", 180, 150), journal: j, prices: { ...PRICES, NVDA: 150 } }));
    expect(crollo.segnali[0]!.perche).toContain("stop");
  });

  test("la proiezione negativa fa uscire solo se netta (stessa soglia degli acquisti)", () => {
    const j = diario(trade("NVDA", ["trend"]));
    expect(new ExitAgent().observe(view({ positions: pos("NVDA", 180, 181), journal: j, previsioni: { NVDA: -0.003 } })).segnali).toEqual([]);
    expect(new ExitAgent().observe(view({ positions: pos("NVDA", 180, 181), journal: j, previsioni: { NVDA: -0.02 } })).segnali[0]!.perche).toContain("proiezione negativa");
  });

  test("la presa di profitto aspetta se Kronos vede altro rialzo, e non riguarda l'intraday", () => {
    const j = diario(trade("NVDA", ["trend"]), trade("MSFT", ["intraday"]));
    const positions = [...pos("NVDA", 170, 180), ...pos("MSFT", 450, 480)];
    expect(new TakeProfitAgent().observe(view({ positions, journal: j, previsioni: { NVDA: 0.03 } })).segnali).toEqual([]);
    expect(new TakeProfitAgent().observe(view({ positions, journal: j, previsioni: { NVDA: 0 } })).segnali.map((x) => x.simbolo)).toEqual(["NVDA"]);
  });

  test("l'allocatore non ridistribuisce i contanti già impegnati e senza proiezione utilizzabile aspetta", () => {
    const sig = (simbolo: string) => ({ agente: "trend", simbolo, lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "in trend" });
    const reports = { trend: { segnali: [sig("SPY"), sig("GLD")] } };
    const base = view({ previsioni: { SPY: 0.03, GLD: 0.03 } });
    const libero = allocate(base, reports, {}).proposte.reduce((a, p) => a + p.qty * base.prices[p.symbol]!, 0);
    const impegnato = allocate({ ...base, account: { ...base.account, cash: 20_000 }, cashImpegnato: 15_000 }, reports, {}).proposte.reduce((a, p) => a + p.qty * base.prices[p.symbol]!, 0);
    expect(impegnato).toBeLessThanOrEqual(20_000 - 15_000);
    expect(libero).toBeGreaterThan(impegnato);
    const senza = allocate(view({ previsioni: { SPY: 0.03 } }), reports, {});
    expect(senza.inAttesa.find((x) => x.simbolo === "GLD")!.motivo).toContain("nessuna proiezione di Kronos");
  });

  test("una proiezione che il contesto non ritiene affidabile non fa comprare, ma fa sempre uscire", () => {
    const j = diario(trade("NVDA", ["trend"]));
    // Fed in arrivo: il contesto toglie la proiezione dalle filtrate, resta tra quelle di Kronos.
    const r = new ExitAgent().observe(view({ positions: pos("NVDA", 180, 181), journal: j, previsioni: {}, previsioniKronos: { NVDA: -0.02 } }));
    expect(r.segnali[0]!.perche).toContain("proiezione negativa");
    const sig = { agente: "trend", simbolo: "SPY", lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "in trend" };
    const a = allocate(view({ previsioni: {}, previsioniKronos: { SPY: 0.0005 } }), { trend: { segnali: [sig] } }, {});
    expect(a.inAttesa[0]!.motivo).toContain("non copre");
  });

  test("la gabbia non rimanda uno stop o un'uscita di trend se la vendita è già in corso", () => {
    const v = view();
    const p = pos("NVDA", 220, 180); // oltre lo stop
    const aperto = { id: "x", clientOrderId: "x", symbol: "NVDA", side: "sell", type: "market", qty: 10, filledQty: 0, status: "new", submittedAt: "2026-09-24T13:00:00Z" } as any;
    const r = applyCage({ today: "2026-09-24", marketOpen: true, account: v.account, positions: p, prices: { ...v.prices, NVDA: 180 }, closes: v.closes, recentOrders: [aperto], lessons: [], buyBlock: null, proposals: [] });
    expect(r.orders).toEqual([]);
    expect(r.rejected[0]!.reason).toContain("già in corso");
  });

  test("gli orizzonti di Kronos per candela: dai quarti d'ora alle ore, stesse candele per titoli e crypto", () => {
    expect(orizzonti("5Min").map((o) => o.h)).toEqual([15, 30, 60]);
    expect(orizzonti("15Min").map((o) => o.h)).toEqual([15, 30, 60, 120, 240]);
    expect(orizzonti("1Hour").map((o) => o.h)).toEqual([60, 120, 240, 480]);
    expect(orizzonti("4Hour").map((o) => o.h)).toEqual([240, 480]);
    expect(AGENTS.intraday.candele).toEqual(["5Min", "15Min", "1Hour", "4Hour"]);
  });
});

describe("capo ufficio e intraday", () => {
  test("il richiamo usa la soglia del Kronos a 5 sedute solo per i voti di più giorni; un voto intraday perde solo forza", async () => {
    const { applyGuidance } = await import("../src/agents/capo.ts");
    const capo = { aggiornato: "", sintesi: "", migliori: [], sogliaKronos: null, ingressoMigliore: null, valutazioni: [{ agente: "intraday", giudizio: "richiamato", kronosMin: 0.01, forza: 0.5, messaggio: "", consigli: [] }, { agente: "trend", giudizio: "richiamato", kronosMin: 0.01, forza: 0.5, messaggio: "", consigli: [] }] } as any;
    const reports = {
      intraday: { segnali: [{ agente: "intraday", simbolo: "BTC/USD", lato: "buy" as const, forza: 1, orizzonteSedute: 1, intraday: true, perche: "candele 15Min" }] },
      trend: { segnali: [{ agente: "trend", simbolo: "SPY", lato: "buy" as const, forza: 1, orizzonteSedute: 60, perche: "in trend" }] },
    };
    applyGuidance(reports, capo, { "BTC/USD": -0.02, SPY: 0.002 });
    expect(reports.intraday.segnali[0]!.forza).toBe(0.5);
    expect(reports.trend.segnali).toEqual([]);
  });

  test("con la taglia indicata, richiamo e sala caffè riducono la taglia del voto intraday, non la forza: resta sopra la soglia d'acquisto", async () => {
    const { applyGuidance } = await import("../src/agents/capo.ts");
    const { applyLessons } = await import("../src/agents/caffe.ts");
    const capo = { aggiornato: "", sintesi: "", migliori: [], sogliaKronos: null, ingressoMigliore: null, valutazioni: [{ agente: "intraday", giudizio: "richiamato", kronosMin: 0.01, forza: 0.6, messaggio: "", consigli: [] }] } as any;
    const reports: Record<string, any> = { intraday: { segnali: [{ agente: "intraday", simbolo: "ETH/USD", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.1, perche: "candele 5Min" }] } };
    applyGuidance(reports, capo, undefined);
    applyLessons(reports, [{ tema: "settore", chiave: "crypto", trade: 3, vinti: 0, media: -0.02, effetto: "prudenza", testo: "" } as any], undefined);
    const s = reports.intraday.segnali[0];
    expect(s.forza).toBe(1);
    expect(s.pesoMassimo).toBeCloseTo(0.1 * 0.6 * 0.85, 6);
    const a = allocate(view({ positions: [] } as any), reports, { intraday: 1 });
    expect(a.punteggi[0]!.punteggio).toBeGreaterThanOrEqual(AGENTS.buyScore);
  });

  test("il motore punta all'intraday: un voto di più giorni da solo non apre; con un voto intraday entra quello", () => {
    AGENTS.puntaIntraday = true;
    try {
      const v = view();
      const kronos = { segnali: [{ agente: "kronos", simbolo: "SPY", lato: "buy" as const, forza: 1, orizzonteSedute: 5, kronos: 0.05, perche: "Kronos +5%" }] };
      const intraday = { segnali: [{ agente: "intraday", simbolo: "SPY", lato: "buy" as const, forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.02, perche: "candele 1Hour, Kronos a 2 h +1.5%" }] };
      const solo = allocate(v, { kronos }, { kronos: 1 });
      expect(solo.proposte.find((p) => p.symbol === "SPY")).toBeUndefined();
      expect(solo.inAttesa.find((x) => x.simbolo === "SPY")!.motivo).toContain("punta all'intraday");
      const con = allocate(v, { kronos, intraday }, { kronos: 1, intraday: 1 });
      expect(con.proposte.find((p) => p.symbol === "SPY")!.intraday).toBe(true);
    } finally { AGENTS.puntaIntraday = false; }
  });

  test("voti misti: se l'ingresso di più giorni aspetta (evidenza bassa), entra la sola parte intraday con la sua taglia", () => {
    const v = view();
    const reports: Record<string, any> = {
      kronos: { segnali: [{ agente: "kronos", simbolo: "SPY", lato: "buy", forza: 0.6, orizzonteSedute: 5, kronos: 0.05, perche: "Kronos +5%" }] },
      intraday: { segnali: [{ agente: "intraday", simbolo: "SPY", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.02, perche: "candele 5Min, Kronos a 15 min +1.5%" }] },
      custodi: { segnali: [], custodi: [{ simbolo: "SPY", dossier: { probabilita: 0.3 } }] },
    };
    const a = allocate(v, reports, { kronos: 1, intraday: 1 });
    const spy = a.proposte.find((p) => p.symbol === "SPY");
    expect(spy).toBeDefined();
    expect(spy!.intraday).toBe(true);
    expect(spy!.why).toContain("entra solo la parte intraday");
    expect(a.inAttesa.find((x) => x.simbolo === "SPY")).toBeUndefined();
    // Senza il voto intraday lo stesso titolo resta in attesa per l'evidenza.
    const b = allocate(v, { kronos: reports.kronos, custodi: reports.custodi }, { kronos: 1 });
    expect(b.proposte.find((p) => p.symbol === "SPY")).toBeUndefined();
    expect(b.inAttesa.find((x) => x.simbolo === "SPY")!.motivo).toContain("evidenza combinata");
  });
});

describe("più giorni: profitto minimo e uscita a tempo", () => {
  const pos = (symbol: string, avg: number, price: number) => ({ symbol, qty: 10, avgEntryPrice: avg, currentPrice: price, marketValue: price * 10 });
  const t = (simbolo: string, apertoIl: string, massimo?: number) => ({ id: simbolo, simbolo, stato: "aperto" as const, apertoIl, comprate: 10, costo: 1000, vendute: 0, incassato: 0, quantita: 10, contesto: null, massimo });
  test("arrivato a +2% e tornato a +0,3%: si esce in guadagno; dopo 5 sedute senza rendere e senza Kronos favorevole: si esce", () => {
    const j = emptyJournal();
    j.trade.push(t("SPY", "2026-09-23T14:00:00Z", 102.5), t("QQQ", "2026-09-10T14:00:00Z"), t("MSFT", "2026-09-10T14:00:00Z"));
    const v = view({ positions: [pos("SPY", 100, 100.3), pos("QQQ", 100, 100.1), pos("MSFT", 100, 100.1)], journal: j, previsioni: { MSFT: 0.03 } });
    v.prices.SPY = 100.3; v.prices.QQQ = 100.1; v.prices.MSFT = 100.1;
    const r = new ExitAgent(AGENTS.exit).observe(v).segnali;
    expect(r.find((x) => x.simbolo === "SPY")!.perche).toContain("profitto minimo");
    expect(r.find((x) => x.simbolo === "QQQ")!.perche).toContain("uscita a tempo");
    expect(r.find((x) => x.simbolo === "MSFT")).toBeUndefined(); // Kronos vede ancora +3%: resta
  });
});
