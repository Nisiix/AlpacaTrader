import { describe, expect, test } from "bun:test";
import { allocate } from "../src/agents/allocator.ts";
import { IntradayAgent } from "../src/agents/intraday.ts";
import type { AgentView, Signal } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage } from "../src/cage.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

AGENTS.intraday.riporto.enabled = false;
const now = new Date("2026-09-27T21:00:00+02:00"); // domenica sera: solo crypto
const ORA = 3_600_000;
function piatta(fine: number, passo: number, n = 120): IntradayBar[] {
  const end = Math.floor(now.getTime() / passo) * passo;
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const c = fine * (1 - 0.0015 * k) * (1 + (k % 2 === 0 ? 0.004 : -0.004));
    const o = i ? out[i - 1]!.close : c;
    out.push({ t: new Date(end - (k + 1) * passo).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1_000 });
  }
  const k = fine / out.at(-1)!.close;
  return out.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
}
const fetch = async (syms: string[], tf: string) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, piatta(100, ORA)])) : {});
// `su` percorsi su 16 salgono fino a +4%, gli altri scendono piano.
const percorsi = (h: number, su: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < su ? Math.min(0.04, 0.01 * (i + 1)) : -0.001 * (i + 1))));
const media = (cs: number[][]) => cs[0]!.map((_, i) => cs.reduce((a, r) => a + r[i]!, 0) / cs.length);
// BTC (occasione nuova): 16 percorsi su 16 salgono. ETH (aperta): solo `suEth` su 16.
const kf = (suEth: number) => async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => { const su = x === "ETH/USD" ? suEth : 16; return [x, step === 60 ? { path: media(percorsi(h, su)), campioni: percorsi(h, su) } : Array.from({ length: h }, () => 0)]; }));
const misurata = () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 });
const diario = (minutiFa: number): JournalFile => ({ ...emptyJournal(), trade: [{ id: "e1", simbolo: "ETH/USD", stato: "aperto", apertoIl: new Date(now.getTime() - minutiFa * 60_000).toISOString(), comprate: 990, costo: 99_000, vendute: 0, incassato: 0, quantita: 990, contesto: { agenti: ["intraday"], tipo: "intraday", livelli: { candela: "1Hour", obiettivo: 102, stop: 98, sopraMedia: false, orizzonteMin: 600 } } } as any] });
const vista = (minutiFa: number, cash = 1_000, extra: Partial<AgentView> = {}) => ({ today: "2026-09-27", now, prices: { "BTC/USD": 100, "ETH/USD": 100 }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260), "ETH/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [{ symbol: "ETH/USD", qty: 990, avgEntryPrice: 100, currentPrice: 100, marketValue: 99_000 }], account: { equity: cash + 99_000, lastEquity: cash + 99_000, cash, status: "ACTIVE" }, journal: diario(minutiFa), mercatoAperto: false, ...extra }) as unknown as AgentView;
const giro = async (suEth: number, minutiFa: number, cash?: number) => {
  // Il processo riparte a ogni prova: l'operazione aperta riprende i livelli dal diario (aperta `minutiFa` minuti fa).
  const a = new IntradayAgent(fetch, kf(suEth), misurata);
  const r = await a.observe(vista(minutiFa, cash));
  return { r, sostituzione: r.segnali.find((x) => x.lato === "sell" && x.libera) };
};

describe("sostituzione dei trade deboli", () => {
  test("budget pieno, ETH aperta da 2 ore con il 38% di salire, BTC nuova al 73%: si vende ETH per far posto", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const { r, sostituzione } = await giro(4, 120);
    expect(r.segnali.some((x) => x.lato === "buy" && x.simbolo === "BTC/USD")).toBe(true);
    expect(sostituzione?.simbolo).toBe("ETH/USD");
    expect(sostituzione!.vincolante).toBe(true);
    expect(sostituzione!.perche).toMatch(/sostituito da BTC\/USD \(probabilità \d+% contro \d+% di salire qui sulle candele 1Hour\): budget pieno/);
    expect(r.intraday!.find((x) => x.simbolo === "ETH/USD")!.motivo).toContain("sostituito da BTC/USD");
  });

  test("niente sostituzione: aperta da poco, spazio libero, o aperta ancora probabile", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    expect((await giro(4, 10)).sostituzione).toBeUndefined(); // aperta da 10 minuti (minimo 30)
    expect((await giro(4, 120, 99_000)).sostituzione).toBeUndefined(); // contanti liberi: la nuova entra senza vendere
    expect((await giro(14, 120)).sostituzione).toBeUndefined(); // ETH al 69% di salire: sopra la soglia d'ingresso
  });

  test("al massimo maxGiorno sostituzioni al giorno per lo stesso agente", async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const prima = AGENTS.intraday.sostituzione.maxGiorno;
    AGENTS.intraday.sostituzione.maxGiorno = 1;
    try {
      const a = new IntradayAgent(fetch, kf(4), misurata);
      expect((await a.observe(vista(120))).segnali.some((x) => x.libera)).toBe(true);
      expect((await a.observe({ ...vista(120), now: new Date(now.getTime() + 5 * 60_000) } as AgentView)).segnali.some((x) => x.libera)).toBe(false);
    } finally { AGENTS.intraday.sostituzione.maxGiorno = prima; }
  });

  test("allocatore e gabbia: il ricavato della vendita di sostituzione va subito all'acquisto nuovo", () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const v = vista(120);
    const vende: Signal = { agente: "intraday", simbolo: "ETH/USD", lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, intraday: true, libera: true, perche: "ETH/USD intraday: sostituito da BTC/USD" };
    const compra: Signal = { agente: "intraday", simbolo: "BTC/USD", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.15, perche: "prova" };
    const senza = allocate(v, { intraday: { segnali: [compra] } }, { intraday: 1 });
    expect(senza.proposte.find((x) => x.symbol === "BTC/USD")).toBeUndefined(); // niente contanti, niente budget
    const con = allocate(v, { intraday: { segnali: [vende, compra] } }, { intraday: 1 });
    const sell = con.proposte.find((x) => x.symbol === "ETH/USD" && x.side === "sell")!;
    const buy = con.proposte.find((x) => x.symbol === "BTC/USD" && x.side === "buy")!;
    expect(sell.libera).toBe(true);
    expect(buy.qty * 100).toBeGreaterThan(0.15 * 100_000 * AGENTS.regime.bearScale - 1); // taglia vera (anche col regime più prudente)
    const cage = applyCage({ today: "2026-09-27", marketOpen: false, account: v.account, positions: v.positions, prices: v.prices, closes: v.closes, recentOrders: [], lessons: [], buyBlock: null, proposals: con.proposte } as any);
    expect(cage.rejected).toEqual([]);
    expect(cage.orders.map((o) => `${o.side} ${o.symbol}${o.libera ? " libera" : ""}`)).toEqual(["sell ETH/USD libera", "buy BTC/USD"]);
    // Senza la vendita di sostituzione la gabbia rifiuta l'acquisto (settore crypto pieno, niente contanti).
    const solo = applyCage({ today: "2026-09-27", marketOpen: false, account: v.account, positions: v.positions, prices: v.prices, closes: v.closes, recentOrders: [], lessons: [], buyBlock: null, proposals: [buy] } as any);
    expect(solo.orders).toEqual([]);
    expect(solo.rejected).toHaveLength(1);
  });
});

describe("sostituzione nel motore vero", () => {
  test("conto da 1.000 $ con il budget pieno: vende NVDA (sostituzione), aspetta l'esecuzione e compra MSFT nello stesso giro", async () => {
    const { EventBus } = await import("../src/agents/bus.ts");
    const { emptyCache, runTick } = await import("../src/agents/engine.ts");
    const { segnaFrazionabili } = await import("../src/broker/types.ts");
    const { makeEnv, ordersFor } = await import("./helpers.ts");
    const prima = AGENTS.intraday.budget.quota;
    AGENTS.intraday.budget.quota = 0.2; // budget piccolo: NVDA da sola lo riempie
    try {
      segnaFrazionabili({ NVDA: true, MSFT: true });
      const env = makeEnv(new Date("2026-09-24T15:00:00Z")); // giovedì, borsa aperta
      env.setFake((s) => { s.cash = 1_000; s.lastEquity = 1_000; s.prices.NVDA = 180; s.prices.MSFT = 400; s.clock = "open"; });
      let fase = 1;
      const agente = {
        name: "intraday",
        async observe(v: AgentView) {
          const nvda = v.positions.find((p) => p.symbol === "NVDA" && p.qty > 0);
          if (fase === 1) return { segnali: nvda ? [] : [{ agente: "intraday", simbolo: "NVDA", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.2, perche: "prova: ingresso" } as Signal] };
          return { segnali: [
            ...(nvda ? [{ agente: "intraday", simbolo: "NVDA", lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, intraday: true, libera: true, perche: "NVDA intraday: sostituito da MSFT" } as Signal] : []),
            { agente: "intraday", simbolo: "MSFT", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.2, perche: "prova: occasione migliore" } as Signal,
          ] };
        },
      };
      const d = env.deps();
      const deps = { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [agente], bus: new EventBus(d.stateDir, d.now), echo: false };
      const cache = emptyCache();
      await runTick(deps as any, cache);
      expect(env.broker.load().positions.NVDA?.qty ?? 0).toBeGreaterThan(0);
      // Senza sostituzione MSFT non entrerebbe (budget pieno): con la vendita «libera» entra nello stesso giro.
      fase = 2;
      env.clock.t += 10 * 60_000;
      const r = await runTick(deps as any, cache);
      expect(env.broker.load().positions.NVDA).toBeUndefined();
      const msft = ordersFor(env, "MSFT").find((o) => o.side === "buy");
      expect(msft, JSON.stringify({ rifiuti: r.status_file?.rifiuti, attesa: r.status_file?.inAttesa })).toBeDefined();
      expect(msft!.status).toBe("filled");
      expect(msft!.qty * 400).toBeGreaterThan(150);
      // Prima la vendita, poi l'acquisto.
      const tutti = env.broker.load().orders;
      expect(tutti.findIndex((o) => o.symbol === "NVDA" && o.side === "sell")).toBeLessThan(tutti.findIndex((o) => o.symbol === "MSFT" && o.side === "buy"));
    } finally { AGENTS.intraday.budget.quota = prima; }
  });
});
