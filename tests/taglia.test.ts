import { describe, expect, test } from "bun:test";
import { allocate } from "../src/agents/allocator.ts";
import { IntradayAgent } from "../src/agents/intraday.ts";
import type { AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal } from "../src/journal.ts";

AGENTS.intraday.riporto.enabled = false;
const now = new Date("2026-09-27T21:00:00+02:00"); // domenica sera: solo crypto
const ORA = 3_600_000;
function salita(fine: number, passo: number, n = 120): IntradayBar[] {
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
// Solo candele da 1 ora: la candela dell'ingresso è quella.
const fetch = async (syms: string[], tf: string) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, salita(100, ORA)])) : {});
// `su` percorsi su 16 salgono fino a +4%, gli altri scendono piano.
const percorsi = (h: number, su: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < su ? Math.min(0.04, 0.01 * (i + 1)) : -0.001 * (i + 1))));
const media = (cs: number[][]) => cs[0]!.map((_, i) => cs.reduce((a, r) => a + r[i]!, 0) / cs.length);
const kf = (su: number) => async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? { path: media(percorsi(h, su)), campioni: percorsi(h, su) } : Array.from({ length: h }, () => 0)]));
const misurata = () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 });
const vista = (extra: Partial<AgentView> = {}) => ({ today: "2026-09-27", now, prices: { "BTC/USD": 100 }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false, ...extra }) as unknown as AgentView;

describe("taglia intraday: indizi nella probabilità, rischio nella taglia, pavimento", () => {
  test("un indizio contrario toglie punti di probabilità: al limite della soglia non si entra, con il motivo", async () => {
    setCryptoUniverse(["BTC/USD"]);
    // 10 percorsi su 16: probabilità circa 56%, appena sopra la soglia del 55%.
    const senza = await new IntradayAgent(fetch, kf(10), misurata).observe(vista());
    expect(senza.segnali.some((x) => x.lato === "buy")).toBe(true);
    // Con Kronos a 5 sedute al −3% (indizio contrario, −2 punti): 54%, sotto la soglia.
    const con = await new IntradayAgent(fetch, kf(10), misurata).observe(vista({ previsioni: { "BTC/USD": -0.03 } }));
    expect(con.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(con.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toMatch(/indizi contrari \(Kronos a 5 sedute -3\.00%\): la probabilità scende da 56% a 54%, sotto la soglia del 55%/);
    // Con più margine (16 percorsi su 16) l'indizio toglie i punti ma si entra, e la taglia non si dimezza.
    const forte = await new IntradayAgent(fetch, kf(16), misurata).observe(vista());
    const forteCon = await new IntradayAgent(fetch, kf(16), misurata).observe(vista({ previsioni: { "BTC/USD": -0.03 } }));
    const a = forte.segnali.find((x) => x.lato === "buy")!, b = forteCon.segnali.find((x) => x.lato === "buy")!;
    expect(b.perche).toContain("indizi contrari: Kronos a 5 sedute -3.00%");
    expect(b.pesoMassimo!).toBeGreaterThan(a.pesoMassimo! * 0.8);
  });

  test("pavimento: i fattori di rischio non portano la taglia sotto il pavimento della taglia massima", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const prima = AGENTS.intraday.taglia.pavimento;
    AGENTS.intraday.taglia.pavimento = 0.9;
    const r = await new IntradayAgent(fetch, kf(10), misurata).observe(vista());
    const buy = r.segnali.find((x) => x.lato === "buy")!;
    // Stop delle crypto 1% (minimo): taglia dal rischio = 0,25% / (1% + 0,4% di costi + 0,2% di scivolamento) ≈ 15,6%.
    const pesoRischio = Math.min(AGENTS.intraday.maxWeight, AGENTS.intraday.budget.quota * AGENTS.intraday.budget.maxQuotaTrade, AGENTS.intraday.budget.rischioTrade / (0.01 + 0.004 + AGENTS.intraday.budget.scivolamento));
    expect(buy.pesoMassimo!).toBeCloseTo(pesoRischio * 0.9, 9);
    expect(buy.perche).toContain("taglia al pavimento (90% della massima)");
    AGENTS.intraday.taglia.pavimento = prima;
  });

  test("più è probabile, più si investe: alla soglia ×min, ampiezza punti sopra ×max, mai oltre maxWeight", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const tp = AGENTS.intraday.taglia.probabilita;
    const peso = async (su: number) => (await new IntradayAgent(fetch, kf(su), misurata).observe(vista())).segnali.find((x) => x.lato === "buy");
    const bassa = (await peso(10))!, alta = (await peso(16))!;
    expect(alta.pesoMassimo!).toBeGreaterThan(bassa.pesoMassimo! * 1.5);
    expect(alta.pesoMassimo!).toBeLessThanOrEqual(AGENTS.intraday.maxWeight + 1e-12);
    expect(alta.perche).toMatch(/taglia ×\d\.\d\d per la probabilità \(\d+% contro la soglia del \d+%\)/);
    // Spento: le due taglie tornano uguali (stesso stop, stesso rischio).
    tp.enabled = false;
    const b0 = (await peso(10))!, a0 = (await peso(16))!;
    tp.enabled = true;
    expect(a0.pesoMassimo!).toBeCloseTo(b0.pesoMassimo!, 9);
    // Il fattore non supera max: con un'ampiezza minima (subito ×max) la taglia resta ≤ max volte quella di serie.
    const prima = tp.ampiezza;
    tp.ampiezza = 0.01;
    const piena = (await peso(16))!;
    tp.ampiezza = prima;
    expect(piena.pesoMassimo!).toBeLessThanOrEqual(a0.pesoMassimo! * tp.max + 1e-12);
  });

  test("allocatore: la taglia di un voto intraday non la riduce Kronos a 5 sedute (prima fino a ×0,4)", () => {
    setCryptoUniverse(["BTC/USD"]);
    const v = vista({ previsioni: { "BTC/USD": -0.03 }, mercatoAperto: true } as Partial<AgentView>);
    const a = allocate(v, { intraday: { segnali: [{ agente: "intraday", simbolo: "BTC/USD", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.05, perche: "prova" }] } }, { intraday: 1 });
    const p = a.proposte.find((x) => x.symbol === "BTC/USD")!;
    expect((p.qty * 100) / 100_000).toBeGreaterThan(0.049);
  });
});
