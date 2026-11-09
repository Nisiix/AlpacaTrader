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
  // Le persone che hanno preso l'occasione (p:Nome per trading e intraday agents, a:nome per gli agenti generali).
  persone?: string[];
  // Proiezione di Kronos all'ingresso: il capo ufficio la confronta con l'esito per consigliare la soglia giusta.
  kronos?: number;
  // Operazione intraday promossa a posizione di più giorni (ISO del momento): da lì la seguono le regole di più giorni.
  promossa?: string;
  // Livelli dell'operazione intraday decisi all'ingresso (candela, obiettivo, stop, orizzonte, sostegno delle candele
  // superiori): dopo un riavvio del motore l'operazione riparte con gli stessi, non con livelli ricalcolati.
  livelli?: LivelliIntraday;
}

export interface LivelliIntraday {
  candela: string;
  obiettivo: number;
  stop: number;
  orizzonteMin?: number;
  sopraMedia?: boolean;
  sostegno?: { tf: string; obiettivo: number; orizzonteMin: number };
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

// Le intenzioni si scrivono prima di inviare: se il processo muore dopo l'invio, il contesto del trade non si perde.
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

// Applica gli ordini eseguiti, ognuno una volta sola anche se la stessa finestra di ordini torna a ogni giro.
export function applyFills(file: JournalFile, orders: Order[]): { opened: Trade[]; closed: Trade[] } {
  const seen = new Set(file.ordiniVisti.map((x) => x.id));
  const fills = orders
    .filter((o) => !isOpenOrder(o) && o.filledQty > 0 && !seen.has(o.id))
    .sort((a, b) => (a.filledAt ?? a.submittedAt).localeCompare(b.filledAt ?? b.submittedAt));
  const opened: Trade[] = [];
  const closed: Trade[] = [];
  for (const o of fills) {
    // Senza prezzo di esecuzione non si può misurare: si riprova al prossimo giro.
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
    // Un resto frazionario non tiene aperto il trade: sulle crypto Alpaca trattiene la commissione in moneta (0,15-0,25%),
    // quindi oltre il 99% venduto il trade è chiuso; sui titoli oltre il 99,99%.
    if (open.quantita > open.comprate * dustShare(open.simbolo)) continue;
    open.quantita = 0;
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
  ora?: string; // ISO della vendita
  aperto?: string; // ISO dell'apertura del trade
}

export interface DailyPnl {
  data: string;
  vendite: DailySale[];
  acquisti: { simbolo: string; quantita: number; prezzo: number; agenti: string[]; ora?: string }[];
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
    for (const a of t.acquisti ?? []) if (romeDateOf(a.data) === today) acquisti.push({ simbolo: t.simbolo, quantita: a.quantita, prezzo: a.prezzo, agenti, ora: a.data });
    const sales = t.vendite ?? [];
    sales.forEach((v, i) => {
      if (romeDateOf(v.data) !== today) return;
      const last = i === sales.length - 1 && t.stato === "chiuso";
      let pnl = (v.prezzo - v.carico) * v.quantita;
      let risultato = v.carico ? v.prezzo / v.carico - 1 : 0;
      // L'ultima vendita di un trade chiuso porta il saldo vero (incassato − costo): dentro ci sono le commissioni e la
      // frazione di crypto trattenuta, così il conto di oggi e il giudizio del capo ufficio danno lo stesso numero.
      if (last && Number.isFinite(t.incassato) && Number.isFinite(t.costo) && t.costo > 0) {
        const before = sales.slice(0, i).reduce((a, x) => a + (x.prezzo - x.carico) * x.quantita, 0);
        pnl = t.incassato - t.costo - before;
        risultato = v.carico * v.quantita ? pnl / (v.carico * v.quantita) : risultato;
      }
      vendite.push({ simbolo: t.simbolo, quantita: v.quantita, carico: v.carico, prezzo: v.prezzo, pnl, risultato, motivo: v.motivo, agenti, chiuso: last, ora: v.data, aperto: t.apertoIl });
    });
    // Trade chiusi oggi da una versione precedente del diario, senza l'elenco delle vendite: conta il saldo.
    if (!sales.length && t.stato === "chiuso" && t.chiusoIl && romeDateOf(t.chiusoIl) === today) {
      vendite.push({ simbolo: t.simbolo, quantita: t.vendute, carico: t.prezzoIngresso ?? t.costo / t.comprate, prezzo: t.prezzoUscita ?? t.incassato / t.vendute, pnl: t.incassato - t.costo, risultato: t.risultato ?? 0, motivo: t.motivoUscita ?? "sconosciuto", agenti, chiuso: true, ora: t.chiusoIl, aperto: t.apertoIl });
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

const dustShare = (symbol: string) => (symbol.includes("/") ? 0.01 : 1e-4);

// Trade rimasti aperti per un resto frazionario prima della correzione: si chiudono con le vendite già registrate.
export function closeDust(file: JournalFile): Trade[] {
  const closed: Trade[] = [];
  for (const t of file.trade) {
    if (t.stato !== "aperto" || t.vendute <= 0 || t.quantita > t.comprate * dustShare(t.simbolo)) continue;
    const entry = t.costo / t.comprate;
    const exit = t.incassato / t.vendute;
    const last = t.vendite?.at(-1);
    Object.assign(t, { stato: "chiuso", quantita: 0, chiusoIl: last?.data ?? t.apertoIl, prezzoIngresso: entry, prezzoUscita: exit, risultato: exit / entry - 1, giorni: daysBetween(t.apertoIl, last?.data ?? t.apertoIl), motivoUscita: last?.motivo ?? "sconosciuto" });
    closed.push(t);
  }
  return closed;
}

export interface Stats {
  trade: number;
  vinti: number;
  percVinti: number | null;
  percCapitaleVinti: number | null;
  mediaVincita: number | null;
  mediaPerdita: number | null;
  attesa: number | null; // risultato medio per trade: è questo che dice se il metodo guadagna
  campione: "nessuno" | "troppo piccolo" | "indicativo" | "affidabile";
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function statsOf(trades: Trade[]): Stats {
  const chiusi = trades.filter((t) => t.stato === "chiuso" && t.risultato !== undefined);
  const r = chiusi.map((t) => t.risultato!);
  // Capitale sui vincenti: la parte del capitale investito nei trade chiusi finita in quelli in guadagno.
  const capV = chiusi.filter((t) => t.risultato! > 0).reduce((a, t) => a + t.costo, 0);
  const capT = chiusi.reduce((a, t) => a + t.costo, 0);
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const n = r.length;
  return {
    trade: n,
    vinti: wins.length,
    percVinti: n ? wins.length / n : null,
    percCapitaleVinti: capT > 0 ? capV / capT : null,
    mediaVincita: mean(wins),
    mediaPerdita: mean(losses),
    attesa: mean(r),
    campione: n === 0 ? "nessuno" : n < JOURNAL.minIndicative ? "troppo piccolo" : n < JOURNAL.minReliable ? "indicativo" : "affidabile",
  };
}


// Tiene il file piccolo: i trade restano tutti (sono la memoria), il resto solo finché serve.
export function pruneJournal(file: JournalFile, today: string) {
  const cut = addDays(today, -JOURNAL.keepIdsDays);
  file.ordiniVisti = file.ordiniVisti.filter((x) => x.data >= cut);
  file.intenzioni = file.intenzioni.filter((i) => i.data >= cut);
}

