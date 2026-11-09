import { describe, expect, test } from "bun:test";
import { IntradayAgent, atr, letturaCampioni } from "../src/agents/intraday.ts";
import type { AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal } from "../src/journal.ts";
import { campioniDi, intradayForecaster, type KronosLink } from "../src/kronos-sidecar.ts";

AGENTS.puntaIntraday = false;
AGENTS.intraday.riporto.enabled = false;

// Candele da 5 minuti di BTC in salita con oscillazioni dello 0,3% (EMA 9 sopra EMA 20, prezzo sopra la 9).
function salita(fine: number, finoA: Date, n = 120, passo = 300_000, osc = 0.003): IntradayBar[] {
  const end = Math.floor(finoA.getTime() / passo) * passo;
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const c = fine * (1 - 0.0015 * k) * (1 + (k % 2 === 0 ? osc : -osc));
    const o = i ? out[i - 1]!.close : c;
    out.push({ t: new Date(end - (k + 1) * passo).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1_000 });
  }
  return out;
}

const now = new Date("2026-09-27T21:00:00+02:00"); // domenica sera: solo crypto
const vista = (prezzo = 76_000) => ({ today: "2026-09-27", now, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(prezzo, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false }) as unknown as AgentView;
// `su` percorsi su 16 salgono a +1,5% (+0,5% a candela), gli altri scendono piano (−0,1% a candela).
const percorsi = (h: number, su: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < su ? Math.min(0.015, 0.005 * (i + 1)) : -0.001 * (i + 1))));
const media = (cs: number[][]) => cs[0]!.map((_, i) => cs.reduce((a, r) => a + r[i]!, 0) / cs.length);

describe("Kronos a percorsi: probabilità, stop, candele senza vantaggio, selezione", () => {
  test("letturaCampioni: conta i percorsi sopra i costi che non toccano lo stop; lo stop è il quantile dei minimi", () => {
    const cs = [[0.01, 0.02], [0.005, 0.01], [-0.002, 0.012], [-0.03, 0.02], [0.001, -0.004]];
    const l = letturaCampioni(cs, 2, 0.004, 0.004, 0.02, 0.2)!;
    // Minimi: 0, 0, −0,002, −0,03, −0,004 → al 20% (indice 0 di 5 ordinati) −0,03, limitato dallo stop dell'ATR (2%).
    expect(l.stop).toBeCloseTo(0.02);
    // Sopra lo 0,4% a 2 candele senza scendere sotto −2%: il 1°, il 2° e il 3° (il 4° tocca −3%).
    expect(l.sopra).toBe(3);
    expect(l.tot).toBe(5);
    // Lo stop non scende sotto il minimo.
    expect(letturaCampioni([[0.01], [0.02]], 1, 0, 0.004, 0.02, 0.2)!.stop).toBe(0.004);
  });

  test("con i percorsi la probabilità è la quota che sale: 12 su 16 entra, 7 su 16 no (anche con la stessa media)", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const bars = salita(76_000, now);
    const fetch = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, bars]));
    const conPercorsi = (su: number) => new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => { const cs = step === 5 ? percorsi(h, su) : Array.from({ length: 16 }, () => Array.from({ length: h }, () => 0)); return [x, { path: media(percorsi(h, 12)), campioni: cs }]; })), () => ({ fattore: 1, quota: 0.55, campione: 0 }));
    const si = await conPercorsi(12).observe(vista());
    const buy = si.segnali.find((x) => x.lato === "buy");
    expect(buy?.perche).toContain("candele 5Min");
    expect(buy!.perche).toContain("percorsi su 16 sopra i costi");
    const no = await conPercorsi(7).observe(vista());
    expect(no.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(no.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("non basta");
  });

  test("lo stop dell'ingresso viene dai percorsi peggiori di Kronos, non dall'ATR; decide l'aspettativa", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const bars = salita(76_000, now, 120, 300_000, 0.006);
    const fetch = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, bars]));
    // 12 percorsi su 16 salgono senza scendere, 4 scendono dell'1,2%: lo stop è quello dei peggiori (1,2%), tra il minimo
    // delle crypto (1%) e quello dell'ATR (più largo).
    const cs = (h: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < 12 ? Math.min(0.02, 0.006 * (i + 1)) : -Math.min(0.012, 0.004 * (i + 1)))));
    const a = new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? { path: media(cs(h)), campioni: cs(h) } : { path: Array.from({ length: h }, () => 0) }])), () => ({ fattore: 1, quota: 0.55, campione: 0 }));
    const r = await a.observe(vista());
    const buy = r.segnali.find((x) => x.lato === "buy")!;
    const stop = Number(/stop [\d.]+ \((-[\d.]+)%\)/.exec(buy.perche)![1]);
    const conAtr = (AGENTS.intraday.stopAtr * atr(bars, 14)!) / 76_000;
    expect(conAtr).toBeGreaterThan(0.012);
    expect(stop).toBeCloseTo(-1.2, 1);
    // Percorsi che salgono poco (+0,6%) contro uno stop dell'1,2%: aspettativa negativa, niente ingresso.
    const poco = (h: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < 11 ? Math.min(0.006, 0.002 * (i + 1)) : -Math.min(0.012, 0.004 * (i + 1)))));
    const r2 = await new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? { path: media(poco(h)), campioni: poco(h) } : { path: Array.from({ length: h }, () => 0) }])), () => ({ fattore: 1, quota: 0.55, campione: 0 })).observe(vista());
    expect(r2.segnali.filter((x) => x.lato === "buy")).toEqual([]);
  });

  test("l'ATR non conta il salto tra una seduta e l'altra", () => {
    // 20 candele da 1 ora, poi una notte (salto di 16 ore) con un'apertura del +5%.
    const t0 = Date.parse("2026-09-21T13:30:00Z");
    const b: IntradayBar[] = [];
    for (let i = 0; i < 20; i++) b.push({ t: new Date(t0 + i * 3_600_000).toISOString(), open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 });
    b.push({ t: new Date(t0 + 19 * 3_600_000 + 16 * 3_600_000).toISOString(), open: 105, high: 105.5, low: 104.5, close: 105, volume: 1 });
    expect(atr(b, 14)).toBeCloseTo(1, 5);
  });

  test("candela con direzione giusta sotto il 50% su abbastanza previsioni: non si entra lì e non blocca le altre", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const bars = salita(76_000, now);
    const fetch = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, bars]));
    // 1 ora al ribasso (sarebbe contraria), ma su 1 ora Kronos indovina il 41% su 44: non conta.
    const kf = async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? Array.from({ length: h }, (_, i) => Math.min(0.015, 0.005 * (i + 1))) : step === 60 ? Array.from({ length: h }, () => -0.02) : Array.from({ length: h }, () => 0)]));
    const aff = (step: number) => (step === 60 ? { fattore: 0, quota: 0.5, campione: 44, giusti: 0.41 } : { fattore: 1, quota: 0.55, campione: 0 });
    const r = await new IntradayAgent(fetch, kf, aff).observe(vista());
    expect(r.segnali.some((x) => x.lato === "buy" && x.perche.includes("candele 5Min"))).toBe(true);
    expect((r.note ?? []).join(" ")).toContain("senza vantaggio misurato, solo misurate: 1Hour");
    // Con la 1 ora affidabile lo stesso calo blocca (Triple Screen).
    const r2 = await new IntradayAgent(fetch, kf, () => ({ fattore: 1, quota: 0.55, campione: 0 })).observe(vista());
    expect(r2.segnali.filter((x) => x.lato === "buy")).toEqual([]);
  });

  test("selezione: per ogni candela al massimo perCandela proiezioni nuove a giro, e niente proiezione se il prezzo si muove troppo poco", async () => {
    const prima = AGENTS.intraday.selezione.movimentoMin;
    AGENTS.intraday.selezione.movimentoMin = 1;
    const coppie = Array.from({ length: 20 }, (_, i) => `C${i}/USD`);
    setCryptoUniverse(coppie);
    const bars = salita(10, now);
    const piatte = salita(10, now, 120, 300_000, 0.0002);
    const fetch = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, x === "C0/USD" ? piatte : bars]));
    const chieste = new Map<number, number>();
    const kf = async (b: Record<string, IntradayBar[]>, step: number, h: number) => { chieste.set(step, (chieste.get(step) ?? 0) + Object.keys(b).length); return Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, () => 0)])); };
    const v = { ...vista(), prices: Object.fromEntries(coppie.map((x) => [x, 10])), closes: Object.fromEntries(coppie.map((x) => [x, syntheticCloses(10, 0.02, 260)])) } as unknown as AgentView;
    const r = await new IntradayAgent(fetch, kf, () => ({ fattore: 1, quota: 0.55, campione: 0 })).observe(v);
    expect(chieste.get(5)).toBeLessThanOrEqual(AGENTS.intraday.selezione.perCandela["5Min"]!);
    expect(chieste.get(15)).toBeLessThanOrEqual(AGENTS.intraday.selezione.perCandela["15Min"]!);
    expect(r.intraday!.find((x) => x.simbolo === "C0/USD")!.motivo).toContain("si muove troppo poco per coprire i costi");
    setCryptoUniverse(["BTC/USD"]);
    AGENTS.intraday.selezione.movimentoMin = prima;
  });

  test("sidecar: i grafici aspettano mentre gli agenti usano Kronos; i percorsi si leggono solo se sono buoni", async () => {
    const link: KronosLink = { url: "http://127.0.0.1:1", ready: true, stato: "", stop: () => {}, occupato: 1 };
    await expect(intradayForecaster(link, "grafico")({ X: [] }, 5, 12)).rejects.toThrow("occupato");
    expect(campioniDi([[0.1, 0.2], [0.1, 0.2], [0.1, 0.2], [0.1, 0.2]])).toHaveLength(4);
    expect(campioniDi([[0.1], [0.1]])).toBeNull();
    expect(campioniDi([[0.1, NaN], [0.1, 0.2], [0.1, 0.2], [0.1, 0.2]])).toBeNull();
  });
});
