import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/agents/bus.ts";
import { emptyCache, runTick, type EngineDeps } from "../src/agents/engine.ts";
import { IntradayAgent, promuovibile } from "../src/agents/intraday.ts";
import type { AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";
import { makeEnv } from "./helpers.ts";

// Questi test provano anche il metodo di più giorni e la promozione: il motore che punta all'intraday (e il riporto al
// giorno dopo) ha i suoi test, che lo riaccendono.
AGENTS.puntaIntraday = false;
AGENTS.intraday.riporto.enabled = false;

// Candele da 5 minuti di BTC in salita con oscillazioni (EMA 9 sopra EMA 20, prezzo sopra la 9), che finiscono a `fine`.
function salitaA5Minuti(fine: number, finoA: Date, n = 120): IntradayBar[] {
  const end = Math.floor(finoA.getTime() / 300_000) * 300_000;
  const out: IntradayBar[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const c = fine * (1 - 0.0015 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
    const o = i ? out[i - 1]!.close : c;
    out.push({ t: new Date(end - (k + 1) * 300_000).toISOString(), open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 1_000 });
  }
  // L'ultima chiusura è esattamente `fine` (il prezzo di adesso nei test): le proiezioni di Kronos partono da lì.
  const k = fine / out[out.length - 1]!.close;
  return out.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
}

describe("intraday nel motore vero: candele da 5 minuti, Kronos, ordini", () => {
  test("Kronos vede +1,5% in 15 minuti su BTC: il motore compra su candele da 5 minuti e incassa all'obiettivo di Kronos pochi minuti dopo", async () => {
    // Questo test prova le uscite di prima (all'obiettivo si esce subito): «lascia correre» ha i suoi test.
    AGENTS.intraday.lasciaCorrere.enabled = false;
    setCryptoUniverse(["BTC/USD"]);
    const start = new Date("2026-09-27T21:00:00+02:00"); // domenica sera: solo crypto
    const env = makeEnv(start);
    env.setFake((s) => {
      s.prices["BTC/USD"] = 76_000;
      s.intraday = { "BTC/USD": { "5Min": salitaA5Minuti(76_000, start) } };
    });
    const chiesti: number[] = [];
    // Kronos sulle candele da 5 minuti: +1,5% già alla terza candela (15 minuti) e poi fermo; sulle altre candele niente.
    const kronos = async (b: Record<string, IntradayBar[]>, step: number, h: number) => {
      chiesti.push(step);
      return Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? Array.from({ length: h }, (_, i) => Math.min(0.015, 0.005 * (i + 1))) : Array.from({ length: h }, () => 0)]));
    };
    const intraday = new IntradayAgent((s, tf, n) => env.broker.getIntradayBars(s, tf, n), kronos);
    const d = env.deps();
    const deps: EngineDeps = { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [intraday], bus: new EventBus(d.stateDir, d.now), echo: false };
    const cache = emptyCache();

    const r1 = await runTick(deps, cache);
    const acquisto = r1.status_file!.ordini.find((o) => o.simbolo === "BTC/USD" && o.lato === "buy");
    expect(acquisto?.esito).toStartWith("inviato");
    expect(acquisto!.perche).toContain("intraday su candele 5Min");
    expect(acquisto!.perche).toContain("da Kronos in 15 min");
    expect(chiesti).toContain(5);
    const st = r1.status_file!.intraday.find((x) => x.simbolo === "BTC/USD")!;
    expect(st.orizzonte).toBe("15 min");
    const entrata = env.broker.load().positions["BTC/USD"]!.avgEntryPrice;
    // I livelli decisi all'ingresso sono nel diario con il trade: dopo un riavvio l'operazione riparte con gli stessi.
    const { readJournal } = await import("../src/journal.ts");
    const lv = readJournal(d.stateDir, new Date(env.clock.t)).file.trade.find((t) => t.simbolo === "BTC/USD" && t.stato === "aperto")?.contesto?.livelli;
    expect(lv?.candela).toBe("5Min");
    expect(lv!.obiettivo).toBeGreaterThan(lv!.stop);
    expect(st.obiettivo! / entrata - 1).toBeCloseTo(0.015, 2); // ingresso con ordine limite appena sotto il prezzo

    // Cinque minuti dopo (giro senza analisi d'ingresso): il prezzo è all'obiettivo, Kronos sulla candela breve non vede altro.
    env.clock.t += 5 * 60_000;
    env.setFake((s) => (s.prices["BTC/USD"] = entrata * 1.016));
    const r2 = await runTick(deps, cache);
    expect(r2.status_file!.analisi!.questoGiro).toBe(AGENTS.analisiMinuti <= 5); // con l'analisi ogni 5 minuti, ogni giro ne ha una
    const vendita = r2.status_file!.ordini.find((o) => o.simbolo === "BTC/USD" && o.lato === "sell");
    expect(vendita?.esito).toStartWith("inviato");
    expect(vendita!.perche).toContain("obiettivo raggiunto");
    expect(env.broker.load().positions["BTC/USD"]).toBeUndefined();
    // Il conto di oggi registra l'operazione chiusa in pochi minuti, in guadagno.
    const pnl = r2.status_file!.pnlOggi;
    expect(pnl.vendite.find((x) => x.simbolo === "BTC/USD")!.pnl).toBeGreaterThan(0);
    AGENTS.intraday.lasciaCorrere.enabled = true;
  });

  test("trend che continua: a fine finestra l'operazione in guadagno non si chiude, passa alle regole di più giorni", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const aperta = new Date("2026-09-27T08:00:00Z");
    const now = new Date(aperta.getTime() + AGENTS.intraday.cryptoOreMax * 3_600_000 + 60_000); // oltre la durata massima
    const prezzo = 76_600; // +0,8%: in guadagno ma sotto l'obiettivo, ancora in corsa
    const bars = salitaA5Minuti(prezzo, now);
    const journal: JournalFile = { ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: aperta.toISOString(), comprate: 0.1, costo: 7_600, vendute: 0, incassato: 0, quantita: 0.1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"] } } as any] };
    const view = (previsioni: Record<string, number>) => ({ today: "2026-09-27", now, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(prezzo, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 76_000, currentPrice: prezzo, marketValue: 7_660 }], account: { equity: 100_000, lastEquity: 100_000, cash: 92_000, status: "ACTIVE" }, journal, previsioni, mercatoAperto: false, analisi: false }) as unknown as AgentView;
    const agente = () => new IntradayAgent(async (syms) => Object.fromEntries(syms.map((s) => [s, bars])), async (b, _s, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, () => 0.002)])));
    // Kronos a 5 sedute +3% con trend in corso: promossa, nessuna vendita, da ora la seguono le regole di più giorni.
    expect(promuovibile(view({ "BTC/USD": 0.03 }), "BTC/USD", 0.008).ok).toBe(true);
    const r = await agente().observe(view({ "BTC/USD": 0.03 }));
    expect(r.segnali.filter((x) => x.lato === "sell").map((x) => x.perche)).toEqual([]);
    expect(r.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("promossa a posizione di più giorni");
    expect(journal.trade[0]!.contesto!.promossa).toBeDefined();
    // Senza un rialzo che copra i costi a 5 sedute la stessa operazione si chiude alla durata massima.
    journal.trade[0]!.contesto!.promossa = undefined;
    const r2 = await agente().observe(view({ "BTC/USD": 0.002 }));
    expect(r2.segnali.find((x) => x.lato === "sell")!.perche).toContain("durata massima");
  });

  test("medie brevi non ancora in ordine: decide Kronos da solo, con probabilità più alta e taglia dal rischio", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    // Candele in leggera discesa con oscillazioni: EMA 9 sotto EMA 20, nessuna rottura né rientro.
    const end = Math.floor(now.getTime() / 300_000) * 300_000;
    const bars: IntradayBar[] = Array.from({ length: 120 }, (_, i) => {
      const k = 119 - i;
      const c = 76_000 * (1 + 0.0008 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
      return { t: new Date(end - (k + 1) * 300_000).toISOString(), open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1_000 };
    });
    const prezzo = bars.at(-1)!.close;
    const v = { today: "2026-09-27", now, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(prezzo, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false } as unknown as AgentView;
    const con = (rialzo: number) => new IntradayAgent(async (syms, tf) => Object.fromEntries(syms.map((x) => [x, tf === "5Min" ? bars : []])), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, (_, i) => (step === 5 ? Math.min(rialzo, (rialzo / 3) * (i + 1)) : 0))])));
    const forte = await con(0.015).observe(v);
    const buy = forte.segnali.find((x) => x.lato === "buy")!;
    expect(buy.perche).toContain("Kronos anticipa la ripartenza sulle candele 5Min");
    // Le medie brevi non in ordine alzano la soglia (minProbSenzaGrafico) ma non dimezzano più la taglia: decide il rischio,
    // con il pavimento.
    expect(buy.perche).toContain("medie brevi delle candele 5Min non ancora in ordine");
    expect(buy.pesoMassimo!).toBeLessThanOrEqual(AGENTS.intraday.maxWeight + 1e-9);
    // Dal rischio allo stop: con lo stop delle crypto all'1% almeno il pavimento di 0,25% / 1,6% (≈ 15,6%).
    expect(buy.pesoMassimo!).toBeGreaterThanOrEqual(Math.min(AGENTS.intraday.budget.quota * AGENTS.intraday.budget.maxQuotaTrade, AGENTS.intraday.budget.rischioTrade / (0.01 + 0.004 + AGENTS.intraday.budget.scivolamento)) * AGENTS.intraday.taglia.pavimento - 1e-9);
    const debole = await con(0.006).observe(v); // +0,6%: non copre 2 volte i costi crypto (0,8%)
    expect(debole.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(debole.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("non basta");
  });

  test("rimbalzo dopo un calo netto sotto la media a 50: si decide sulle candele con probabilità ≥ 57% invece di minProbSenzaGrafico", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    const end = Math.floor(now.getTime() / 300_000) * 300_000;
    const bars: IntradayBar[] = Array.from({ length: 120 }, (_, i) => {
      const k = 119 - i;
      const c = 76_000 * (1 + 0.0008 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
      return { t: new Date(end - (k + 1) * 300_000).toISOString(), open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1_000 };
    });
    const prezzo = bars.at(-1)!.close;
    // Chiusure giornaliere: oscillano intorno a un livello più alto, poi due settimane di discesa e -7% nell'ultimo giorno.
    const giorni = Array.from({ length: 245 }, (_, i) => 1 + 0.01 * Math.sin(i / 3));
    for (let i = 1; i <= 14; i++) giorni.push(1 - 0.006 * i);
    giorni.push(giorni.at(-1)! * 0.93);
    const calo = giorni.map((x) => (x * prezzo) / giorni.at(-1)!);
    const vista = (closes: number[]) => ({ today: "2026-09-27", now, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": closes }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false }) as unknown as AgentView;
    const agente = () => new IntradayAgent(async (syms, tf) => Object.fromEntries(syms.map((x) => [x, tf === "5Min" ? bars : []])), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, (_, i) => (step === 5 ? Math.min(0.015, 0.005 * (i + 1)) : 0))])));
    const prima = AGENTS.intraday.kronos.minProbSenzaGrafico;
    AGENTS.intraday.kronos.minProbSenzaGrafico = 0.99; // senza rimbalzo servirebbe il 99%
    try {
      const senza = await agente().observe(vista(syntheticCloses(prezzo, 0.02, 260)));
      expect(senza.segnali.filter((x) => x.lato === "buy")).toEqual([]);
      const con = await agente().observe(vista(calo));
      const buy = con.segnali.find((x) => x.lato === "buy")!;
      expect(buy.perche).toContain("rimbalzo dopo un calo del -7.00%");
      expect(buy.perche).toContain("candele 5Min");
      expect(buy.misure?.rimbalzo).toBeCloseTo(-0.07, 6);
    } finally { AGENTS.intraday.kronos.minProbSenzaGrafico = prima; }
  });

  test("ingresso deciso da Kronos sotto la media a 20: al giro dopo non si esce per «due candele sotto la media» (la ragione per cui è entrato)", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    const end = Math.floor(now.getTime() / 300_000) * 300_000;
    const bars: IntradayBar[] = Array.from({ length: 120 }, (_, i) => {
      const k = 119 - i;
      const c = 76_000 * (1 + 0.0008 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
      return { t: new Date(end - (k + 1) * 300_000).toISOString(), open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1_000 };
    });
    const prezzo = bars.at(-1)!.close;
    const base = { today: "2026-09-27", prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(prezzo, 0.02, 260) }, indicators: {}, account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, mercatoAperto: false };
    const agente = new IntradayAgent(async (syms, tf) => Object.fromEntries(syms.map((x) => [x, tf === "5Min" ? bars : []])), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, (_, i) => (step === 5 ? Math.min(0.015, 0.005 * (i + 1)) : 0))])));
    const r1 = await agente.observe({ ...base, now, positions: [], journal: emptyJournal() } as unknown as AgentView);
    expect(r1.segnali.find((x) => x.lato === "buy")!.perche).toContain("Kronos anticipa la ripartenza");
    const journal: JournalFile = { ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: now.toISOString(), comprate: 0.1, costo: prezzo * 0.1, vendute: 0, incassato: 0, quantita: 0.1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"] } } as any] };
    const r2 = await agente.observe({ ...base, now: new Date(now.getTime() + 5 * 60_000), positions: [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: prezzo, currentPrice: prezzo, marketValue: prezzo * 0.1 }], journal, analisi: false } as unknown as AgentView);
    expect(r2.segnali.filter((x) => x.lato === "sell")).toEqual([]);
    expect(r2.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("in corsa");
  });

  test("scelta della candela: conta la probabilità netta dei costi, pesata dall'affidabilità misurata di Kronos su quella candela; candele discordi = niente ingresso", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    const bars = salitaA5Minuti(76_000, now);
    const v = { today: "2026-09-27", now, prices: { "BTC/USD": 76_000 }, closes: { "BTC/USD": syntheticCloses(76_000, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false } as unknown as AgentView;
    const rialzo = (step: number, h: number) => Array.from({ length: h }, (_, i) => (step === 5 ? Math.min(0.015, 0.005 * (i + 1)) : step === 60 ? Math.min(0.03, 0.006 * (i + 1)) : 0));
    const fetch = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, bars]));
    // Affidabilità come attesa su tutte le candele: entra.
    const ok = await new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, rialzo(step, h)])), () => ({ fattore: 1, quota: 0.55, campione: 0 })).observe(v);
    expect(ok.segnali.some((x) => x.lato === "buy")).toBe(true);
    // Kronos sulle 5 minuti indovina come una moneta (fattore 0): quella candela non fa più entrare, si sceglie la 1 ora.
    const solo1h = await new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, rialzo(step, h)])), (step) => (step === 5 ? { fattore: 0, quota: 0.5, campione: 400, giusti: 0.48 } : { fattore: 1, quota: 0.55, campione: 0 })).observe(v);
    const b1 = solo1h.segnali.find((x) => x.lato === "buy");
    expect(b1?.perche).toContain("candele 1Hour");
    expect(b1!.perche).toContain("5Min a 15 min +1.50% → 50%");
    // Sulle 15 minuti Kronos vede un calo nella stessa ora: discorde, nessun ingresso.
    const discorde = await new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 15 ? Array.from({ length: h }, () => -0.006) : step === 5 ? rialzo(5, h) : Array.from({ length: h }, () => 0)])), () => ({ fattore: 1, quota: 0.55, campione: 0 })).observe(v);
    expect(discorde.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(discorde.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("Kronos discorde tra le candele");
  });

  test("Triple Screen: candele da 5 minuti al rialzo ma 1 ora al ribasso = niente ingresso; 1 ora al rialzo = trade di trend con stop e obiettivo delle ore", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    const bars = salitaA5Minuti(76_000, now);
    const v = { today: "2026-09-27", now, prices: { "BTC/USD": 76_000 }, closes: { "BTC/USD": syntheticCloses(76_000, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false } as unknown as AgentView;
    const fetch = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, bars]));
    const breve = (h: number) => Array.from({ length: h }, (_, i) => Math.min(0.015, 0.005 * (i + 1)));
    const agente = (ora: (h: number) => number[]) => new IntradayAgent(fetch, async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? breve(h) : step === 60 ? ora(h) : Array.from({ length: h }, () => 0)])));
    // 1 ora: dopo un primo rialzo (che non contraddice i 5 minuti) Kronos vede un calo del 2% a fine orizzonte.
    const contro = await agente((h) => Array.from({ length: h }, (_, i) => (i < 1 ? 0.004 : -0.02))).observe(v);
    expect(contro.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(contro.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("controcorrente");
    // 1 ora: rialzo che continua fino a +1,8% in 8 ore (meno netto dei 5 minuti, che restano la candela d'ingresso): trade di trend.
    const breveSolo = await agente((h) => Array.from({ length: h }, () => 0)).observe(v);
    const pesoBreve = breveSolo.segnali.find((x) => x.lato === "buy")!.pesoMassimo!;
    const conTrend = await agente((h) => Array.from({ length: h }, (_, i) => Math.min(0.018, 0.00225 * (i + 1)))).observe(v);
    const buy = conTrend.segnali.find((x) => x.lato === "buy")!;
    expect(buy.perche).toContain("trade di trend: le candele 1Hour vedono");
    expect(buy.pesoMassimo!).toBeLessThanOrEqual(pesoBreve + 1e-12);
    const st = conTrend.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(st.obiettivo! / 76_000 - 1).toBeCloseTo(0.018, 4);
  });

  test("trade di trend aperto: un calo previsto sulle candele da 1 minuto e l'orizzonte breve scaduto non lo chiudono finché le ore sono a favore; quando le ore girano, si chiude", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const t0 = new Date("2026-09-27T21:00:00+02:00");
    const bars = salitaA5Minuti(76_000, t0);
    let ora = (h: number) => Array.from({ length: h }, (_, i) => Math.min(0.018, 0.00225 * (i + 1)));
    const agente = new IntradayAgent(async (syms) => Object.fromEntries(syms.map((x) => [x, bars])), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? Array.from({ length: h }, (_, i) => Math.min(0.015, 0.005 * (i + 1))) : step === 60 ? ora(h) : step === 1 ? Array.from({ length: h }, () => -0.004) : Array.from({ length: h }, () => 0)])), () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.001 }));
    // Kronos misurato anche sulla candela da 1 minuto: lì si segue la posizione (controllo).
    const base = { today: "2026-09-27", closes: { "BTC/USD": syntheticCloses(76_000, 0.02, 260) }, indicators: {}, account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, mercatoAperto: false };
    const r1 = await agente.observe({ ...base, now: t0, prices: { "BTC/USD": 76_000 }, positions: [], journal: emptyJournal() } as unknown as AgentView);
    expect(r1.segnali.find((x) => x.lato === "buy")!.perche).toContain("trade di trend");
    const journal: JournalFile = { ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: t0.toISOString(), comprate: 0.1, costo: 7_600, vendute: 0, incassato: 0, quantita: 0.1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"] } } as any] };
    // 40 minuti dopo (orizzonte breve di 15 minuti × 1,5 scaduto), prezzo -0,3%, la candela da 1 minuto vede ancora un calo.
    const dopo = (min: number, prezzo: number) => ({ ...base, now: new Date(t0.getTime() + min * 60_000), prices: { "BTC/USD": prezzo }, positions: [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 76_000, currentPrice: prezzo, marketValue: prezzo * 0.1 }], journal, analisi: false }) as unknown as AgentView;
    const r2 = await agente.observe(dopo(40, 75_770));
    expect(r2.segnali.filter((x) => x.lato === "sell")).toEqual([]);
    expect(r2.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("trade di trend sostenuto dalle candele 1Hour");
    // Le ore girano al ribasso: torna alle regole della candela breve e l'orizzonte scaduto la chiude.
    ora = (h: number) => Array.from({ length: h }, () => -0.02);
    bars.push({ ...bars.at(-1)!, t: new Date(Date.parse(bars.at(-1)!.t) + 300_000).toISOString() }); // candela nuova: Kronos si ricalcola
    const r3 = await agente.observe(dopo(45, 75_770));
    expect(r3.segnali.find((x) => x.lato === "sell")?.perche).toMatch(/orizzonte di Kronos scaduto|taglio della perdita/);
  });

  test("dopo un riavvio l'operazione intraday riparte con candela e livelli salvati nel diario, non ricalcolati", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    const bars = salitaA5Minuti(76_000, now);
    const journal: JournalFile = { ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: new Date(now.getTime() - 20 * 60_000).toISOString(), comprate: 0.1, costo: 7_600, vendute: 0, incassato: 0, quantita: 0.1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], livelli: { candela: "15Min", obiettivo: 77_500, stop: 74_000, orizzonteMin: 240, sopraMedia: false } } } as any] };
    const v = { today: "2026-09-27", now, prices: { "BTC/USD": 75_000 }, closes: { "BTC/USD": syntheticCloses(76_000, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 76_000, currentPrice: 75_000, marketValue: 7_500 }], account: { equity: 100_000, lastEquity: 100_000, cash: 92_000, status: "ACTIVE" }, journal, mercatoAperto: false, analisi: false } as unknown as AgentView;
    const r = await new IntradayAgent(async (syms) => Object.fromEntries(syms.map((x) => [x, bars])), null).observe(v);
    const st = r.intraday!.find((x) => x.simbolo === "BTC/USD")!;
    expect(st.candela).toBe("15Min");
    expect(st.stop).toBe(74_000);
    expect(st.obiettivo).toBe(77_500);
    expect(r.segnali.filter((x) => x.lato === "sell")).toEqual([]);
  });

  test("un acquisto eseguito entra nel diario prima delle decisioni del giro dopo: l'operazione intraday non viene venduta dalle regole di più giorni", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const start = new Date("2026-09-27T21:00:00+02:00");
    const env = makeEnv(start);
    env.setFake((s) => { s.prices["BTC/USD"] = 76_000; s.intraday = { "BTC/USD": { "5Min": salitaA5Minuti(76_000, start) } }; });
    const kronos = async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 5 ? Array.from({ length: h }, (_, i) => Math.min(0.015, 0.005 * (i + 1))) : Array.from({ length: h }, () => 0)]));
    const intraday = new IntradayAgent((s, tf, n) => env.broker.getIntradayBars(s, tf, n), kronos);
    const { ExitAgent } = await import("../src/agents/exits.ts");
    const d = env.deps();
    // Kronos a 5 sedute netto al ribasso: per una posizione di più giorni l'agente uscite venderebbe subito.
    const forecaster = async (symbols: string[]) => Object.fromEntries(symbols.map((x) => [x, { rendimentoPrevisto: -0.03, percorso: [-0.01, -0.02, -0.03], ultimaChiusura: null }]));
    const deps: EngineDeps = { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [intraday, new ExitAgent(AGENTS.exit)], bus: new EventBus(d.stateDir, d.now), echo: false, forecaster };
    const cache = emptyCache();
    const r1 = await runTick(deps, cache);
    expect(r1.status_file!.ordini.find((o) => o.simbolo === "BTC/USD" && o.lato === "buy")?.esito).toStartWith("inviato");
    // Come su Alpaca: l'ordine si esegue qualche secondo dopo la fine del giro, quindi il diario non ha ancora il trade.
    const { readJournal, writeJournal } = await import("../src/journal.ts");
    const j = readJournal(d.stateDir, new Date(env.clock.t)).file;
    j.trade = j.trade.filter((t) => t.simbolo !== "BTC/USD"); j.ordiniVisti = [];
    writeJournal(d.stateDir, j);
    env.clock.t += 5 * 60_000;
    const r2 = await runTick(deps, cache);
    expect(r2.status_file!.ordini.filter((o) => o.simbolo === "BTC/USD" && o.lato === "sell")).toEqual([]);
    expect(env.broker.load().positions["BTC/USD"]).toBeDefined();
  });

  test("obiettivo 51% di vittorie: se sulle candele da 5 minuti si vince meno, per entrare lì serve più probabilità (le altre candele restano aperte)", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const now = new Date("2026-09-27T21:00:00+02:00");
    const bars = salitaA5Minuti(76_000, now);
    const chiuso = (i: number, vinto: boolean) => ({ id: `t${i}`, simbolo: "ETH/USD", stato: "chiuso", apertoIl: "2026-09-27T10:00:00Z", chiusoIl: new Date(Date.parse("2026-09-27T10:00:00Z") + i * 60_000).toISOString(), comprate: 1, costo: 100, vendute: 1, incassato: vinto ? 101 : 99, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], livelli: { candela: "5Min", obiettivo: 1, stop: 1 } } }) as any;
    const prova = async (n: number, vinti: number) => {
      const journal: JournalFile = { ...emptyJournal(), trade: Array.from({ length: n }, (_, i) => chiuso(i, i < vinti)) };
      const v = { today: "2026-09-27", now, prices: { "BTC/USD": 76_000 }, closes: { "BTC/USD": syntheticCloses(76_000, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal, mercatoAperto: false } as unknown as AgentView;
      return (await new IntradayAgent(async (syms) => Object.fromEntries(syms.map((x) => [x, bars])), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, (_, i) => (step === 5 ? Math.min(0.015, 0.005 * (i + 1)) : 0))]))).observe(v)).note ?? [];
    };
    expect((await prova(20, 6)).some((n) => n.includes("candele 5Min: 6 vinti su 20 (30%)") && n.includes("+10 punti"))).toBe(true);
    // Con meno di 20 trade chiusi sulla candela il caso pesa troppo: la soglia non si alza (prima bastavano 4 vinti su 9).
    expect((await prova(10, 3)).some((n) => n.includes("candele 5Min:") && n.includes("punti"))).toBe(false);
  });
});

describe("il motore punta all'intraday: più giorni solo per riporto, deciso sulle candele", () => {
  test("a fine finestra l'operazione si riporta al giorno dopo se Kronos sulle candele resta dentro la forchetta; altrimenti si chiude", async () => {
    AGENTS.intraday.riporto.enabled = true;
    try {
      setCryptoUniverse(["BTC/USD"]);
      const aperta = new Date("2026-09-27T08:00:00Z");
      const now = new Date(aperta.getTime() + AGENTS.intraday.cryptoOreMax * 3_600_000 + 60_000); // oltre la durata massima
      const prezzo = 76_600;
      const bars = salitaA5Minuti(prezzo, now);
      const nuovo = (): JournalFile => ({ ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: aperta.toISOString(), comprate: 0.1, costo: 7_600, vendute: 0, incassato: 0, quantita: 0.1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], livelli: { candela: "5Min", obiettivo: 77_500, stop: 75_500, orizzonteMin: 60 } } } as any] });
      const view = (journal: JournalFile, quando = now) => ({ today: "2026-09-27", now: quando, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(prezzo, 0.02, 260) }, indicators: {}, positions: [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 76_000, currentPrice: prezzo, marketValue: 7_660 }], account: { equity: 100_000, lastEquity: 100_000, cash: 92_000, status: "ACTIVE" }, journal, previsioni: { "BTC/USD": -0.05 }, mercatoAperto: false, analisi: false }) as unknown as AgentView;
      const agente = (path: (h: number) => number[]) => new IntradayAgent(async (syms) => Object.fromEntries(syms.map((s) => [s, bars])), async (b, _s, h) => Object.fromEntries(Object.keys(b).map((x) => [x, path(h)])));
      // Kronos sulle candele vede salire piano senza mai scendere: riportata, anche se il Kronos a 5 sedute è negativo.
      const j = nuovo();
      const a = agente((h) => Array.from({ length: h }, (_, i) => 0.003 * (i + 1)));
      const r = await a.observe(view(j));
      expect(r.segnali.filter((x) => x.lato === "sell")).toEqual([]);
      expect(r.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("riportata al giorno dopo");
      expect(j.trade[0]!.contesto!.livelli!.riporti).toBe(1);
      expect(j.trade[0]!.contesto!.promossa).toBeUndefined();
      // Un'ora dopo la nuova finestra è aperta: niente «durata massima», decidono le candele.
      const r1 = await a.observe(view(j, new Date(now.getTime() + 3_600_000)));
      expect(r1.segnali.filter((x) => x.lato === "sell" && /durata massima/.test(x.perche))).toEqual([]);
      // Kronos vede un calo che arriverebbe allo stop: si chiude alla durata massima.
      const j2 = nuovo();
      const r2 = await agente((h) => Array.from({ length: h }, (_, i) => -0.004 * (i + 1))).observe(view(j2));
      expect(r2.segnali.find((x) => x.lato === "sell")!.perche).toContain("arriverebbe allo stop");
    } finally { AGENTS.intraday.riporto.enabled = false; }
  });
});

describe("ingressi intraday: candele senza vantaggio, dossier e contesto, rientri dopo un guadagno", () => {
  const scenario = () => {
    const now = new Date("2026-09-27T21:00:00+02:00");
    const end = Math.floor(now.getTime() / 300_000) * 300_000;
    const bars: IntradayBar[] = Array.from({ length: 120 }, (_, i) => {
      const k = 119 - i;
      const c = 76_000 * (1 + 0.0008 * k) * (1 + (k % 2 === 0 ? 0.003 : -0.003));
      return { t: new Date(end - (k + 1) * 300_000).toISOString(), open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1_000 };
    });
    const prezzo = bars.at(-1)!.close;
    const vista = (extra: Record<string, unknown> = {}) => ({ today: "2026-09-27", now, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(prezzo, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false, ...extra }) as unknown as AgentView;
    const agente = (aff?: (step: number) => { fattore: number; quota: number; campione: number; giusti?: number }) => new IntradayAgent(async (syms, tf) => Object.fromEntries(syms.map((x) => [x, tf === "5Min" ? bars : []])), async (b, step, h) => Object.fromEntries(Object.keys(b).map((x) => [x, Array.from({ length: h }, (_, i) => (step === 5 ? Math.min(0.015, 0.005 * (i + 1)) : 0))])), aff ?? null);
    return { vista, agente, now };
  };
  test("una candela su cui Kronos non ha un vantaggio misurato non fa entrare (si continua a misurarla)", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const { vista, agente } = scenario();
    const r = await agente(() => ({ fattore: 0.05, quota: 0.5, campione: 1_400, giusti: 0.499 })).observe(vista());
    expect(r.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(r.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("senza vantaggio misurato");
  });
  test("dossier e contesto pesano una parte minima: al limite decidono loro", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const { vista, agente } = scenario();
    const prima = AGENTS.intraday.kronos.minProbSenzaGrafico;
    AGENTS.intraday.kronos.minProbSenzaGrafico = 0.75; // soglia alta: Kronos da solo (83%) ci sta, con un dossier pessimo no
    try {
      expect((await agente().observe(vista({ dossier: { "BTC/USD": 0.9 } }))).segnali.some((x) => x.lato === "buy")).toBe(true);
      const no = await agente().observe(vista({ dossier: { "BTC/USD": 0.05 } }));
      expect(no.segnali.some((x) => x.lato === "buy")).toBe(false);
    } finally { AGENTS.intraday.kronos.minProbSenzaGrafico = prima; }
  });
  test("dopo un'operazione chiusa in guadagno oggi si può rientrare; dopo una in perdita no", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const { vista, agente, now } = scenario();
    const diario = (risultato: number): JournalFile => ({ ...emptyJournal(), trade: [{ id: "x", simbolo: "BTC/USD", stato: "chiuso", apertoIl: new Date(now.getTime() - 3_600_000).toISOString(), chiusoIl: new Date(now.getTime() - 600_000).toISOString(), comprate: 0.1, costo: 7_600, vendute: 0.1, incassato: 7_600 + risultato, quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"] } } as any] });
    expect((await agente().observe(vista({ journal: diario(50) }))).segnali.some((x) => x.lato === "buy")).toBe(true);
    expect((await agente().observe(vista({ journal: diario(-50) }))).segnali.some((x) => x.lato === "buy")).toBe(false);
  });
});

