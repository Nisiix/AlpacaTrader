import { describe, expect, test } from "bun:test";
import { IntradayAgent } from "../src/agents/intraday.ts";
import type { AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage } from "../src/cage.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

const conCryptoFerme = async (fn: () => Promise<void> | void) => { const prima = AGENTS.cryptoAcquisti.enabled; AGENTS.cryptoAcquisti.enabled = false; try { await fn(); } finally { AGENTS.cryptoAcquisti.enabled = prima; } };
const now = new Date("2026-09-27T21:00:00+02:00");
const ORA = 3_600_000;
function salita(fine: number, n = 120): IntradayBar[] {
  const end = Math.floor(now.getTime() / ORA) * ORA;
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) { const k = n - 1 - i; const c = fine * (1 - 0.0015 * k) * (1 + (k % 2 === 0 ? 0.004 : -0.004)); const o = i ? out[i - 1]!.close : c; out.push({ t: new Date(end - (k + 1) * ORA).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1_000 }); }
  const k = fine / out.at(-1)!.close;
  return out.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
}
const percorsi = (h: number) => Array.from({ length: 16 }, () => Array.from({ length: h }, (_, i) => Math.min(0.04, 0.01 * (i + 1))));
const agente = () => new IntradayAgent(async (syms, tf) => (tf === "1Hour" ? Object.fromEntries(syms.map((x) => [x, salita(100)])) : {}), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? { path: percorsi(h)[0]!, campioni: percorsi(h) } : Array.from({ length: h }, () => 0)])), () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 }));
const vista = (journal: JournalFile, positions: unknown[] = [], prezzo = 100) => ({ today: "2026-09-27", now, prices: { "BTC/USD": prezzo, "ETH/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260), "ETH/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions, account: { equity: 100_000, lastEquity: 100_000, cash: 90_000, status: "ACTIVE" }, journal, mercatoAperto: false }) as unknown as AgentView;

describe("acquisti crypto fermati (10/11/2026)", () => {
  test("valori di serie: acquisti crypto spenti, soglie di probabilità al 60%", () => {
    const r = Bun.spawnSync(["bun", "-e", "import { AGENTS } from './src/config.ts'; console.log(JSON.stringify([AGENTS.cryptoAcquisti.enabled, AGENTS.intraday.kronos.minProb, AGENTS.intraday.kronos.minProbSenzaGrafico, AGENTS.intraday.sostituzione.traClassi]))"], { cwd: import.meta.dir + "/.." });
    expect(JSON.parse(r.stdout.toString().trim())).toEqual([false, 0.6, 0.6, false]);
  });

  test("gabbia: un acquisto crypto si rifiuta, la vendita di una crypto aperta passa", () => conCryptoFerme(() => {
    const base = { today: "2026-09-27", marketOpen: false, account: { equity: 100_000, lastEquity: 100_000, cash: 90_000, status: "ACTIVE" }, positions: [{ symbol: "ETH/USD", qty: 10, avgEntryPrice: 100, currentPrice: 100, marketValue: 1_000 }], prices: { "BTC/USD": 100, "ETH/USD": 100 }, closes: {}, recentOrders: [], lessons: [], buyBlock: null };
    const c = applyCage({ ...base, proposals: [{ symbol: "BTC/USD", side: "buy", qty: 10, why: "prova", confidence: "alta", expect: "" }, { symbol: "ETH/USD", side: "sell", qty: 10, why: "prova", confidence: "alta", expect: "" }] } as any);
    expect(c.rejected.map((r) => [r.symbol, r.reason.slice(0, 23)])).toEqual([["BTC/USD", "acquisti crypto fermati"]]);
    expect(c.orders.map((o) => `${o.side} ${o.symbol}`)).toEqual(["sell ETH/USD"]);
  }));

  test("agente intraday: nessuna analisi d'ingresso sulle crypto, ma la crypto aperta si gestisce fino all'uscita", () => conCryptoFerme(async () => {
    setCryptoUniverse(["BTC/USD", "ETH/USD"]);
    const r = await agente().observe(vista(emptyJournal()));
    expect(r.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(r.intraday ?? []).toEqual([]);
    // ETH aperta con stop a 98: il prezzo a 97 la fa uscire anche con gli acquisti fermi.
    const j: JournalFile = { ...emptyJournal(), trade: [{ id: "e1", simbolo: "ETH/USD", stato: "aperto", apertoIl: new Date(now.getTime() - 2 * ORA).toISOString(), comprate: 10, costo: 1_000, vendute: 0, incassato: 0, quantita: 10, contesto: { agenti: ["intraday"], tipo: "intraday", livelli: { candela: "1Hour", obiettivo: 104, stop: 98, orizzonteMin: 600 } } } as any] };
    const u = await agente().observe(vista(j, [{ symbol: "ETH/USD", qty: 10, avgEntryPrice: 100, currentPrice: 97, marketValue: 970 }], 97));
    expect(u.segnali.find((x) => x.lato === "sell" && x.simbolo === "ETH/USD")?.perche).toContain("stop");
    expect(u.segnali.some((x) => x.lato === "buy")).toBe(false);
  }));
});
