import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentWeights, allocate, scoreSignals } from "../src/agents/allocator.ts";
import { runAgentsBacktest } from "../src/agents/backtest.ts";
import { ExitAgent } from "../src/agents/exits.ts";
import { EventBus, readEvents } from "../src/agents/bus.ts";
import { emptyCache, inEntryWindow, runTick, statusPath, type AgentsStatus, type EngineDeps } from "../src/agents/engine.ts";
import { HorizonAgent } from "../src/agents/horizon.ts";
import { KronosAgent } from "../src/agents/kronos.ts";
import { PullbackAgent } from "../src/agents/pullback.ts";
import { RegimeAgent } from "../src/agents/regime.ts";
import { TrendAgent } from "../src/agents/trend.ts";
import type { AgentView } from "../src/agents/types.ts";
import { evaluateBreaker } from "../src/breaker.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { LIMITS, UNIVERSE } from "../src/config.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { indicatorsFor } from "../src/indicators.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";
import { makeEnv, ordersFor, openStopsFor, type TestEnv } from "./helpers.ts";

const day = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+02:00`);
const PRICES: Record<string, number> = { SPY: 600, QQQ: 520, IWM: 230, AAPL: 250, MSFT: 480, NVDA: 180, GLD: 380, TLT: 90 };

// Una vista degli agenti costruita a mano: storico sintetico in salita per tutti, salvo dove indicato.
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
    expect(buys.every((s) => s.orizzonteSedute === 20)).toBe(true);
    expect(r.segnali.find((s) => s.lato === "sell")?.simbolo).toBe("TLT");
  });

  test("rientro: sopra la 200, tornato vicino alla 50 dopo una corsa", () => {
    const c = syntheticCloses(100, 0, 260);
    // Corsa: 10 sedute fa chiudeva il 6% sopra la media a 50; oggi è tornato a +1% dalla media.
    const boosted = [...c];
    for (let i = 240; i < 252; i++) boosted[i] = c[i]! * 1.08;
    const v = view();
    v.closes.SPY = boosted;
    const m50 = boosted.slice(-50).reduce((a, b) => a + b, 0) / 50;
    v.prices.SPY = m50 * 1.01;
    const r = new PullbackAgent().observe(v);
    expect(r.segnali.map((s) => s.simbolo)).toContain("SPY");
    expect(r.segnali.find((s) => s.simbolo === "SPY")!.forza).toBe(0.7);
    // Senza corsa precedente non è un rientro.
    v.closes.SPY = c;
    v.prices.SPY = (c.slice(-50).reduce((a, b) => a + b, 0) / 50) * 1.01;
    expect(new PullbackAgent().observe(v).segnali.find((s) => s.simbolo === "SPY")).toBeUndefined();
  });

  test("regime: SPY sotto la media a 200 dimezza il rischio, sopra lo lascia intero", () => {
    expect(new RegimeAgent().observe(view()).rischio).toBe(1);
    const r = new RegimeAgent().observe(view({ falling: ["SPY"] }));
    expect(r.rischio).toBe(0.5);
    expect(r.note?.[0]).toContain("sotto la media a 200");
  });

  test("orizzonte: a 20 sedute dall'ingresso chiede di uscire, forte se lo slancio è finito, debole se il trend regge", () => {
    const j = emptyJournal();
    j.trade.push({ id: "x", simbolo: "AAPL", stato: "aperto", apertoIl: "2026-08-20T14:00:00Z", comprate: 10, costo: 2400, vendute: 0, incassato: 0, quantita: 10, contesto: null });
    j.trade.push({ id: "y", simbolo: "MSFT", stato: "aperto", apertoIl: "2026-09-20T14:00:00Z", comprate: 10, costo: 4800, vendute: 0, incassato: 0, quantita: 10, contesto: null });
    const pos = [
      { symbol: "AAPL", qty: 10, avgEntryPrice: 240, currentPrice: 250, marketValue: 2500 },
      { symbol: "MSFT", qty: 10, avgEntryPrice: 480, currentPrice: 480, marketValue: 4800 },
    ];
    const strong = new HorizonAgent().observe(view({ journal: j, positions: pos }));
    expect(strong.segnali.map((s) => s.simbolo)).toEqual(["AAPL"]); // MSFT è entrato da 4 giorni
    expect(strong.segnali[0]!.forza).toBe(0.4);
    const tired = new HorizonAgent().observe(view({ journal: j, positions: pos, falling: ["AAPL"] }));
    expect(tired.segnali[0]!.forza).toBe(0.8);
  });

  test("kronos: senza sidecar tace; con previsioni tiene solo le più nette e nel verso del trend", async () => {
    const down = new KronosAgent(async () => {
      throw new Error("connessione rifiutata");
    });
    const r0 = await down.observe(view());
    expect(r0.segnali).toEqual([]);
    expect(r0.note?.[0]).toContain("Kronos non disponibile");
    const k = new KronosAgent(async () => UNIVERSE.map((s, i) => ({ simbolo: s, rendimentoPrevisto: s === "NVDA" ? 0.05 : s === "GLD" ? -0.04 : 0.001 * (i + 1) })));
    const r = await k.observe(view({ positions: [{ symbol: "GLD", qty: 5, avgEntryPrice: 370, currentPrice: 380, marketValue: 1900 }] }));
    expect(r.segnali.map((s) => `${s.lato} ${s.simbolo}`).sort()).toEqual(["buy NVDA", "sell GLD"]);
    expect(r.segnali.every((s) => s.forza === 0.5)).toBe(true);
  });
});

describe("allocatore", () => {
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

  test("pesi dal diario: tutti 1 finché la raccolta non è finita; poi chi perde scende a 0,5 e chi vince con campione affidabile sale a 1,2", () => {
    const j = emptyJournal();
    const trade = (i: number, agenti: string[], risultato: number, opened = "2026-01-05") => ({ id: `t${i}`, simbolo: "SPY", stato: "chiuso" as const, apertoIl: `${opened}T14:00:00Z`, comprate: 1, costo: 100, vendute: 1, incassato: 100 * (1 + risultato), quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti }, chiusoIl: "2026-02-01T14:00:00Z", risultato, giorni: 20 });
    for (let i = 0; i < 30; i++) j.trade.push(trade(i, ["trend"], 0.01));
    for (let i = 30; i < 42; i++) j.trade.push(trade(i, ["rientro"], -0.02));
    expect(agentWeights(j, "2026-02-01", ["trend", "rientro", "regime"])).toEqual({ trend: 1, rientro: 1, regime: 1 });
    expect(agentWeights(j, "2026-09-24", ["trend", "rientro", "regime"])).toEqual({ trend: 1.2, rientro: 0.5, regime: 1 });
    const sc = scoreSignals([{ agente: "rientro", simbolo: "SPY", lato: "buy", forza: 1, orizzonteSedute: 20, perche: "" }], { rientro: 0.5 });
    expect(sc[0]!.punteggio).toBe(0.5);
  });
});

function engineDeps(env: TestEnv, agents = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent()]): EngineDeps {
  const d = env.deps();
  return { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents, bus: new EventBus(d.stateDir, d.now), echo: false };
}

describe("motore", () => {
  test("finestra di ingresso: lun-ven 15:40-17:30 ora di Roma", () => {
    expect(inEntryWindow(day("2026-09-24", "15:41"))).toBe(true);
    expect(inEntryWindow(day("2026-09-24", "17:31"))).toBe(false);
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
    // Fuori finestra con un titolo che non è più in portafoglio: la gabbia rifiuta l'acquisto.
    env.setFake((s) => {
      delete s.positions.GLD;
      s.cash += 1_000_000;
    });
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const r3 = await runTick(deps, cache);
    expect(r3.status_file!.ordini.filter((o) => o.lato === "buy")).toEqual([]);
    expect(r3.status_file!.rifiuti.some((x) => x.reason.includes("solo alla sveglia di apertura"))).toBe(true);
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
    env.clock.t = day("2026-09-24", "22:20").getTime();
    await runTick(deps, cache);
    expect(env.outbox().split("riepilogo 2026-09-24").length).toBe(2);
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
      expect(page).toContain("Agenti Alpaca");
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

describe("backtest del motore", () => {
  test("su storico in salita compra, tiene e misura; i trade finiscono nel diario con gli agenti; nessun errore sul crollo", () => {
    const closes: Record<string, number[]> = {};
    for (const s of UNIVERSE) closes[s] = syntheticCloses(PRICES[s]!, 0.01, 320);
    const r = runAgentsBacktest(closes, 100_000, "2026-01-05");
    expect(r.days).toBe(320 - LIMITS.longSmaDays);
    expect(r.buys).toBeGreaterThan(0);
    expect(r.avgExposure).toBeGreaterThan(0.3);
    expect(r.totalReturn).toBeGreaterThan(0);
    // Crollo del 30% di tutto a metà: stop e uscite di trend, l'interruttore scatta, il diario registra trade chiusi dagli agenti.
    const crash: Record<string, number[]> = {};
    for (const s of UNIVERSE) crash[s] = closes[s]!.map((x, i) => (i >= 280 ? x * 0.7 : x));
    const c = runAgentsBacktest(crash, 100_000, "2026-01-05");
    expect(c.stopOuts + c.trendExits + c.agentSells).toBeGreaterThan(0);
    expect(c.breakerTrips).toBeGreaterThanOrEqual(1);
    expect(c.stats.trade).toBeGreaterThan(0);
    expect(Object.keys(c.perAgent)).toContain("trend");
    expect(c.maxDrawdown).toBeGreaterThan(0.1);
  });
});

describe("uscite (regole vincolanti)", () => {
  const pos = (symbol: string, avg: number, price: number) => ({ symbol, qty: 10, avgEntryPrice: avg, currentPrice: price, marketValue: price * 10 });
  const openTrade = (simbolo: string, massimo?: number) => ({ id: simbolo, simbolo, stato: "aperto" as const, apertoIl: "2026-09-01T14:00:00Z", comprate: 10, costo: 1000, vendute: 0, incassato: 0, quantita: 10, contesto: null, massimo });

  test("stop a -2% vende; sotto l'obiettivo tace; a +3% senza proiezione incassa", () => {
    const j = emptyJournal();
    j.trade.push(openTrade("AAPL"), openTrade("MSFT"), openTrade("SPY"));
    const v = view({ positions: [pos("AAPL", 100, 97.9), pos("MSFT", 100, 101), pos("SPY", 100, 103.1)], journal: j });
    v.prices.AAPL = 97.9; v.prices.MSFT = 101; v.prices.SPY = 103.1;
    const r = new ExitAgent().observe(v);
    expect(r.segnali.map((s) => s.simbolo).sort()).toEqual(["AAPL", "SPY"]);
    expect(r.segnali.every((s) => s.vincolante && s.lato === "sell")).toBe(true);
    expect(r.segnali.find((s) => s.simbolo === "AAPL")!.perche).toContain("oltre lo stop");
    expect(r.segnali.find((s) => s.simbolo === "SPY")!.perche).toContain("si incassa");
  });

  test("con proiezione positiva oltre l'obiettivo lascia correre e vende solo se restituisce il 2% dal massimo (mai sotto carico + 0,5%)", () => {
    const j = emptyJournal();
    j.trade.push(openTrade("SPY", 106));
    const run = view({ positions: [pos("SPY", 100, 104.5)], journal: j, previsioni: { SPY: 0.01 } });
    run.prices.SPY = 104.5; // dal massimo 106 ha restituito l'1,4%: si tiene
    expect(new ExitAgent().observe(run).segnali).toEqual([]);
    run.prices.SPY = 103.8; // restituito il 2,1%: si incassa
    expect(new ExitAgent().observe(run).segnali[0]?.perche).toContain("prima di restituire");
    const j2 = emptyJournal();
    j2.trade.push(openTrade("SPY", 103.2));
    const low = view({ positions: [pos("SPY", 100, 100.3)], journal: j2, previsioni: { SPY: 0.01 } });
    low.prices.SPY = 100.3; // massimo 103,2 × 0,98 = 101,1 ma il pavimento è carico + 0,5% = 100,5: sotto, si vende
    expect(new ExitAgent().observe(low).segnali.length).toBe(1);
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

  test("nel motore lo stop GTC su Alpaca sta al 2% dal carico e il massimo visto finisce nel diario", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"));
    const r = await runTick(engineDeps(env, [new TrendAgent(), new RegimeAgent(), new ExitAgent()]));
    const sym = r.status_file!.posizioni[0]!.simbolo;
    const stop = openStopsFor(env, sym)[0]!;
    expect(stop.stopPrice).toBeCloseTo(PRICES[sym]! * 0.98, 1);
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
