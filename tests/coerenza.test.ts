import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEZIONE_MIN, review } from "../src/agents/capo.ts";
import { Cervello } from "../src/agents/cervello.ts";
import { explore, readEsplorazione, scoutVotes } from "../src/agents/esplorazione.ts";
import { IntradayAgent } from "../src/agents/intraday.ts";
import type { AgentReport, AgentView } from "../src/agents/types.ts";
import type { IntradayBar } from "../src/broker/types.ts";
import { syntheticCloses } from "../src/broker/fake.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

AGENTS.intraday.riporto.enabled = false;

const now = new Date("2026-09-27T21:00:00+02:00"); // domenica sera: solo crypto
const ORA = 3_600_000;
// Candele da 1 ora in salita con oscillazioni, che finiscono esattamente a `fine`.
function salita(fine: number, passo = ORA, n = 120): IntradayBar[] {
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
const passi: Record<string, number> = { "5Min": 300_000, "15Min": 900_000, "1Hour": ORA, "4Hour": 4 * ORA };
const fetch = async (syms: string[], tf: string) => Object.fromEntries(syms.map((x) => [x, salita(100, passi[tf])]));
const vista = (prezzo: number, extra: Partial<AgentView> = {}) => ({ today: "2026-09-27", now, prices: { "BTC/USD": prezzo }, closes: { "BTC/USD": syntheticCloses(100, 0.02, 260) }, indicators: {}, positions: [], account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" }, journal: emptyJournal(), mercatoAperto: false, ...extra }) as unknown as AgentView;
// Sulle 1 ora: tutti i percorsi salgono fino a +2% dalla chiusura dell'ultima candela; sulle altre fermi.
const sale = (h: number) => Array.from({ length: h }, (_, i) => Math.min(0.02, 0.005 * (i + 1)));
const kf = async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? { path: sale(h), campioni: Array.from({ length: 16 }, () => sale(h)) } : Array.from({ length: h }, () => 0)]));
const misurata = () => ({ fattore: 1, quota: 0.55, campione: 120, giusti: 0.56, resa: 0.002 });

describe("coerenza del motore dopo le correzioni", () => {
  test("1. la proiezione si riporta al prezzo di adesso: un rialzo già fatto non si conta due volte", async () => {
    setCryptoUniverse(["BTC/USD"]);
    // Prezzo uguale alla chiusura dell'ultima candela: Kronos vede +2% → si entra.
    const si = await new IntradayAgent(fetch, kf, misurata).observe(vista(100));
    expect(si.segnali.find((x) => x.lato === "buy")?.perche).toContain("su candele 1Hour");
    // Il prezzo è già salito dell'1,6% dalla chiusura: restano +0,4%, sotto il doppio dei costi (0,8%) → niente.
    const no = await new IntradayAgent(fetch, kf, misurata).observe(vista(101.6));
    expect(no.segnali.filter((x) => x.lato === "buy")).toEqual([]);
    expect(no.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toMatch(/1Hour a [^:]+ \+0\.[0-4]\d%/);
  });

  test("1. rientro con la stessa proiezione di un trade di oggi già chiuso: si aspetta la candela nuova", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const ultima = salita(100).at(-1)!.t;
    const chiuso = (previsione: string): JournalFile => ({ ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "chiuso", apertoIl: new Date(now.getTime() - 20 * 60_000).toISOString(), chiusoIl: new Date(now.getTime() - 5 * 60_000).toISOString(), comprate: 0.1, costo: 10, vendute: 0.1, incassato: 10.2, quantita: 0, risultato: 0.02, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], tipo: "intraday", livelli: { candela: "1Hour", obiettivo: 102, stop: 99, previsione } } } as any] });
    // Solo candele da 1 ora, così il motivo mostrato è quello della 1 ora.
    const solo1h = async (syms: string[], tf: string) => (tf === "1Hour" ? fetch(syms, tf) : {});
    const stessa = await new IntradayAgent(solo1h, kf, misurata).observe(vista(100, { journal: chiuso(`1Hour|${ultima}`) }));
    expect(stessa.segnali.filter((x) => x.lato === "buy" && x.perche.includes("candele 1Hour"))).toEqual([]);
    expect(stessa.intraday!.find((x) => x.simbolo === "BTC/USD")!.motivo).toContain("ha già fatto il suo trade");
    const nuova = await new IntradayAgent(solo1h, kf, misurata).observe(vista(100, { journal: chiuso("1Hour|2026-09-27T10:00:00.000Z") }));
    expect(nuova.segnali.some((x) => x.lato === "buy")).toBe(true);
    // L'ingresso salva la proiezione usata, per il prossimo rientro.
    expect(nuova.intraday!.find((x) => x.livelli)?.livelli?.previsione).toBe(`1Hour|${ultima}`);
  });

  test("2. la posizione si segue sulla candela più breve solo se lì Kronos ha un vantaggio misurato; le azioni sulla loro candela", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const journal: JournalFile = { ...emptyJournal(), trade: [{ id: "t1", simbolo: "BTC/USD", stato: "aperto", apertoIl: now.toISOString(), comprate: 0.1, costo: 10, vendute: 0, incassato: 0, quantita: 0.1, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], livelli: { candela: "1Hour", obiettivo: 102, stop: 99 } } } as any] };
    const pos = [{ symbol: "BTC/USD", qty: 0.1, avgEntryPrice: 100, currentPrice: 100, marketValue: 10 }];
    const segue = async (aff: (step: number) => ReturnType<typeof misurata>) => (await new IntradayAgent(fetch, kf, aff).observe(vista(100, { positions: pos, journal }))).intraday!.find((x) => x.fase === "in posizione")!.controllo!;
    // 15 minuti senza resa (come oggi): si segue sulle 1 ora, la candela dell'operazione.
    expect(await segue((step) => (step === 15 ? { fattore: 1, quota: 0.55, campione: 1085, giusti: 0.51, resa: -0.0006 } : misurata()))).toContain("candele 1Hour");
    // 15 minuti senza misure (meno di 40 previsioni): anche.
    expect(await segue((step) => (step === 15 ? { fattore: 1, quota: 0.55, campione: 10, giusti: 0.6, resa: 0.001 } : misurata()))).toContain("candele 1Hour");
    // 15 minuti con un vantaggio misurato: lì.
    expect(await segue(misurata)).toContain("candele 15Min");
  });

  test("3. probabilità dai percorsi avvicinata a 50% (prudenza): 12 percorsi su 16 con affidabilità ×1 → circa 62%, non 74%", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const meta = (h: number) => Array.from({ length: 16 }, (_, j) => Array.from({ length: h }, (_, i) => (j < 12 ? Math.min(0.02, 0.005 * (i + 1)) : -0.001 * (i + 1))));
    const kf12 = async (b: Record<string, IntradayBar[]>, step: number, h: number) => Object.fromEntries(Object.keys(b).map((x) => [x, step === 60 ? { path: sale(h), campioni: meta(h) } : Array.from({ length: h }, () => 0)]));
    const r = await new IntradayAgent(fetch, kf12, () => ({ fattore: 1, quota: 0.55, campione: 0 })).observe(vista(100));
    const testo = JSON.stringify(r.intraday);
    expect(testo).toMatch(/1Hour a [^→]+→ 6[12]% \(12 percorsi su 16/);
  });

  test("5. esplorazione intraday: entra chi si muove abbastanza e non ha Kronos contrario; niente voti di più giorni; non si lascia chi ha un voto intraday", async () => {
    const prima = AGENTS.puntaIntraday;
    AGENTS.puntaIntraday = true;
    const nervoso = (n = 260) => Array.from({ length: n }, (_, i) => 100 * (1 + (i % 2 ? 0.02 : -0.02)));
    const calmo = (n = 260) => Array.from({ length: n }, (_, i) => 100 * (1 + (i % 2 ? 0.002 : -0.002)));
    const bars = (c: number[]) => c.map((x, i) => ({ date: `d${i}`, open: x, high: x, low: x, close: x, volume: 1 }));
    const f = readEsplorazione("/nonexistent-dir", "2026-11-09");
    const presenti = [{ chiave: "p:Lorenzo", nome: "Lorenzo", perche: "aspetta", reparto: "intraday" as const }];
    const ordine: string[] = [];
    const r = await explore({
      now: new Date("2026-11-09T15:00:00Z"), today: "2026-11-09", file: f, presenti, universe: ["SPY"], cryptoFuori: [],
      getBars: async (syms) => { ordine.push(...syms); return Object.fromEntries(syms.map((s, i) => [s, bars(i === 0 ? calmo() : nervoso())])); },
      forecast: async (syms) => Object.fromEntries(syms.map((s) => [s, s === ordine[1] ? -0.03 : -0.005])),
    });
    const [primo, secondo, terzo] = r!.esaminati;
    expect(r!.scartati.find((x) => x.simbolo === primo)!.motivo).toContain("si muove troppo poco");
    expect(r!.scartati.find((x) => x.simbolo === secondo)!.motivo).toContain("calo netto");
    const nuova = r!.nuove.find((x) => x.simbolo === terzo)!;
    expect(nuova.agente).toBe("intraday");
    expect(nuova.motivo).toContain("per l'intraday");
    // Lo scopritore non resta alla scrivania: al giro dopo (un minuto) la stessa persona trova altri titoli.
    const r2 = await explore({ now: new Date("2026-11-09T15:02:00Z"), today: "2026-11-09", file: f, presenti, universe: ["SPY"], cryptoFuori: [], getBars: async (syms) => Object.fromEntries(syms.map((s) => [s, bars(nervoso())])), forecast: async (syms) => Object.fromEntries(syms.map((s) => [s, 0])) });
    expect(r2!.nuove.length).toBeGreaterThan(0);
    expect(r2!.nuove[0]!.scopritore).toBe("p:Lorenzo");
    // A ogni giro: nessun voto di più giorni; con Kronos −3% si lascia, salvo che gli intraday agents l'abbiano votata.
    const v = { today: "2026-11-09", now: new Date("2026-11-09T15:05:00Z"), prices: {}, closes: {}, positions: [], journal: emptyJournal(), previsioni: { [terzo!]: -0.03 } } as any;
    const reports: Record<string, AgentReport> = { intraday: { segnali: [{ agente: "intraday", simbolo: terzo!, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, perche: "prova" }] } };
    scoutVotes(f, v, reports);
    expect(f.scoperte.find((x) => x.simbolo === terzo)!.stato).toBe("attiva");
    expect(Object.values(reports).flatMap((x) => x.segnali).filter((x) => !x.intraday)).toEqual([]);
    scoutVotes(f, v, { intraday: { segnali: [] } });
    expect(f.scoperte.find((x) => x.simbolo === terzo)!.stato).toBe("svanita");
    AGENTS.puntaIntraday = prima;
  });

  test("6. capo: nessuna lezione sotto i 20 trade; per gli intraday conta la probabilità d'ingresso, non Kronos a 5 sedute", () => {
    const trade = (i: number, p: number, vince: boolean) => ({ id: `t${i}`, simbolo: "NVDA", stato: "chiuso", apertoIl: "2026-11-09T15:00:00Z", chiusoIl: "2026-11-09T15:30:00Z", comprate: 1, costo: 100, vendute: 1, incassato: vince ? 101 : 99, quantita: 0, risultato: vince ? 0.01 : -0.01, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], persone: ["p:Camilla"], tipo: "intraday", kronos: 0.05, misure: { probabilita: p }, livelli: { candela: "1Hour", obiettivo: 101, stop: 99 } } });
    const sei = { ...emptyJournal(), trade: [0, 1, 2, 3, 4, 5].map((i) => trade(i, 0.6, i % 2 === 0)) } as any;
    const r1 = review(sei, new Date("2026-11-09T20:00:00Z"));
    expect(r1.sogliaKronos).toBeNull();
    expect(r1.sogliaProbabilita).toBeNull();
    expect(r1.sintesi).not.toContain("Lezione");
    // 30 trade: i vinti sono quelli entrati con probabilità alta.
    const tanti = { ...emptyJournal(), trade: Array.from({ length: 30 }, (_, i) => trade(i, i % 2 === 0 ? 0.7 : 0.58, i % 2 === 0)) } as any;
    const r2 = review(tanti, new Date("2026-11-09T20:00:00Z"));
    expect(LEZIONE_MIN).toBe(20);
    expect(r2.sogliaKronos).toBeNull(); // Kronos a 5 sedute non giudica gli intraday
    expect(r2.sogliaProbabilita).toBeGreaterThan(0.58);
    expect(r2.sintesi).toContain("Lezione intraday");
    const cam = r2.valutazioni.find((x) => x.agente === "p:Camilla")!;
    expect(cam.kronosVinti).toBeNull();
    expect(cam.probVinti).toBeCloseTo(0.7);
  });

  test("7. cervello: le misure intraday contano anche per classe; sotto il minimo vale la candela intera", () => {
    const c = new Cervello(mkdtempSync(join(tmpdir(), "cerv-")));
    const t0 = new Date("2026-11-09T15:00:00Z");
    // 200 previsioni su 1 ora: le crypto sbagliano sempre, le azioni indovinano sempre.
    for (let i = 0; i < 200; i++) {
      const s = i % 2 ? `C${i}/USD` : `S${i}`;
      const fatta = new Date(t0.getTime() + i * 60_000), scade = new Date(fatta.getTime() + ORA);
      c.registra("intraday-60m", s, 100, fatta, scade, { kronos: 0.01 });
      c.valuta(new Date(scade.getTime() + 60_000), { [s]: s.includes("/") ? 99 : 101 });
    }
    const tutte = c.affidabilitaTipo("intraday-60m");
    expect(tutte.campione).toBe(200);
    expect(c.affidabilitaTipo("intraday-60m-crypto").campione).toBe(100);
    // 100 per classe, sotto minClasse (150): vale la candela intera.
    expect(c.affidabilitaPer("intraday-60m", "BTC/USD").campione).toBe(200);
    const prima = AGENTS.intraday.affidabilita.minClasse;
    AGENTS.intraday.affidabilita.minClasse = 50;
    expect(c.affidabilitaPer("intraday-60m", "BTC/USD").giusti).toBe(0);
    expect(c.affidabilitaPer("intraday-60m", "NVDA").giusti).toBe(1);
    AGENTS.intraday.affidabilita.minClasse = prima;
  });
});
