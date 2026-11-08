import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isOpenOrder, isProtectiveStop, type Order } from "./broker/types.ts";
import { JOURNAL } from "./config.ts";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";
import type { Indicator } from "./indicators.ts";
import { activeLessons, type Lesson, type LessonsFile } from "./lessons.ts";
import { addDays, addTradingDays, romeTime } from "./slots.ts";

// Il diario dei trade: ogni acquisto eseguito apre un trade, la vendita che azzera la posizione lo chiude.
// La verità sono gli ordini eseguiti su Alpaca; qui sopra c'è solo il contesto (perché, fiducia, indicatori).
export type Confidence = "bassa" | "media" | "alta";

export interface EntryContext {
  setup: string;
  momentum20: number | null;
  volGiornaliera: number | null;
  distanzaMedia: number | null; // prezzo / media a 50 giorni - 1
  fiducia: Confidence | null;
  attesa: string;
  perche: string;
  // Motore degli agenti: quali agenti hanno votato l'ingresso (serve a pesarli sui risultati).
  agenti?: string[];
  // Proiezione di Kronos all'ingresso: il capo ufficio la confronta con l'esito per consigliare la soglia giusta.
  kronos?: number;
}

export interface Intent {
  id: string; // client_order_id
  simbolo: string;
  lato: string;
  origine: string;
  data: string;
  contesto: EntryContext;
}

export interface Trade {
  id: string; // client_order_id del primo acquisto
  simbolo: string;
  stato: "aperto" | "chiuso";
  apertoIl: string;
  comprate: number;
  costo: number;
  vendute: number;
  incassato: number;
  quantita: number; // ancora in mano
  contesto: EntryContext | null;
  // Prezzo massimo visto dall'ingresso: serve allo stop che segue il profitto.
  massimo?: number;
  chiusoIl?: string;
  prezzoIngresso?: number;
  prezzoUscita?: number;
  risultato?: number; // frazione, 0.021 = +2,1%
  giorni?: number;
  motivoUscita?: string;
  // Ogni esecuzione con la sua data: serve al conto giornaliero di profitto e perdita (anche sulle uscite parziali).
  acquisti?: Fill[];
  vendite?: SaleFill[];
}

export interface Fill {
  data: string; // ISO dell'esecuzione
  quantita: number;
  prezzo: number;
}

export interface SaleFill extends Fill {
  carico: number; // prezzo medio di carico al momento della vendita
  motivo: string;
}

export interface JournalFile {
  versione: 1;
  trade: Trade[];
  intenzioni: Intent[];
  ordiniVisti: { id: string; data: string }[];
}

const isJournalFile = (v: unknown): v is JournalFile => isObject(v) && v.versione === 1 && Array.isArray(v.trade) && Array.isArray(v.intenzioni) && Array.isArray(v.ordiniVisti);

export const journalPath = (stateDir: string) => join(stateDir, "journal.json");
export const emptyJournal = (): JournalFile => ({ versione: 1, trade: [], intenzioni: [], ordiniVisti: [] });

// Come il registro degli errori: un diario rotto si mette da parte, non si cancella.
export function readJournal(stateDir: string, now: Date): { file: JournalFile; problem?: string } {
  const p = journalPath(stateDir);
  const r = readJson(p, isJournalFile);
  if (r.kind === "ok") return { file: r.value };
  if (r.kind === "missing") return { file: emptyJournal() };
  const aside = `${p}.illeggibile-${now.getTime()}`;
  try {
    if (existsSync(p)) renameSync(p, aside);
  } catch {}
  return { file: emptyJournal(), problem: `diario dei trade illeggibile (${r.error}), messo da parte in ${aside}: riparto vuoto, le statistiche ripartono da zero` };
}

export function writeJournal(stateDir: string, file: JournalFile) {
  writeJsonAtomic(journalPath(stateDir), file);
}

export function setupOf(ind: Indicator | undefined): string {
  if (!ind || ind.momentum20 === null || ind.volGiornaliera === null) return "dati insufficienti";
  const m = ind.momentum20 >= JOURNAL.strongMomentum ? "forte" : "debole";
  const v = ind.volGiornaliera >= JOURNAL.highVol ? "alta" : "bassa";
  return `momentum ${m} · volatilità ${v}`;
}

export function contextFor(ind: Indicator | undefined, price: number | undefined, fiducia: Confidence | null, attesa: string, perche: string): EntryContext {
  const dist = ind?.sma50 && price ? price / ind.sma50 - 1 : null;
  return { setup: setupOf(ind), momentum20: ind?.momentum20 ?? null, volGiornaliera: ind?.volGiornaliera ?? null, distanzaMedia: dist, fiducia, attesa, perche };
}

// Le intenzioni si scrivono prima di inviare: se la sveglia muore dopo l'invio, il contesto del trade non si perde.
export function recordIntent(file: JournalFile, intent: Intent) {
  if (!file.intenzioni.some((i) => i.id === intent.id)) file.intenzioni.push(intent);
}

const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));

function exitReason(o: Order, intent: Intent | undefined): string {
  if (isProtectiveStop(o)) return "stop su Alpaca";
  if (intent?.origine === "stop-loss") return "stop loss del codice";
  if (intent?.origine === "uscita-trend") return "uscita di trend del codice";
  if (intent?.origine === "modello") return "scelta del modello";
  if (intent?.origine === "agenti") return `agenti: ${intent.contesto?.perche ?? ""}`.trim();
  return "sconosciuto";
}

// Applica gli ordini eseguiti, ognuno una volta sola anche se la stessa finestra di ordini torna a ogni sveglia.
export function applyFills(file: JournalFile, orders: Order[]): { opened: Trade[]; closed: Trade[] } {
  const seen = new Set(file.ordiniVisti.map((x) => x.id));
  const fills = orders
    .filter((o) => !isOpenOrder(o) && o.filledQty > 0 && !seen.has(o.id))
    .sort((a, b) => (a.filledAt ?? a.submittedAt).localeCompare(b.filledAt ?? b.submittedAt));
  const opened: Trade[] = [];
  const closed: Trade[] = [];
  for (const o of fills) {
    // Senza prezzo di esecuzione non si può misurare: si riprova alla prossima sveglia.
    if (!o.filledAvgPrice || o.filledAvgPrice <= 0) continue;
    const when = o.filledAt ?? o.submittedAt;
    file.ordiniVisti.push({ id: o.id, data: when.slice(0, 10) });
    const intent = file.intenzioni.find((i) => i.id === o.clientOrderId);
    const open = file.trade.find((t) => t.simbolo === o.symbol && t.stato === "aperto");
    const value = o.filledQty * o.filledAvgPrice;
    if (o.side === "buy") {
      if (open) {
        open.comprate += o.filledQty;
        open.costo += value;
        open.quantita += o.filledQty;
        (open.acquisti ??= []).push({ data: when, quantita: o.filledQty, prezzo: o.filledAvgPrice });
        continue;
      }
      const t: Trade = { id: o.clientOrderId, simbolo: o.symbol, stato: "aperto", apertoIl: when, comprate: o.filledQty, costo: value, vendute: 0, incassato: 0, quantita: o.filledQty, contesto: intent?.contesto ?? null, acquisti: [{ data: when, quantita: o.filledQty, prezzo: o.filledAvgPrice }] };
      file.trade.push(t);
      opened.push(t);
      continue;
    }
    // Vendita di una posizione nata prima del diario: non c'è un ingresso da misurare.
    if (!open) continue;
    const qty = Math.min(o.filledQty, open.quantita);
    (open.vendite ??= []).push({ data: when, quantita: qty, prezzo: o.filledAvgPrice, carico: open.costo / open.comprate, motivo: exitReason(o, intent) });
    open.vendute += qty;
    open.incassato += qty * o.filledAvgPrice;
    open.quantita -= qty;
    if (open.quantita > 0) continue;
    const entry = open.costo / open.comprate;
    const exit = open.incassato / open.vendute;
    Object.assign(open, { stato: "chiuso", chiusoIl: when, prezzoIngresso: entry, prezzoUscita: exit, risultato: exit / entry - 1, giorni: daysBetween(open.apertoIl, when), motivoUscita: exitReason(o, intent) });
    closed.push(open);
  }
  return { opened, closed };
}

// Profitto e perdita della giornata: ogni vendita eseguita oggi vale (prezzo - carico) × quantità, realizzato,
// attribuito agli agenti che avevano votato l'ingresso. Gli acquisti di oggi si elencano ma non pesano.
export interface DailySale {
  simbolo: string;
  quantita: number;
  carico: number;
  prezzo: number;
  pnl: number; // dollari
  risultato: number; // frazione
  motivo: string;
  agenti: string[];
  chiuso: boolean; // la vendita ha azzerato il trade
}

export interface DailyPnl {
  data: string;
  vendite: DailySale[];
  acquisti: { simbolo: string; quantita: number; prezzo: number; agenti: string[] }[];
  realizzato: number;
  tradeChiusi: number;
  perAgente: Record<string, { pnl: number; operazioni: number }>;
}

const romeDateOf = (iso: string) => romeTime(new Date(iso)).date;

export function dailyPnl(file: JournalFile, today: string): DailyPnl {
  const vendite: DailySale[] = [];
  const acquisti: DailyPnl["acquisti"] = [];
  for (const t of file.trade) {
    const agenti = t.contesto?.agenti ?? [];
    for (const a of t.acquisti ?? []) if (romeDateOf(a.data) === today) acquisti.push({ simbolo: t.simbolo, quantita: a.quantita, prezzo: a.prezzo, agenti });
    const sales = t.vendite ?? [];
    sales.forEach((v, i) => {
      if (romeDateOf(v.data) !== today) return;
      const last = i === sales.length - 1 && t.stato === "chiuso";
      vendite.push({ simbolo: t.simbolo, quantita: v.quantita, carico: v.carico, prezzo: v.prezzo, pnl: (v.prezzo - v.carico) * v.quantita, risultato: v.carico ? v.prezzo / v.carico - 1 : 0, motivo: v.motivo, agenti, chiuso: last });
    });
    // Trade chiusi oggi da una versione precedente del diario, senza l'elenco delle vendite: conta il saldo.
    if (!sales.length && t.stato === "chiuso" && t.chiusoIl && romeDateOf(t.chiusoIl) === today) {
      vendite.push({ simbolo: t.simbolo, quantita: t.vendute, carico: t.prezzoIngresso ?? t.costo / t.comprate, prezzo: t.prezzoUscita ?? t.incassato / t.vendute, pnl: t.incassato - t.costo, risultato: t.risultato ?? 0, motivo: t.motivoUscita ?? "sconosciuto", agenti, chiuso: true });
    }
  }
  const perAgente: DailyPnl["perAgente"] = {};
  for (const v of vendite) for (const a of v.agenti.length ? v.agenti : ["senza agente"]) {
    const g = (perAgente[a] ??= { pnl: 0, operazioni: 0 });
    g.pnl += v.pnl;
    g.operazioni += 1;
  }
  return { data: today, vendite, acquisti, realizzato: vendite.reduce((s, v) => s + v.pnl, 0), tradeChiusi: vendite.filter((v) => v.chiuso).length, perAgente };
}

export interface Stats {
  trade: number;
  vinti: number;
  percVinti: number | null;
  mediaVincita: number | null;
  mediaPerdita: number | null;
  attesa: number | null; // risultato medio per trade: è questo che dice se il metodo guadagna
  campione: "nessuno" | "troppo piccolo" | "indicativo" | "affidabile";
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function statsOf(trades: Trade[]): Stats {
  const r = trades.filter((t) => t.stato === "chiuso" && t.risultato !== undefined).map((t) => t.risultato!);
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const n = r.length;
  return {
    trade: n,
    vinti: wins.length,
    percVinti: n ? wins.length / n : null,
    mediaVincita: mean(wins),
    mediaPerdita: mean(losses),
    attesa: mean(r),
    campione: n === 0 ? "nessuno" : n < JOURNAL.minIndicative ? "troppo piccolo" : n < JOURNAL.minReliable ? "indicativo" : "affidabile",
  };
}

export function groupStats(trades: Trade[], key: (t: Trade) => string): Record<string, Stats> {
  const groups: Record<string, Trade[]> = {};
  for (const t of trades) if (t.stato === "chiuso") (groups[key(t)] ??= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, statsOf(v)]));
}

export const bySymbol = (t: Trade) => t.simbolo;
export const bySetup = (t: Trade) => t.contesto?.setup ?? "sconosciuto";
export const byConfidence = (t: Trade) => t.contesto?.fiducia ?? "non dichiarata";

// Finché la raccolta non è finita i primi dati non toccano le scelte: niente diario al modello, niente blocchi.
export function learningStatus(file: JournalFile, today: string): { attivo: boolean; motivo: string } {
  const closed = file.trade.filter((t) => t.stato === "chiuso").length;
  const first = file.trade.map((t) => t.apertoIl.slice(0, 10)).sort()[0];
  const from = first ? addDays(first, JOURNAL.observeDays) : null;
  if (from && today >= from && closed >= JOURNAL.minReliable) return { attivo: true, motivo: `apprendimento attivo: ${closed} trade chiusi dal ${first}` };
  const parts = [from ? (today >= from ? "periodo di osservazione finito" : `osservazione fino al ${from}`) : "nessun trade ancora", `${closed}/${JOURNAL.minReliable} trade chiusi`];
  return { attivo: false, motivo: `solo raccolta dati (${parts.join(", ")}): le statistiche non influenzano le scelte` };
}

// Impara dai risultati, ma solo stringendo: un titolo o un tipo di ingresso che perde con costanza
// non si compra per un po'. Un nuovo blocco sullo stesso gruppo serve solo se ci sono trade nuovi da allora.
export function learnFromJournal(lessons: LessonsFile, journal: JournalFile, today: string): Lesson[] {
  const learned: Lesson[] = [];
  if (!learningStatus(journal, today).attivo) return learned;
  const active = activeLessons(lessons, today);
  const consider = (kind: "titolo" | "setup", key: string, s: Stats) => {
    if (key === "sconosciuto" || key === "dati insufficienti") return;
    if (s.trade < JOURNAL.minForLesson || s.attesa === null || s.attesa >= 0 || (s.percVinti ?? 0) >= 0.5) return;
    const simbolo = kind === "titolo" ? key : "*";
    const setup = kind === "setup" ? key : undefined;
    const same = (l: Lesson) => l.tipo === "statistica" && l.simbolo === simbolo && l.setup === setup;
    if (active.some(same)) return;
    const prior = lessons.lezioni.filter(same).reduce((m, l) => Math.max(m, l.campione ?? 0), 0);
    if (prior >= s.trade) return;
    const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
    const l: Lesson = {
      id: `statistica-${kind}-${key}-${today}`,
      tipo: "statistica",
      simbolo,
      setup,
      lato: "buy",
      dal: today,
      finoAl: addTradingDays(today, JOURNAL.lessonDays),
      campione: s.trade,
      motivo: `${kind === "titolo" ? key : `ingressi con ${key}`}: ${s.trade} trade chiusi, ${s.vinti} vinti, risultato medio ${pct(s.attesa)}: niente acquisti per ${JOURNAL.lessonDays} giorni di borsa`,
    };
    lessons.lezioni.push(l);
    learned.push(l);
  };
  for (const [k, s] of Object.entries(groupStats(journal.trade, bySymbol))) consider("titolo", k, s);
  for (const [k, s] of Object.entries(groupStats(journal.trade, bySetup))) consider("setup", k, s);
  return learned;
}

// Tiene il file piccolo: i trade restano tutti (sono la memoria), il resto solo finché serve.
export function pruneJournal(file: JournalFile, today: string) {
  const cut = addDays(today, -JOURNAL.keepIdsDays);
  file.ordiniVisti = file.ordiniVisti.filter((x) => x.data >= cut);
  file.intenzioni = file.intenzioni.filter((i) => i.data >= cut);
}

// Quello che il modello vede a ogni sveglia.
export function journalForBrain(file: JournalFile) {
  const closed = file.trade.filter((t) => t.stato === "chiuso");
  return {
    statistiche: statsOf(file.trade),
    perTitolo: groupStats(file.trade, bySymbol),
    perTipoDiIngresso: groupStats(file.trade, bySetup),
    perFiducia: groupStats(file.trade, byConfidence),
    ultimiChiusi: closed.slice(-JOURNAL.recentForBrain).map((t) => ({ simbolo: t.simbolo, apertoIl: t.apertoIl.slice(0, 10), chiusoIl: t.chiusoIl?.slice(0, 10), risultato: t.risultato, giorni: t.giorni, uscita: t.motivoUscita, contesto: t.contesto })),
    aperti: file.trade.filter((t) => t.stato === "aperto").map((t) => ({ simbolo: t.simbolo, apertoIl: t.apertoIl.slice(0, 10), prezzoIngresso: t.costo / t.comprate, contesto: t.contesto })),
  };
}
