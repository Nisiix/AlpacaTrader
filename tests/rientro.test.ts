import { describe, expect, test } from "bun:test";
import { IntradayAgent } from "../src/agents/intraday.ts";
import type { AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, LIMITS, setCryptoUniverse } from "../src/config.ts";
import { activeLessons, emptyLessons, learnFromBrokerReject, learnFromStopLoss, pauseAOre } from "../src/lessons.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

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
const fetch = async (syms: string[], tf: string) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, salita(100, ORA)])) : {});
const percorsi = (h: number, su: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < su ? Math.min(0.04, 0.01 * (i + 1)) : -0.001 * (i + 1))));
const media = (cs: number[][]) => cs[0]!.map((_, i) => cs.reduce((a, r) => a + r[i]!, 0) / cs.length);
const kf = (su: number) => async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? { path: media(percorsi(h, su)), campioni: percorsi(h, su) } : Array.from({ length: h }, () => 0)]));
const misurata = () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 });
// BTC chiusa in perdita (stop) `oreFa` ore fa.
const diario = (oreFa: number | null): JournalFile => ({ ...emptyJournal(), trade: oreFa === null ? [] : [{ id: "b1", simbolo: "BTC/USD", stato: "chiuso", apertoIl: new Date(now.getTime() - (oreFa + 1) * ORA).toISOString(), chiusoIl: new Date(now.getTime() - oreFa * ORA).toISOString(), comprate: 1, costo: 100, vendute: 1, incassato: 99, quantita: 0, motivoUscita: "stop", contesto: { agenti: ["intraday"], tipo: "intraday" } } as any] });
const vista = (oreFa: number | null) => ({ today: "2026-09-27", now, prices: { "BTC/USD": 100 }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: diario(oreFa), mercatoAperto: false }) as unknown as AgentView;
const prova = (su: number, oreFa: number | null) => new IntradayAgent(fetch, kf(su), misurata).observe(vista(oreFa));

describe("dopo uno stop: pausa di qualche ora, poi rientro con più margine (niente blocchi di giorni)", () => {
  test("registro: lo stop mette una pausa di 2 ore, non 5 giorni; i rifiuti di Alpaca una di 4 ore", () => {
    const f = emptyLessons();
    const t0 = new Date("2026-11-09T19:45:00Z");
    const l = learnFromStopLoss(f, "stop-1", "SHEL", "2026-11-09", "stop su Alpaca eseguito", t0)!;
    expect(l.finoAl).toBe("2026-11-09");
    expect(Date.parse(l.finoAlle!) - t0.getTime()).toBe(LIMITS.stopLossPausaOre * ORA);
    expect(l.motivo).toContain("pausa di 2 ore (fino alle 22:45)");
    expect(activeLessons(f, "2026-11-09", new Date(t0.getTime() + ORA))).toHaveLength(1);
    expect(activeLessons(f, "2026-11-09", new Date(t0.getTime() + 2 * ORA + 1))).toHaveLength(0);
    expect(activeLessons(f, "2026-11-10", new Date("2026-11-10T15:00:00Z"))).toHaveLength(0);
    const r = emptyLessons();
    learnFromBrokerReject(r, "XYZ", "buy", "2026-11-09", "asset not tradable", t0);
    const lr = learnFromBrokerReject(r, "XYZ", "buy", "2026-11-09", "asset not tradable", t0)!;
    expect(Date.parse(lr.finoAlle!) - t0.getTime()).toBe(LIMITS.brokerRejectPausaOre * ORA);
  });

  test("registro: le lezioni vecchie da 5 giorni diventano pause a ore (quella di oggi da adesso, le altre finite)", () => {
    const f = emptyLessons();
    f.lezioni.push({ id: "stop-a", tipo: "stop-loss", simbolo: "SHEL", lato: "buy", dal: "2026-11-09", finoAl: "2026-11-16", motivo: "stop loss su SHEL (x): niente riacquisto per 5 giorni di borsa" });
    f.lezioni.push({ id: "stop-b", tipo: "stop-loss", simbolo: "TTE", lato: "buy", dal: "2026-11-05", finoAl: "2026-11-12", motivo: "stop loss su TTE (x): niente riacquisto per 5 giorni di borsa" });
    const adesso = new Date("2026-11-09T20:00:00Z");
    expect(pauseAOre(f, "2026-11-09", adesso)).toBe(true);
    expect(activeLessons(f, "2026-11-09", adesso).map((l) => l.simbolo)).toEqual(["SHEL"]);
    expect(f.lezioni[0]!.motivo).toBe("stop loss su SHEL (x): pausa fino alle 23:00");
    expect(activeLessons(f, "2026-11-10", new Date("2026-11-10T09:00:00Z"))).toHaveLength(0);
    expect(pauseAOre(f, "2026-11-09", adesso)).toBe(false); // una volta sola
  });

  test("agente: 1 ora dopo lo stop pausa (con il motivo); 3 ore dopo si rientra solo con 3 punti di probabilità in più", async () => {
    setCryptoUniverse(["BTC/USD"]);
    // 10 percorsi su 16: circa 56%, sopra la soglia normale (55%).
    expect((await prova(10, null)).segnali.some((x) => x.lato === "buy")).toBe(true);
    const pausa = await prova(16, 1);
    expect(pausa.segnali.some((x) => x.lato === "buy")).toBe(false);
    expect(pausa.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toBe("pausa dopo una perdita (chiusa alle 20:00): rientro valutato dalle 22:00, con 3 punti di probabilità in più");
    // 3 ore dopo: al 56% non basta più (soglia 58%), al 74% si rientra e il perché lo dice.
    expect((await prova(10, 3)).segnali.some((x) => x.lato === "buy")).toBe(false);
    const rientro = (await prova(16, 3)).segnali.find((x) => x.lato === "buy");
    expect(rientro?.perche).toContain("rientro dopo una perdita alle 18:00: soglia più alta di 3 punti");
    // Oltre la finestra (24 ore) torna la soglia normale.
    expect((await prova(10, 30)).segnali.some((x) => x.lato === "buy")).toBe(true);
  });
});
