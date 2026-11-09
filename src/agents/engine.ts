import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenOrder, isProtectiveStop, type Account, type Bar, type Broker, type MarketClock, type Order, type Position } from "../broker/types.ts";
import { compareWithBenchmarks, type Comparison } from "../benchmark.ts";
import { evaluateBreaker, readBreaker, writeBreaker } from "../breaker.ts";
import { applyCage, lossPct, tradingBlockReason, type Rejection } from "../cage.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, DAILY_BARS_DAYS, LIMITS, RADAR_SECTORS, UNIVERSE, isCrypto, setCryptoUniverse } from "../config.ts";
import { roundQty } from "../broker/types.ts";
import type { KronosForecastPath } from "../kronos-sidecar.ts";
import { stopPctFor } from "../stops.ts";
import type { CustodeStato } from "./custode.ts";
import type { IntradayStato } from "./intraday.ts";
import type { FontiDati } from "./fonti.ts";
import { applyLessons, coffeeBreak, teamLessons, type CaffeReport } from "./caffe.ts";
import { attive, explore, radar, readEsplorazione, scoutVotes, writeEsplorazione, type Scoperta } from "./esplorazione.ts";
import { refreshCryptoUniverse, type TopFetcher } from "./universe.ts";
import { applyAgentSettings } from "../agent-settings.ts";
import * as simulations from "../simulations.ts";
import type { Simulazione } from "../simulations.ts";
import { clientOrderId, sendOne, waitForFills, type ExecOutcome } from "../execute.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import { indicatorsFor } from "../indicators.ts";
import { applyFills, closeDust, contextFor, dailyPnl, pruneJournal, readJournal, recordIntent, statsOf, writeJournal, type DailyPnl, type Stats } from "../journal.ts";
import { activeLessons, learnFromBrokerReject, learnFromStopLoss, pruneLessons, readLessons, writeLessons, type Lesson } from "../lessons.ts";
import { acquireLock, inspectLock, releaseLock, type LockData } from "../lock.ts";
import { Logger, type Redactor } from "../log.ts";
import { romeTime } from "../slots.ts";
import { limitiSedute } from "../sedute.ts";
import { manageStops, type StopsReport } from "../stops.ts";
import type { Notifier } from "../telegram.ts";
import { allocate, openedToday, type Score } from "./allocator.ts";
import { applyGuidance, review, type CapoReport } from "./capo.ts";
import { simboliIntraday } from "./posizioni.ts";
import type { Cervello, RigaCervello } from "./cervello.ts";
import { BIBLIOTECA, type Principio } from "./biblioteca.ts";
import { aggiornaCalibrazione, applicaCalibrazione, type RigaCalibrazione } from "./calibrazione.ts";
import { aggiornaMeta, aggiornaProbabilita, calibraP, KELLY, META, pesoKelly, probMeta, rapportoVinciPerdi, type StatoCalibrazione, type StatoMeta } from "./statistica.ts";
import { giornataPersone, preparaProfili, TUTTI_PERSONALI, valore, valutaProve, type GiornataPersona } from "./profili.ts";
import { aggiornaFormazione, applicaFormazione, postazioneDelVoto, provaRientro, type FormazioneReport } from "./formazione.ts";
import { estraiBeta } from "./casuale.ts";
import { assegnaPersone, chiavePersona, leggiRegistro, persone, personeDelTrade, rilascia, type Bisogno, type Persona } from "./persone.ts";
import { nomiTitoli } from "../nomi-titoli.ts";
import { plausibile } from "./fiducia.ts";
import { refreshEarnings, type EarningsFetcher } from "../earnings.ts";
import { addEarnings } from "../events.ts";
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
  forecaster?: (symbols: string[], bars: Record<string, Bar[]>, tipo?: "giorno" | "esplorazione") => Promise<Record<string, number | KronosForecastPath>>;
  // Fonti esterne gratuite (Fear & Greed, funding): se assenti si va avanti senza.
  fonti?: { read(): Promise<FontiDati> };
  // Una riga sullo stato di Kronos per la dashboard (attivo, in avvio, non installato).
  kronosStato?: () => string;
  // Universo crypto dinamico: coppie di Alpaca nella top N per capitalizzazione. fetchTop null = solo lista Alpaca.
  cryptoUniverse?: { fetchTop: TopFetcher | null };
  // Il cervello delle previsioni: confronta le previsioni scadute di ogni modello con i prezzi veri e ne tiene i pesi.
  cervello?: Cervello;
  // Calendario delle trimestrali (Nasdaq): una lettura al giorno; assente = solo il calendario scritto a mano.
  trimestrali?: EarningsFetcher;
}

export interface AgentsStatus {
  versione: 1;
  aggiornato: string;
  giro: string;
  mercatoAperto: boolean;
  finestraIngressi: boolean;
  conto: { patrimonio: number; contanti: number; pnlGiorno: number } | null;
  posizioni: { simbolo: string; quantita: number; prezzoCarico: number; prezzoAttuale: number; variazione: number; valore: number; dal?: string; agenti?: string[] }[];
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
  giornata: { pnlPct: number; obiettivoPct: number; pavimentoPct: number; picco: number; perditaMaxPct: number; obiettivoRaggiunto: boolean; difesa: boolean; perditaOltre: boolean };
  // Operazioni simulate di oggi (dopo il tetto del giorno), con l'esito virtuale ai prezzi correnti.
  simulazioni: Simulazione[];
  // Il capo ufficio: sintesi, migliori, giudizio e consigli per ogni agente.
  capo: CapoReport;
  // Sala caffè: chi è in pausa e chi alla scrivania, cosa si dicono, le lezioni di squadra.
  caffe?: CaffeReport;
  fonti?: FontiDati;
  // Esplorazione del radar da parte degli agenti in pausa.
  esplorazione?: { ultimoGiro: string | null; esito: string | null; daEsaminareOggi: number; attive: Scoperta[]; recenti: Scoperta[] };
  // Analisi d'ingresso: se questo giro l'ha fatta, quando è stata l'ultima e quando arriva la prossima.
  analisi?: { questoGiro: boolean; ultima: string | null; prossima: string | null; ogniMinuti: number };
  // Il cervello delle previsioni: per tipo (giorno, candela intraday) e modello, quante previsioni valutate, quota di
  // direzioni giuste, resa media seguendole e peso di adesso nella previsione combinata.
  cervello?: { righe: RigaCervello[]; inAttesa: number };
  // La biblioteca degli agenti: i principi dei libri di trading tradotti in regole.
  biblioteca?: { principi: Principio[] };
  // Gli agenti come persone (nome e ruolo), per chiave dell'ufficio: 'capo', 'a:trend', 'c:AAPL', 'i:BTC/USD'.
  persone?: Record<string, Persona>;
  // Chi è in sala caffè per formazione e chi è tornato alla scrivania col bagaglio dei colleghi bravi.
  formazione?: FormazioneReport;
  // La giornata di ogni persona: guadagno sul capitale dei suoi trade di oggi, obiettivo personale, difesa.
  giornataPersone?: Record<string, GiornataPersona>;
  // Il motore punta all'intraday: gli ingressi nuovi li decidono le candele; i dossier dei trading agents fanno da contesto.
  puntaIntraday?: boolean;
  // Calibrazione delle probabilità e meta-modello: campione, attivi o no, Brier score sulla prova fuori campione.
  statistica?: { probabilita: Record<string, StatoCalibrazione>; meta: StatoMeta };
  // I nomi dei titoli e delle crypto (Apple, Bitcoin...), per mostrarli accanto ai codici.
  nomi?: Record<string, string>;
  // La calibrazione del capo ufficio: per agente il parametro d'ingresso, il valore di base e quello calibrato.
  calibrazione?: RigaCalibrazione[];
}

// Il registro degli errori nel motore tiene solo le regole di sicurezza: niente riacquisto dopo uno stop e niente nuovo
// tentativo dopo due rifiuti di Alpaca. Le lezioni statistiche dal diario non si usano: imparare dai risultati lo fanno il
// capo ufficio e la sala caffè, da subito e con limiti, e due sistemi insieme punirebbero due volte lo stesso errore.
const lezioniDiSicurezza = (file: Parameters<typeof activeLessons>[0], today: string) => activeLessons(file, today).filter((l) => l.tipo !== "statistica");
// Tutti gli agenti votano con lo stesso peso: chi va male lo richiama il capo ufficio (forza ridotta, soglia di Kronos).
const pesiUguali = (agents: { name: string }[]) => Object.fromEntries(agents.map((a) => [a.name, 1]));

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
  // date = chiave delle giornate concluse (src/sedute.ts) su cui sono state calcolate; giorno = data italiana, per la dashboard.
  previsioni?: { date: string; giorno?: string; data: Record<string, KronosForecastPath> };
  // Avviso Telegram dell'obiettivo/perdita del giorno: una volta sola al giorno.
  giornataAvvisata?: string;
  capoSintesi?: string;
  giriCaffe?: number;
  caffePresenti?: string;
  difeseAvvisate?: string[];
  inTick?: boolean;
  exploring?: boolean;
  scartateNota?: string;
  trimestraliDate?: string;
  ultimaAnalisi?: string;
}

export const emptyCache = (): EngineCache => ({ closes: {}, bars: {}, ultimoRiepilogo: null });
export const barsPath = (stateDir: string) => join(stateDir, "bars.json");
export const forecastsPath = (stateDir: string) => join(stateDir, "previsioni.json");

// Le proiezioni oltre ±maxAbs sono rumore del modello (un −46% in 5 sedute non è una previsione): il motore le toglie
// per tutti gli agenti, la gabbia e il contesto, non solo per l'agente Kronos. Restano nel file e sul grafico, segnate.
// Il massimo guadagno del giorno toccato finora (ora di Roma), in state/giornata.json: la difesa del guadagno vale anche
// dopo un riavvio del motore.
export function registraPicco(stateDir: string, today: string, pnlPct: number): number {
  const p = join(stateDir, "giornata.json");
  const r = readJson(p, (v): v is { data: string; picco: number } => isObject(v) && typeof v.data === "string" && typeof v.picco === "number");
  const prima = r.kind === "ok" && r.value.data === today ? r.value.picco : -Infinity;
  const picco = Math.max(prima, pnlPct);
  if (picco !== prima) writeJsonAtomic(p, { data: today, picco });
  return picco;
}

export function usableForecasts(p: Record<string, number> | undefined, closes?: Record<string, number[]>): { usabili: Record<string, number> | undefined; scartate: string[] } {
  if (!p) return { usabili: undefined, scartate: [] };
  const usabili: Record<string, number> = {};
  const scartate: string[] = [];
  for (const [s, f] of Object.entries(p)) {
    if (plausibile(f, closes?.[s])) usabili[s] = f;
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

// Le barre giornaliere di tutto l'universo, solo giornate concluse; si riscaricano quando ne arriva una nuova (chiave di
// src/sedute.ts: dopo la chiusura di New York per le azioni, a mezzanotte UTC per le crypto). Da qui gli indicatori e i grafici.
async function loadBars(deps: EngineDeps, cache: EngineCache, chiave: string, symbols: string[], warn: (m: string) => void) {
  if (cache.closesDate === chiave && symbols.every((s) => cache.bars[s] || !isCrypto(s))) return;
  try {
    const bars = await retry(() => deps.broker.getDailyBars(symbols, DAILY_BARS_DAYS), deps.sleep);
    cache.bars = bars;
    cache.closes = Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.map((x) => x.close)]));
    cache.closesDate = chiave;
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

// Kronos prevede il rendimento dall'ultima chiusura conclusa; le decisioni si prendono al prezzo di adesso. Se oggi il
// titolo è già salito del 2,5% e Kronos vedeva +2% dalla chiusura, da qui l'attesa è circa -0,5%: senza questo
// riallineamento il motore comprerebbe dopo il rialzo e venderebbe dopo il calo già avvenuto.
export const daAdesso = (r: number, chiusura: number | null | undefined, prezzo: number | undefined) => (chiusura && chiusura > 0 && prezzo && prezzo > 0 ? ((1 + r) * chiusura) / prezzo - 1 : r);
export const percorsoDaAdesso = (p: KronosForecastPath, prezzo: number | undefined) => p.percorso.map((x) => daAdesso(x, p.ultimaChiusura, prezzo));
export function riallinea(previsioni: Record<string, number> | undefined, data: Record<string, KronosForecastPath> | undefined, prezzi: Record<string, number>): Record<string, number> | undefined {
  if (!previsioni) return undefined;
  return Object.fromEntries(Object.entries(previsioni).map(([s, r]) => [s, daAdesso(r, data?.[s]?.ultimaChiusura, prezzi[s])]));
}

// Il limite delle giornate concluse per la classe del titolo, e se una proiezione è calcolata su quello attuale.
const limiteDi = (s: string, chiave: string) => chiave.split("|")[isCrypto(s) ? 1 : 0]!;
const aggiornata = (p: KronosForecastPath | undefined, s: string, chiave: string) => !!p && p.del === limiteDi(s, chiave);

// Le proiezioni di Kronos: si calcolano sulle giornate concluse e si ricalcolano quando ne arriva una nuova (per le sole
// azioni dopo la chiusura di New York, per le sole crypto a mezzanotte UTC); tra un ricalcolo e l'altro si riusano.
// Se il sidecar non risponde si tengono le ultime (meglio una proiezione di qualche ora fa che nessuna: senza, le
// posizioni tenute per Kronos perderebbero il loro motivo). Le crypto nuove dell'universo si aggiungono quando servono.
async function loadForecasts(deps: EngineDeps, cache: EngineCache, chiave: string, today: string, symbols: string[], note: (m: string) => void): Promise<Record<string, number> | undefined> {
  if (!deps.forecaster) return undefined;
  if (!cache.previsioni) {
    try {
      const f = JSON.parse(readFileSync(forecastsPath(deps.stateDir), "utf8")) as { chiave?: string; giorno?: string; previsioni?: Record<string, KronosForecastPath> };
      if (f.previsioni) cache.previsioni = { date: f.chiave ?? "", giorno: f.giorno, data: f.previsioni };
    } catch {}
  }
  const need = symbols.filter((s) => cache.bars[s] && !aggiornata(cache.previsioni?.data[s], s, chiave));
  if (need.length) {
    try {
      const raw = await deps.forecaster(need, cache.bars);
      const data = { ...(cache.previsioni?.data ?? {}) };
      for (const [s, v] of Object.entries(raw)) data[s] = { ...normalizeForecast(v), del: limiteDi(s, chiave) };
      cache.previsioni = { date: chiave, giorno: today, data };
      writeJsonAtomic(forecastsPath(deps.stateDir), { versione: 1, aggiornato: deps.now().toISOString(), giorno: today, chiave, orizzonte: AGENTS.kronos.horizon, previsioni: data });
      note(`proiezioni (${Object.keys(raw).length} nuove su giornate concluse ${chiave.replace("|", " / ")}): ${Object.entries(raw).map(([k, v]) => `${k} ${((typeof v === "number" ? v : v.rendimentoPrevisto) * 100).toFixed(1)}%`).join(", ")}`);
    } catch (e) {
      note(`proiezioni non ricalcolate: ${(e as Error).message}${cache.previsioni ? "; restano le ultime" : ""}`);
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

// Gli acquisti di azioni: per tutta la seduta vera, dall'orologio di Alpaca (apertura e chiusura reali, ora legale e giorni
// festivi compresi), fino a 5 minuti dalla chiusura. Senza orario di chiusura vale la finestra fissa in ora di Roma.
export function stockEntryOpen(clock: { isOpen: boolean; nextClose?: string }, now: Date): boolean {
  if (!clock.isOpen) return false;
  if (clock.nextClose) return Date.parse(clock.nextClose) - now.getTime() >= 5 * 60_000;
  return inEntryWindow(now);
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

  // 1. Un solo attore alla volta: se un altro processo ha il lock (es. una chiusura delle posizioni), questo giro aspetta il prossimo.
  const existing = inspectLock(deps.stateDir, startedAt);
  if (existing.kind === "alive") {
    bus.emit("nota", { testo: `giro saltato: lock di ${existing.data.runId} (pid ${existing.data.pid}) ancora vivo` });
    return { status: "occupato", message: `Un'altra esecuzione (${existing.data.runId}) ha il lock: giro saltato.` };
  }
  if (existing.kind === "stale") log.warn(`lock morto di ${existing.data?.runId ?? "sconosciuto"} messo da parte`);
  const lock: LockData = { runId: giro, pid: process.pid, startedAt: startedAt.toISOString(), intended: [] };
  if (!acquireLock(deps.stateDir, lock)) return { status: "occupato", message: "Lock preso da un altro processo nello stesso istante: giro saltato." };

  try {
    bus.emit("tick", { giro });
    // Le impostazioni degli agenti cambiate dalla dashboard valgono dal giro successivo, senza riavvio.
    const settings = applyAgentSettings(deps.stateDir);
    for (const e of settings.errori) log.warn(`impostazioni agenti: ${e}`);
    // Poi la calibrazione del capo ufficio sopra le impostazioni delle schede (solo verso ingressi più selettivi, nei limiti).
    const calibrazione = applicaCalibrazione(deps.stateDir);
    preparaProfili(deps.stateDir); // le impostazioni di ogni persona sul titolo su cui lavora
    // 2. L'universo crypto del giorno, poi Alpaca.
    await loadUniverse(deps, cache, today, (m) => {
      log.info(m);
      bus.emit("nota", { testo: m });
    });
    // Le trimestrali dei prossimi giorni per tutti i titoli seguiti: bloccano gli acquisti di quel titolo nei giorni prima.
    if (deps.trimestrali && cache.trimestraliDate !== today) {
      try {
        const r = await refreshEarnings(deps.stateDir, today, [...new Set([...AGENTS.universe, ...Object.keys(RADAR_SECTORS), ...UNIVERSE])], deps.trimestrali);
        if (r.file) addEarnings(r.file.date);
        cache.trimestraliDate = today;
        const m = r.problema ? `trimestrali: ${r.problema}; resta il calendario già noto` : r.nuove ? `trimestrali dei prossimi giorni: ${r.file!.date.map((x) => `${x.symbol} ${x.date}`).join(", ")}` : null;
        if (m) {
          log.info(m);
          bus.emit("nota", { testo: m });
        }
      } catch (e) {
        log.warn(`trimestrali: ${(e as Error).message}`);
      }
    }
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
    // Le previsioni scadute di ogni modello si confrontano con i prezzi di adesso (prima di chiederne di nuove).
    try {
      const n = deps.cervello?.valuta(startedAt, snap.prices) ?? 0;
      if (n) log.info(`cervello: ${n} previsioni valutate`);
    } catch (e) {
      log.warn(`cervello: ${(e as Error).message}`);
    }
    const dati = limitiSedute(startedAt);
    await loadBars(deps, cache, dati.chiave, [...new Set([...UNIVERSE, ...AGENTS.universe, ...snap.positions.map((p) => p.symbol)])], (m) => log.warn(m));
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
    // Obiettivo del giorno: patrimonio contro la chiusura di ieri, con il massimo toccato oggi (salvato: vale anche dopo un
    // riavvio). Toccato l'obiettivo si continua a investire; se il guadagno torna al pavimento, scatta la difesa: gli agenti
    // vendono i trade non favorevoli. Perdita oltre la soglia (se impostata) → niente nuovi acquisti.
    const pnlPct = snap.account.lastEquity > 0 ? snap.account.equity / snap.account.lastEquity - 1 : 0;
    const picco = registraPicco(deps.stateDir, today, pnlPct);
    const d = AGENTS.daily;
    // L'obiettivo del giorno è di ogni persona (src/agents/profili.ts): qui resta solo la perdita massima del conto.
    const obiettivoRaggiunto = false;
    const giornata = { pnlPct, picco, obiettivoRaggiunto, difesa: false, perditaOltre: d.enabled && d.maxLossPct > 0 && pnlPct <= -d.maxLossPct };
    const pc = (x: number) => `${(x * 100).toFixed(2)}%`;
    if (obiettivoRaggiunto && cache.giornataAvvisata !== `${today}-obiettivo` && cache.giornataAvvisata !== `${today}-difesa`) {
      cache.giornataAvvisata = `${today}-obiettivo`;
      const r = await deps.notifier.send(deps.redactor.apply(`🎯 Agenti · obiettivo del giorno raggiunto (${pc(picco)} ≥ ${pc(d.targetPct)}): si continua a investire; se il guadagno del giorno torna al ${pc(d.pavimentoPct)} si vendono i trade non favorevoli`));
      if (!r.ok) log.error(`Telegram non ha ricevuto l'avviso: ${r.error}`);
    }
    if (giornata.difesa && cache.giornataAvvisata !== `${today}-difesa`) {
      cache.giornataAvvisata = `${today}-difesa`;
      await alarm("Difesa del guadagno del giorno", `il guadagno del giorno è tornato a ${pc(pnlPct)} dopo aver toccato ${pc(picco)}: gli agenti vendono i trade non favorevoli`);
    }
    if (!buyBlock && giornata.perditaOltre) {
      buyBlock = `perdita del giorno oltre la soglia (${(pnlPct * 100).toFixed(2)}% ≤ -${(AGENTS.daily.maxLossPct * 100).toFixed(1)}%): niente nuovi acquisti fino a domani`;
      if (cache.giornataAvvisata !== `${today}-perdita`) {
        cache.giornataAvvisata = `${today}-perdita`;
        await alarm("Perdita del giorno oltre la soglia", buyBlock);
      }
    }
    const lessonsNow = lezioniDiSicurezza(lessonsFile, today);
    const jr = readJournal(deps.stateDir, startedAt);
    const journal = jr.file;
    // Dal diario: calibrazione delle probabilità e meta-modello, attivi solo se verificati sui trade più recenti.
    const statistica = { probabilita: aggiornaProbabilita(journal), meta: aggiornaMeta(journal) };
    if (jr.problem) await alarm("Diario dei trade illeggibile", jr.problem);
    // Le esecuzioni dal giro scorso entrano nel diario prima che agenti, allocatore e gabbia decidano. Prima entravano solo
    // a fine giro: al giro dopo un acquisto appena eseguito non risultava «aperto oggi» né intraday, e l'uscita di trend o
    // la proiezione a 5 sedute lo vendevano dopo 5 minuti (14 dei 15 trade chiusi del primo conto).
    {
      const primi = applyFills(journal, snap.recentOrders);
      for (const t of primi.opened) bus.emit("trade", { stato: "aperto", simbolo: t.simbolo, quantita: t.comprate, prezzo: t.costo / t.comprate, agenti: t.contesto?.agenti ?? [] });
      for (const t of primi.closed) bus.emit("trade", { stato: "chiuso", simbolo: t.simbolo, risultato: t.risultato ?? 0, pnl: t.incassato - t.costo, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto", agenti: t.contesto?.agenti ?? [] });
      if (primi.opened.length || primi.closed.length) writeJournal(deps.stateDir, journal);
    }
    for (const n of valutaProve(deps.stateDir, journal, startedAt)) { log.info(`formazione: ${n}`); bus.emit("nota", { testo: `formazione: ${n}` }); }
    for (const n of aggiornaCalibrazione(deps.stateDir, journal, startedAt)) {
      log.info(n);
      bus.emit("nota", { testo: n });
    }

    // 4. Il massimo visto da ogni trade aperto (per lo stop che segue il profitto), poi le proiezioni, poi gli agenti.
    for (const t of journal.trade) {
      if (t.stato !== "aperto") continue;
      const price = snap.prices[t.simbolo];
      if (price) t.massimo = Math.max(t.massimo ?? 0, price);
    }
    const { usabili: previsioniGrezze, scartate } = usableForecasts(
      await loadForecasts(deps, cache, dati.chiave, today, [...new Set([...AGENTS.universe, ...snap.positions.map((p) => p.symbol)])], (m) => {
        log.info(m);
        bus.emit("nota", { testo: m });
      }),
      closes,
    );
    // Dalla chiusura su cui le ha calcolate Kronos al prezzo di adesso: è da qui che si compra o si vende.
    const previsioni = riallinea(previsioniGrezze, cache.previsioni?.data, snap.prices);
    const scartateKey = `${today}:${scartate.join(",")}`;
    if (scartate.length && cache.scartateNota !== scartateKey) {
      cache.scartateNota = scartateKey;
      const m = `Kronos: proiezioni fuori misura non usate (oltre ±${(AGENTS.kronos.maxAbs * 100).toFixed(0)}% o oltre ${AGENTS.kronos.zMax} volte la volatilità del titolo: rumore del modello): ${scartate.join(", ")}`;
      log.info(m);
      bus.emit("nota", { testo: m });
    }
    let fonti: FontiDati | undefined;
    try {
      fonti = deps.fonti ? await deps.fonti.read() : undefined;
    } catch {}
    const percorsi = previsioni && cache.previsioni ? Object.fromEntries(Object.keys(previsioni).filter((k) => cache.previsioni!.data[k]?.percorso?.length).map((k) => [k, percorsoDaAdesso(cache.previsioni!.data[k]!, snap.prices[k])])) : undefined;
    // Analisi d'ingresso ogni AGENTS.analisiMinuti (con mezzo minuto di tolleranza sul ritmo dei giri).
    const analisi = !cache.ultimaAnalisi || startedAt.getTime() - Date.parse(cache.ultimaAnalisi) >= AGENTS.analisiMinuti * 60_000 - 30_000;
    if (analisi) cache.ultimaAnalisi = startedAt.toISOString();
    const cashImpegnato = snap.recentOrders.filter((o) => isOpenOrder(o) && !isProtectiveStop(o) && o.side === "buy").reduce((a, o) => a + (o.qty - o.filledQty) * (snap.prices[o.symbol] ?? 0), 0);
    // La giornata di ogni persona: il suo obiettivo del giorno e, se dopo averlo toccato torna sotto metà, la difesa dei
    // suoi trade. Al cambio di giorno l'obiettivo si aggiusta con l'esito di ieri.
    const giornataP = giornataPersone(deps.stateDir, journal, snap.prices, today, (iso) => romeTime(new Date(iso)).date, (sym) => closes[sym]?.at(-1));
    for (const n of giornataP.note) { log.info(n); bus.emit("nota", { testo: n }); }
    for (const [sym, motivo] of Object.entries(giornataP.difesa)) {
      const chiave = `${today}-difesa-${motivo.split(" ")[0]}`;
      if (cache.difeseAvvisate?.includes(chiave)) continue;
      (cache.difeseAvvisate ??= []).push(chiave);
      await alarm("Difesa del guadagno di una persona", `${motivo}: si vendono i suoi trade non favorevoli (${sym}${Object.entries(giornataP.difesa).filter(([s2, m]) => s2 !== sym && m === motivo).map(([s2]) => `, ${s2}`).join("")})`);
    }
    const view: AgentView = { today, now: startedAt, difesaPersonale: giornataP.difesa, prices: snap.prices, closes, indicators, positions: snap.positions, account: snap.account, cashImpegnato, analisi, journal, previsioni, previsioniKronos: previsioni, percorsi, mercatoAperto: snap.clock.isOpen, chiusuraBorsa: snap.clock.nextClose, finestraIngressi: stockEntryOpen(snap.clock, startedAt), giornata, fonti };
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
    // Il capo ufficio giudica le persone sui trade che hanno preso (i suoi richiami si applicano dopo l'assegnazione).
    const capo = review(journal, startedAt, leggiRegistro(deps.stateDir).vecchi);
    // Le persone. Formazione: chi lavora male va in sala caffè a imparare da chi lavora bene. Poi le occasioni del giro
    // (posizioni aperte, trading agents pronti a entrare, voti d'acquisto) vanno alle persone libere dello staff, le
    // più brave per risultati; chi non ha un'occasione (anche chi è «in attesa») resta in sala caffè.
    const registro = leggiRegistro(deps.stateDir);
    const generaliAttivi = Object.entries(reports).filter(([n, r]) => n !== "custodi" && n !== "intraday" && r.segnali.length).map(([n]) => `a:${n}`);
    const formazione = aggiornaFormazione(deps.stateDir, journal, [...Object.keys(registro.staff).map(chiavePersona), ...generaliAttivi], startedAt, registro.vecchi, view.contesto?.generale);
    const votiDi = (desk: string) => Object.values(reports).flatMap((r) => r.segnali).filter((s) => s.lato === "buy" && !s.vincolante && postazioneDelVoto(s) === desk);
    const custodiGiro = Object.values(reports).flatMap((r) => r.custodi ?? []);
    const intradayGiro = Object.values(reports).flatMap((r) => r.intraday ?? []);
    const inIntraday = new Set(intradayGiro.filter((x) => x.fase === "in posizione").map((x) => x.simbolo));
    const preferite = new Map(attive(espl, today).map((s) => [`${s.agente === "intraday" ? "i" : "c"}:${s.simbolo}`, s.scopritore]));
    const bisogni: Record<"trading" | "intraday", Bisogno[]> = { trading: [], intraday: [] };
    // Un'azione si può comprare solo nella finestra degli ingressi: fuori, chi la vorrebbe resta in sala caffè (resta
    // alla scrivania solo chi segue una posizione aperta).
    const entrabile = (sym: string) => isCrypto(sym) || view.finestraIngressi !== false;
    const aggiungi = (rep: "trading" | "intraday", b: Bisogno) => { if (!b.tiene && !entrabile(b.simbolo)) return; const x = bisogni[rep].find((y) => y.simbolo === b.simbolo); if (x) { x.tiene ||= b.tiene; x.voto ||= b.voto; } else bisogni[rep].push(b); };
    for (const c of custodiGiro) {
      const tiene = (c.fase === "in posizione" || c.fase === "in uscita") && !inIntraday.has(c.simbolo);
      // Con il motore che punta all'intraday un trading agent «pronto» non apre posizioni: alla scrivania solo chi le segue.
      const pronto = !AGENTS.puntaIntraday && c.fase === "pronto" && (c.dossier?.probabilita ?? 0) >= Number(valore("AGENTS.custodi.minProbabilita", c.simbolo)) - 0.005;
      if (tiene || pronto) aggiungi("trading", { simbolo: c.simbolo, tiene, voto: false, ...(preferite.get(`c:${c.simbolo}`) ? { preferita: preferite.get(`c:${c.simbolo}`)! } : {}) });
    }
    for (const x of intradayGiro) if (x.fase === "in posizione") aggiungi("intraday", { simbolo: x.simbolo, tiene: true, voto: false });
    for (const s of Object.values(reports).flatMap((r) => r.segnali)) {
      if (s.lato !== "buy" || s.vincolante) continue;
      const desk = postazioneDelVoto(s);
      // Un voto su un titolo il cui trading agent non è pronto (in attesa, in osservazione) non porta nessuno alla scrivania.
      const cust = custodiGiro.find((c) => c.simbolo === desk.slice(2));
      if (desk.startsWith("c:") && cust && cust.fase !== "pronto" && cust.fase !== "in posizione" && cust.fase !== "in uscita") continue;
      if (desk.startsWith("c:") && cust?.fase === "pronto" && (cust.dossier?.probabilita ?? 0) < 0.595) continue;
      if (desk.startsWith("c:") && AGENTS.puntaIntraday) continue;
      if (desk.startsWith("c:")) aggiungi("trading", { simbolo: desk.slice(2), tiene: false, voto: true, ...(preferite.get(desk) ? { preferita: preferite.get(desk)! } : {}) });
      else if (desk.startsWith("i:")) aggiungi("intraday", { simbolo: desk.slice(2), tiene: false, voto: true, ...(preferite.get(desk) ? { preferita: preferite.get(desk)! } : {}) });
    }
    // Più bravo = più trade vinti in quel tipo di operazione (stima prudente: (vinti + 1) / (trade + 2)); chi non ne ha
    // ancora di quel tipo vale per i suoi risultati in generale.
    const record = new Map<string, { n: number; v: number }>();
    for (const t of journal.trade.filter((t) => t.stato === "chiuso")) for (const k of personeDelTrade(t, registro.vecchi)) for (const r of [k, `${k}|${t.contesto?.livelli ? "intraday" : "trading"}`]) { const g = record.get(r) ?? { n: 0, v: 0 }; g.n++; if (t.incassato - t.costo > 0) g.v++; record.set(r, g); }
    const assegnazione = assegnaPersone({
      stateDir: deps.stateDir,
      now: startedAt,
      bisogni,
      sospesi: [...formazione.inFormazione].sort((a, b) => a.dal.localeCompare(b.dal)).map((x) => x.chiave),
      // Thompson sampling: un'estrazione dalla distribuzione Beta(vinti + 1, persi + 1) di ogni persona in quel tipo.
      punteggio: (p, tipo) => { const g = record.get(`${p}|${tipo}`) ?? record.get(p) ?? { n: 0, v: 0 }; return estraiBeta(g.v + 1, g.n - g.v + 1); },
      media: (p, tipo) => { const g = record.get(`${p}|${tipo}`) ?? record.get(p); return g ? (g.v + 1) / (g.n + 2) : 0.5; },
      rientro: (p, desk, rep, scrivania) => provaRientro(deps.stateDir, formazione, p, votiDi(desk), view.previsioni, scrivania, rep === "intraday" ? AGENTS.formazione.minIntraday : AGENTS.formazione.minOperativi, startedAt),
    });
    // Esplorazione (occasione data a chi ha meno dati): taglia ridotta a 3/4.
    for (const r of Object.values(reports)) r.segnali = r.segnali.map((s) => {
      if (s.lato !== "buy" || s.vincolante || !assegnazione.esplorazione.includes(postazioneDelVoto(s))) return s;
      return { ...s, pesoMassimo: (s.pesoMassimo ?? LIMITS.maxPositionPct) * 0.75, perche: `${s.perche} · occasione di apprendimento per chi ha meno trade: taglia ridotta` };
    });
    // Una sola posizione per titolo: su un titolo con un'operazione intraday aperta non entra nessun voto di più giorni
    // (neanche degli agenti generali), e viceversa (i voti intraday li ferma già l'assegnazione).
    const posizioniAperte = new Set(view.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    for (const r of Object.values(reports)) r.segnali = r.segnali.filter((s) => {
      if (s.lato === "buy" && !s.vincolante && s.intraday && posizioniAperte.has(s.simbolo) && !inIntraday.has(s.simbolo)) {
        assegnazione.note.push(`voto intraday su ${s.simbolo} non vale: c'è già una posizione di più giorni, una sola posizione per titolo`);
        return false;
      }
      if (s.lato !== "buy" || s.vincolante || s.intraday || !inIntraday.has(s.simbolo)) return true;
      assegnazione.note.push(`voto di ${s.agente} su ${s.simbolo} non vale: c'è già un'operazione intraday aperta, una sola posizione per titolo`);
      return false;
    });
    for (const n of [...formazione.note, ...assegnazione.note.map((n) => `ufficio: ${n}`), ...applicaFormazione(deps.stateDir, reports, formazione, view.previsioni, assegnazione.chi, new Set(assegnazione.senzaPersona), startedAt, assegnazione.bloccati)]) {
      log.info(n);
      bus.emit("nota", { testo: n });
    }
    // I richiami del capo valgono per la persona che prende il voto (o per l'agente generale che l'ha dato).
    for (const n of applyGuidance(reports, capo, view.previsioni, (s) => { const d = postazioneDelVoto(s); return d.startsWith("a:") ? d.slice(2) : assegnazione.chi[d]; })) {
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
    const weights = pesiUguali(deps.agents);
    const alloc = allocate(view, reports, weights);
    // Nessun acquisto senza una persona alla scrivania: ogni trade ha qualcuno che ne risponde (e da cui si impara).
    // (Senza trading agents né intraday agents nel motore, ad esempio in una prova con i soli agenti generali, non c'è
    // staff e la regola non si applica.)
    const conStaff = deps.agents.some((a) => a.name === "custodi" || a.name === "intraday");
    alloc.proposte = alloc.proposte.filter((o) => {
      if (!conStaff || o.side !== "buy" || assegnazione.chi[`c:${o.symbol}`] || assegnazione.chi[`i:${o.symbol}`]) return true;
      alloc.inAttesa.push({ simbolo: o.symbol, motivo: "nessuna persona alla scrivania su questo titolo (non è «pronto a entrare» o lo staff è tutto occupato): non si compra" });
      return false;
    });
    // Meta-modello e Kelly frazionario sugli acquisti: il meta-modello (se attivo) stima la probabilità che il trade finisca
    // in guadagno e sotto il 45% lo ferma; Kelly (un quarto) ferma i trade ad aspettativa stimata negativa e limita la
    // taglia a quota di rischio / distanza dello stop.
    alloc.proposte = alloc.proposte.filter((o) => {
      if (o.side !== "buy") return true;
      const price = snap.prices[o.symbol];
      if (!price) return true;
      const tipo: "trading" | "intraday" = o.intraday ? "intraday" : "trading";
      const voti = Object.values(reports).flatMap((r) => r.segnali).filter((x) => x.lato === "buy" && x.simbolo === o.symbol);
      const dos = Object.values(reports).flatMap((r) => r.custodi ?? []).find((c) => c.simbolo === o.symbol)?.dossier;
      const grezza = o.intraday ? voti.find((x) => x.intraday && x.misure?.probabilita !== undefined)?.misure?.probabilita : (dos?.grezza ?? dos?.probabilita ?? voti.find((x) => x.misure?.probabilita !== undefined)?.misure?.probabilita);
      const ctx = contextFor(indicators[o.symbol], price, null, "", "");
      const pm = grezza !== undefined ? probMeta({ probabilita: grezza, kronos: view.previsioni?.[o.symbol] ?? 0, distanzaMedia: ctx.distanzaMedia ?? 0, vol: ctx.volGiornaliera ?? 0, momentum: ctx.momentum20 ?? 0, crypto: isCrypto(o.symbol) ? 1 : 0, intraday: o.intraday ? 1 : 0 }) : null;
      const fuori = (motivo: string) => { alloc.inAttesa.push({ simbolo: o.symbol, motivo }); return false; };
      if (pm !== null && pm < META.soglia) return fuori(`il meta-modello stima solo ${Math.round(pm * 100)}% di probabilità che il trade finisca in guadagno (minimo ${Math.round(META.soglia * 100)}%)`);
      const p = pm ?? (grezza !== undefined ? calibraP(tipo, grezza) : null);
      if (p === null) return true;
      const lv = Object.values(reports).flatMap((r) => r.intraday ?? []).find((x) => x.simbolo === o.symbol && x.livelli)?.livelli;
      const stop = o.intraday && lv ? Math.max(0.002, 1 - lv.stop / price) : stopPctFor(closes[o.symbol]);
      const b = rapportoVinciPerdi(journal, tipo) ?? (o.intraday && lv ? Math.max(0.5, (lv.obiettivo / price - 1) / stop) : KELLY.bDiSerie);
      const kw = pesoKelly(p, b, stop);
      if (kw === null) return fuori(`aspettativa stimata negativa (probabilità ${Math.round(p * 100)}%, guadagno medio / perdita media ${b.toFixed(2)}): Kelly dice di non entrare`);
      const eq = snap.account.equity;
      let qty = o.qty;
      if (pm !== null) qty = qty * Math.max(0.5, Math.min(1, 0.5 + (pm - META.soglia) / 0.3));
      if (eq > 0 && (qty * price) / eq > kw) qty = (kw * eq) / price;
      qty = roundQty(o.symbol, qty);
      if (qty <= 0 || (isCrypto(o.symbol) && qty * price < CRYPTO_MIN_NOTIONAL)) return fuori("taglia troppo piccola dopo Kelly e meta-modello");
      if (qty < o.qty) o.expect = `${o.expect} · taglia ridotta da ${pm !== null ? "meta-modello e " : ""}Kelly frazionario`;
      o.qty = qty;
      return true;
    });
    // Un titolo votato ma in attesa (contesto, Kronos al ribasso) non è un ordine rifiutato: nessuna quantità, evento a sé.
    for (const w of alloc.inAttesa) bus.emit("attesa", { simbolo: w.simbolo, motivo: w.motivo });
    // Chi aveva preso un titolo che il riparto mette «in attesa» torna in sala caffè (resta chi segue una posizione).
    for (const n of rilascia(deps.stateDir, assegnazione, new Set(alloc.inAttesa.map((w) => w.simbolo)), new Set(view.positions.filter((p) => p.qty > 0).map((p) => p.symbol)), startedAt)) { log.info(`ufficio: ${n}`); bus.emit("nota", { testo: `ufficio: ${n}` }); }
    bus.emit("allocazione", { rischio: alloc.rischio, pesi: weights, punteggi: alloc.punteggi, proposte: alloc.proposte, inAttesa: alloc.inAttesa });

    // 5. Gabbia: gli acquisti solo nella finestra di ingresso, le vendite e gli stop sempre a mercato aperto.
    const entry = stockEntryOpen(snap.clock, startedAt);
    const cage = applyCage({ today, marketOpen: snap.clock.isOpen, account: snap.account, positions: snap.positions, prices: snap.prices, closes, recentOrders: snap.recentOrders, lessons: lessonsNow, buyBlock, proposals: alloc.proposte, previsioni: view.previsioni, apertiOggi: openedToday(view), intradayAperti: simboliIntraday(journal) });
    // Un acquisto fermato dalla gabbia non apre nulla: chi l'aveva preso torna in sala caffè.
    for (const n of rilascia(deps.stateDir, assegnazione, new Set(cage.rejected.filter((r) => r.side === "buy").map((r) => r.symbol)), new Set(view.positions.filter((p) => p.qty > 0).map((p) => p.symbol)), startedAt)) { log.info(`ufficio: ${n.replace("è in attesa", "acquisto fermato dalle regole")}`); }
    for (const x of cage.rejected) {
      log.warn(`rifiutato ${x.side} ${x.qty} ${x.symbol} [${x.source}]: ${x.reason}`);
      bus.emit("rifiuto", { simbolo: x.symbol, lato: x.side, quantita: x.qty, origine: x.source, motivo: x.reason });
    }
    // Le simulazioni di oggi si rivalutano con i prezzi di adesso: come sarebbe andata.
    const simulazioni = simulations.evaluate(deps.stateDir, today, snap.prices);
    // Un ID per giro, per acquisti e vendite: un nuovo tentativo nello stesso giro non si duplica (Alpaca rifiuta l'ID già
    // usato) e un ordine ancora aperto ferma il doppione nella gabbia. Più acquisti dello stesso titolo nella giornata
    // (un'aggiunta dal riparto, un'operazione intraday) sono ammessi; l'intraday ha il suo limite di un ingresso al giorno.
    const runIdFor = (_side: string) => giro;
    for (const o of cage.orders) {
      const sc = alloc.punteggi.find((p) => p.simbolo === o.symbol);
      const proposed = alloc.proposte.find((p) => p.symbol === o.symbol && p.side === o.side);
      const ctx = contextFor(indicators[o.symbol], snap.prices[o.symbol], o.source === "modello" ? (proposed?.confidence ?? null) : null, o.source === "modello" ? (proposed?.expect ?? "") : "", o.why);
      if (o.source === "modello" && sc) {
        ctx.agenti = sc.agenti;
        const chi = sc.agenti.map((a) => (a.startsWith("custode ") ? assegnazione.chi[`c:${o.symbol}`] : a === "intraday" ? (proposed?.intraday ? assegnazione.chi[`i:${o.symbol}`] : assegnazione.chi[`c:${o.symbol}`]) : `a:${a}`)).filter((k): k is string => !!k);
        if (chi.length) ctx.persone = [...new Set(chi)];
      }
      if (o.side === "buy") {
        // Le misure del momento: probabilità di riuscita (intraday: Kronos sulle candele; più giorni: dossier), RSI del
        // rientro; le impostazioni della persona in vigore sul titolo; il clima del mercato.
        const voti = Object.values(reports).flatMap((r) => r.segnali).filter((x) => x.lato === "buy" && x.simbolo === o.symbol);
        const dos = Object.values(reports).flatMap((r) => r.custodi ?? []).find((c) => c.simbolo === o.symbol)?.dossier;
        const dossierP = dos?.grezza ?? dos?.probabilita; // nel diario la stima grezza: la calibrazione si rifà su quella
        const pIntra = voti.find((x) => x.intraday && x.misure?.probabilita !== undefined)?.misure?.probabilita;
        const rsi2 = voti.find((x) => x.misure?.rsi2 !== undefined)?.misure?.rsi2;
        const misure: Record<string, number> = {};
        const prob = proposed?.intraday ? pIntra : (dossierP ?? pIntra);
        if (prob !== undefined) misure.probabilita = prob;
        if (rsi2 !== undefined) misure.rsi2 = rsi2;
        // Rimbalzo intraday dopo un calo netto: il calo dell'ultimo giorno, per giudicare a posteriori questi ingressi.
        const calo = voti.find((x) => x.intraday && x.misure?.rimbalzo !== undefined)?.misure?.rimbalzo;
        if (calo !== undefined) misure.rimbalzo = calo;
        if (Object.keys(misure).length) ctx.misure = misure;
        ctx.impostazioni = Object.fromEntries(TUTTI_PERSONALI.map((k) => [k, Number(valore(k, o.symbol))]));
        if (view.contesto?.generale) ctx.clima = view.contesto.generale;
        ctx.tipo = proposed?.intraday ? "intraday" : "trading";
      }
      if (view.previsioni?.[o.symbol] !== undefined) ctx.kronos = view.previsioni[o.symbol];
      // Operazione intraday: i livelli decisi all'ingresso vanno nel diario con il trade (sopravvivono a un riavvio).
      if (o.side === "buy" && proposed?.intraday) {
        const lv = Object.values(reports).flatMap((r) => r.intraday ?? []).find((x) => x.simbolo === o.symbol && x.livelli)?.livelli;
        if (lv) ctx.livelli = lv;
      }
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
    const equitiesOpen = !tradingBlockReason({ marketOpen: snap.clock.isOpen, account: snap.account });
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
      biblioteca: { principi: BIBLIOTECA },
      mercatoAperto: snap.clock.isOpen,
      finestraIngressi: entry && snap.clock.isOpen,
      conto: { patrimonio: account.equity, contanti: account.cash, pnlGiorno: account.equity - account.lastEquity },
      posizioni: positions.map((p) => {
        // Da quando la si tiene e chi l'ha votata: dal diario (il trade aperto su quel titolo).
        const t = journal.trade.find((x) => x.simbolo === p.symbol && x.stato === "aperto");
        return { simbolo: p.symbol, quantita: p.qty, prezzoCarico: p.avgEntryPrice, prezzoAttuale: p.currentPrice, variazione: lossPct(p), valore: p.marketValue, ...(t ? { dal: t.apertoIl, agenti: t.contesto?.agenti ?? [] } : {}) };
      }),
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
      lezioniAttive: lezioniDiSicurezza(lessonsFile, today),
      allarmi: alarms,
      diario: { stato: `${journal.trade.filter((t) => t.stato === "chiuso").length} trade chiusi: da questi imparano il capo ufficio e la sala caffè`, statistiche: statsOf(journal.trade) },
      confronto: bm.cmp,
      ultimoRiepilogo: cache.ultimoRiepilogo,
      tradeChiusiOggi: fills.closed.map((t) => ({ simbolo: t.simbolo, risultato: t.risultato ?? 0, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto" })),
      pnlOggi: { ...dailyPnl(journal, today), nonRealizzato: positions.reduce((s, p) => s + (p.currentPrice - p.avgEntryPrice) * p.qty, 0) },
      custodi: Object.values(reports).flatMap((r) => r.custodi ?? []),
      intraday: Object.values(reports).flatMap((r) => r.intraday ?? []),
      nomi: await nomiTitoli(deps.stateDir, deps.broker, [...AGENTS.universe, ...positions.map((p) => p.symbol), ...Object.values(reports).flatMap((r) => r.intraday ?? []).map((x) => x.simbolo)]).catch(() => ({})),
      persone: persone(assegnazione.reg, assegnazione.chi),
      calibrazione,
      universo: { titoli: AGENTS.universe.filter((s) => !isCrypto(s)), crypto: AGENTS.universe.filter(isCrypto), fonteCrypto: cache.universeInfo?.fonte ?? null, aggiornatoCrypto: cache.universeInfo?.aggiornato ?? null },
      kronos: { stato: deps.kronosStato?.() ?? (deps.forecaster ? "attivo" : "non configurato"), proiezioniDel: cache.previsioni?.giorno ?? null, simboli: Object.keys(cache.previsioni?.data ?? {}).length, scartate },
      giornataPersone: giornataP.perPersona,
      puntaIntraday: AGENTS.puntaIntraday,
      statistica,
      giornata: { pnlPct, obiettivoPct: AGENTS.daily.targetPct, pavimentoPct: AGENTS.daily.pavimentoPct, picco: giornata.picco, perditaMaxPct: AGENTS.daily.maxLossPct, obiettivoRaggiunto: giornata.obiettivoRaggiunto, difesa: giornata.difesa, perditaOltre: giornata.perditaOltre },
      simulazioni,
      analisi: { questoGiro: analisi, ultima: cache.ultimaAnalisi ?? null, prossima: cache.ultimaAnalisi ? new Date(Date.parse(cache.ultimaAnalisi) + AGENTS.analisiMinuti * 60_000).toISOString() : null, ogniMinuti: AGENTS.analisiMinuti },
      capo,
      fonti: fonti ? { paura: fonti.paura, funding: Object.fromEntries(AGENTS.universe.filter((u) => fonti!.funding[u] !== undefined).map((u) => [u, fonti!.funding[u]!])), errori: fonti.errori } : undefined,
      caffe: coffeeBreak({ now: deps.now(), reports, held: new Set([...positions.map((p) => p.symbol), ...cage.orders.filter((o) => o.side === "buy").map((o) => o.symbol)]), previsioni: view.previsioni, scartate, lezioni, capo, applicati: applicatiCaffe, giro: (cache.giriCaffe = (cache.giriCaffe ?? 0) + 1), primaInPausa: new Set((cache.caffePresenti ?? "").split(",").filter(Boolean)), esploratori: scout.esploratori, formazione, staff: { chi: assegnazione.chi, reg: assegnazione.reg } }),
      formazione,
    };
    // Esplorazione: con qualcuno in pausa si passa in rassegna un pezzo del radar (anche tra un giro e l'altro, ogni minuto).
    await exploreRound(deps, cache, today, espl, status.caffe!, (m) => log.info(m), (m) => log.warn(m));
    status.esplorazione = esplSummary(espl, today);
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
    if (deps.cervello) {
      deps.cervello.salva();
      status.cervello = deps.cervello.stato();
    }
    writeJsonAtomic(statusPath(deps.stateDir), status);
    log.info(`giro ${giro}${analisi ? " (con analisi d'ingresso)" : ""}: ${status.segnali.length} segnali, ${alloc.proposte.length} proposte, ${outcomes.length} ordini, ${cage.rejected.length} rifiuti, rischio ${alloc.rischio}`);

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
  await loadBars(deps, cache, limitiSedute(now).chiave, symbols, (m) => note.push(m));
  const closes = cache.closes;
  const indicators = indicatorsFor(closes, prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays);
  const lessonsFile = readLessons(deps.stateDir, now).file;
  const br = readBreaker(deps.stateDir);
  const buyBlock = !LIMITS.breakerEnabled ? null : br.kind === "corrupt" ? "interruttore illeggibile" : evaluateBreaker(br.file, account.equity, account.lastEquity, now.toISOString()).buyBlock;
  const journal = readJournal(deps.stateDir, now).file;
  const previsioniNum = riallinea(usableForecasts(cache.previsioni ? Object.fromEntries(Object.entries(cache.previsioni.data).map(([k, v]) => [k, v.rendimentoPrevisto])) : undefined, closes).usabili, cache.previsioni?.data, prices);
  const view: AgentView = { today, now, prices, closes, indicators, positions, account, journal, previsioni: previsioniNum, previsioniKronos: previsioniNum, mercatoAperto: clock.isOpen, chiusuraBorsa: clock.nextClose, finestraIngressi: stockEntryOpen(clock, now) };
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
  const weights = pesiUguali(deps.agents);
  const alloc = allocate(view, reports, weights);
  const voti = Object.values(reports).flatMap((r) => r.segnali).filter((s) => s.simbolo === symbol);
  const score = alloc.punteggi.find((p) => p.simbolo === symbol);
  const proposals = alloc.proposte.filter((p) => p.symbol === symbol);
  const entry = stockEntryOpen(clock, now);
  const recentOrders = open;
  const cage = applyCage({ today, marketOpen: clock.isOpen, account, positions, prices, closes, recentOrders, lessons: lezioniDiSicurezza(lessonsFile, today), buyBlock, proposals, previsioni: view.previsioni, apertiOggi: openedToday(view), intradayAperti: simboliIntraday(journal) });
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
// Orari in ora di Roma: solo l'ora se è lo stesso giorno, altrimenti giorno e ora; durata leggibile.
const quando = (iso: string, oggi: string) => {
  const d = new Date(iso);
  const ora = d.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
  return romeTime(d).date === oggi ? ora : `${d.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit" })} ${ora}`;
};
export const durata = (da: string, a: string) => {
  const m = Math.max(0, Math.round((Date.parse(a) - Date.parse(da)) / 60_000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${Math.floor(m / 1440)} g ${Math.floor((m % 1440) / 60)} h`;
};

export function pnlText(p: AgentsStatus["pnlOggi"]): string[] {
  const lines = [`💰 Profitto e perdita del ${p.data}`];
  if (!p.vendite.length && !p.acquisti.length) {
    lines.push(`Nessuna operazione oggi · non realizzato sulle posizioni aperte ${usd(p.nonRealizzato)}`);
    return lines;
  }
  const parziali = p.vendite.length - p.tradeChiusi;
  lines.push(`Realizzato ${usd(p.realizzato)} su ${p.vendite.length} vendit${p.vendite.length === 1 ? "a" : "e"} (${p.tradeChiusi} trade chius${p.tradeChiusi === 1 ? "o" : "i"}${parziali ? `, ${parziali} parzial${parziali === 1 ? "e" : "i"}` : ""})`);
  for (const v of p.vendite) lines.push(` • ${v.simbolo} ${qty(v.quantita)} × ${v.carico.toFixed(2)} → ${v.prezzo.toFixed(2)}: ${usd(v.pnl)} (${pct(v.risultato)})${v.chiuso ? "" : " parziale"}${v.aperto && v.ora ? ` · comprato ${quando(v.aperto, p.data)}, venduto ${quando(v.ora, p.data)} (${durata(v.aperto, v.ora)})` : ""} · ${v.motivo}${v.agenti.length ? ` · agenti ${v.agenti.join(", ")}` : ""}`);
  const perAgente = Object.entries(p.perAgente).sort((a, b) => b[1].pnl - a[1].pnl);
  if (perAgente.length) lines.push(`Per agente: ${perAgente.map(([a, g]) => `${a} ${usd(g.pnl)} (${g.operazioni} op.)`).join(", ")}`);
  if (p.acquisti.length) lines.push(`Acquisti di oggi: ${p.acquisti.map((a) => `${a.simbolo} ${qty(a.quantita)} @ ${a.prezzo.toFixed(2)}${a.ora ? ` alle ${quando(a.ora, p.data)}` : ""}${a.agenti.length ? ` (${a.agenti.join(", ")})` : ""}`).join("; ")}`);
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
// Un giro di esplorazione (dal giro del motore o dal timer di ogni minuto): legge il radar, aggiorna universo, candele e
// proiezioni in memoria, sposta lo scopritore dalla sala caffè alla scrivania, scrive il file dell'esplorazione.
async function exploreRound(deps: EngineDeps, cache: EngineCache, today: string, espl: ReturnType<typeof readEsplorazione>, caffe: CaffeReport, info: (m: string) => void, warn: (m: string) => void) {
  try {
    const giroEspl = await explore({
      now: deps.now(), today, file: espl, presenti: caffe.presenti, universe: AGENTS.universe, cryptoFuori: [],
      getBars: (syms) => retry(() => deps.broker.getDailyBars(syms, DAILY_BARS_DAYS), deps.sleep),
      forecast: deps.forecaster
        ? async (syms, bars) => {
            // Kronos una volta per giornata conclusa: i titoli già proiettati sull'ultima non si richiedono al sidecar.
            const out: Record<string, number> = {};
            const known = cache.previsioni?.data ?? {};
            const chiave = limitiSedute(deps.now()).chiave;
            for (const k of syms) if (aggiornata(known[k], k, chiave) || known[k]?.del === `esplorazione ${limiteDi(k, chiave)}`) out[k] = known[k]!.rendimentoPrevisto;
            const need = syms.filter((k) => out[k] === undefined);
            if (!need.length) return out;
            const raw = await deps.forecaster!(need, bars, "esplorazione");
            for (const [k, v] of Object.entries(raw)) {
              // Proiezione di scrematura (meno campioni): se il titolo entra nell'universo si rifà con il budget pieno.
              const fp = { ...normalizeForecast(v), del: `esplorazione ${limiteDi(k, chiave)}` };
              out[k] = fp.rendimentoPrevisto;
              if (cache.previsioni) cache.previsioni.data[k] = fp;
            }
            if (cache.previsioni) writeJsonAtomic(forecastsPath(deps.stateDir), { versione: 1, aggiornato: deps.now().toISOString(), giorno: cache.previsioni.giorno ?? today, chiave: cache.previsioni.date, orizzonte: AGENTS.kronos.horizon, previsioni: cache.previsioni.data });
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
        const i = caffe.presenti.findIndex((p) => p.chiave === n.scopritore);
        if (i >= 0) caffe.presenti.splice(i, 1);
        caffe.operativi.push({ chiave: n.scopritore, nome: n.agente, perche: `ha trovato ${n.simbolo}` });
        caffe.scambi.unshift({ da: n.scopritore, a: null, tema: "esplorazione", testo: `Ho trovato ${n.simbolo} (${n.settore}): ${n.motivo}. Torno alla scrivania, lo porto al motore.` });
      }
      if (giroEspl.nuove.length || giroEspl.esaminati.length) info(`esplorazione: ${giroEspl.messaggio}`);
      if (giroEspl.esaminati.length) deps.bus.emit("esplorazione", { esaminati: giroEspl.esaminati, nuove: giroEspl.nuove.map((n) => ({ simbolo: n.simbolo, agente: n.agente, kronos: n.kronos, motivo: n.motivo })), scartati: giroEspl.scartati });
    }
    writeEsplorazione(deps.stateDir, espl);
  } catch (e) {
    warn(`esplorazione non riuscita: ${(e as Error).message}`);
  }
}

const esplSummary = (espl: ReturnType<typeof readEsplorazione>, today: string) => ({
  ultimoGiro: espl.ultimoGiro,
  esito: espl.ultimoEsito,
  daEsaminareOggi: radar(AGENTS.universe).filter((x) => !espl.esaminati.includes(x)).length,
  attive: attive(espl, today),
  recenti: espl.scoperte.filter((x) => x.stato !== "attiva").slice(-6),
});

// Il timer di ogni minuto: tra un giro e l'altro gli agenti in sala caffè continuano a cercare. Salta se un giro è in corso;
// aggiorna nello stato solo sala caffè ed esplorazione.
export async function exploreNow(deps: EngineDeps, cache: EngineCache): Promise<void> {
  if (cache.inTick || cache.exploring) return;
  const r = readJson(statusPath(deps.stateDir), isObject);
  if (r.kind !== "ok") return;
  const status = r.value as unknown as AgentsStatus;
  if (!status.caffe?.presenti?.length) return;
  cache.exploring = true;
  try {
    const today = romeTime(deps.now()).date;
    const espl = readEsplorazione(deps.stateDir, today);
    const before = espl.ultimoGiro;
    await exploreRound(deps, cache, today, espl, status.caffe, (m) => console.log(`${deps.now().toISOString()} ${m}`), (m) => console.warn(`${deps.now().toISOString()} ${m}`));
    if (espl.ultimoGiro === before || cache.inTick) return;
    status.esplorazione = esplSummary(espl, today);
    writeJsonAtomic(statusPath(deps.stateDir), status);
  } finally {
    cache.exploring = false;
  }
}

export async function runEngine(deps: EngineDeps, tickMs: number, shouldStop: () => boolean = () => false, cache: EngineCache = emptyCache()): Promise<void> {
  while (!shouldStop()) {
    const t0 = deps.now().getTime();
    try {
      cache.inTick = true;
      const r = await runTick(deps, cache);
      if (deps.echo ?? true) console.log(`${deps.now().toISOString()} ${r.message}`);
    } catch (e) {
      console.error(`${deps.now().toISOString()} giro fallito: ${(e as Error).message}`);
      deps.bus.emit("allarme", { titolo: "Giro fallito", dettaglio: (e as Error).message });
    } finally {
      cache.inTick = false;
    }
    const wait = Math.max(5_000, tickMs - (deps.now().getTime() - t0));
    await deps.sleep(wait);
  }
}
