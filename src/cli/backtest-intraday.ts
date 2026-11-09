// Prova sullo storico del motore intraday, in due fasi.
//
// 1. raccolta (sul PC, dove ci sono Alpaca e Kronos): scarica le candele degli ultimi giorni e, per ogni candela chiusa
//    del periodo, chiede a Kronos la proiezione delle candele successive come la chiederebbe il motore in quel momento
//    (le ultime 400 candele, solo il modello Kronos, un sidecar suo su un'altra porta). Salva tutto in
//    state/backtest/dati.json.
//       bun src/cli/backtest-intraday.ts raccolta --giorni 3 --campioni 8
//
// 2. replay (ovunque, senza rete): rimette il vero IntradayAgent davanti alle candele e alle proiezioni salvate, giro
//    per giro ogni 5 minuti, con gli stessi criteri, ordini limite simulati, commissioni e uscite. Stampa quanti trade al
//    giorno, quanti vinti, il risultato, per candela, e perché la maggior parte delle volte non si entra. Le varianti si
//    provano con le opzioni (soglie, candele, affidabilità).
//       bun src/cli/backtest-intraday.ts replay --file state/backtest/dati.json [--minprob 0.55] [--senzagrafico 0.57] [--percorsi no]
//         [--margine 2] [--affidabilita misurata|neutra] [--candele 5Min,1Hour,4Hour] [--json out.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IntradayAgent, profondita, type PrevisioneIntraday } from "../agents/intraday.ts";
import type { AgentView } from "../agents/types.ts";
import type { Bar, IntradayBar } from "../broker/types.ts";
import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import type { JournalFile, Trade } from "../journal.ts";
import { romeTime } from "../slots.ts";

interface Raccolta {
  versione: 1;
  creata: string;
  dal: string;
  al: string;
  simboli: string[];
  candele: Record<string, string[]>; // simbolo -> timeframe usati
  barre: Record<string, Record<string, IntradayBar[]>>; // tf -> simbolo -> candele
  giornaliere: Record<string, Bar[]>;
  previsioni: Record<string, number[]>; // `${simbolo}|${tf}|${t ultima candela}` -> percorso
  // I singoli percorsi di Kronos (stessa chiave), per provare la probabilità e lo stop dai percorsi; assenti nelle
  // raccolte vecchie (lì vale la probabilità dalla media).
  percorsi?: Record<string, number[][]>;
  campioni: number;
  affidabilita?: Record<string, { n: number; giusti: number }>; // dal cervello del PC, al momento della raccolta
}

const tfMin = (tf: string) => (tf.endsWith("Min") ? Number(tf.replace("Min", "")) : Number(tf.replace("Hour", "")) * 60);
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

async function raccolta() {
  const { buildDeps, ROOT } = await import("../deps.ts");
  const { ensureKronos, intradayForecaster } = await import("../kronos-sidecar.ts");
  const { parseArgs } = await import("./args.ts");
  const giorni = Number(arg("giorni", "3"));
  const campioni = Number(arg("campioni", "8"));
  const porta = Number(arg("porta", "8766"));
  const deps = await buildDeps(parseArgs([]));
  const out = join(deps.stateDir, "backtest");
  mkdirSync(out, { recursive: true });
  const log = (m: string) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); try { writeFileSync(join(out, "raccolta.log"), l + "\n", { flag: "a" }); } catch {} };
  // Simboli: le crypto dell'universo di oggi (state/crypto-universe.json) e i titoli dell'universo fisso.
  let crypto: string[] = [];
  try { crypto = (JSON.parse(readFileSync(join(deps.stateDir, "crypto-universe.json"), "utf8")).coppie ?? JSON.parse(readFileSync(join(deps.stateDir, "crypto-universe.json"), "utf8")).pairs ?? []) as string[]; } catch {}
  if (!crypto.length) crypto = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD", "AVAX/USD", "LINK/USD", "LTC/USD", "DOT/USD"];
  crypto = crypto.slice(0, Number(arg("crypto", "12")));
  const azioni = (arg("azioni", AGENTS.universe.filter((s) => !isCrypto(s)).join(",")) ?? "").split(",").filter(Boolean);
  const tfCrypto = (arg("candele", "5Min,1Hour,4Hour") ?? "").split(",");
  // Candele da 5 minuti: una proiezione ogni `passo5` candele (con 3: ogni 15 minuti), per stare in tempi ragionevoli.
  const passo5 = Number(arg("passo5", "3"));
  const tfAzioni = AGENTS.intraday.candeleAzioni;
  // Solo Kronos, con un numero fisso di campioni, su un sidecar suo (quello del motore resta libero).
  AGENTS.kronos.modelli = ["kronos"];
  AGENTS.kronos.campioni.min = campioni;
  AGENTS.kronos.campioni.max = campioni;
  const link = await ensureKronos({ root: ROOT, log, port: porta });
  for (let i = 0; i < 120 && !link.ready; i++) await Bun.sleep(5_000);
  if (!link.ready) throw new Error(`Kronos non pronto: ${link.stato}`);
  const kf = intradayForecaster(link, "intraday");
  const al = new Date();
  const dal = new Date(al.getTime() - giorni * 86_400_000);
  const r: Raccolta = { versione: 1, creata: al.toISOString(), dal: dal.toISOString(), al: al.toISOString(), simboli: [...crypto, ...azioni], candele: {}, barre: {}, giornaliere: {}, previsioni: {}, campioni };
  try { const c = JSON.parse(readFileSync(join(deps.stateDir, "cervello.json"), "utf8")); r.affidabilita = Object.fromEntries(Object.entries<any>(c.stat ?? {}).filter(([k]) => k.endsWith("|kronos")).map(([k, v]) => [k.split("|")[0]!, { n: v.n, giusti: v.giusti }])); } catch {}
  for (const s of crypto) r.candele[s] = tfCrypto;
  for (const s of azioni) r.candele[s] = tfAzioni;
  // Candele: il periodo più le 400 che servono a Kronos prima della prima decisione (e il 5 minuti per i prezzi).
  const tfs = [...new Set([...tfCrypto, ...tfAzioni, "5Min"])];
  for (const tf of tfs) {
    const syms = r.simboli.filter((s) => r.candele[s]!.includes(tf) || tf === "5Min");
    const n = Math.ceil((giorni * 1440) / tfMin(tf)) + AGENTS.kronos.lookback + 30;
    r.barre[tf] = await deps.broker.getIntradayBars(syms, tf, n);
    log(`candele ${tf}: ${Object.entries(r.barre[tf]!).map(([s, b]) => `${s} ${b.length}`).join(", ")}`);
  }
  r.giornaliere = await deps.broker.getDailyBars(r.simboli, 400);
  const salva = () => writeFileSync(join(out, "dati.json"), JSON.stringify(r));
  // Le proiezioni: per ogni candela chiusa nel periodo, tutte le serie di quella candela insieme (come nel motore).
  for (const tf of tfCrypto.concat(tfAzioni.filter((x) => !tfCrypto.includes(x)))) {
    const syms = r.simboli.filter((s) => r.candele[s]!.includes(tf));
    const tempi = [...new Set(syms.flatMap((s) => (r.barre[tf]![s] ?? []).filter((b) => Date.parse(b.t) >= dal.getTime()).map((b) => b.t)))].sort().filter((t) => tf !== "5Min" || Math.round(Date.parse(t) / 300_000) % passo5 === 0);
    log(`proiezioni ${tf}: ${tempi.length} candele × ${syms.length} titoli`);
    let fatte = 0;
    for (const t of tempi) {
      const serie: Record<string, IntradayBar[]> = {};
      for (const s of syms) {
        const b = r.barre[tf]![s] ?? [];
        const i = b.findIndex((x) => x.t === t);
        if (i >= 60) serie[s] = b.slice(Math.max(0, i + 1 - AGENTS.kronos.lookback), i + 1);
      }
      if (!Object.keys(serie).length) continue;
      try {
        const f = await kf(serie, tfMin(tf), profondita(tf));
        for (const [s, p] of Object.entries(f)) {
          r.previsioni[`${s}|${tf}|${t}`] = p.percorso.length ? p.percorso : [p.rendimentoPrevisto];
          if (p.campioni?.length) (r.percorsi ??= {})[`${s}|${tf}|${t}`] = p.campioni.map((x) => x.map((y) => Math.round(y * 1e5) / 1e5));
        }
      } catch (e) { log(`proiezione ${tf} ${t}: ${(e as Error).message}`); }
      if (++fatte % 20 === 0) { log(`  ${tf}: ${fatte}/${tempi.length}`); salva(); }
      if (existsSync(join(out, "stop"))) { log("fermata a richiesta"); salva(); link.stop(); process.exit(0); }
    }
    salva();
  }
  salva();
  link.stop();
  log(`raccolta finita: ${Object.keys(r.previsioni).length} proiezioni in ${join(out, "dati.json")}`);
}

// ---------- replay ----------
function replay() {
  const file = arg("file", "state/backtest/dati.json")!;
  const r = JSON.parse(readFileSync(file, "utf8")) as Raccolta;
  const c = AGENTS.intraday;
  if (arg("minprob")) c.kronos.minProb = Number(arg("minprob"));
  if (arg("senzagrafico")) c.kronos.minProbSenzaGrafico = Number(arg("senzagrafico"));
  if (arg("margine")) AGENTS.costi.margineCosti = Number(arg("margine"));
  if (arg("evidenza")) c.evidenza.peso = Number(arg("evidenza"));
  const soloCandele = arg("candele")?.split(",");
  const affMode = arg("affidabilita", "misurata");
  AGENTS.puntaIntraday = true;
  AGENTS.universe = [...r.simboli];
  // Affidabilità delle candele: quella misurata dal cervello del PC al momento della raccolta, o neutra (Kronos creduto).
  const aff = (step: number) => {
    if (affMode === "neutra") return { fattore: 1, quota: c.affidabilita.prior, campione: 0 };
    const st = r.affidabilita?.[`intraday-${step}m`];
    const a = c.affidabilita;
    const n = st?.n ?? 0;
    const quota = ((st?.giusti ?? 0) + a.prior * a.forza) / (n + a.forza);
    return { fattore: Math.max(0, Math.min(a.max, (quota - 0.5) / (a.prior - 0.5))), quota, campione: n, giusti: n ? st!.giusti / n : null };
  };
  let ora = new Date(r.dal);
  const chiuse = (b: IntradayBar[] | undefined, tf: string) => (b ?? []).filter((x) => Date.parse(x.t) + tfMin(tf) * 60_000 <= ora.getTime());
  const fetchBars = async (syms: string[], tf: string, n: number) => Object.fromEntries(syms.map((s) => [s, chiuse(r.barre[tf]?.[s], tf).slice(-n)]).filter(([s, b]) => (b as IntradayBar[]).length && (!soloCandele || soloCandele.includes(tf)) && r.candele[s as string]?.includes(tf))) as Record<string, IntradayBar[]>;
  const tfDiStep: Record<number, string> = { 5: "5Min", 15: "15Min", 60: "1Hour", 240: "4Hour" };
  const usaPercorsi = arg("percorsi", "si") !== "no";
  const forecast = async (bars: Record<string, IntradayBar[]>, step: number, h: number) => {
    const out: Record<string, PrevisioneIntraday> = {};
    for (const [s, b] of Object.entries(bars)) {
      const k = `${s}|${tfDiStep[step]}|${b.at(-1)!.t}`;
      const p = r.previsioni[k];
      const cs = usaPercorsi ? r.percorsi?.[k] : undefined;
      if (p && p.length >= Math.min(h, p.length)) out[s] = cs?.length ? { path: p, campioni: cs } : p;
    }
    return out;
  };
  const agent = new IntradayAgent(fetchBars, forecast, aff, null);
  const journal: JournalFile = { versione: 1, trade: [], intenzioni: [] } as unknown as JournalFile;
  let cash = 100_000;
  const pos = new Map<string, { qty: number; carico: number; trade: Trade }>();
  const prezzoA = (s: string) => chiuse(r.barre["5Min"]?.[s], "5Min").at(-1)?.close ?? null;
  const giornaliere = (s: string) => (r.giornaliere[s] ?? []).filter((b) => b.date.slice(0, 10) < romeTime(ora).date).map((b) => b.close);
  const motivi = new Map<string, number>();
  const categoria = (m: string) => /senza vantaggio/.test(m) ? "candela senza vantaggio misurato" : /discorde/.test(m) ? "Kronos discorde tra le candele" : /candele superiori vede un calo/.test(m) ? "candele superiori contrarie" : /aspettativa negativa/.test(m) ? "aspettativa negativa" : /rispetto allo stop/.test(m) ? "rialzo piccolo rispetto allo stop" : /non basta/.test(m) ? (/probabilità (\d+)%/.exec(m) && Number(/probabilità (\d+)%/.exec(m)![1]) >= 55 ? "rialzo previsto sotto i costi ×2" : "probabilità o rialzo insufficienti") : /in attesa della proiezione/.test(m) ? "proiezione mancante" : /insufficienti/.test(m) ? "candele insufficienti" : /più lunga del tempo rimasto/.test(m) ? "candela più lunga del tempo rimasto" : m.slice(0, 40);
  const fine = new Date(r.al).getTime();
  const oc = (d: Date) => { const u = d.getUTCHours() * 60 + d.getUTCMinutes(); const wd = d.getUTCDay(); return wd >= 1 && wd <= 5 && u >= 14 * 60 + 30 && u < 21 * 60; };
  (async () => {
    let giri = 0;
    for (; ora.getTime() <= fine; ora = new Date(ora.getTime() + 5 * 60_000)) {
      giri++;
      const prices: Record<string, number> = {};
      for (const s of r.simboli) { const p = prezzoA(s); if (p) prices[s] = p; }
      const closes: Record<string, number[]> = {};
      for (const s of r.simboli) closes[s] = giornaliere(s);
      const aperto = oc(ora);
      const close = new Date(Date.UTC(ora.getUTCFullYear(), ora.getUTCMonth(), ora.getUTCDate(), 21, 0));
      const positions = [...pos.entries()].map(([s, p]) => ({ symbol: s, qty: p.qty, avgEntryPrice: p.carico, currentPrice: prices[s] ?? p.carico, marketValue: p.qty * (prices[s] ?? p.carico) }));
      const equity = cash + positions.reduce((a, p) => a + p.marketValue, 0);
      const view = { today: romeTime(ora).date, now: ora, prices, closes, indicators: {}, positions, account: { equity, lastEquity: equity, cash, status: "ACTIVE" }, journal, analisi: true, mercatoAperto: aperto, chiusuraBorsa: aperto ? close.toISOString() : undefined, finestraIngressi: aperto } as unknown as AgentView;
      const rep = await agent.observe(view);
      for (const x of rep.intraday ?? []) if (x.fase === "cerca ingresso" && x.motivo && !/ingresso votato/.test(x.motivo)) { const k = categoria(x.motivo); motivi.set(k, (motivi.get(k) ?? 0) + 1); }
      // Vendite: a mercato al prezzo di adesso (commissione taker 0,25% sulle crypto).
      for (const sg of rep.segnali.filter((x) => x.lato === "sell")) {
        const p = pos.get(sg.simbolo); const px = prices[sg.simbolo];
        if (!p || !px) continue;
        const incasso = p.qty * px * (1 - (isCrypto(sg.simbolo) ? 0.0025 : 0));
        cash += incasso;
        Object.assign(p.trade, { stato: "chiuso", chiusoIl: ora.toISOString(), vendute: p.qty, incassato: incasso, quantita: 0, risultato: incasso - p.trade.costo, motivoUscita: sg.perche.split(": ").slice(1).join(": ").slice(0, 80) });
        pos.delete(sg.simbolo);
      }
      // Acquisti: ordine limite appena sotto il prezzo, eseguito se nei 10 minuti dopo il prezzo lo tocca (crypto); azioni a mercato.
      for (const sg of rep.segnali.filter((x) => x.lato === "buy")) {
        const s = sg.simbolo; const px = prices[s];
        if (!px || pos.has(s)) continue;
        if (!isCrypto(s) && !aperto) continue;
        // Come nel motore: la taglia dell'agente (dal rischio allo stop), poi il budget dell'intraday (investito insieme al
        // massimo budget.quota del conto, crypto al massimo budget.maxCrypto).
        const investito = (pred: (x: string) => boolean) => [...pos.entries()].filter(([x]) => pred(x)).reduce((a, [x, p2]) => a + p2.qty * (prices[x] ?? p2.carico), 0);
        const spazio = Math.min(c.budget.quota * equity - investito(() => true), isCrypto(s) ? c.budget.maxCrypto * equity - investito(isCrypto) : Infinity);
        const peso = Math.min(sg.pesoMassimo ?? c.maxWeight, c.maxWeight, Math.max(0, spazio) / equity);
        if (peso * equity < 10) { motivi.set("budget intraday pieno", (motivi.get("budget intraday pieno") ?? 0) + 1); continue; }
        let prezzo = px;
        if (isCrypto(s)) {
          const lim = px * (1 - AGENTS.costi.ordiniLimite.sotto);
          const dopo = (r.barre["5Min"]?.[s] ?? []).filter((b) => Date.parse(b.t) >= ora.getTime() && Date.parse(b.t) < ora.getTime() + AGENTS.costi.ordiniLimite.scadenzaMinuti * 60_000);
          if (!dopo.some((b) => b.low <= lim)) { motivi.set("ordine limite non eseguito", (motivi.get("ordine limite non eseguito") ?? 0) + 1); continue; }
          prezzo = lim;
        }
        const qty = (equity * peso) / prezzo;
        const costo = qty * prezzo * (1 + (isCrypto(s) ? 0.0015 : 0));
        if (costo > cash) continue;
        cash -= costo;
        const lv = rep.intraday?.find((x) => x.simbolo === s && x.livelli)?.livelli;
        const trade = { id: `${s}-${ora.toISOString()}`, simbolo: s, stato: "aperto", apertoIl: ora.toISOString(), comprate: qty, costo, vendute: 0, incassato: 0, quantita: qty, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: sg.perche, agenti: ["intraday"], tipo: "intraday", ...(lv ? { livelli: lv } : {}), misure: sg.misure } } as unknown as Trade;
        journal.trade.push(trade);
        pos.set(s, { qty, carico: prezzo, trade });
      }
    }
    // Chiusura delle posizioni rimaste all'ultimo prezzo.
    for (const [s, p] of pos) { const px = prezzoA(s) ?? p.carico; const inc = p.qty * px * (1 - (isCrypto(s) ? 0.0025 : 0)); Object.assign(p.trade, { stato: "chiuso", chiusoIl: ora.toISOString(), incassato: inc, risultato: inc - p.trade.costo, motivoUscita: "fine della prova" }); }
    const ts = journal.trade;
    const giorniN = (fine - Date.parse(r.dal)) / 86_400_000;
    const per = new Map<string, Trade[]>();
    for (const t of ts) { const k = t.contesto?.livelli?.candela ?? "?"; (per.get(k) ?? per.set(k, []).get(k)!).push(t); }
    const riassunto = (l: Trade[]) => { const v = l.filter((t) => (t.risultato ?? 0) > 0).length; const pnl = l.reduce((a, t) => a + (t.risultato ?? 0), 0); const pct = l.reduce((a, t) => a + (t.risultato ?? 0) / t.costo, 0) / Math.max(1, l.length); return { trade: l.length, vinti: v, quota: l.length ? v / l.length : null, risultato: Math.round(pnl * 100) / 100, mediaPct: Math.round(pct * 10_000) / 100 }; };
    const esito = {
      periodo: `${r.dal.slice(0, 16)} → ${r.al.slice(0, 16)} (${giorniN.toFixed(1)} giorni)`,
      opzioni: { minProb: c.kronos.minProb, senzaGrafico: c.kronos.minProbSenzaGrafico, margine: AGENTS.costi.margineCosti, affidabilita: affMode, candele: soloCandele ?? "tutte", evidenza: c.evidenza.peso },
      giri,
      totale: { ...riassunto(ts), alGiorno: Math.round((ts.length / giorniN) * 10) / 10 },
      perCandela: Object.fromEntries([...per].map(([k, l]) => [k, riassunto(l)])),
      motiviNonIngresso: Object.fromEntries([...motivi].sort((a, b) => b[1] - a[1])),
      trade: ts.map((t) => ({ s: t.simbolo, dal: t.apertoIl.slice(5, 16), al: t.chiusoIl?.slice(5, 16), candela: t.contesto?.livelli?.candela, pct: Math.round(((t.risultato ?? 0) / t.costo) * 10_000) / 100, uscita: (t as any).motivoUscita })),
    };
    console.log(JSON.stringify(esito, null, 2));
    if (arg("json")) writeFileSync(arg("json")!, JSON.stringify(esito, null, 2));
  })();
}

const cmd = process.argv[2];
if (cmd === "raccolta") raccolta().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "replay") replay();
else console.log("uso: bun src/cli/backtest-intraday.ts raccolta|replay [opzioni]");
