import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventBus } from "../src/agents/bus.ts";
import { emptyCache, runTick } from "../src/agents/engine.ts";
import { IntradayAgent } from "../src/agents/intraday.ts";
import type { Agent, AgentReport, AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal } from "../src/journal.ts";
import { Logger, Redactor } from "../src/log.ts";
import { azzeraRifiutiFrazioni, manageStops } from "../src/stops.ts";
import { makeEnv, openStopsFor } from "./helpers.ts";

AGENTS.puntaIntraday = false;
AGENTS.intraday.riporto.enabled = false;

// Candele in salita con oscillazioni dello 0,3% (EMA 9 sopra EMA 20, prezzo sopra la 9), passo `passo` ms.
function salita(fine: number, finoA: Date, passo = 300_000, n = 120): IntradayBar[] {
  const end = Math.floor(finoA.getTime() / passo) * passo;
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const c = fine * (1 - 0.0015 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
    const o = i ? out[i - 1]!.close : c;
    out.push({ t: new Date(end - (k + 1) * passo).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1_000 });
  }
  return out;
}
const now = new Date("2026-09-27T21:00:00+02:00"); // domenica sera: solo crypto
const passoDi: Record<string, number> = { "5Min": 300_000, "15Min": 900_000, "1Hour": 3_600_000, "4Hour": 14_400_000 };
const vista = (simboli: string[]) => ({ today: "2026-09-27", now, prices: Object.fromEntries(simboli.map((s) => [s, 100])), closes: Object.fromEntries(simboli.map((s) => [s, syntheticCloses(100, 0.02, 260)])), indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false }) as unknown as AgentView;
const fetch = async (syms: string[], tf: string) => Object.fromEntries(syms.map((x) => [x, salita(100, now, passoDi[tf])]));
const sale = (fino: number, passo: number) => (h: number) => Array.from({ length: h }, (_, i) => Math.min(fino, passo * (i + 1)));
const piatta = (h: number) => Array.from({ length: h }, () => 0);
const normale = () => ({ fattore: 1, quota: 0.55, campione: 0 });

describe("consigli 2-5: candele senza resa, crypto, tetto crypto, stop intraday su Alpaca", () => {
  test("2. candela con tante previsioni ma resa media ≤ 0 (le 15 minuti): non fa entrare, si entra dove Kronos rende", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const kf = async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 15 ? sale(0.03, 0.01)(h) : step === 60 ? sale(0.03, 0.008)(h) : piatta(h)]));
    const aff = (step: number) => (step === 15 ? { fattore: 1, quota: 0.55, campione: 1085, giusti: 0.51, resa: -0.0006 } : normale());
    const r = await new IntradayAgent(fetch, kf, aff).observe(vista(["BTC/USD"]));
    const buy = r.segnali.find((x) => x.lato === "buy");
    expect(buy?.perche).toContain("su candele 1Hour");
    expect((r.note ?? []).join(" ")).toContain("solo misurate: 15Min");
  });

  test("3. crypto sulle candele brevi solo con un rialzo previsto di almeno 3 volte i costi; sulle 1 ora basta il doppio", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const prova = (step5: number, step60: number) => new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? sale(step5, step5 / 3)(h) : step === 60 ? sale(step60, step60 / 3)(h) : piatta(h)])), normale).observe(vista(["BTC/USD"]));
    // +1,0% in 15 minuti sulle 5 minuti: oltre il doppio dei costi (0,8%) ma sotto il triplo (1,2%): niente.
    const no = await prova(0.01, 0);
    expect(no.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(no.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("crypto su candele brevi");
    // +1,5%: sopra il triplo, si entra sulle 5 minuti.
    expect((await prova(0.015, 0)).segnali.find((x) => x.lato === "buy")?.perche).toContain("su candele 5Min");
    // +1,0% sulle 1 ora (con i percorsi di Kronos, tutti al rialzo): lì basta il doppio dei costi.
    const ora = await new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? { path: sale(0.01, 0.01 / 3)(h), campioni: Array.from({ length: 16 }, () => sale(0.01, 0.01 / 3)(h)) } : piatta(h)])), normale).observe(vista(["BTC/USD"]));
    expect(ora.segnali.find((x) => x.lato === "buy")?.perche).toContain("su candele 1Hour");
  });

  test("4. tetto alle crypto: al massimo 2 ingressi crypto nello stesso giro, i più probabili; con maxAperte più basso ancora meno", async () => {
    const coppie = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD"];
    setCryptoUniverse(coppie);
    // Rialzi diversi per coppia: probabilità diverse, così si vede chi passa per primo.
    const forza: Record<string, number> = { "BTC/USD": 0.012, "ETH/USD": 0.03, "SOL/USD": 0.016, "XRP/USD": 0.025, "DOGE/USD": 0.014 };
    const kf = async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? sale(forza[x]!, forza[x]! / 2)(h) : piatta(h)]));
    const r = await new IntradayAgent(fetch, kf, normale).observe(vista(coppie));
    const buys = r.segnali.filter((x) => x.lato === "buy").map((x) => x.simbolo);
    expect(buys).toHaveLength(AGENTS.intraday.crypto.maxIngressiGiro);
    expect(buys.sort()).toEqual(["ETH/USD", "XRP/USD"]);
    expect(r.intraday!.filter((x) => /tetto alle crypto/.test(x.motivo))).toHaveLength(3);
    const prima = AGENTS.intraday.crypto.maxAperte;
    AGENTS.intraday.crypto.maxAperte = 1;
    const r2 = await new IntradayAgent(fetch, kf, normale).observe(vista(coppie));
    expect(r2.segnali.filter((x) => x.lato === "buy")).toHaveLength(1);
    AGENTS.intraday.crypto.maxAperte = prima;
    setCryptoUniverse(["BTC/USD"]);
  });

  test("5. stop su Alpaca: per un'operazione intraday quello dell'operazione, non quello largo dei più giorni", async () => {
    azzeraRifiutiFrazioni();
    const env = makeEnv(new Date("2026-09-24T15:00:00Z"));
    env.setFake((s) => { s.prices.NVDA = 180; s.positions.NVDA = { qty: 2.5, avgEntryPrice: 180 }; });
    const log = new Logger(join(env.logsDir, "prova.log"), new Redactor([]), false);
    const r = await manageStops(env.broker, "g1", await env.broker.getPositions(), await env.broker.getOpenOrders(), log, {}, 0.05, env.deps().now(), { NVDA: 179.26 });
    expect(r.errors).toEqual([]);
    expect(r.placed).toEqual(["NVDA 2 @ 179.26 (stop intraday)", "NVDA 0.5 (frazione, stop day) @ 179.26 (stop intraday)"]);
    // Lo stop dell'operazione sale (pareggio): su Alpaca si sposta.
    env.clock.t += 5 * 60_000;
    const r2 = await manageStops(env.broker, "g2", await env.broker.getPositions(), await env.broker.getOpenOrders(), log, {}, 0.05, env.deps().now(), { NVDA: 179.7 });
    expect(r2.cancelled).toHaveLength(2);
    expect(openStopsFor(env, "NVDA").every((o) => o.stopPrice === 179.7)).toBe(true);
    // Prezzo già sotto lo stop dell'operazione (l'agente vende in questo giro): su Alpaca resta lo stop normale.
    const r3 = await manageStops(env.broker, "g3", await env.broker.getPositions(), await env.broker.getOpenOrders(), log, {}, 0.05, env.deps().now(), { NVDA: 181 });
    expect(openStopsFor(env, "NVDA").every((o) => o.stopPrice === 171)).toBe(true);
    expect(r3.errors).toEqual([]);
  });

  test("5. motore vero: comprato un intraday, lo stop su Alpaca è al livello dell'operazione; promossa a più giorni, torna largo", async () => {
    azzeraRifiutiFrazioni();
    const env = makeEnv(new Date("2026-09-24T15:00:00Z"));
    env.setFake((s) => { s.cash = 1_000; s.lastEquity = 1_000; s.prices.NVDA = 180; s.clock = "open"; });
    let stop = 179.26;
    const agente: Agent = {
      name: "intraday",
      async observe(v: AgentView): Promise<AgentReport> {
        const held = v.positions.find((p) => p.symbol === "NVDA" && p.qty > 0);
        if (held) return { segnali: [], intraday: [{ simbolo: "NVDA", candela: "1Hour", fase: "in posizione", ingresso: 180, obiettivo: 181.5, stop, prezzo: 180, motivo: "in corsa" }] };
        return { segnali: [{ agente: "intraday", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.05, perche: "prova" }], intraday: [{ simbolo: "NVDA", candela: "1Hour", fase: "cerca ingresso", ingresso: 180, obiettivo: 181.5, stop, prezzo: 180, motivo: "ingresso votato", livelli: { candela: "1Hour", obiettivo: 181.5, stop, sopraMedia: true } }] };
      },
    };
    const d = env.deps();
    const deps = { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [agente], bus: new EventBus(d.stateDir, d.now), echo: false };
    const cache = emptyCache();
    await runTick(deps, cache);
    expect(openStopsFor(env, "NVDA").map((o) => o.stopPrice)).toEqual([179.26]);
    // Il prezzo sale e lo stop dell'operazione va in pareggio: su Alpaca segue.
    env.setFake((s) => { s.prices.NVDA = 181; });
    stop = 180.05;
    env.clock.t += 5 * 60_000;
    await runTick(deps, cache);
    expect(openStopsFor(env, "NVDA").map((o) => o.stopPrice)).toEqual([180.05]);
    // Con lo stop intraday su Alpaca spento torna quello largo.
    AGENTS.intraday.stopSuAlpaca = false;
    env.clock.t += 5 * 60_000;
    await runTick(deps, cache);
    expect(openStopsFor(env, "NVDA")[0]!.stopPrice!).toBeLessThan(175);
    AGENTS.intraday.stopSuAlpaca = true;
  });
});
