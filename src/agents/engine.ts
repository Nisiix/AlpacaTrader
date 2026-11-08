import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProtectiveStop, type Account, type Bar, type Broker, type MarketClock, type Order, type Position } from "../broker/types.ts";
import { compareWithBenchmarks, type Comparison } from "../benchmark.ts";
import { evaluateBreaker, readBreaker, writeBreaker } from "../breaker.ts";
import { applyCage, lossPct, tradingBlockReason, type Rejection } from "../cage.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, DAILY_BARS_DAYS, LIMITS, RADAR_SECTORS, UNIVERSE, isCrypto, setCryptoUniverse } from "../config.ts";
import { roundQty } from "../broker/types.ts";
import type { KronosForecastPath } from "../kronos-sidecar.ts";
import { stopPctFor } from "../stops.ts";
import type { CustodeStato } from "./custode.ts";
import type { IntradayStato } from "./intraday.ts";
import { applyLessons, coffeeBreak, teamLessons, type CaffeReport } from "./caffe.ts";
import { attive, explore, radar, readEsplorazione, scoutVotes, writeEsplorazione, type Scoperta } from "./esplorazione.ts";
import { refreshCryptoUniverse, type TopFetcher } from "./universe.ts";
import { applyAgentSettings } from "../agent-settings.ts";
import * as simulations from "../simulations.ts";
import type { Simulazione } from "../simulations.ts";
import { clientOrderId, sendOne, waitForFills, type ExecOutcome } from "../execute.ts";
import { writeJsonAtomic } from "../fsutil.ts";
import { indicatorsFor } from "../indicators.ts";
import { applyFills, closeDust, contextFor, dailyPnl, learnFromJournal, learningStatus, pruneJournal, readJournal, recordIntent, statsOf, writeJournal, type DailyPnl, type Stats } from "../journal.ts";
import { activeLessons, learnFromBrokerReject, learnFromStopLoss, pruneLessons, readLessons, writeLessons, type Lesson } from "../lessons.ts";
import { acquireLock, inspectLock, releaseLock, type LockData } from "../lock.ts";
import { Logger, type Redactor } from "../log.ts";
import { romeTime } from "../slots.ts";
import { manageStops, type StopsReport } from "../stops.ts";
import type { Notifier } from "../telegram.ts";
import { agentWeights, allocate, openedToday, type Score } from "./allocator.ts";
import { applyGuidance, review, type CapoReport } from "./capo.ts";
import type { EventBus } from "./bus.ts";
import { ContextAgent } from "./context.ts";
import type { Agent, AgentReport, AgentView, MarketContext, Signal } from "./types.ts";

export interface EngineDeps {
  broker: Broker;
  notifier: Notifier;
  stateDir: string;
  logsDir: string;
  redactor: Redactor;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  agents: Agent[];
  bus: EventBus;
  echo?: boolean;
  // Proiezioni (Kronos) per l'agente delle uscite e per l'agente kronos; assente = nessuna proiezione.
  // Riceve anche le barre giornaliere già scaricate (il sidecar lavora su quelle). Un numero = solo rendimento finale.
  forecaster?: (symbols: string[], bars: Record<string, Bar[]>) => Promise<Record<string, number | KronosForecastPath>>;
  // Una riga sullo stato di Kronos per la dashboard (attivo, in avvio, non installato).
  kronosStato?: () => string;
  // Universo crypto dinamico: coppie di Alpaca nella top N per capitalizzazione. fetchTop null = solo lista Alpaca.
  cryptoUniverse?: { fetchTop: TopFetcher | null };
}

export interface AgentsStatus {
  versione: 1;
  aggiornato: string;
  giro: string;
  mercatoAperto: boolean;
  finestraIngressi: boolean;
  conto: { patrimonio: number; contanti: number; pnlGiorno: number } | null;
  posizioni: { simbolo: string; quantita: number; prezzoCarico: number; prezzoAttuale: number; variazione: number; valore: number }[];
  prezzi: Record<string, number>;
  rischio: number;
  pesi: Record<string, number>;
  agenti: Record<string, { segnali: number; note: string[]; errore?: string }>;
  segnali: Signal[];
  punteggi: Score[];
  ordini: { id: string; simbolo: string; lato: string; quantita: number; esito: string; perche: string }[];
  rifiuti: Rejection[];
  contesto: MarketContext | null;
  inAttesa: { simbolo: string; motivo: string }[];
  stopSuAlpaca: StopsReport | null;
  acquistiBloccati: string | null;
  lezioniAttive: Lesson[];
  allarmi: string[];
  diario: { stato: string; statistiche: Stats };
  confronto: Comparison | null;
  ultimoRiepilogo: string | null;
  tradeChiusiOggi: { simbolo: string; risultato: number; giorni: number; uscita: string }[];
  // Profitto e perdita della giornata: realizzato dalle vendite di oggi (per operazione e per agente) e
  // non realizzato sulle posizioni ancora aperte.
  pnlOggi: DailyPnl & { nonRealizzato: number };
  // I custodi (un investitore per crypto seguita), l'universo crypto del giorno, lo stato di Kronos.
  custodi: CustodeStato[];
  intraday: IntradayStato[];
  universo: { titoli: string[]; crypto: string[]; fonteCrypto: string | null; aggiornatoCrypto: string | null };
  kronos: { stato: string; proiezioniDel: string | null; simboli: number; scartate?: string[] };
  giornata: { pnlPct: number; obiettivoPct: number; perditaMaxPct: number; obiettivoRaggiunto: boolean; perditaOltre: boolean };
  // Operazioni simulate di oggi (dopo il tetto del giorno), con l'esito virtuale ai prezzi correnti.
  simulazioni: Simulazione[];
  // Il capo ufficio: sintesi, migliori, giudizio e consigli per ogni agente.
  capo: CapoReport;
  // Sala caffè: chi è in pausa e chi alla scrivania, cosa si dicono, le lezioni di squadra.
  caffe?: CaffeReport;
  // Esplorazione del radar da parte degli agenti in pausa.
  esplorazione?: { ultimoGiro: string | null; esito: string | null; daEsaminareOggi: number; attive: Scoperta[]; recenti: Scoperta[] };
}

export const statusPath = (stateDir: string) => join(stateDir, "agents-status.json");

interface Snapshot {
  account: Account;
  positions: Position[];
  recentOrders: Order[];
  clock: MarketClock;
  prices: Record<string, number>;
}

// Lo storico giornaliero cambia una volta al giorno: si scarica alla prima passata di ogni data.
export interface EngineCache {
  closesDate?: string;
  closes: Record<string, number[]>;
  bars: Record<string, Bar[]>;
  ultimoRiepilogo: string | null;
  universeDate?: string;
  universeInfo?: { fonte: string; aggiornato: string; coppie: string[] };
  // Proiezioni del giorno (Kronos): si calcolano una volta sulle barre giornaliere e si riusano a ogni giro.
  previsioni?: { date: string; data: Record<string, KronosForecastPath> };
  // Avviso Telegram dell'obiettivo/perdita del giorno: una volta sola al giorno.
  giornataAvvisata?: string;
  capoSintesi?: string;
  giriCaffe?: number;
  caffePresenti?: string;
  scartateNota?: string;
}

export const emptyCache = (): EngineCache => ({ closes: {}, bars: {}, ultimoRiepilogo: null });
export const barsPath = (stateDir: string) => join(stateDir, "bars.json");
export const forecastsPath = (stateDir: string) => join(stateDir, "previsioni.json");

// Le proiezioni oltre ±maxAbs sono rumore del modello (un −46% in 5 sedute non è una previsione): il motore le toglie
// per tutti gli agenti, la gabbia e il contesto, non solo per l'agente Kronos. Restano nel file e sul grafico, segnate.
export function usableForecasts(p: Record<string, number> | undefined): { usabili: Record<string, number> | undefined; scartate: string[] } {
  if (!p) return { usabili: undefined, scartate: [] };
  const usabili: Record<string, number> = {};
  const scartate: string[] = [];
  for (const [s, f] of Object.entries(p)) {
    if (Number.isFinite(f) && Math.abs(f) <= AGENTS.kronos.maxAbs) usabili[s] = f;
    else scartate.push(s);
  }
  return { usabili, scartate };
}

// Le posizioni come le vede il motore: niente briciole (resti frazionari sotto il minimo negoziabile, che Alpaca
// rifiuterebbe con "qty must be > 0") e quantità crypto troncate a 6 decimali (mai arrotondate per eccesso: Alpaca
// risponderebbe "insufficient balance").
export function cleanPositions(positions: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of positions) {
    if (!isCrypto(p.symbol)) {
      if (p.qty > 0) out.push(p);
      continue;
    }
    const qty = roundQty(p.symbol, p.qty);
    if (qty <= 0 || qty * p.currentPrice < CRYPTO_MIN_NOTIONAL) continue; // briciola: si ignora
    out.push({ ...p, qty, marketValue: qty * p.currentPrice });
  }
  return out;
}

const normalizeForecast = (v: number | KronosForecastPath): KronosForecastPath => (typeof v === "number" ? { rendimentoPrevisto: v, percorso: [v], ultimaChiusura: null } : v);

// Le barre giornaliere di tutto l'universo, una volta al giorno; da qui le chiusure per gli indicatori e il file per i grafici.
async function loadBars(deps: EngineDeps, cache: EngineCache, today: string, symbols: string[], warn: (m: string) => void) {
  if (cache.closesDate === today && symbols.every((s) => cache.bars[s] || !isCrypto(s))) return;
  try {
    const bars = await retry(() => deps.broker.getDailyBars(symbols, DAILY_BARS_DAYS), deps.sleep);
    cache.bars = bars;
    cache.closes = Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.map((x) => x.close)]));
    cache.closesDate = today;
    writeJsonAtomic(barsPath(deps.stateDir), { versione: 1, aggiornato: deps.now().toISOString(), barre: bars });
  } catch (e) {
    warn(`storico non disponibile: ${(e as Error).message}. Senza storico niente acquisti.`);
    if (!cache.closesDate) {
      cache.closes = {};
      cache.bars = {};
    }
  }
}

// L'universo crypto del giorno (top N per capitalizzazione ∩ coppie Alpaca), una volta al giorno.
async function loadUniverse(deps: EngineDeps, cache: EngineCache, today: string, note: (m: string) => void) {
  if (!deps.cryptoUniverse || !AGENTS.cryptoUniverse.enabled || cache.universeDate === today) return;
  try {
    const r = await refreshCryptoUniverse(deps.broker, deps.stateDir, deps.now(), deps.cryptoUniverse.fetchTop);
    setCryptoUniverse(r.file.coppie);
    cache.universeDate = today;
    cache.universeInfo = { fonte: r.file.fonte, aggiornato: r.file.aggiornato, coppie: r.file.coppie };
    if (r.refreshed) note(`universo crypto (${r.file.fonte}): ${r.file.coppie.length} coppie: ${r.file.coppie.join(", ")}${r.problem ? ` · ${r.problem}` : ""}`);
  } catch (e) {
    note(`universo crypto non aggiornato: ${(e as Error).message}`);
  }
}

// Le proiezioni di Kronos del giorno: una chiamata sulle barre giornaliere, poi riuso. Se il sidecar non è pronto si riprova al giro dopo.
async function loadForecasts(deps: EngineDeps, cache: EngineCache, today: string, symbols: string[], note: (m: string) => void): Promise<Record<string, number> | undefined> {
  if (!deps.forecaster) return undefined;
  // Dopo un riavvio le proiezioni di oggi già calcolate si riprendono dal file: senza, al primo giro (sidecar ancora in
  // caricamento) le posizioni aperte per Kronos perderebbero il loro motivo e verrebbero vendute.
  if (!cache.previsioni) {
    try {
      const f = JSON.parse(readFileSync(forecastsPath(deps.stateDir), "utf8")) as { giorno?: string; previsioni?: Record<string, KronosForecastPath> };
      if (f.giorno === today && f.previsioni) cache.previsioni = { date: today, data: f.previsioni };
    } catch {}
  }
  const missing = symbols.filter((s) => !cache.previsioni?.data[s] && cache.bars[s]);
  if (!cache.previsioni || cache.previsioni.date !== today || missing.length) {
    try {
      const raw = await deps.forecaster(cache.previsioni?.date === today ? missing : symbols, cache.bars);
      const data = { ...(cache.previsioni?.date === today ? cache.previsioni.data : {}) };
      for (const [s, v] of Object.entries(raw)) data[s] = normalizeForecast(v);
      cache.previsioni = { date: today, data };
      writeJsonAtomic(forecastsPath(deps.stateDir), { versione: 1, aggiornato: deps.now().toISOString(), giorno: today, orizzonte: AGENTS.kronos.horizon, previsioni: data });
      note(`proiezioni (${Object.keys(raw).length} nuove): ${Object.entries(data).map(([k, v]) => `${k} ${(v.rendimentoPrevisto * 100).toFixed(1)}%`).join(", ")}`);
    } catch (e) {
      note(`proiezioni non disponibili: ${(e as Error).message}`);
      if (cache.previsioni?.date !== today) return undefined;
    }
  }
  return cache.previsioni ? Object.fromEntries(Object.entries(cache.previsioni.data).map(([k, v]) => [k, v.rendimentoPrevisto])) : undefined;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

export function inEntryWindow(now: Date): boolean {
  const rt = romeTime(now);
  return rt.weekday >= 1 && rt.weekday <= 5 && rt.minutes >= minutesOf(AGENTS.entryWindow.from) && rt.minutes <= minutesOf(AGENTS.entryWindow.to);
}

async function retry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, delays = [2_000, 5_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delays.length) throw e;
      await sleep(delays[i]!);
    }
  }
}

export type TickStatus = "fatto" | "occupato" | "broker-giu";

export interface TickResult {
  status: TickStatus;
  status_file?: AgentsStatus;
  message: string;
}

// Un giro del motore: legge il conto, interroga gli agenti, alloca, passa dalla gabbia, invia, aggiorna stop,
// diario e registro, scrive lo stato per la dashboard. Ogni passo lascia un evento nel registro.
export async function runTick(deps: EngineDeps, cache: EngineCache = emptyCache()): Promise<TickResult> {
  const startedAt = deps.now();
  const rt = romeTime(startedAt);
  const today = rt.date;
  const giro = `agenti-${today}-${String(Math.floor(rt.minutes / 60)).padStart(2, "0")}${String(rt.minutes % 60).padStart(2, "0")}`;
  const log = new Logger(join(deps.logsDir, `agenti-${today}.log`), deps.redactor, deps.echo ?? true);
  const bus = deps.bus;
  const alarms: string[] = [];
  const alarm = async (title: string, detail: string, telegram = true) => {
    alarms.push(`${title}: ${detail}`);
    log.warn(`ALLARME ${title}: ${detail}`);
    bus.emit("allarme", { titolo: title, dettaglio: detail });
    if (telegram) {
      const r = await deps.notifier.send(deps.redactor.apply(`⚠️ Agenti · ${title}\n${detail}`));
      if (!r.ok) log.error(`Telegram non ha ricevuto l'allarme: ${r.error}`);
    }
  };

  // 1. Un solo attore alla volta: se una sveglia classica è in corso, questo giro aspetta il prossimo.
  const existing = inspectLock(deps.stateDir, startedAt);
  if (existing.kind === "alive") {
    bus.emit("nota", { testo: `giro saltato: lock di ${existing.data.runId} (pid ${existing.data.pid}) ancora vivo` });
    return { status: "occupato", message: `Un'altra esecuzione (${existing.data.runId}) ha il lock: giro saltato.` };
  }
  if (existing.kind === "stale") log.warn(`lock morto di ${existing.data?.runId ?? "sconosciuto"} messo da parte: lo riconcilia la prossima sveglia classica`);
  const lock: LockData = { runId: giro, pid: process.pid, startedAt: startedAt.toISOString(), intended: [] };
  if (!acquireLock(deps.stateDir, lock)) return { status: "occupato", message: "Lock preso da un altro processo nello stesso istante: giro saltato." };

  try {
    bus.emit("tick", { giro });
    // Le impostazioni degli agenti cambiate dalla dashboard valgono dal giro successivo, senza riavvio.
    const settings = applyAgentSettings(deps.stateDir);
    for (const e of settings.errori) log.warn(`impostazioni agenti: ${e}`);
    // 2. L'universo crypto del giorno, poi Alpaca.
    await loadUniverse(deps, cache, today, (m) => {
      log.info(m);
      bus.emit("nota", { testo: m });
    });
    // Le scoperte dell'esplorazione ancora attive stanno nell'universo (prezzi, contesto, custodi, gabbia le vedono).
    const espl = readEsplorazione(deps.stateDir, today);
    for (const sc of attive(espl, today)) if (!AGENTS.universe.includes(sc.simbolo)) AGENTS.universe.push(sc.simbolo);
    let snap: Snapshot;
    try {
      snap = await retry(async () => {
        const [account, positions, recent, open, clock] = await Promise.all([deps.broker.getAccount(), deps.broker.getPositions(), deps.broker.getRecentOrders(48), deps.broker.getOpenOrders(), deps.broker.getClock()]);
        const recentOrders = [...recent, ...open.filter((o) => !recent.some((r) => r.id === o.id))];
        const symbols = [...new Set([...UNIVERSE, ...AGENTS.universe, ...positions.map((p) => p.symbol)])];
        const prices = await deps.broker.getLatestPrices(symbols);
        for (const p of positions) if (!prices[p.symbol] && p.currentPrice > 0) prices[p.symbol] = p.currentPrice;
        return { account, positions: cleanPositions(positions), recentOrders, clock, prices };
      }, deps.sleep);
    } catch (e) {
      await alarm("Errore del broker", `Alpaca non risponde: ${(e as Error).message}. Nessun ordine in questo giro.`, false);
      return { status: "broker-giu", message: `Alpaca non risponde: ${(e as Error).message}` };
    }
    // I titoli del radar escono dall'universo quando la scoperta è chiusa e non sono in portafoglio; quelli in portafoglio restano.
    {
      const keep = new Set([...attive(espl, today).map((x) => x.simbolo), ...snap.positions.map((p) => p.symbol)]);
      for (let i = AGENTS.universe.length - 1; i >= 0; i--) { const u = AGENTS.universe[i]!; if (RADAR_SECTORS[u] && !keep.has(u)) AGENTS.universe.splice(i, 1); }
      for (const p of snap.positions) if (RADAR_SECTORS[p.symbol] && !AGENTS.universe.includes(p.symbol)) AGENTS.universe.push(p.symbol);
    }
    bus.emit("conto", { patrimonio: snap.account.equity, contanti: snap.account.cash, pnlGiorno: snap.account.equity - snap.account.lastEquity, mercatoAperto: snap.clock.isOpen });
    bus.emit("prezzi", { prezzi: snap.prices });
    await loadBars(deps, cache, today, [...new Set([...UNIVERSE, ...AGENTS.universe, ...snap.positions.map((p) => p.symbol)])], (m) => log.warn(m));
    const closes = cache.closes;
    const indicators = indicatorsFor(closes, snap.prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays);

    // 3. Memoria del rischio: interruttore (con riarmo automatico), registro degli errori, diario.
    const lr = readLessons(deps.stateDir, startedAt);
    const lessonsFile = lr.file;
    if (lr.problem) await alarm("Registro degli errori illeggibile", lr.problem);
    const learned: Lesson[] = [];
    for (const o of snap.recentOrders) {
      if (!isProtectiveStop(o) || o.status !== "filled") continue;
      const l = learnFromStopLoss(lessonsFile, `stop-${o.clientOrderId}`, o.symbol, today, `stop su Alpaca eseguito, ${o.filledQty} azioni`);
      if (l) learned.push(l);
    }
    let buyBlock: string | null = null;
    const br = readBreaker(deps.stateDir);
    if (!LIMITS.breakerEnabled) {
      // Interruttore spento: il massimo si aggiorna comunque (per il confronto), ma non blocca niente.
      if (br.kind !== "corrupt") writeBreaker(deps.stateDir, evaluateBreaker(br.file, snap.account.equity, snap.account.lastEquity, startedAt.toISOString()).file);
    } else if (br.kind === "corrupt") {
      buyBlock = `file dell'interruttore illeggibile (${br.error}): acquisti bloccati finché non lanci bun run breaker-reset`;
      await alarm("Interruttore illeggibile", buyBlock);
    } else {
      const ev = evaluateBreaker(br.file, snap.account.equity, snap.account.lastEquity, startedAt.toISOString());
      writeBreaker(deps.stateDir, ev.file);
      buyBlock = ev.buyBlock;
      if (ev.newlyTripped) await alarm("Interruttore scattato", `${ev.newlyTripped}. Acquisti fermi per ${LIMITS.breakerRearmSessions} giorni di borsa; vendite e stop restano attivi.`);
    }
    // Obiettivo giornaliero: patrimonio contro la chiusura di ieri. Raggiunto → niente nuovi acquisti fino a domani e
    // l'intraday incassa; perdita oltre la soglia → niente nuovi acquisti (gli stop proteggono il resto).
    const pnlPct = snap.account.lastEquity > 0 ? snap.account.equity / snap.account.lastEquity - 1 : 0;
    const giornata = { pnlPct, obiettivoRaggiunto: AGENTS.daily.enabled && AGENTS.daily.targetPct > 0 && pnlPct >= AGENTS.daily.targetPct, perditaOltre: AGENTS.daily.enabled && AGENTS.daily.maxLossPct > 0 && pnlPct <= -AGENTS.daily.maxLossPct };
    if (!buyBlock && giornata.obiettivoRaggiunto) {
      buyBlock = `obiettivo giornaliero raggiunto (${(pnlPct * 100).toFixed(2)}% ≥ ${(AGENTS.daily.targetPct * 100).toFixed(1)}%): per oggi niente nuovi acquisti, gli agenti continuano in simulazione; si riparte domani`;
      if (cache.giornataAvvisata !== `${today}-obiettivo`) {
        cache.giornataAvvisata = `${today}-obiettivo`;
        const r = await deps.notifier.send(deps.redactor.apply(`🎯 Agenti · ${buyBlock}`));
        if (!r.ok) log.error(`Telegram non ha ricevuto l'avviso: ${r.error}`);
      }
    } else if (!buyBlock && giornata.perditaOltre) {
      buyBlock = `perdita del giorno oltre la soglia (${(pnlPct * 100).toFixed(2)}% ≤ -${(AGENTS.daily.maxLossPct * 100).toFixed(1)}%): niente nuovi acquisti fino a domani`;
      if (cache.giornataAvvisata !== `${today}-perdita`) {
        cache.giornataAvvisata = `${today}-perdita`;
        await alarm("Perdita del giorno oltre la soglia", buyBlock);
      }
    }
    const lessonsNow = activeLessons(lessonsFile, today);
    const jr = readJournal(deps.stateDir, startedAt);
    const journal = jr.file;
    if (jr.problem) await alarm("Diario dei trade illeggibile", jr.problem);
    const learning = learningStatus(journal, today);

    // 4. Il massimo visto da ogni trade aperto (per lo stop che segue il profitto), poi le proiezioni, poi gli agenti.
    for (const t of journal.trade) {
      if (t.stato !== "aperto") continue;
      const price = snap.prices[t.simbolo];
      if (price) t.massimo = Math.max(t.massimo ?? 0, price);
    }
    const { usabili: previsioni, scartate } = usableForecasts(
      await loadForecasts(deps, cache, today, [...new Set([...AGENTS.universe, ...snap.positions.map((p) => p.symbol)])], (m) => {
        log.info(m);
        bus.emit("nota", { testo: m });
      }),
    );
    const scartateKey = `${today}:${scartate.join(",")}`;
    if (scartate.length && cache.scartateNota !== scartateKey) {
      cache.scartateNota = scartateKey;
      const m = `Kronos: proiezioni oltre ±${(AGENTS.kronos.maxAbs * 100).toFixed(0)}% non usate (rumore del modello): ${scartate.join(", ")}`;
      log.info(m);
      bus.emit("nota", { testo: m });
    }
    const view: AgentView = { today, now: startedAt, prices: snap.prices, closes, indicators, positions: snap.positions, account: snap.account, journal, previsioni, mercatoAperto: snap.clock.isOpen, finestraIngressi: inEntryWindow(startedAt) && snap.clock.isOpen, giornata };
    const reports: Record<string, AgentReport> = {};
    const agentStatus: AgentsStatus["agenti"] = {};
    // Il contesto economico si valuta per primo: decide dove si aspetta e di quali proiezioni fidarsi.
    const ctxAgent = deps.agents.find((a): a is ContextAgent => a instanceof ContextAgent);
    let contesto: MarketContext | null = null;
    if (ctxAgent) {
      try {
        contesto = await ctxAgent.assess(view);
        view.contesto = contesto;
        if (view.previsioni) view.previsioni = Object.fromEntries(Object.entries(view.previsioni).filter(([s]) => contesto!.fidatiDellaProiezione[s] !== false));
        bus.emit("contesto", { generale: contesto.generale, settori: contesto.settori, fonte: contesto.fonte, motivo: contesto.motivo, attendi: contesto.attendi });
      } catch (e) {
        log.error(`contesto: ${(e as Error).message}`);
        bus.emit("agente", { agente: ctxAgent.name, errore: (e as Error).message });
      }
    }
    await Promise.all(
      deps.agents.map(async (a) => {
        try {
          const r = await a.observe(view);
          reports[a.name] = r;
          agentStatus[a.name] = { segnali: r.segnali.length, note: r.note ?? [] };
          bus.emit("agente", { agente: a.name, segnali: r.segnali.length, rischio: r.rischio ?? null, note: r.note ?? [] });
          for (const s of r.segnali) bus.emit("segnale", { ...s });
          if (r.rischio !== undefined) bus.emit("rischio", { agente: a.name, rischio: r.rischio, note: r.note ?? [] });
        } catch (e) {
          agentStatus[a.name] = { segnali: 0, note: [], errore: (e as Error).message };
          log.error(`agente ${a.name}: ${(e as Error).message}`);
          bus.emit("agente", { agente: a.name, errore: (e as Error).message });
        }
      }),
    );
    // Esplorazione: chi ha trovato un titolo in sala caffè lo vota finché l'opportunità regge (poi capo, lezioni, gabbia).
    const scout = scoutVotes(espl, view, reports);
    for (const n of scout.note) {
      log.info(n);
      bus.emit("nota", { testo: n });
    }
    for (const r of Object.values(reports)) for (const sg of r.segnali) if (sg.perche.startsWith("esplorazione dalla sala caffè")) bus.emit("segnale", { ...sg });
    // Il capo ufficio: rivede i risultati di ciascun agente sul diario e applica i suoi richiami ai voti di oggi.
    const capo = review(journal, startedAt);
    for (const n of applyGuidance(reports, capo, view.previsioni)) {
      log.info(n);
      bus.emit("nota", { testo: n });
    }
    // Sala caffè: le lezioni di squadra dal diario correggono, con limiti, i voti d'acquisto che somigliano a quello che
    // alla squadra è andato male (o bene).
    const lezioni = teamLessons(journal);
    const applicatiCaffe = applyLessons(reports, lezioni, view.previsioni);
    for (const n of applicatiCaffe) {
      log.info(n);
      bus.emit("nota", { testo: n });
    }
    if (cache.capoSintesi !== capo.sintesi) {
      cache.capoSintesi = capo.sintesi;
      bus.emit("capo", { sintesi: capo.sintesi, richiamati: capo.valutazioni.filter((v) => v.giudizio === "richiamato").map((v) => ({ agente: v.agente, messaggio: v.messaggio, consigli: v.consigli })) });
    }
    const weights = agentWeights(journal, today, deps.agents.map((a) => a.name));
    const alloc = allocate(view, reports, weights);
    // Un titolo votato ma in attesa (contesto, Kronos al ribasso) non è un ordine rifiutato: nessuna quantità, evento a sé.
    for (const w of alloc.inAttesa) bus.emit("attesa", { simbolo: w.simbolo, motivo: w.motivo });
    bus.emit("allocazione", { rischio: alloc.rischio, pesi: weights, punteggi: alloc.punteggi, proposte: alloc.proposte, inAttesa: alloc.inAttesa });

    // 5. Gabbia: gli acquisti solo nella finestra di ingresso, le vendite e gli stop sempre a mercato aperto.
    const entry = inEntryWindow(startedAt);
    const cage = applyCage({ today, slotKind: entry ? "open" : "mid", marketOpen: snap.clock.isOpen, latenessMin: 0, account: snap.account, positions: snap.positions, prices: snap.prices, closes, recentOrders: snap.recentOrders, lessons: lessonsNow, buyBlock, proposals: alloc.proposte, previsioni: view.previsioni, apertiOggi: openedToday(view) });
    for (const x of cage.rejected) {
      // Obiettivo del giorno raggiunto: l'acquisto che si sarebbe fatto diventa una simulazione (si segue e si misura).
      if (giornata.obiettivoRaggiunto && x.side === "buy" && /obiettivo giornaliero/.test(x.reason)) {
        const price = snap.prices[x.symbol];
        if (price) {
          const sc = alloc.punteggi.find((p) => p.simbolo === x.symbol);
          simulations.add(deps.stateDir, today, { id: `${giro}-${x.symbol}`, simbolo: x.symbol, quantita: x.qty, prezzo: price, quando: startedAt.toISOString(), agenti: sc?.agenti ?? [], perche: sc?.perche.join(" · ") ?? "" });
          bus.emit("simulazione", { simbolo: x.symbol, lato: "buy", quantita: x.qty, prezzo: price, agenti: sc?.agenti ?? [], motivo: "obiettivo del giorno raggiunto: operazione simulata, non inviata" });
          log.info(`simulazione: comprerebbe ${x.qty} ${x.symbol} a ${price}`);
        }
        continue;
      }
      log.warn(`rifiutato ${x.side} ${x.qty} ${x.symbol} [${x.source}]: ${x.reason}`);
      bus.emit("rifiuto", { simbolo: x.symbol, lato: x.side, quantita: x.qty, origine: x.source, motivo: x.reason });
    }
    // Le simulazioni di oggi si rivalutano con i prezzi di adesso: come sarebbe andata.
    const simulazioni = simulations.evaluate(deps.stateDir, today, snap.prices);
    // Gli acquisti hanno un ID al giorno (un solo ingresso per titolo al giorno), le vendite uno per giro.
    const runIdFor = (side: string) => (side === "buy" ? `agenti-${today}` : giro);
    for (const o of cage.orders) {
      const sc = alloc.punteggi.find((p) => p.simbolo === o.symbol);
      const proposed = alloc.proposte.find((p) => p.symbol === o.symbol && p.side === o.side);
      const ctx = contextFor(indicators[o.symbol], snap.prices[o.symbol], o.source === "modello" ? (proposed?.confidence ?? null) : null, o.source === "modello" ? (proposed?.expect ?? "") : "", o.why);
      if (o.source === "modello" && sc) ctx.agenti = sc.agenti;
      if (view.previsioni?.[o.symbol] !== undefined) ctx.kronos = view.previsioni[o.symbol];
      recordIntent(journal, { id: clientOrderId(runIdFor(o.side), o.symbol, o.side), simbolo: o.symbol, lato: o.side, origine: o.source === "modello" ? "agenti" : o.source, data: today, contesto: ctx });
    }
    if (cage.orders.length) writeJournal(deps.stateDir, journal);

    // 6. Invio.
    lock.intended = cage.orders.map((o) => ({ clientOrderId: clientOrderId(runIdFor(o.side), o.symbol, o.side), symbol: o.symbol, side: o.side, qty: o.qty }));
    const outcomes: ExecOutcome[] = [];
    for (const plan of cage.orders) {
      const out = await sendOne(deps.broker, runIdFor(plan.side), plan, log, deps.sleep);
      outcomes.push(out);
      bus.emit("ordine", { id: out.id, simbolo: plan.symbol, lato: plan.side, quantita: plan.qty, origine: plan.source, esito: out.kind, stato: "order" in out ? out.order.status : undefined, errore: "error" in out ? out.error : undefined, perche: plan.why });
      if (out.kind === "inviato") {
        const r = await deps.notifier.send(deps.redactor.apply(`🤖 Agenti · ${plan.side === "buy" ? "COMPRA" : "VENDE"} ${plan.qty} ${plan.symbol}\n${plan.why}`));
        if (!r.ok) log.error(`Telegram non ha ricevuto l'ordine: ${r.error}`);
      }
    }
    const uncertain = outcomes.filter((o) => o.kind === "incerto");
    if (uncertain.length) await alarm("Esito incerto", `Alpaca non ha confermato: ${uncertain.map((o) => o.id).join(", ")}. L'ID impedisce i doppioni; il prossimo giro verifica.`);
    const failed = outcomes.filter((o) => o.kind === "fallito");
    if (failed.length) await alarm("Ordini rifiutati da Alpaca", failed.map((o) => `${o.id}: ${o.kind === "fallito" ? o.error : ""}`).join("\n"));
    for (const o of outcomes) {
      const l = o.kind === "inviato" && o.plan.source === "stop-loss" ? learnFromStopLoss(lessonsFile, `stop-${o.id}`, o.plan.symbol, today, o.plan.why) : o.kind === "fallito" ? learnFromBrokerReject(lessonsFile, o.plan.symbol, o.plan.side, today, o.error) : null;
      if (l) learned.push(l);
    }

    // 7. Stop su Alpaca, diario, lezioni.
    let stops: StopsReport | null = null;
    let positions = snap.positions;
    const equitiesOpen = !tradingBlockReason({ slotKind: "mid", marketOpen: snap.clock.isOpen, latenessMin: 0, account: snap.account });
    if (equitiesOpen || snap.positions.some((p) => isCrypto(p.symbol)) || outcomes.length) {
      await waitForFills(deps.broker, outcomes.filter((o) => o.kind === "inviato").map((o) => o.id), deps.sleep, log);
      try {
        const [pos, open] = await Promise.all([deps.broker.getPositions(), deps.broker.getOpenOrders()]);
        positions = cleanPositions(pos);
        // A borsa chiusa si toccano solo gli stop delle crypto; quelli dei titoli restano com'erano.
        const manageable = equitiesOpen ? positions : positions.filter((p) => isCrypto(p.symbol));
        const relevantOpen = equitiesOpen ? open : open.filter((o) => isCrypto(o.symbol));
        stops = await manageStops(deps.broker, giro, manageable, relevantOpen, log, closes, AGENTS.exit.enabled && AGENTS.exit.stopMode === "fisso" ? AGENTS.exit.stopPct : undefined);
      } catch (e) {
        stops = { ok: [], placed: [], cancelled: [], errors: [`Alpaca non risponde: ${(e as Error).message}`] };
      }
      for (const s of stops.placed) bus.emit("stop", { azione: "piazzato", dettaglio: s });
      for (const s of stops.cancelled) bus.emit("stop", { azione: "tolto", dettaglio: s });
      if (stops.errors.length) await alarm("Stop su Alpaca non a posto", stops.errors.join("\n"));
    }
    let filled = snap.recentOrders;
    try {
      filled = await deps.broker.getRecentOrders(24 * 7);
    } catch (e) {
      log.warn(`diario: ordini della settimana non leggibili: ${(e as Error).message}`);
    }
    const fills = applyFills(journal, filled);
    fills.closed.push(...closeDust(journal));
    for (const t of fills.opened) bus.emit("trade", { stato: "aperto", simbolo: t.simbolo, quantita: t.comprate, prezzo: t.costo / t.comprate, agenti: t.contesto?.agenti ?? [] });
    for (const t of fills.closed) bus.emit("trade", { stato: "chiuso", simbolo: t.simbolo, risultato: t.risultato ?? 0, pnl: t.incassato - t.costo, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto", agenti: t.contesto?.agenti ?? [] });
    learned.push(...learnFromJournal(lessonsFile, journal, today));
    pruneLessons(lessonsFile, today);
    writeLessons(deps.stateDir, lessonsFile);
    pruneJournal(journal, today);
    writeJournal(deps.stateDir, journal);
    for (const l of learned) {
      log.info(`lezione nuova: ${l.motivo} (fino al ${l.finoAl})`);
      bus.emit("nota", { testo: `lezione: ${l.motivo} (fino al ${l.finoAl})` });
    }

    // 8. Conto finale, confronto, stato per la dashboard.
    let account = snap.account;
    if (outcomes.length || stops?.placed.length || stops?.cancelled.length) {
      try {
        account = await deps.broker.getAccount();
      } catch {}
    }
    const bm = compareWithBenchmarks(deps.stateDir, today, account.equity, snap.prices.SPY, snap.prices.TLT);
    const status: AgentsStatus = {
      versione: 1,
      aggiornato: deps.now().toISOString(),
      giro,
      mercatoAperto: snap.clock.isOpen,
      finestraIngressi: entry && snap.clock.isOpen,
      conto: { patrimonio: account.equity, contanti: account.cash, pnlGiorno: account.equity - account.lastEquity },
      posizioni: positions.map((p) => ({ simbolo: p.symbol, quantita: p.qty, prezzoCarico: p.avgEntryPrice, prezzoAttuale: p.currentPrice, variazione: lossPct(p), valore: p.marketValue })),
      prezzi: snap.prices,
      rischio: alloc.rischio,
      pesi: weights,
      agenti: agentStatus,
      segnali: Object.values(reports).flatMap((r) => r.segnali),
      punteggi: alloc.punteggi,
      ordini: outcomes.map((o) => ({ id: o.id, simbolo: o.plan.symbol, lato: o.plan.side, quantita: o.plan.qty, esito: "order" in o ? `${o.kind} (${o.order.status})` : `${o.kind}: ${o.error}`, perche: o.plan.why })),
      rifiuti: cage.rejected,
      contesto,
      inAttesa: alloc.inAttesa,
      stopSuAlpaca: stops,
      acquistiBloccati: buyBlock,
      lezioniAttive: activeLessons(lessonsFile, today),
      allarmi: alarms,
      diario: { stato: learning.motivo, statistiche: statsOf(journal.trade) },
      confronto: bm.cmp,
      ultimoRiepilogo: cache.ultimoRiepilogo,
      tradeChiusiOggi: fills.closed.map((t) => ({ simbolo: t.simbolo, risultato: t.risultato ?? 0, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto" })),
      pnlOggi: { ...dailyPnl(journal, today), nonRealizzato: positions.reduce((s, p) => s + (p.currentPrice - p.avgEntryPrice) * p.qty, 0) },
      custodi: Object.values(reports).flatMap((r) => r.custodi ?? []),
      intraday: Object.values(reports).flatMap((r) => r.intraday ?? []),
      universo: { titoli: AGENTS.universe.filter((s) => !isCrypto(s)), crypto: AGENTS.universe.filter(isCrypto), fonteCrypto: cache.universeInfo?.fonte ?? null, aggiornatoCrypto: cache.universeInfo?.aggiornato ?? null },
      kronos: { stato: deps.kronosStato?.() ?? (deps.forecaster ? "attivo" : "non configurato"), proiezioniDel: cache.previsioni?.date ?? null, simboli: Object.keys(cache.previsioni?.data ?? {}).length, scartate },
      giornata: { pnlPct, obiettivoPct: AGENTS.daily.targetPct, perditaMaxPct: AGENTS.daily.maxLossPct, obiettivoRaggiunto: giornata.obiettivoRaggiunto, perditaOltre: giornata.perditaOltre },
      simulazioni,
      capo,
      caffe: coffeeBreak({ now: deps.now(), reports, held: new Set([...positions.map((p) => p.symbol), ...cage.orders.filter((o) => o.side === "buy").map((o) => o.symbol)]), previsioni: view.previsioni, scartate, lezioni, capo, applicati: applicatiCaffe, giro: (cache.giriCaffe = (cache.giriCaffe ?? 0) + 1), primaInPausa: new Set((cache.caffePresenti ?? "").split(",").filter(Boolean)), esploratori: scout.esploratori }),
    };
    // Esplorazione: con qualcuno in pausa, ogni mezz'ora si passa in rassegna un pezzo del radar.
    try {
      const giroEspl = await explore({
        now: deps.now(), today, file: espl, presenti: status.caffe!.presenti, universe: AGENTS.universe, cryptoFuori: [],
        getBars: (syms) => retry(() => deps.broker.getDailyBars(syms, DAILY_BARS_DAYS), deps.sleep),
        forecast: deps.forecaster
          ? async (syms, bars) => {
              const raw = await deps.forecaster!(syms, bars);
              const out: Record<string, number> = {};
              for (const [k, v] of Object.entries(raw)) {
                const fp = normalizeForecast(v);
                out[k] = fp.rendimentoPrevisto;
                if (cache.previsioni?.date === today) cache.previsioni.data[k] = fp;
              }
              if (cache.previsioni?.date === today) writeJsonAtomic(forecastsPath(deps.stateDir), { versione: 1, aggiornato: deps.now().toISOString(), giorno: today, orizzonte: AGENTS.kronos.horizon, previsioni: cache.previsioni.data });
              return out;
            }
          : null,
      });
      if (giroEspl) {
        for (const [k, b] of Object.entries(giroEspl.bars)) {
          cache.bars[k] = b;
          cache.closes[k] = b.map((x) => x.close);
        }
        for (const n of giroEspl.nuove) {
          if (!AGENTS.universe.includes(n.simbolo)) AGENTS.universe.push(n.simbolo);
          // Lo scopritore lascia la sala caffè e torna alla scrivania: lo dice ai colleghi.
          const c = status.caffe!;
          const i = c.presenti.findIndex((p) => p.chiave === n.scopritore);
          if (i >= 0) c.presenti.splice(i, 1);
          c.operativi.push({ chiave: n.scopritore, nome: n.agente, perche: `ha trovato ${n.simbolo}` });
          c.scambi.unshift({ da: n.scopritore, a: null, tema: "esplorazione", testo: `Ho trovato ${n.simbolo} (${n.settore}): ${n.motivo}. Torno alla scrivania, lo porto al motore.` });
        }
        log.info(`esplorazione: ${giroEspl.messaggio}`);
        bus.emit("esplorazione", { esaminati: giroEspl.esaminati, nuove: giroEspl.nuove.map((n) => ({ simbolo: n.simbolo, agente: n.agente, kronos: n.kronos, motivo: n.motivo })), scartati: giroEspl.scartati });
      }
      writeEsplorazione(deps.stateDir, espl);
    } catch (e) {
      log.warn(`esplorazione non riuscita: ${(e as Error).message}`);
    }
    status.esplorazione = {
      ultimoGiro: espl.ultimoGiro,
      esito: espl.ultimoEsito,
      daEsaminareOggi: radar(AGENTS.universe).filter((x) => !espl.esaminati.includes(x)).length,
      attive: attive(espl, today),
      recenti: espl.scoperte.filter((x) => x.stato !== "attiva").slice(-6),
    };
    // Chi entra e chi esce dalla sala caffè: un evento solo quando cambia qualcosa.
    const presentiKey = status.caffe!.presenti.map((p) => p.chiave).join(",");
    if (cache.caffePresenti !== undefined && cache.caffePresenti !== presentiKey) {
      const prima = new Set(cache.caffePresenti.split(",").filter(Boolean));
      const ora = new Set(status.caffe!.presenti.map((p) => p.chiave));
      const entrati = [...ora].filter((k) => !prima.has(k));
      const usciti = status.caffe!.operativi.filter((o) => prima.has(o.chiave));
      bus.emit("caffe", { entrati, usciti: usciti.map((o) => ({ chiave: o.chiave, perche: o.perche })) });
    }
    cache.caffePresenti = presentiKey;
    writeJsonAtomic(statusPath(deps.stateDir), status);
    log.info(`giro ${giro}: ${status.segnali.length} segnali, ${alloc.proposte.length} proposte, ${outcomes.length} ordini, ${cage.rejected.length} rifiuti, rischio ${alloc.rischio}`);

    // 9. Riepilogo del giorno su Telegram, una volta, dopo la chiusura. Nel fine settimana solo se c'è stato
    // movimento (crypto): il conto di profitto e perdita del giorno non deve perdersi.
    const operato = status.pnlOggi.vendite.length + status.pnlOggi.acquisti.length > 0;
    if (rt.minutes >= minutesOf(AGENTS.summaryAfter) && cache.ultimoRiepilogo !== today && ((rt.weekday >= 1 && rt.weekday <= 5) || operato)) {
      cache.ultimoRiepilogo = today;
      status.ultimoRiepilogo = today;
      writeJsonAtomic(statusPath(deps.stateDir), status);
      const r = await deps.notifier.send(deps.redactor.apply(summaryText(status)));
      if (!r.ok) log.error(`Telegram non ha ricevuto il riepilogo: ${r.error}`);
    }
    bus.prune(today);
    return { status: "fatto", status_file: status, message: `giro ${giro} completato` };
  } finally {
    releaseLock(deps.stateDir);
  }
}

// Valutazione interattiva di un titolo, su richiesta dalla dashboard: stessi dati e stessi agenti di un giro, ma a secco.
// Nessun ordine, nessun lock, niente scritto nello stato: solo cosa direbbero gli agenti, l'allocatore e la gabbia adesso.
export interface Valutazione {
  simbolo: string;
  quando: string;
  prezzo: number | null;
  mercatoAperto: boolean;
  finestraIngressi: boolean;
  posizione: { quantita: number; carico: number; valore: number; guadagno: number; variazione: number } | null;
  livelli: { media20: number | null; media50: number | null; media200: number | null; stopPct: number; stop: number | null; obiettivo: number | null };
  contesto: { generale: string; motivo: string; attendi: string | null } | null;
  voti: Signal[];
  punteggio: number | null;
  proposta: { lato: string; quantita: number; perche: string } | null;
  gabbia: { esito: "passa" | "rifiuta" | "niente"; motivo: string };
  verdetto: string; // una frase
  previsione: (KronosForecastPath & { orizzonte: number }) | null;
  custode: CustodeStato | null;
  intraday: IntradayStato | null;
  note: string[];
}

export async function valutaTitolo(deps: EngineDeps, cache: EngineCache, symbol: string): Promise<Valutazione> {
  const now = deps.now();
  const rt = romeTime(now);
  const today = rt.date;
  const note: string[] = [];
  const [account, rawPositions, clock, open] = await Promise.all([deps.broker.getAccount(), deps.broker.getPositions(), deps.broker.getClock(), deps.broker.getOpenOrders()]);
  const positions = cleanPositions(rawPositions);
  const symbols = [...new Set([...UNIVERSE, ...AGENTS.universe, symbol, ...positions.map((p) => p.symbol)])];
  const prices = await deps.broker.getLatestPrices(symbols);
  for (const p of positions) if (!prices[p.symbol] && p.currentPrice > 0) prices[p.symbol] = p.currentPrice;
  await loadBars(deps, cache, today, symbols, (m) => note.push(m));
  const closes = cache.closes;
  const indicators = indicatorsFor(closes, prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays);
  const lessonsFile = readLessons(deps.stateDir, now).file;
  const br = readBreaker(deps.stateDir);
  const buyBlock = !LIMITS.breakerEnabled ? null : br.kind === "corrupt" ? "interruttore illeggibile" : evaluateBreaker(br.file, account.equity, account.lastEquity, now.toISOString()).buyBlock;
  const journal = readJournal(deps.stateDir, now).file;
  const previsioniNum = usableForecasts(cache.previsioni?.date === today ? Object.fromEntries(Object.entries(cache.previsioni.data).map(([k, v]) => [k, v.rendimentoPrevisto])) : undefined).usabili;
  const view: AgentView = { today, now, prices, closes, indicators, positions, account, journal, previsioni: previsioniNum, mercatoAperto: clock.isOpen, finestraIngressi: inEntryWindow(now) && clock.isOpen };
  const ctxAgent = deps.agents.find((a): a is ContextAgent => a instanceof ContextAgent);
  let contesto: MarketContext | null = null;
  if (ctxAgent) {
    try {
      contesto = await ctxAgent.assess(view);
      view.contesto = contesto;
      if (view.previsioni) view.previsioni = Object.fromEntries(Object.entries(view.previsioni).filter(([s]) => contesto!.fidatiDellaProiezione[s] !== false));
    } catch (e) {
      note.push(`contesto non valutato: ${(e as Error).message}`);
    }
  }
  const reports: Record<string, AgentReport> = {};
  await Promise.all(
    deps.agents.map(async (a) => {
      try {
        reports[a.name] = await a.observe(view);
      } catch (e) {
        note.push(`${a.name}: ${(e as Error).message}`);
      }
    }),
  );
  // Come nel giro vero: i richiami del capo ufficio e le lezioni della sala caffè cambiano i voti prima dei punteggi.
  for (const n of [...applyGuidance(reports, review(journal, now), view.previsioni), ...applyLessons(reports, teamLessons(journal), view.previsioni)]) if (n.includes(` ${symbol} `)) note.push(n);
  const weights = agentWeights(journal, today, deps.agents.map((a) => a.name));
  const alloc = allocate(view, reports, weights);
  const voti = Object.values(reports).flatMap((r) => r.segnali).filter((s) => s.simbolo === symbol);
  const score = alloc.punteggi.find((p) => p.simbolo === symbol);
  const proposals = alloc.proposte.filter((p) => p.symbol === symbol);
  const entry = inEntryWindow(now);
  const recentOrders = open;
  const cage = applyCage({ today, slotKind: entry ? "open" : "mid", marketOpen: clock.isOpen, latenessMin: 0, account, positions, prices, closes, recentOrders, lessons: activeLessons(lessonsFile, today), buyBlock, proposals, previsioni: view.previsioni, apertiOggi: openedToday(view) });
  const pos = positions.find((p) => p.symbol === symbol && p.qty > 0) ?? null;
  const price = prices[symbol] ?? closes[symbol]?.at(-1) ?? null;
  const c = closes[symbol];
  const stopPct = AGENTS.exit.enabled && AGENTS.exit.stopMode === "fisso" ? AGENTS.exit.stopPct : stopPctFor(c);
  const sma = (n: number) => (c && c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const target = AGENTS.exit.enabled && AGENTS.exit.mode === "obiettivo" && pos ? pos.avgEntryPrice * (1 + (AGENTS.exit.targetBySymbol[symbol] ?? AGENTS.exit.targetPct)) : null;
  const prop = proposals[0] ?? null;
  const order = cage.orders.find((o) => o.symbol === symbol);
  const rej = cage.rejected.find((r) => r.symbol === symbol);
  const gabbia: Valutazione["gabbia"] = order ? { esito: "passa", motivo: `la gabbia lascerebbe passare: ${order.side === "buy" ? "acquisto" : "vendita"} di ${order.qty} ${symbol}` } : rej ? { esito: "rifiuta", motivo: rej.reason } : { esito: "niente", motivo: prop ? "nessun ordine" : "gli agenti non propongono niente su questo titolo" };
  const fc = cache.previsioni?.data[symbol];
  const custode = Object.values(reports).flatMap((r) => r.custodi ?? []).find((k) => k.simbolo === symbol) ?? null;
  let verdetto: string;
  if (prop && order) verdetto = `Gli agenti ${prop.side === "buy" ? "comprerebbero" : "venderebbero"} ${order.qty} ${symbol} adesso: ${prop.why}`;
  else if (prop && rej) verdetto = `Gli agenti vorrebbero ${prop.side === "buy" ? "comprare" : "vendere"} ${prop.qty} ${symbol}, ma le regole lo fermano: ${rej.reason}`;
  else if (pos) verdetto = `Tenere ${symbol}: nessun agente chiede di uscire${score ? ` (punteggio ${score.punteggio.toFixed(2)})` : ""}.`;
  else if (voti.length) verdetto = `Nessun ordine su ${symbol}: i voti non bastano (punteggio ${score ? score.punteggio.toFixed(2) : "0"}, serve ${AGENTS.buyScore} per comprare).`;
  else verdetto = `Nessun agente vede un'occasione su ${symbol} adesso.`;
  return {
    simbolo: symbol,
    quando: now.toISOString(),
    prezzo: price,
    mercatoAperto: clock.isOpen,
    finestraIngressi: entry && clock.isOpen,
    posizione: pos ? { quantita: pos.qty, carico: pos.avgEntryPrice, valore: pos.marketValue, guadagno: (pos.currentPrice - pos.avgEntryPrice) * pos.qty, variazione: lossPct(pos) } : null,
    livelli: { media20: sma(AGENTS.custodi.pullbackSmaDays), media50: sma(LIMITS.trendSmaDays), media200: sma(LIMITS.longSmaDays), stopPct, stop: pos ? pos.avgEntryPrice * (1 - stopPct) : price !== null ? price * (1 - stopPct) : null, obiettivo: target },
    contesto: contesto ? { generale: contesto.generale, motivo: contesto.motivo, attendi: contesto.attendi[symbol] ?? null } : null,
    voti,
    punteggio: score?.punteggio ?? null,
    proposta: prop ? { lato: prop.side, quantita: prop.qty, perche: prop.why } : null,
    gabbia,
    verdetto,
    previsione: fc ? { ...fc, orizzonte: AGENTS.kronos.horizon } : null,
    custode,
    intraday: Object.values(reports).flatMap((r) => r.intraday ?? []).find((k) => k.simbolo === symbol) ?? null,
    note,
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const usd = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} $`;
const qty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));

// Il conto della giornata: ogni vendita con il suo guadagno o perdita in dollari, il totale, chi l'ha votata.
export function pnlText(p: AgentsStatus["pnlOggi"]): string[] {
  const lines = [`💰 Profitto e perdita del ${p.data}`];
  if (!p.vendite.length && !p.acquisti.length) {
    lines.push(`Nessuna operazione oggi · non realizzato sulle posizioni aperte ${usd(p.nonRealizzato)}`);
    return lines;
  }
  const parziali = p.vendite.length - p.tradeChiusi;
  lines.push(`Realizzato ${usd(p.realizzato)} su ${p.vendite.length} vendit${p.vendite.length === 1 ? "a" : "e"} (${p.tradeChiusi} trade chius${p.tradeChiusi === 1 ? "o" : "i"}${parziali ? `, ${parziali} parzial${parziali === 1 ? "e" : "i"}` : ""})`);
  for (const v of p.vendite) lines.push(` • ${v.simbolo} ${qty(v.quantita)} × ${v.carico.toFixed(2)} → ${v.prezzo.toFixed(2)}: ${usd(v.pnl)} (${pct(v.risultato)})${v.chiuso ? "" : " parziale"} · ${v.motivo}${v.agenti.length ? ` · agenti ${v.agenti.join(", ")}` : ""}`);
  const perAgente = Object.entries(p.perAgente).sort((a, b) => b[1].pnl - a[1].pnl);
  if (perAgente.length) lines.push(`Per agente: ${perAgente.map(([a, g]) => `${a} ${usd(g.pnl)} (${g.operazioni} op.)`).join(", ")}`);
  if (p.acquisti.length) lines.push(`Acquisti di oggi: ${p.acquisti.map((a) => `${a.simbolo} ${qty(a.quantita)} @ ${a.prezzo.toFixed(2)}${a.agenti.length ? ` (${a.agenti.join(", ")})` : ""}`).join("; ")}`);
  lines.push(`Non realizzato sulle posizioni aperte ${usd(p.nonRealizzato)} · totale giornata ${usd(p.realizzato + p.nonRealizzato)}`);
  return lines;
}

export function summaryText(s: AgentsStatus): string {
  const lines = [`📊 Agenti · riepilogo ${s.aggiornato.slice(0, 10)}`];
  if (s.conto) lines.push(`Patrimonio ${s.conto.patrimonio.toFixed(2)} $ (oggi ${s.conto.pnlGiorno >= 0 ? "+" : ""}${s.conto.pnlGiorno.toFixed(2)} $), contanti ${s.conto.contanti.toFixed(2)} $`);
  if (s.confronto) lines.push(`Dal ${s.confronto.dal}: conto ${pct(s.confronto.conto)}, SPY ${pct(s.confronto.spy)}${s.confronto.misto ? `, 60/40 ${pct(s.confronto.misto.rendimento)}` : ""}`);
  lines.push(`Posizioni: ${s.posizioni.length ? s.posizioni.map((p) => `${p.simbolo} ${p.quantita} (${pct(p.variazione)})`).join(", ") : "nessuna"}`);
  lines.push(`Rischio ammesso ${(s.rischio * 100).toFixed(0)}% · pesi ${Object.entries(s.pesi).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (s.contesto) lines.push(`Contesto ${s.contesto.generale} (${s.contesto.fonte}): ${s.contesto.motivo}${s.inAttesa.length ? ` · in attesa: ${s.inAttesa.map((w) => w.simbolo).join(", ")}` : ""}`);
  lines.push("", ...pnlText(s.pnlOggi), "");
  lines.push(`Diario: ${s.diario.stato}`);
  if (s.acquistiBloccati) lines.push(`Acquisti bloccati: ${s.acquistiBloccati}`);
  if (s.allarmi.length) lines.push(`Allarmi: ${s.allarmi.join(" | ")}`);
  return lines.join("\n");
}

// Il ciclo: un giro ogni tickMinutes, finché il processo vive. Fuori orario il giro è solo lettura.
export async function runEngine(deps: EngineDeps, tickMs: number, shouldStop: () => boolean = () => false, cache: EngineCache = emptyCache()): Promise<void> {
  while (!shouldStop()) {
    const t0 = deps.now().getTime();
    try {
      const r = await runTick(deps, cache);
      if (deps.echo ?? true) console.log(`${deps.now().toISOString()} ${r.message}`);
    } catch (e) {
      console.error(`${deps.now().toISOString()} giro fallito: ${(e as Error).message}`);
      deps.bus.emit("allarme", { titolo: "Giro fallito", dettaglio: (e as Error).message });
    }
    const wait = Math.max(5_000, tickMs - (deps.now().getTime() - t0));
    await deps.sleep(wait);
  }
}
