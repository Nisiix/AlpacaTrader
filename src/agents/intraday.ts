import type { IntradayBar } from "../broker/types.ts";
import { AGENTS, LIMITS, isCrypto, sectorOf } from "../config.ts";
import { dailyVol, momentum, sma, trendOf } from "../indicators.ts";
import { romeTime } from "../slots.ts";
import { caloNetto, erf, kronosProb, livelloMedie } from "./fiducia.ts";
import { prossimaTrimestrale } from "../events.ts";
import { addTradingDays } from "../slots.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";
import { valore } from "./profili.ts";
import { calibraP } from "./statistica.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { LivelliIntraday } from "../journal.ts";

// L'agente intraday: operazioni che nascono e muoiono nella stessa giornata, solo nel verso del trend giornaliero.
// Sceglie da solo la candela dalla volatilità del titolo (nervoso → 5 minuti, medio → 15, calmo → 4 ore), entra su una
// rottura dei massimi delle ultime 20 candele o su un rientro sulla media a 20 candele con RSI non tirato, e porta a
// casa: obiettivo di profitto (percentuale o 1,5 ATR, il maggiore), stop a 1,2 ATR, uscita se il prezzo rompe al ribasso
// la media a 20 candele, e comunque chiusura prima della fine della giornata. Le uscite sono regole vincolanti.
export type BarFetcher = (symbols: string[], timeframe: string, count: number) => Promise<Record<string, IntradayBar[]>>;

export interface IntradayStato {
  simbolo: string;
  candela: string; // "5Min" | "15Min" | "4Hour"
  fase: "in posizione" | "cerca ingresso" | "fuori orario" | "fermo";
  ingresso: number | null;
  obiettivo: number | null;
  stop: number | null;
  prezzo: number | null;
  motivo: string;
  orizzonte?: string; // l'orizzonte di Kronos scelto per l'ingresso (es. "2 h")
  controllo?: string; // la candela più breve su cui si segue la posizione (e cosa dice Kronos lì)
  livelli?: LivelliIntraday; // per un ingresso votato: i livelli che il motore salva nel diario con il trade
}

// La candela più breve su cui si segue una posizione (per decidere se tenere o vendere) e quella superiore (correttivo).
export const LOWER: Record<string, string> = { "5Min": "1Min", "15Min": "5Min", "1Hour": "15Min", "4Hour": "1Hour" };
export const UP: Record<string, string> = { "5Min": "1Hour", "15Min": "1Hour", "1Hour": "4Hour", "4Hour": "1Day" };
// Le candele superiori che Kronos legge per un'operazione su candele brevi (Triple Screen di Elder: la direzione la dà la
// candela lunga, il momento d'ingresso quella breve). Su 4 ore la candela superiore è il Kronos a 5 sedute.
export const SUPERIORI: Record<string, string[]> = { "1Min": ["15Min", "1Hour"], "5Min": ["1Hour", "4Hour"], "15Min": ["1Hour", "4Hour"], "1Hour": ["4Hour"] };

const tfMinutes = (tf: string) => (tf.endsWith("Min") ? Number(tf.replace("Min", "")) : tf.endsWith("Hour") ? Number(tf.replace("Hour", "")) * 60 : 1440);
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const etichetta = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${+(min / 60).toFixed(1)} h`);

// Gli orizzonti leggibili da una proiezione sulle candele `tf`: minuti dati in config, in candele intere (da 1 a maxCandele).
export function orizzonti(tf: string): { h: number; n: number }[] {
  const k = AGENTS.intraday.kronos;
  const step = tfMinutes(tf);
  const out: { h: number; n: number }[] = [];
  const visti = new Set<number>();
  for (const m of k.orizzontiMin) {
    const n = Math.round(m / step);
    if (n < 1 || n > k.maxCandele || visti.has(n)) continue;
    visti.add(n);
    out.push({ h: n * step, n });
  }
  return out;
}
// Quante candele si chiedono a Kronos per `tf`: quante servono per l'orizzonte più lungo.
export const profondita = (tf: string) => Math.max(1, ...orizzonti(tf).map((o) => o.n));
const nCandele = (tf: string, min: number) => Math.max(1, Math.round(min / tfMinutes(tf)));
const retAt = (path: number[], n: number) => path[Math.min(path.length, Math.max(1, n)) - 1]!;
const num = (x: number) => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x >= 0.01 ? x.toFixed(5) : x.toPrecision(4));

export function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

// ATR delle candele, senza i salti tra una seduta e l'altra: tra due candele separate da più di 1,5 volte il passo
// normale (la notte, il fine settimana delle azioni) la chiusura precedente non conta, vale solo massimo − minimo. Così lo
// stop di una candela da 1 ora non si allarga per il salto d'apertura.
export function atr(bars: IntradayBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const tempi = bars.slice(-(n + 1)).map((b) => Date.parse(b.t));
  const passi = tempi.slice(1).map((t, i) => t - tempi[i]!).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  const passo = passi.length ? passi[Math.floor(passi.length / 2)]! : null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!, prev = bars[i - 1]!;
    const salto = passo !== null && Date.parse(b.t) - Date.parse(prev.t) > 1.5 * passo;
    sum += salto ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  }
  return sum / n;
}

export function rsiOf(values: number[], n = 14): number | null {
  if (values.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// La candela giusta per il titolo: dalla volatilità giornaliera.
export function timeframeFor(closes: number[] | undefined): string {
  const v = closes ? dailyVol(closes, LIMITS.volLookbackDays) : null;
  const c = AGENTS.intraday;
  if (v === null) return c.timeframes.mid;
  return v >= c.volFast ? c.timeframes.fast : v >= c.volMid ? c.timeframes.mid : c.timeframes.slow;
}

// Lettura di una serie di candele: ingresso (rottura o rientro), livelli di obiettivo e stop.
export function readBars(bars: IntradayBar[], price: number, crypto: boolean): { entra: boolean; pattern: string; ema20: number | null; atr: number | null; rsi: number | null; targetPct: number; stopPct: number } {
  const c = AGENTS.intraday;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const a = atr(bars, 14);
  const r = rsiOf(closes, 14);
  const base = { ema20: e20, atr: a, rsi: r };
  const minTarget = crypto ? c.target.crypto : c.target.stocks;
  const minStop = crypto ? c.minStopPct.crypto : c.minStopPct.stocks;
  if (e20 === null || a === null || bars.length < 22) return { ...base, entra: false, pattern: "candele insufficienti", targetPct: minTarget, stopPct: minStop };
  const targetPct = Math.max(minTarget, (c.targetAtr * a) / price);
  const stopPct = Math.max(minStop, (c.stopAtr * a) / price);
  const last = bars[bars.length - 1]!, prev = bars[bars.length - 2]!;
  const prevHigh = Math.max(...bars.slice(-21, -1).map((b) => b.high));
  // Rottura: chiusura sopra i massimi delle 20 candele precedenti, con un movimento vero (almeno mezzo ATR).
  const breakout = last.close > prevHigh && last.close > e20 && last.close - prev.close >= 0.5 * a;
  // Rientro: trend sulla candela già in corso (le 6 candele prima del rientro chiuse sopra la media), la candela precedente
  // tocca la media (entro 0,2%) e l'ultima riparte chiudendo sopra il massimo di quella del rientro.
  const before = bars.slice(-8, -2);
  const trendOnTf = before.length === 6 && before.every((b) => b.close > e20);
  const pullback = trendOnTf && prev.low <= e20 * 1.002 && prev.low >= e20 * 0.99 && last.close > prev.high && last.close > e20 && last.close - prev.low >= 0.5 * a;
  // Troppo esteso: oltre 3 ATR sopra il livello di rottura (o la media a 20) si insegue, non si entra.
  const ext = (last.close - Math.max(prevHigh, e20)) / a;
  const tired = ext > c.maxExtensionAtr;
  const pattern = tired ? `${ext.toFixed(1)} ATR sopra la media a 20: troppo esteso per entrare` : breakout ? `rottura dei massimi delle ultime 20 candele (${num(prevHigh)}) sopra la media a 20 (${num(e20)})` : pullback ? `rientro sulla media a 20 candele (${num(e20)}) e ripartenza` : "nessun ingresso: né rottura né rientro";
  return { ...base, entra: !tired && (breakout || pullback), pattern, targetPct, stopPct };
}

// Kronos sulle candele intraday: per ogni titolo il rendimento previsto a fine delle prossime `horizon` candele.
// Restituisce, per titolo, il rendimento cumulato candela per candela (un numero vale come percorso piatto).
// Con i singoli percorsi (campioni) la probabilità e lo stop si leggono da quanti salgono e da quanto scendono i peggiori.
export type PrevisioneIntraday = number | number[] | { path: number[]; campioni?: number[][] };
export type IntradayForecast = (bars: Record<string, IntradayBar[]>, stepMinutes: number, horizon: number) => Promise<Record<string, PrevisioneIntraday>>;

// Dai percorsi di Kronos a `n` candele: quanti chiudono sopra `costo` senza scendere sotto −stop, e lo stop stesso (il
// quantile `qStop` dei minimi dei percorsi, tra `minStop` e `maxStop`).
export function letturaCampioni(campioni: number[][], n: number, costo: number, minStop: number, maxStop: number, qStop: number): { sopra: number; tot: number; stop: number } | null {
  const righe = campioni.filter((r) => r.length >= n && n >= 1);
  if (!righe.length) return null;
  const minimi = righe.map((r) => Math.min(0, ...r.slice(0, n))).sort((a, b) => a - b);
  const qi = Math.min(minimi.length - 1, Math.max(0, Math.floor(qStop * (minimi.length - 1))));
  const stop = Math.min(Math.max(minStop, maxStop), Math.max(minStop, -minimi[qi]!));
  const sopra = righe.filter((r) => r[n - 1]! > costo && Math.min(...r.slice(0, n)) > -stop).length;
  return { sopra, tot: righe.length, stop };
}

interface Operazione {
  simbolo: string;
  candela: string;
  giorno: string;
  ingresso: number;
  obiettivo: number;
  stop: number;
  aperta?: string; // ISO dell'ingresso (per la durata massima sulle crypto)
  // Riporto al giorno dopo: quante volte, da quando conta la nuova finestra (durata massima delle crypto, orizzonte) e il
  // giorno in cui si è deciso (le azioni non lo ridecidono a ogni giro fino alla chiusura).
  riporti?: number;
  rinnovo?: string;
  riportoGiorno?: string;
  orizzonteMin?: number; // orizzonte della proiezione di Kronos con cui si è entrati
  // Il prezzo è stato sopra la media a 20 della candela (all'ingresso o dopo). Solo allora "due candele sotto la media"
  // vuol dire che il movimento è finito: un ingresso deciso da Kronos sotto la media (ripartenza anticipata) non si chiude
  // per la stessa ragione per cui è entrato.
  sopraMedia?: boolean;
  // Trade di trend: le candele superiori (1 ora, 4 ore) vedono un rialzo netto. Obiettivo finale e orizzonte sono i loro,
  // lo stop è quello della candela superiore (deciso all'ingresso, mai allargato dopo) e le uscite «morbide» della candela
  // breve (media persa, orizzonte breve scaduto, calo previsto sulla candela da 1 minuto) non valgono finché le candele
  // superiori restano a favore: un calo di pochi minuti non chiude un movimento che continua sulle ore.
  sostegno?: { tf: string; obiettivo: number; orizzonteMin: number };
}

// L'affidabilità misurata di Kronos sulle candele di `stepMinutes` minuti (dal cervello): fattore 1 = come atteso.
// `simbolo`: per le misure della sua classe (azioni o crypto), se ce ne sono abbastanza.
export type AffidabilitaCandela = (stepMinutes: number, simbolo?: string) => { fattore: number; quota: number; campione: number; giusti?: number | null; resa?: number | null };

// L'obiettivo minimo per tipo: copre i costi di andata e ritorno con margine.
const minimoObiettivo = (s: string) => (isCrypto(s) ? AGENTS.intraday.target.crypto : AGENTS.intraday.target.stocks);

// Un'operazione intraday può diventare di più giorni? Sì se è in guadagno e il metodo di più giorni la comprerebbe adesso:
// sopra la media a 200 e sopra la 50 (o Kronos netto), Kronos a 5 sedute che copre i costi con probabilità sufficiente,
// nessuna attesa del contesto e nessuna trimestrale nei prossimi giorni.
export function promuovibile(v: AgentView, s: string, gain: number): { ok: boolean; perche: string } {
  const p = AGENTS.intraday.promozione;
  if (!p.enabled) return { ok: false, perche: "promozione spenta" };
  if (gain <= 0) return { ok: false, perche: "non in guadagno" };
  const c = v.closes[s];
  const t = trendOf(c, LIMITS.trendSmaDays, LIMITS.longSmaDays);
  const fc = v.previsioni?.[s];
  if (!t || t.close <= t.long) return { ok: false, perche: "sotto la media a 200 giorni" };
  if (t.close <= t.sma && !(fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia)) return { ok: false, perche: "sotto la media a 50 senza un rialzo netto di Kronos" };
  const costo = (isCrypto(s) ? AGENTS.costi.cryptoAndataRitorno : AGENTS.costi.azioniAndataRitorno) * AGENTS.costi.margineCosti;
  if (fc === undefined || fc < costo) return { ok: false, perche: `Kronos a ${AGENTS.kronos.horizon} sedute ${fc === undefined ? "n.d." : pct(fc)}: non copre i costi` };
  const pr = kronosProb(c, fc);
  if (pr === null || pr < p.minProb) return { ok: false, perche: `Kronos a ${AGENTS.kronos.horizon} sedute ${pct(fc)} con probabilità ${pr === null ? "n.d." : `${Math.round(pr * 100)}%`}: troppo bassa` };
  if (v.contesto?.attendi[s]) return { ok: false, perche: `il contesto dice di aspettare (${v.contesto.attendi[s]})` };
  const tri = isCrypto(s) ? null : prossimaTrimestrale(s, v.today);
  if (tri && tri.date <= addTradingDays(v.today, LIMITS.earningsBlackoutDays + 1)) return { ok: false, perche: `trimestrale il ${tri.date}` };
  return { ok: true, perche: `trend in corso, Kronos a ${AGENTS.kronos.horizon} sedute ${pct(fc)} (${Math.round(pr * 100)}%)` };
}

export class IntradayAgent implements Agent {
  private giroKronos = 0; // rotazione delle coppie titolo-candela da proiettare
  readonly name = "intraday";
  private operazioni = new Map<string, Operazione>();
  private entrateOggi = new Map<string, string>(); // simbolo -> giorno dell'ultimo ingresso
  // Ultima proiezione intraday per titolo: si ricalcola solo quando chiude una candela nuova.
  private kCache = new Map<string, { chiave: string; path: number[]; campioni?: number[][] }>();
  // La probabilità vista all'ultima proiezione di ogni coppia titolo-candela: decide chi si riproietta per primo.
  private ultimaProb = new Map<string, number>();
  // Gli stati delle candidate all'ultima analisi d'ingresso: tra un'analisi e l'altra restano visibili in dashboard.
  private ultimeCandidate: IntradayStato[] = [];
  constructor(
    private fetchBars: BarFetcher,
    private forecast: IntradayForecast | null = null,
    private affidabilita: AffidabilitaCandela | null = null,
    // File in cui tenere le proiezioni di Kronos sulle candele: dopo un riavvio si riparte da quelle ancora valide
    // (stessa candela), invece di restare «in attesa della proiezione» per qualche analisi.
    private cacheFile: string | null = null,
  ) {
    if (cacheFile) {
      const r = readJson(cacheFile, (x): x is Record<string, { chiave: string; path: number[]; campioni?: number[][] }> => isObject(x));
      if (r.kind === "ok") for (const [k, val] of Object.entries(r.value)) this.kCache.set(k, val);
    }
  }

  async observe(v: AgentView): Promise<AgentReport> {
    const c = AGENTS.intraday;
    const rt = romeTime(v.now);
    const segnali: Signal[] = [];
    const note: string[] = [];
    const stati: IntradayStato[] = [];
    const held = new Map(v.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
    // Le mie operazioni aperte: dal diario (trade aperti votati da "intraday") e dalla memoria del processo.
    const mine = new Set<string>();
    for (const t of v.journal.trade) if (t.stato === "aperto" && t.contesto?.agenti?.includes(this.name) && !t.contesto.promossa && held.has(t.simbolo)) mine.add(t.simbolo);
    for (const s of this.operazioni.keys()) if (held.has(s) && !v.journal.trade.some((t) => t.simbolo === s && t.stato === "aperto" && t.contesto?.promossa)) mine.add(s);
    for (const s of [...this.operazioni.keys()]) if (!held.has(s)) this.operazioni.delete(s);
    // Ingressi di oggi già fatti (anche dal diario, se il processo è ripartito).
    for (const t of v.journal.trade) if (t.apertoIl && romeTime(new Date(t.apertoIl)).date === v.today && t.contesto?.agenti?.includes(this.name)) this.entrateOggi.set(t.simbolo, v.today);

    // Crypto: nessuna finestra, si lavora 24 ore su 24; un'operazione dura al massimo c.cryptoOreMax ore.
    // Azioni: per tutta la seduta vera (orologio di Alpaca), ingressi fino a c.minutiPrimaChiusura.ingresso dalla chiusura,
    // operazioni chiuse a c.minutiPrimaChiusura.uscita dalla chiusura. Senza orologio valgono gli orari fissi di Roma.
    const minToClose = v.chiusuraBorsa ? (Date.parse(v.chiusuraBorsa) - v.now.getTime()) / 60_000 : null;
    const inWindow = (s: string) => {
      if (isCrypto(s)) return true;
      if (minToClose !== null) return v.mercatoAperto !== false && minToClose >= c.minutiPrimaChiusura.ingresso;
      const w = c.entry.stocks;
      return rt.minutes >= minutesOf(w.from) && rt.minutes <= minutesOf(w.to) && rt.weekday >= 1 && rt.weekday <= 5;
    };
    // Minuti dall'ingresso o, per un'operazione riportata al giorno dopo, dal riporto (la nuova finestra).
    const apertaDa = (s: string) => { const op = this.operazioni.get(s); const da = op?.rinnovo ?? op?.aperta; return da ? (v.now.getTime() - Date.parse(da)) / 60_000 : null; };
    const mustClose = (s: string) => !isCrypto(s) && this.operazioni.get(s)?.riportoGiorno === v.today ? false : isCrypto(s) ? (apertaDa(s) ?? 0) >= c.cryptoOreMax * 60 : minToClose !== null ? minToClose <= c.minutiPrimaChiusura.uscita : rt.minutes >= minutesOf(c.closeBy.stocks);
    // Minuti a disposizione per arrivare all'obiettivo: crypto la durata massima, azioni fino all'uscita prima della chiusura.
    const minutiPer = (s: string) => isCrypto(s) ? c.cryptoOreMax * 60 - (apertaDa(s) ?? 0) : minToClose !== null ? minToClose - c.minutiPrimaChiusura.uscita : minutesOf(c.closeBy.stocks) - rt.minutes;
    const chiusuraDi = (s: string) => isCrypto(s) ? `al massimo ${c.cryptoOreMax} ore` : `entro ${c.minutiPrimaChiusura.uscita} minuti dalla chiusura della borsa`;

    // Candidate: tutti i titoli e le crypto dell'universo nella finestra degli ingressi. Per un trade che si chiude in
    // giornata non decidono le medie giornaliere (50, 200) né il settimanale: decidono la proiezione di Kronos sulle
    // candele brevi e le medie brevi della candela scelta; il grafico più lungo e il Kronos a 5 sedute pesano solo sulla
    // taglia. Senza Kronos intraday (sidecar spento) vale il Kronos a 5 sedute, come prima.
    // Ingressi di oggi sullo stesso titolo: dopo un'operazione chiusa in guadagno si può rientrare (al massimo
    // ingressiGiorno.max volte); dopo una chiusa in perdita, o con una ancora aperta, no.
    const bloccatoOggi = (s: string): string | null => {
      const oggi = v.journal.trade.filter((t) => t.simbolo === s && t.apertoIl && romeTime(new Date(t.apertoIl)).date === v.today && t.contesto?.agenti?.includes(this.name)).sort((a, b) => a.apertoIl.localeCompare(b.apertoIl));
      if (!oggi.length) return this.entrateOggi.get(s) === v.today ? "ingresso appena fatto" : null;
      if (oggi.length >= c.ingressiGiorno.max) return `già ${oggi.length} ingressi oggi`;
      const ultimo = oggi.at(-1)!;
      if (ultimo.stato !== "chiuso") return "operazione di oggi ancora aperta";
      if (!(ultimo.incassato - ultimo.costo > 0)) return "ultima operazione di oggi non chiusa in guadagno";
      return null;
    };
    const candidates: string[] = [];
    for (const s of AGENTS.universe) {
      if (v.analisi === false) break; // la scansione delle candidate si fa nell'analisi d'ingresso, ogni AGENTS.analisiMinuti
      if (v.giornata?.perditaOltre) break; // oltre la perdita massima del giorno (se impostata) niente ingressi
      if (held.has(s) || bloccatoOggi(s)) continue;
      if (!inWindow(s)) continue;
      if (!v.closes[s] || !v.prices[s]) continue;
      if (!this.forecast) {
        const fc = v.previsioni?.[s];
        if (fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia / 2) continue; // senza Kronos intraday: niente contro il Kronos a 5 sedute
      }
      candidates.push(s);
    }
    // Prima i titoli con la proiezione migliore a 5 sedute (solo per l'ordine in cui si guardano).
    candidates.sort((a, b) => (v.previsioni?.[b] ?? 0) - (v.previsioni?.[a] ?? 0));
    // Con Kronos intraday ogni candidato si guarda su tutte le candele (5 min, 15 min, 1 ora, 4 ore) e si sceglie quella con
    // la probabilità di successo più alta; senza Kronos vale la candela scelta dalla volatilità, come prima.
    const TFS = this.forecast ? c.candele : [];
    const candTfs = new Map<string, string[]>();
    for (const s of candidates) candTfs.set(s, this.forecast ? (isCrypto(s) ? TFS : TFS.filter((tf) => c.candeleAzioni.includes(tf))) : [timeframeFor(v.closes[s])]);
    const tfOfMine = new Map<string, string>();
    for (const s of mine) tfOfMine.set(s, this.operazioni.get(s)?.candela ?? v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.contesto?.livelli?.candela ?? timeframeFor(v.closes[s]));
    // Candele: per i candidati su ogni candela da valutare, per le posizioni sulla loro candela e su quella più breve
    // (si decide se tenere o vendere guardando più da vicino), più la candela superiore per il correttivo.
    const want = new Map<string, Set<string>>();
    const ask = (tf: string, s: string) => { if (tf === "1Day") return; (want.get(tf) ?? want.set(tf, new Set()).get(tf)!).add(s); };
    for (const [s, tfs] of candTfs) for (const tf of tfs) { ask(tf, s); ask(UP[tf] ?? "1Day", s); }
    for (const [s, tf] of tfOfMine) { ask(tf, s); ask(LOWER[tf] ?? tf, s); for (const sup of SUPERIORI[tf] ?? []) ask(sup, s); }
    // Le candele di tutti i passi insieme (richieste in parallelo): prima si scaricavano una dopo l'altra.
    const barsBy = new Map<string, Record<string, IntradayBar[]>>();
    const tCandele = Date.now();
    await Promise.all([...want].map(async ([tf, syms]) => {
      try {
        barsBy.set(tf, await this.fetchBars([...syms], tf, c.bars));
      } catch (e) {
        note.push(`candele ${tf} non disponibili: ${(e as Error).message}`);
        barsBy.set(tf, {});
      }
    }));
    const msCandele = Date.now() - tCandele;
    const barsOf = (s: string, tf: string) => barsBy.get(tf)?.[s];
    // Kronos sulle prossime candele, una proiezione per titolo e candela finché non ne chiude una nuova.
    let msKronos = 0, serieKronos = 0;
    // Una proiezione di Kronos parte dalla chiusura dell'ultima candela, ma si usa per tutta la candela (fino a un'ora o
    // quattro): nel frattempo il prezzo si muove. Rendimenti (percorso e singoli percorsi) riportati al prezzo di adesso:
    // un rialzo già fatto non si conta due volte (prima, a obiettivo raggiunto, si rientrava con la stessa proiezione).
    const prezzoDi = (s: string) => v.prices[s] ?? held.get(s)?.currentPrice;
    const attuale = (s: string, tf: string, path: number[]) => {
      const base = barsOf(s, tf)?.at(-1)?.close, p = prezzoDi(s);
      if (!(base! > 0) || !(p! > 0)) return path;
      const rel = base! / p!;
      return Math.abs(rel - 1) < 1e-12 ? path : path.map((r) => (1 + r) * rel - 1);
    };
    const kronosOn = async (pairs: { s: string; tf: string }[]) => {
      const out = new Map<string, number[]>();
      if (!this.forecast || !pairs.length) return out;
      const t0 = Date.now();
      try { return await kronosSu(pairs, out); } finally { msKronos += Date.now() - t0; }
    };
    const kronosSu = async (pairs: { s: string; tf: string }[], out: Map<string, number[]>) => {
      if (!this.forecast) return out;
      const byTf = new Map<string, string[]>();
      for (const p of pairs) byTf.set(p.tf, [...(byTf.get(p.tf) ?? []), p.s]);
      for (const [tf, syms] of byTf) {
        const keyOf = (s: string) => `${tf}|${barsOf(s, tf)!.at(-1)!.t}`;
        const need = syms.filter((s) => this.kCache.get(`${s}|${tf}`)?.chiave !== keyOf(s));
        if (need.length) {
          serieKronos += need.length;
          try {
            const n = profondita(tf);
            const r = await this.forecast(Object.fromEntries(need.map((s) => [s, barsOf(s, tf)!])), tfMinutes(tf), n);
            for (const s of need) {
              const x = r[s];
              if (x === undefined) continue;
              const path = Array.isArray(x) ? x : typeof x === "number" ? Array.from({ length: n }, () => x) : x.path;
              const campioni = typeof x === "object" && !Array.isArray(x) && x.campioni?.length ? x.campioni : undefined;
              this.kCache.set(`${s}|${tf}`, { chiave: keyOf(s), path, ...(campioni ? { campioni } : {}) });
            }
            if (this.cacheFile) { try { writeJsonAtomic(this.cacheFile, Object.fromEntries(this.kCache)); } catch {} }
          } catch (e) {
            note.push(`Kronos intraday non disponibile (${tf}): ${(e as Error).message}`);
          }
        }
        for (const s of syms) { const k = this.kCache.get(`${s}|${tf}`); if (k && k.chiave === keyOf(s)) out.set(`${s}|${tf}`, attuale(s, tf, k.path)); }
      }
      return out;
    };
    const sdOf = (b: IntradayBar[]) => {
      const rets = b.slice(-50).map((x, i, arr) => (i ? x.close / arr[i - 1]!.close - 1 : 0)).slice(1);
      return rets.length > 5 ? Math.sqrt(rets.reduce((a2, x) => a2 + x * x, 0) / rets.length) : null;
    };
    // Proiezione credibile: entro maxAbs e entro zMax volte la volatilità delle candele sull'orizzonte.
    const credibile = (b: IntradayBar[], k: number, candele: number) => {
      if (Math.abs(k) > AGENTS.kronos.maxAbs) return false;
      const sd = sdOf(b);
      return sd === null || sd <= 0 || Math.abs(k) / (sd * Math.sqrt(candele)) <= c.kronos.zMax;
    };
    const probOf = (b: IntradayBar[], k: number, candele: number) => {
      const rets = b.slice(-50).map((x, i, arr) => (i ? x.close / arr[i - 1]!.close - 1 : 0)).slice(1);
      const sd = rets.length > 5 ? Math.sqrt(rets.reduce((a2, x) => a2 + x * x, 0) / rets.length) : null;
      return sd ? 0.5 * (1 + erf(k / (sd * Math.sqrt(candele)) / Math.SQRT2)) : null;
    };
    // Costo di andata e ritorno: il rialzo previsto deve coprirlo `margineCosti` volte.
    const costoVero = (s: string) => (isCrypto(s) ? AGENTS.costi.cryptoAndataRitorno : AGENTS.costi.azioniAndataRitorno);
    const costoDi = (s: string) => costoVero(s) * AGENTS.costi.margineCosti;
    // Rialzo minimo per entrare su una candela: di norma `margineCosti` volte i costi. Crypto sulle candele brevi (fuori da
    // intraday.crypto.candele, cioè 5 e 15 minuti): almeno crypto.rialzoCosti volte i costi (0,4% × 3 = 1,2%), perché lì
    // il vantaggio misurato di Kronos è più piccolo dei costi di andata e ritorno.
    const breveCrypto = (s: string, tf: string) => isCrypto(s) && !c.crypto.candele.includes(tf);
    const minRialzo = (s: string, tf: string) => (breveCrypto(s, tf) ? Math.max(costoDi(s), c.crypto.rialzoCosti * costoVero(s)) : costoDi(s));
    const quanteVolte = (s: string, tf: string) => (breveCrypto(s, tf) ? Math.max(AGENTS.costi.margineCosti, c.crypto.rialzoCosti) : AGENTS.costi.margineCosti);
    // Affidabilità di Kronos sulla candela (misurata dal cervello; senza cervello 1).
    const affOf = (tf: string, s?: string) => this.affidabilita?.(tfMinutes(tf), s) ?? { fattore: 1, quota: AGENTS.intraday.affidabilita.prior, campione: 0 };
    // Probabilità di un guadagno netto dei costi sull'orizzonte, corretta per l'affidabilità della candela: è il criterio
    // con cui si confrontano candele e orizzonti diversi (un +1,5% in 15 minuti e un +3% in 4 ore si misurano sulla stessa
    // scala: rialzo netto rispetto al rumore atteso in quel tempo, su una candela di cui Kronos ha dimostrato di capire).
    // Candele su cui Kronos non ha un vantaggio misurato: non si entra e non confermano né bloccano le altre (ma si
    // continuano a misurare, poche coppie a giro). Tre casi: tante previsioni con un fattore d'affidabilità troppo basso;
    // abbastanza previsioni con la direzione giusta meno della metà delle volte (peggio di una moneta); tante previsioni
    // che, seguite, non rendono (resa media ≤ minResa: es. le 15 minuti, giuste il 51% ma con resa −0,06%).
    const senzaVantaggio = (tf: string, s?: string) => {
      if (this.forecast === null) return false;
      const a = affOf(tf, s), w = c.vantaggio;
      return (a.campione >= w.minCampione && a.fattore < w.minFattore) || (a.campione >= w.minCampioneContro && a.giusti !== undefined && a.giusti !== null && a.giusti < w.minGiusti) || (a.campione >= w.minCampione && a.resa !== undefined && a.resa !== null && a.resa <= w.minResa);
    };
    // Dai singoli percorsi di Kronos (se ci sono): quanti chiudono sopra i costi senza toccare lo stop, e lo stop.
    const stopAtrDi = (s: string, b: IntradayBar[]) => { const a = atr(b, 14); const last = b.at(-1)?.close; const min = isCrypto(s) ? c.minStopPct.crypto : c.minStopPct.stocks; return a !== null && last ? Math.max(min, (c.stopAtr * a) / last) : min; };
    const daCampioni = (s: string, tf: string, b: IntradayBar[], candele: number) => {
      const grezzi = this.kCache.get(`${s}|${tf}`)?.campioni;
      if (!grezzi || grezzi.length < c.percorsi.minCampioni) return null;
      const cs = grezzi.map((r) => attuale(s, tf, r));
      return letturaCampioni(cs, candele, costoVero(s), isCrypto(s) ? c.minStopPct.crypto : c.minStopPct.stocks, stopAtrDi(s, b), c.percorsi.quantileStop);
    };
    // Con i percorsi: 0,5 + fattore × (quota − 0,5), la quota con mezzo percorso in più per parte (16 su 16 non fa 100%).
    // Senza: Φ(fattore × z), z = (rialzo previsto − costi) / (volatilità × √candele).
    const probNetta = (s: string, tf: string, b: IntradayBar[], k: number, candele: number) => {
      const lc = daCampioni(s, tf, b, candele);
      if (lc) {
        const q = (lc.sopra + 0.5) / (lc.tot + 1);
        return Math.min(0.99, Math.max(0.01, 0.5 + affOf(tf, s).fattore * c.percorsi.prudenza * (q - 0.5)));
      }
      const sd = sdOf(b);
      if (sd === null || sd <= 0) return null;
      const z = (k - costoVero(s)) / (sd * Math.sqrt(candele));
      return 0.5 * (1 + erf((affOf(tf, s).fattore * z) / Math.SQRT2));
    };
    // Probabilità che il prezzo salga (per tenere, incassare o tagliare una posizione): con i percorsi la quota che chiude
    // sopra il prezzo di adesso, avvicinata a 50% come quella d'ingresso; senza, Φ(z) della media.
    const probSale = (s: string, tf: string, b: IntradayBar[], k: number, candele: number) => {
      const grezzi = this.kCache.get(`${s}|${tf}`)?.campioni;
      if (grezzi && grezzi.length >= c.percorsi.minCampioni) {
        const righe = grezzi.map((r) => attuale(s, tf, r)).filter((r) => r.length >= candele);
        if (righe.length) {
          const q = (righe.filter((r) => r[candele - 1]! > 0).length + 0.5) / (righe.length + 1);
          return Math.min(0.99, Math.max(0.01, 0.5 + affOf(tf, s).fattore * c.percorsi.prudenza * (q - 0.5)));
        }
      }
      return probOf(b, k, candele);
    };
    // La candela su cui si segue una posizione: la più breve (LOWER) solo se Kronos lì ha un vantaggio misurato (almeno
    // minCampioneContro previsioni e nessuna regola di «senza vantaggio») e, per le azioni, se è tra le loro candele;
    // altrimenti la candela dell'operazione. Prima le uscite le decidevano le 15 minuti, che il motore escludeva dagli
    // ingressi perché non rendono: trade pensati per ore chiusi in pochi minuti sul rumore.
    const controlloDi = (s: string, tf: string) => {
      const lo = LOWER[tf];
      if (!lo || !this.forecast) return lo ?? tf;
      const a = affOf(lo, s);
      const ammessa = isCrypto(s) || c.candeleAzioni.includes(lo);
      return ammessa && a.campione >= c.vantaggio.minCampioneContro && !senzaVantaggio(lo, s) ? lo : tf;
    };
    // L'orizzonte migliore di una candela tra quelli che stanno nel tempo rimasto: prima quelli con cui si può entrare
    // (rialzo che copre i costi e probabilità ≥ soglia), poi la probabilità più alta, poi chi copre i costi.
    const migliore = (s: string, tf: string, path: number[], b: IntradayBar[], disponibili: number, soglia: number = Number(valore("AGENTS.intraday.kronos.minProb", s))) => {
      const opz = orizzonti(tf).filter((o) => o.h <= disponibili && o.n <= path.length).map((o) => {
        const k = retAt(path, o.n);
        const fuori = !credibile(b, k, o.n);
        return { ...o, k, pr: fuori ? null : probNetta(s, tf, b, k, o.n), fuori, passa: !fuori && k > 0 && k >= minRialzo(s, tf) };
      });
      const entra = (x: (typeof opz)[number]) => x.passa && x.pr !== null && x.pr >= soglia;
      opz.sort((a, d) => Number(entra(d)) - Number(entra(a)) || Number(a.fuori) - Number(d.fuori) || (d.pr ?? 0) - (a.pr ?? 0) || Number(d.passa) - Number(a.passa) || d.k - a.k);
      return opz[0] ?? null;
    };

    // Le candele superiori di un'operazione su candela `tf`: per ognuna Kronos all'orizzonte più lungo nel tempo rimasto
    // (la direzione) e la coppia orizzonte-probabilità migliore (il sostegno). Contraria se all'orizzonte lungo prevede un
    // calo oltre i costi; a sostegno se prevede un rialzo netto con probabilità sufficiente e nessun'altra è contraria.
    const leggiSuperiori = (s: string, tf: string, mappa: Map<string, number[]>, disponibili: number, price: number) => {
      const contrari: string[] = [];
      const letti: string[] = [];
      let sostegno: { tf: string; h: number; k: number; pr: number; stopPct: number } | null = null;
      for (const sup of SUPERIORI[tf] ?? []) {
        if (senzaVantaggio(sup, s)) continue; // Kronos lì non indovina: non conferma e non blocca
        const path = mappa.get(`${s}|${sup}`);
        const b = barsOf(s, sup);
        if (!path || !b || b.length < 22) continue;
        const lunghi = orizzonti(sup).filter((o) => o.h <= disponibili && o.n <= path.length);
        if (!lunghi.length) continue;
        const nL = lunghi.at(-1)!.n;
        const kL = retAt(path, nL);
        if (!credibile(b, kL, nL)) continue;
        letti.push(`${sup} ${pct(kL)} a ${etichetta(nL * tfMinutes(sup))}`);
        if (kL <= -costoVero(s)) {
          contrari.push(`${sup} ${pct(kL)} a ${etichetta(nL * tfMinutes(sup))}`);
          continue;
        }
        const o = migliore(s, sup, path, b, disponibili);
        if (o && o.passa && o.pr !== null && o.pr >= valore("AGENTS.intraday.kronos.minProb", s) && (!sostegno || o.pr > sostegno.pr)) sostegno = { tf: sup, h: o.h, k: o.k, pr: o.pr, stopPct: readBars(b, price, isCrypto(s)).stopPct };
      }
      return { contrari, letti, sostegno: contrari.length ? null : sostegno };
    };

    // Uscite, vincolanti: obiettivo, stop, media a 20 candele persa, fine giornata; e la candela più breve per decidere:
    // Kronos lì sopra dice se tenere (rialzo probabile: oltre l'obiettivo si lascia correre con lo stop alzato), se
    // incassare prima (calo che azzererebbe il guadagno) o se tagliare la perdita (calo che porta verso lo stop).
    const lowK = await kronosOn([...mine].map((s) => ({ s, tf: controlloDi(s, tfOfMine.get(s)!) })).filter((x) => barsOf(x.s, x.tf)?.length));
    const supK = await kronosOn([...mine].flatMap((s) => (SUPERIORI[tfOfMine.get(s)!] ?? []).filter((sup) => (barsOf(s, sup)?.length ?? 0) >= 22).map((sup) => ({ s, tf: sup }))));
    // Kronos anche sulla candela dell'operazione: serve a decidere, a fine giornata, se riportarla al giorno dopo.
    const ownK = await kronosOn([...mine].filter((s) => (barsOf(s, tfOfMine.get(s)!)?.length ?? 0) >= 22).map((s) => ({ s, tf: tfOfMine.get(s)! })));
    // Riporto al giorno dopo (il motore punta all'intraday: un trade si estende su più giorni solo così). A fine giornata
    // (chiusura della borsa, durata massima delle crypto) si tiene se le proiezioni di Kronos sulle candele (la sua e le
    // superiori, all'orizzonte più lungo) restano dentro la forchetta del trade: nessuna tocca lo stop e la più lunga vede
    // ancora salire con probabilità sufficiente. Il giorno dopo decidono di nuovo le candele, con una nuova finestra.
    const riportabile = (s: string, tf: string, price: number, op: Operazione): { ok: boolean; perche: string; h?: number } => {
      const r = c.riporto;
      if (!r.enabled) return { ok: false, perche: "riporto spento" };
      if ((op.riporti ?? 0) >= r.maxRiporti) return { ok: false, perche: `già riportata ${op.riporti} volte` };
      if (price <= op.stop) return { ok: false, perche: "sullo stop" };
      if (!isCrypto(s)) { const tri = prossimaTrimestrale(s, v.today); if (tri && tri.date <= addTradingDays(v.today, 1)) return { ok: false, perche: `trimestrale il ${tri.date}` }; }
      const letture: { t: string; n: number; k: number; min: number; pr: number | null }[] = [];
      for (const t of [tf, ...(SUPERIORI[tf] ?? [])]) {
        const path = (t === tf ? ownK : supK).get(`${s}|${t}`);
        const b = barsOf(s, t);
        if (!path?.length || !b || b.length < 22) continue;
        const k = retAt(path, path.length);
        if (!credibile(b, k, path.length)) continue;
        letture.push({ t, n: path.length, k, min: Math.min(...path), pr: probSale(s, t, b, k, path.length) });
      }
      if (!letture.length) return { ok: false, perche: "nessuna proiezione di Kronos sulle candele per decidere" };
      const tocca = letture.find((x) => price * (1 + x.min) <= op.stop);
      if (tocca) return { ok: false, perche: `sulle candele ${tocca.t} Kronos vede fino a ${pct(tocca.min)}: arriverebbe allo stop` };
      const lunga = letture.at(-1)!;
      const dove = `candele ${lunga.t} a ${etichetta(lunga.n * tfMinutes(lunga.t))}`;
      if (lunga.k <= 0 || (lunga.pr ?? 0) < r.minProb) return { ok: false, perche: `Kronos sulle ${dove} ${pct(lunga.k)}${lunga.pr !== null ? ` (${Math.round(lunga.pr * 100)}% al rialzo)` : ""}: non abbastanza per tenerla` };
      return { ok: true, h: lunga.n * tfMinutes(lunga.t), perche: `Kronos sulle ${dove} ${pct(lunga.k)} (${Math.round((lunga.pr ?? 0) * 100)}% al rialzo), senza toccare lo stop ${num(op.stop)}` };
    };
    for (const s of mine) {
      const p = held.get(s)!;
      const price = v.prices[s] ?? p.currentPrice;
      const tf = tfOfMine.get(s)!;
      const lo = controlloDi(s, tf);
      const b = barsOf(s, tf) ?? [];
      const read = b.length ? readBars(b, price, isCrypto(s)) : null;
      let op = this.operazioni.get(s);
      const salvati = v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.contesto?.livelli;
      if (!op && salvati) {
        // Processo ripartito: l'operazione riprende con i livelli salvati nel diario all'ingresso.
        const aperta = v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.apertoIl;
        op = { simbolo: s, candela: salvati.candela, giorno: v.today, ...(aperta ? { aperta } : {}), ingresso: p.avgEntryPrice, obiettivo: salvati.obiettivo, stop: salvati.stop, ...(salvati.orizzonteMin !== undefined ? { orizzonteMin: salvati.orizzonteMin } : {}), sopraMedia: salvati.sopraMedia ?? false, ...(salvati.sostegno ? { sostegno: { ...salvati.sostegno } } : {}), ...(salvati.riporti ? { riporti: salvati.riporti } : {}), ...(salvati.rinnovo ? { rinnovo: salvati.rinnovo } : {}), ...(salvati.riportoGiorno ? { riportoGiorno: salvati.riportoGiorno } : {}) };
        this.operazioni.set(s, op);
      }
      if (!op) {
        // Processo ripartito senza livelli salvati: ricostruiti dal carico e dalle candele di adesso.
        const entry = p.avgEntryPrice;
        const aperta = v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.apertoIl;
        op = { simbolo: s, candela: tf, giorno: v.today, ...(aperta ? { aperta } : {}), sopraMedia: read?.ema20 ? entry > read.ema20 : true, ingresso: entry, obiettivo: entry * (1 + (read?.targetPct ?? (isCrypto(s) ? c.target.crypto : c.target.stocks))), stop: entry * (1 - (read?.stopPct ?? (isCrypto(s) ? c.minStopPct.crypto : c.minStopPct.stocks) * 2)) };
        this.operazioni.set(s, op);
      }
      const gain = price / op.ingresso - 1;
      if (read?.ema20 && b.length && b[b.length - 1]!.close > read.ema20) op.sopraMedia = true;
      // Il controllo guarda l'orizzonte con cui si è entrati (almeno tre candele brevi), senza superare il tempo rimasto.
      const kpath = lowK.get(`${s}|${lo}`);
      const ctrlMin = Math.max(tfMinutes(lo) * 3, Math.min(op.orizzonteMin ?? 60, Math.max(minutiPer(s), 0) || tfMinutes(lo) * 3));
      const nl = kpath ? Math.min(kpath.length, nCandele(lo, ctrlMin)) : 0;
      const bl = barsOf(s, lo);
      const klRaw = kpath ? retAt(kpath, nl) : undefined;
      const kl = klRaw !== undefined && (!bl || credibile(bl, klRaw, nl)) ? klRaw : undefined;
      const pl = kl !== undefined && bl ? probSale(s, lo, bl, kl, nl) : null;
      const orizzonteCtrl = etichetta(nl * tfMinutes(lo));
      const controllo = kl !== undefined ? `candele ${lo} a ${orizzonteCtrl}: Kronos ${pct(kl)}${pl !== null ? ` (${Math.round(pl * 100)}% al rialzo)` : ""}` : `candele ${lo}: nessuna proiezione`;
      const margine = isCrypto(s) ? AGENTS.protezioneProfitto.margine.crypto : AGENTS.protezioneProfitto.margine.stocks;
      // Pareggio: a una buona parte della strada verso l'obiettivo lo stop sale sopra il carico (salvato anche nel diario).
      if (c.pareggio.enabled && gain > 0) {
        const pareggio = op.ingresso * (1 + margine / 2);
        const soglia = Math.max(c.pareggio.quota * (op.obiettivo / op.ingresso - 1), 2 * margine);
        if (op.stop < pareggio && gain >= soglia) {
          op.stop = pareggio;
          const lv = v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.contesto?.livelli;
          if (lv) lv.stop = pareggio;
          note.push(`${s}: stop portato in pareggio (${num(pareggio)}) a ${pct(gain)} dall'ingresso: il trade non chiuderà in perdita`);
        }
      }
      const why = (m: string) => `${s} intraday (${tf}, controllo su ${lo}): ${m}`;
      let motivo: string | null = null;
      // Le candele superiori: se sono a favore, un calo sulle candele brevi è rumore e non chiude l'operazione; se girano
      // contro, il trade torna alle regole della candela breve (e di solito si chiude per orizzonte scaduto o media persa).
      const sup = leggiSuperiori(s, tf, supK, Math.max(minutiPer(s), 0), price);
      if (op.sostegno && sup.contrari.length) {
        note.push(`${s}: le candele superiori girano al ribasso (${sup.contrari.join(", ")}): l'operazione torna alle regole della candela ${tf}`);
        op.sostegno = undefined;
      } else if (!op.sostegno && sup.sostegno && price > op.stop) {
        // Nato come trade breve, ora le candele superiori vedono il rialzo continuare: diventa trade di trend (lo stop resta dov'è).
        op.sostegno = { tf: sup.sostegno.tf, obiettivo: Math.max(op.obiettivo, price * (1 + sup.sostegno.k)), orizzonteMin: (apertaDa(s) ?? 0) + sup.sostegno.h };
      }
      const appoggio = !!op.sostegno && !sup.contrari.length && (!!sup.sostegno || !sup.letti.length);
      const superiori = sup.letti.length ? `candele superiori: ${sup.letti.join(", ")}${appoggio ? " (a favore)" : sup.contrari.length ? " (contrarie)" : ""}` : "";
      const correBreve = kl !== undefined && kl > 0 && (pl ?? 0) >= 0.6;
      const corre = correBreve || (appoggio && !!sup.sostegno);
      if (price >= op.obiettivo && corre) {
        // Oltre l'obiettivo e Kronos vede ancora salire (sulla candela breve o sulle superiori): si lascia correre, lo stop sale a metà strada.
        op.stop = Math.max(op.stop, op.ingresso * (1 + margine), price - (price - op.ingresso) / 2);
      } else if (price >= op.obiettivo) motivo = `obiettivo raggiunto: ${num(price)} ≥ ${num(op.obiettivo)} (${pct(gain)} dall'ingresso)${kl !== undefined ? `; sulle candele ${lo} Kronos non vede altro rialzo` : ""}`;
      if (!motivo) {
        if (v.giornata?.difesa && !corre) motivo = `difesa del guadagno del giorno: il conto è tornato a ${pct(v.giornata.pnlPct)} dopo aver toccato ${pct(v.giornata.picco ?? AGENTS.daily.targetPct)} e Kronos non vede più salire: si vende a ${pct(gain)}`;
        else if (price <= op.stop) motivo = `stop intraday: ${num(price)} ≤ ${num(op.stop)} (${pct(gain)})`;
        else if (mustClose(s)) {
          const rip = riportabile(s, tf, price, op);
          if (rip.ok) {
            // Le proiezioni restano dentro la forchetta: si tiene fino al giorno dopo, poi decidono di nuovo le candele.
            op.riporti = (op.riporti ?? 0) + 1;
            op.rinnovo = v.now.toISOString();
            op.riportoGiorno = v.today;
            op.orizzonteMin = rip.h;
            op.sostegno = undefined;
            const lv = v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.contesto?.livelli;
            if (lv) { lv.riporti = op.riporti; lv.rinnovo = op.rinnovo; lv.riportoGiorno = op.riportoGiorno; lv.orizzonteMin = op.orizzonteMin; delete lv.sostegno; }
            note.push(`${s}: operazione riportata al giorno dopo (${op.riporti}ª volta): ${rip.perche}`);
            stati.push({ simbolo: s, candela: tf, fase: "in posizione", ingresso: op.ingresso, obiettivo: op.obiettivo, stop: op.stop, prezzo: price, motivo: `riportata al giorno dopo: ${rip.perche}; domani decidono di nuovo le candele (obiettivo ${num(op.obiettivo)}, stop ${num(op.stop)}, ${pct(gain)})` });
            continue;
          }
          const prom = c.riporto.enabled ? { ok: false, perche: rip.perche } : promuovibile(v, s, gain);
          if (prom.ok) {
            // Il trend continua e il metodo di più giorni la terrebbe: non si chiude, passa alle sue regole.
            const t = v.journal.trade.find((x) => x.simbolo === s && x.stato === "aperto");
            if (t?.contesto) t.contesto.promossa = v.now.toISOString();
            this.operazioni.delete(s);
            note.push(`${s}: operazione intraday promossa a posizione di più giorni (${prom.perche})`);
            stati.push({ simbolo: s, candela: tf, fase: "in posizione", ingresso: op.ingresso, obiettivo: null, stop: null, prezzo: price, motivo: `promossa a posizione di più giorni: ${prom.perche}` });
            continue;
          }
          motivo = `${isCrypto(s) ? `${c.cryptoOreMax} ore dall'ingresso, durata massima` : "chiusura della borsa vicina"}: si chiude a ${pct(gain)} dall'ingresso (${prom.perche})`;
        }
        else if (appoggio) motivo = null; // trade di trend: valgono solo obiettivo, stop e fine giornata finché le candele superiori sono a favore
        else if (AGENTS.protezioneProfitto.enabled && kl !== undefined && kl < 0 && gain > margine && (1 + gain) * (1 + kl) - 1 <= margine) motivo = `protezione del profitto: +${(gain * 100).toFixed(2)}% in tasca, ma Kronos vede ${pct(kl)} nei prossimi ${orizzonteCtrl} (candele ${lo}), che lo azzererebbe: si incassa adesso`;
        else if (kl !== undefined && gain < 0 && kl < 0 && (pl ?? 1) <= 0.35 && price * (1 + kl) <= price - (price - op.stop) / 2) motivo = `taglio della perdita: ${pct(gain)} e sulle candele ${lo} Kronos vede ancora ${pct(kl)} (rialzo solo al ${Math.round((pl ?? 0) * 100)}%), metà strada verso lo stop: si esce prima`;
        else if (op.orizzonteMin !== undefined && (apertaDa(s) ?? 0) >= op.orizzonteMin * c.scadenzaOrizzonte && !corre) motivo = `orizzonte di Kronos scaduto (${etichetta(op.orizzonteMin)} × ${c.scadenzaOrizzonte}) senza raggiungere l'obiettivo e senza rialzo ancora probabile: si chiude a ${pct(gain)}`;
        else if (op.sopraMedia && read?.ema20 && b.length >= 2 && b[b.length - 1]!.close < read.ema20 && b[b.length - 2]!.close < read.ema20 && !corre) motivo = `due candele chiuse sotto la media a 20 (${num(read.ema20)}): il movimento è finito (${pct(gain)})`;
      }
      if (motivo) segnali.push({ agente: this.name, simbolo: s, lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, intraday: true, perche: why(motivo) });
      stati.push({ simbolo: s, candela: tf, controllo: [controllo, superiori].filter(Boolean).join(" · "), fase: "in posizione", ingresso: op.ingresso, obiettivo: op.sostegno?.obiettivo ?? op.obiettivo, stop: op.stop, prezzo: price, motivo: motivo ?? `${op.riporti ? `riportata ${op.riporti === 1 ? "una volta" : `${op.riporti} volte`} al giorno dopo · ` : ""}${corre && price >= op.obiettivo ? "oltre l'obiettivo, si lascia correre" : appoggio ? `trade di trend sostenuto dalle candele ${op.sostegno!.tf}` : "in corsa"}: obiettivo ${num(op.obiettivo)}${op.sostegno ? `, poi ${num(op.sostegno.obiettivo)} (candele ${op.sostegno.tf})` : ""}, stop ${num(op.stop)}, ${pct(gain)}` });
    }

    // Ingressi: per ogni candidato e ogni candela che sta nel tempo rimasto, 1) medie brevi (EMA 9 sopra EMA 20, prezzo sopra
    // la 9) o rottura/rientro, obiettivo raggiungibile e rapporto obiettivo/stop; 2) Kronos sulle prossime candele, letto a più
    // orizzonti (minuti e ore): si sceglie la coppia candela + orizzonte che copre i costi con la probabilità più alta. 3) In parte il grafico superiore e il Kronos a 5 sedute: contrari, taglia dimezzata.
    interface Prova { tf: string; read: ReturnType<typeof readBars>; breve: boolean; ok: string | null; reward: number; expected: number; movimento: number }
    // Rimbalzo di breve: sotto la media a 50 giorni dopo un calo netto improvviso (ultimo giorno, ultimi giorni o ultime
    // ore sulle candele da 1 ora). Le medie brevi della candela di solito non sono ancora in ordine: decide Kronos sulle
    // candele con probabilità ≥ AGENTS.rimbalzo.minFiducia (invece di minProbSenzaGrafico), e le sue proiezioni si
    // calcolano a ogni analisi, senza aspettare il turno.
    const rimbalzi = new Map<string, { calo: number; quando: string }>();
    for (const s of candidates) { const r = caloNetto(s, v.closes[s], v.prices[s], barsOf(s, "1Hour")?.map((b) => b.close)); if (r.ok) rimbalzi.set(s, { calo: r.calo!, quando: r.quando! }); }
    const fmtCalo = (s: string) => `rimbalzo dopo un calo del ${pct(rimbalzi.get(s)!.calo)} ${rimbalzi.get(s)!.quando}, sotto la media a ${LIMITS.trendSmaDays} giorni`;
    // Scaletta della prudenza secondo le medie giornaliere: sotto le medie si investe lo stesso, con taglie più piccole.
    const livMedie = (s: string) => { const l = livelloMedie(v.closes[s], v.prices[s]); return l ? ["sopra", "sotto50", "sotto200", "sottoEntrambe"].indexOf(l.livello) : -1; };
    const prudenza = (s: string) => { const l = livelloMedie(v.closes[s], v.prices[s]); return l ? { f: AGENTS.prudenzaMedie.intraday[l.livello], etichetta: l.etichetta } : { f: 1, etichetta: "" }; };
    // Le informazioni del dossier (o, senza, il contesto del settore) pesano una parte minima nella probabilità con cui
    // si decide l'ingresso: (1 − peso) × Kronos sulle candele + peso × evidenza.
    const evidenzaDi = (s: string): { ev: number; fonte: string } | null => {
      const d = v.dossier?.[s];
      if (d !== undefined) return { ev: d, fonte: `dossier ${Math.round(d * 100)}%` };
      const cx = v.contesto;
      if (!cx) return null;
      const o = cx.attendi[s] ? "sfavorevole" : cx.settori[sectorOf(s)] ?? cx.generale;
      return { ev: o === "favorevole" ? 0.6 : o === "sfavorevole" ? 0.4 : 0.5, fonte: `contesto ${o}` };
    };
    const conEvidenza = (s: string, p: number | null) => { const e = evidenzaDi(s); return p === null || !e ? p : (1 - c.evidenza.peso) * p + c.evidenza.peso * e.ev; };
    const prove = new Map<string, Prova[]>();
    for (const s of candidates) {
      const price = v.prices[s]!;
      const list: Prova[] = [];
      for (const tf of candTfs.get(s)!) {
        const b = barsOf(s, tf);
        if (!b || b.length < 22) continue;
        const read = readBars(b, price, isCrypto(s));
        const e9 = ema(b.map((x) => x.close), 9);
        const breve = e9 !== null && read.ema20 !== null && price > e9 && e9 > read.ema20;
        const remainingBars = Math.max(0, minutiPer(s) / tfMinutes(tf));
        const expected = read.atr !== null ? (read.atr * Math.sqrt(Math.max(1, remainingBars))) / price : 0;
        const reward = read.targetPct / read.stopPct;
        // Movimento: la volatilità della candela sull'orizzonte più lungo che sta nel tempo rimasto deve arrivare almeno a
        // movimentoMin × due volte i costi, se no nemmeno un percorso tipico coprirebbe i costi: non vale una proiezione.
        const sd = sdOf(b);
        const nMax = Math.max(0, ...orizzonti(tf).filter((o) => o.h <= minutiPer(s)).map((o) => o.n));
        const movimento = sd !== null && nMax > 0 ? sd * Math.sqrt(nMax) : null;
        const fermo = this.forecast !== null && movimento !== null && movimento < c.selezione.movimentoMin * minRialzo(s, tf);
        // Con Kronos obiettivo e rapporto con lo stop si decidono sul rialzo previsto (più sotto); senza, sull'ATR.
        // Rientro sulla stessa candela con la stessa proiezione di Kronos di un trade di oggi già chiuso: no, quella
        // proiezione ha già fatto il suo trade (spesso il rialzo previsto è già avvenuto); si aspetta la candela nuova.
        const chiaveK = `${tf}|${b.at(-1)!.t}`;
        const giaUsata = v.journal.trade.find((t) => t.simbolo === s && t.stato === "chiuso" && t.contesto?.livelli?.previsione === chiaveK && t.apertoIl && romeTime(new Date(t.apertoIl)).date === v.today);
        const ok = giaUsata ? `rientro: la proiezione di Kronos sulle candele ${tf} (chiusa alle ${(() => { const m = romeTime(new Date(Date.parse(b.at(-1)!.t) + tfMinutes(tf) * 60_000)).minutes; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; })()}) ha già fatto il suo trade: si aspetta la candela nuova` : fermo ? `sulle candele ${tf} il prezzo si muove troppo poco per coprire i costi (tipicamente ${pct(movimento!).replace("+", "±")} in ${etichetta(nMax * tfMinutes(tf))}, servono ${pct(minRialzo(s, tf))}${breveCrypto(s, tf) ? `: crypto su candele brevi, ${quanteVolte(s, tf)} volte i costi` : ""}): non si proietta` : senzaVantaggio(tf, s) ? `Kronos sulle candele ${tf} senza vantaggio misurato (direzione giusta ${Math.round((affOf(tf, s).giusti ?? affOf(tf, s).quota) * 100)}% su ${affOf(tf, s).campione} previsioni${affOf(tf, s).resa !== undefined && affOf(tf, s).resa !== null ? `, resa media ${pct(affOf(tf, s).resa!)}` : ""}): per ora qui non si entra, si continua a misurare` : tfMinutes(tf) > minutiPer(s) ? `la candela ${tf} è più lunga del tempo rimasto (${etichetta(Math.max(0, minutiPer(s)))}): non può completarsi in giornata` : !breve && !read.entra && !this.forecast ? `medie brevi non in ordine sulle candele ${tf} (serve EMA 9 sopra EMA 20 e prezzo sopra la 9) e ${read.pattern}` : /troppo esteso/.test(read.pattern) ? read.pattern : this.forecast ? null : reward < c.rapportoMin ? `rapporto obiettivo/stop ${reward.toFixed(2)} troppo basso (${tf})` : expected < read.targetPct * 0.8 ? `obiettivo ${pct(read.targetPct)} non raggiungibile entro la chiusura sulle candele ${tf} (atteso ${pct(expected)})` : null;
        list.push({ tf, read, breve, ok, reward, expected, movimento: movimento !== null ? movimento / minRialzo(s, tf) : 0 });
      }
      prove.set(s, list);
    }
    // Kronos per le coppie titolo-candela valide. Le coppie con una proiezione ancora valida (nessuna candela nuova) non
    // costano: si tengono tutte. Delle altre, per ogni candela al massimo selezione.perCandela a giro (meno titoli, più
    // qualità): prima rotture e rientri, poi medie brevi in ordine e rimbalzi, poi le altre; a parità la probabilità vista
    // all'ultima proiezione e il movimento rispetto ai costi. `esplora` posti vanno a rotazione alle altre, così ogni
    // coppia ha la sua proiezione entro qualche giro.
    const tutte = [...prove].flatMap(([s, l]) => l.filter((x) => x.ok === null).map((x) => ({ s, tf: x.tf, rank: x.read.entra ? 0 : x.breve || rimbalzi.has(s) ? 1 : 2, prima: this.ultimaProb.get(`${s}|${x.tf}`) ?? 0.5, movimento: x.movimento })));
    tutte.sort((a, b) => a.rank - b.rank || b.prima - a.prima || b.movimento - a.movimento);
    const valida = (x: { s: string; tf: string }) => { const b = barsOf(x.s, x.tf); return !!b?.length && this.kCache.get(`${x.s}|${x.tf}`)?.chiave === `${x.tf}|${b.at(-1)!.t}`; };
    const daFare = tutte.filter((x) => !valida(x));
    const giro = (this.giroKronos = this.giroKronos + 1);
    const scelte: { s: string; tf: string }[] = [];
    for (const tf of new Set(daFare.map((x) => x.tf))) {
      const fila = daFare.filter((x) => x.tf === tf);
      const max = c.selezione.perCandela[tf] ?? 8;
      const esplora = Math.min(c.selezione.esplora, Math.max(0, fila.length - max));
      const primi = fila.slice(0, max - esplora);
      const resto = fila.slice(max - esplora);
      const ruota = resto.length ? [...resto.slice((giro * esplora) % resto.length), ...resto.slice(0, (giro * esplora) % resto.length)].slice(0, esplora) : [];
      scelte.push(...primi, ...ruota);
    }
    // Le candele senza vantaggio si proiettano poco, solo per continuare a misurarle.
    const misura = [...prove].flatMap(([s, l]) => l.filter((x) => senzaVantaggio(x.tf, s)).map((x) => ({ s, tf: x.tf }))).filter((x) => !valida(x));
    const daMisurare = misura.length ? [...misura.slice((giro * c.vantaggio.misuraPerGiro) % misura.length), ...misura.slice(0, (giro * c.vantaggio.misuraPerGiro) % misura.length)].slice(0, c.vantaggio.misuraPerGiro) : [];
    const pairs = [...tutte.filter(valida), ...scelte.slice(0, c.kronos.perGiro), ...daMisurare];
    const kIn = await kronosOn(pairs);
    // Vittorie per candela: dove gli ultimi trade intraday chiusi vincono meno dell'obiettivo, per entrare serve più probabilità.
    const vittorieDi = new Map<string, { n: number; v: number }>();
    for (const t of v.journal.trade.filter((x) => x.stato === "chiuso" && x.contesto?.livelli?.candela).sort((a, b) => (b.chiusoIl ?? "").localeCompare(a.chiusoIl ?? ""))) {
      const k = t.contesto!.livelli!.candela; const g = vittorieDi.get(k) ?? { n: 0, v: 0 };
      if (g.n >= c.vittorie.ultimi) continue;
      g.n++; if (t.incassato - t.costo > 0) g.v++; vittorieDi.set(k, g);
    }
    const extraVittorie = (tf: string) => { const g = vittorieDi.get(tf); if (!g || g.n < c.vittorie.minimo) return 0; const q = g.v / g.n; return q >= c.vittorie.obiettivo ? 0 : q < c.vittorie.obiettivo - 0.11 ? 2 * c.vittorie.passo : c.vittorie.passo; };
    for (const [k, g] of vittorieDi) if (g.n >= c.vittorie.minimo && g.v / g.n < c.vittorie.obiettivo) note.push(`candele ${k}: ${g.v} vinti su ${g.n} (${Math.round((g.v / g.n) * 100)}%), sotto l'obiettivo del ${Math.round(c.vittorie.obiettivo * 100)}%: per entrare serve +${Math.round(extraVittorie(k) * 100)} punti di probabilità`);
    // Probabilità minima per entrare: con le medie brevi in ordine (o rottura/rientro) quella della persona; senza, quella
    // più alta di minProbSenzaGrafico, salvo il rimbalzo dopo un calo netto (AGENTS.rimbalzo.minFiducia).
    const sogliaDi = (s: string, grafico: boolean) => { const mp = Number(valore("AGENTS.intraday.kronos.minProb", s)); return grafico ? mp : Math.max(rimbalzi.has(s) ? AGENTS.rimbalzo.minFiducia : c.kronos.minProbSenzaGrafico, mp); };
    // Candidate che hanno passato i controlli della loro candela: poi si guardano le candele superiori.
    const pronti: { s: string; price: number; best: (typeof prove extends Map<string, (infer P)[]> ? P : never) & { k?: number; pr: number | null; prGrezza?: number | null; h?: number; passa: boolean; fuori: boolean }; valutate: string; fc: number | undefined; stopIn: number }[] = [];

    for (const s of candidates) {
      const price = v.prices[s]!;
      const list = prove.get(s)!;
      if (!list.length) {
        stati.push({ simbolo: s, candela: candTfs.get(s)![0]!, fase: "fermo", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: "candele insufficienti" });
        continue;
      }
      const fc = v.previsioni?.[s];
      // Per ogni candela l'orizzonte migliore (da un quarto d'ora a ore, nel tempo rimasto); poi la coppia candela + orizzonte
      // che copre i costi con la probabilità di successo più alta (a parità, il rialzo previsto più grande).
      const sogliaTf = (x: Prova) => sogliaDi(s, x.breve || x.read.entra) + extraVittorie(x.tf);
      const scored = list.map((x) => {
        const path = kIn.get(`${s}|${x.tf}`);
        const b = barsOf(s, x.tf)!;
        const o = path ? migliore(s, x.tf, path, b, minutiPer(s), sogliaTf(x)) : null;
        // Dai percorsi di Kronos: quanti chiudono sopra i costi senza toccare lo stop, e lo stop (i peggiori).
        const lc = o ? daCampioni(s, x.tf, b, o.n) : null;
        // Probabilità calibrata sui risultati intraday del diario (uguale alla grezza finché la calibrazione non è attiva).
        // Probabilità con cui si decide: Kronos sulle candele (calibrata) più una parte minima di dossier o contesto.
        const pr = conEvidenza(s, o?.pr != null ? calibraP("intraday", o.pr) : null);
        if (pr !== null && !o?.fuori) this.ultimaProb.set(`${s}|${x.tf}`, pr);
        return { ...x, k: o?.k, pr, prGrezza: o?.pr ?? null, h: o?.h, passa: o?.passa ?? false, fuori: o?.fuori ?? false, lc };
      });
      const valide = scored.filter((x) => x.ok === null);
      // La candela: prima quelle con cui si può entrare (rialzo oltre i costi e probabilità oltre la soglia), poi la
      // probabilità più alta, poi chi copre i costi; non più «prima chi copre i costi», che sceglieva le candele lunghe
      // anche dove Kronos indovina meno.
      const entraCon = (x: (typeof scored)[number]) => x.passa && x.pr !== null && x.pr >= sogliaTf(x);
      const conK = valide.filter((x) => x.k !== undefined).sort((a, b) => Number(entraCon(b)) - Number(entraCon(a)) || (b.pr ?? 0) - (a.pr ?? 0) || Number(b.passa) - Number(a.passa) || (b.k ?? 0) - (a.k ?? 0));
      const best = conK[0] ?? valide[0] ?? scored[0]!;
      const valutate = this.forecast ? scored.filter((x) => x.pr !== null).map((x) => { const a = affOf(x.tf, s); return `${x.tf} a ${etichetta(x.h!)} ${pct(x.k!)} → ${Math.round(x.pr! * 100)}%${x.lc ? ` (${x.lc.sopra} percorsi su ${x.lc.tot} sopra i costi)` : ""}${a.campione ? ` (Kronos giusto ${Math.round((a.giusti ?? a.quota) * 100)}% su ${a.campione}, affidabilità ×${a.fattore.toFixed(2)})` : ""}`; }).join(" · ") : "";
      const { tf, read, k, pr, h } = best;
      // Stop dell'ingresso: con i percorsi di Kronos quello dei peggiori (tra lo stop minimo e quello dell'ATR), senza
      // quello dell'ATR (senza i salti tra le sedute).
      const stopIn = best.lc ? best.lc.stop : read.stopPct;
      // Coerenza tra le candele: le altre candele già proiettate da Kronos, lette allo stesso orizzonte, non devono dire
      // il contrario. Se sulle candele da 5 minuti Kronos vede +1,5% in un'ora ma su quelle da 15 o da 1 ora vede un calo
      // nella stessa ora, il segnale è rumore della candela, non un'occasione.
      const discordi: string[] = [];
      if (k !== undefined && h !== undefined) {
        for (const x of scored) {
          if (x.tf === tf || senzaVantaggio(x.tf, s)) continue;
          const path = kIn.get(`${s}|${x.tf}`);
          const n2 = Math.round(h / tfMinutes(x.tf));
          if (!path || n2 < 1 || n2 > path.length) continue;
          const k2 = retAt(path, n2);
          if (k2 < 0 && credibile(barsOf(s, x.tf)!, k2, n2)) discordi.push(`${x.tf} ${pct(k2)}`);
        }
      }
      let motivo: string | null = best.ok;
      if (!motivo) {
        if (this.forecast && k === undefined) motivo = "in attesa della proiezione di Kronos sulle candele brevi";
        else if (best.fuori) motivo = `proiezione di Kronos sulle candele ${tf} fuori misura (${pct(k!)}): rumore del modello, non si usa`;
        else if (k !== undefined && (!best.passa || (pr ?? 0) < sogliaDi(s, best.breve || read.entra) + extraVittorie(tf))) motivo = `${rimbalzi.has(s) ? `${fmtCalo(s)}; ` : ""}Kronos a ${etichetta(h!)} sulle candele ${tf}: ${pct(k)}${pr !== null ? `, probabilità ${Math.round(pr * 100)}%` : ""}: non basta (serve un rialzo di almeno ${pct(minRialzo(s, tf))}, ${quanteVolte(s, tf)} volte i costi${breveCrypto(s, tf) ? " (crypto su candele brevi)" : ""}, con probabilità ≥ ${Math.round(sogliaDi(s, best.breve || read.entra) * 100)}%${best.breve || read.entra ? "" : rimbalzi.has(s) ? ": rimbalzo, medie brevi non ancora in ordine" : ": medie brevi della candela non ancora in ordine"}${extraVittorie(tf) ? `; +${Math.round(extraVittorie(tf) * 100)} punti perché sulle ${tf} si vince sotto il ${Math.round(c.vittorie.obiettivo * 100)}%` : ""})`;
        else if (k === undefined && !(fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia / 2) && !read.entra) motivo = "senza Kronos intraday serve una rottura o un rientro";
        else if (discordi.length) motivo = `Kronos discorde tra le candele: a ${etichetta(h!)} sulle ${tf} ${pct(k!)}, ma sulle ${discordi.join(", ")}: non è un'occasione chiara`;
        // Rapporto obiettivo/stop fisso solo con lo stop dell'ATR: con i percorsi di Kronos probabilità e stop vengono dalle
        // stesse simulazioni e decide l'aspettativa (più sotto: probabilità × guadagno − resto × perdita allo stop > 0).
        else if (k !== undefined && !best.lc && Math.max(costoDi(s), k) / stopIn < c.rapportoMin) motivo = `Kronos a ${etichetta(h!)} sulle candele ${tf}: ${pct(k)}, non abbastanza rispetto allo stop di ${pct(-stopIn)} (serve almeno ${c.rapportoMin} volte)`;
      }
      if (motivo) {
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: `${motivo}${valutate ? ` · probabilità netta per candela: ${valutate}` : ""}` });
        continue;
      }
      pronti.push({ s, price, best, valutate, fc, stopIn });
    }

    // Le candele superiori delle candidate pronte su candele brevi (Kronos su 1 ora e 4 ore, ricalcolato solo a candela nuova).
    const supIn = await kronosOn(pronti.flatMap((x) => (SUPERIORI[x.best.tf] ?? []).filter((sup) => (barsOf(x.s, sup)?.length ?? 0) >= 22).map((sup) => ({ s: x.s, tf: sup }))));
    // Serie di perdite di oggi (trade intraday chiusi, dall'ultimo indietro): dopo `serieNegativa.perdite` di fila la taglia
    // si riduce per il resto della giornata (Douglas, Kahneman: dopo una serie negativa non si rincorre il recupero).
    const chiusiOggi = v.journal.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl && romeTime(new Date(t.chiusoIl)).date === v.today && t.contesto?.agenti?.includes(this.name)).sort((a, b) => Date.parse(a.chiusoIl!) - Date.parse(b.chiusoIl!));
    let perditeDiFila = 0;
    for (let i = chiusiOggi.length - 1; i >= 0 && (chiusiOggi[i]!.risultato ?? 0) < 0; i--) perditeDiFila++;
    const inSerie = perditeDiFila >= c.serieNegativa.perdite;
    if (inSerie) note.push(`${perditeDiFila} operazioni intraday chiuse in perdita di fila oggi: taglia ×${c.serieNegativa.fattore} per il resto della giornata`);

    // Tetto alle crypto: si muovono insieme, tante entrate nello stesso giro sono una scommessa sola. Le candidate pronte
    // si guardano dalla più probabile; oltre maxIngressiGiro crypto nuove a giro (o maxAperte crypto intraday aperte in
    // tutto) le altre aspettano il giro dopo.
    pronti.sort((a, b) => (b.best.pr ?? 0) - (a.best.pr ?? 0));
    const cryptoAperte = [...mine].filter(isCrypto).length;
    let cryptoNuove = 0;
    for (const { s, price, best, valutate, fc, stopIn } of pronti) {
      const { tf, read, k, pr, h } = best;
      // Triple Screen (Elder): la direzione la danno le candele superiori. Se Kronos su 1 ora o 4 ore vede un calo oltre i
      // costi, il rialzo sulle candele brevi va controcorrente e non si entra; se vede un rialzo netto probabile, il trade
      // diventa di trend: obiettivo e orizzonte delle candele superiori, stop della loro candela (deciso adesso, mai
      // allargato dopo) e taglia ridotta in proporzione, così il rischio in euro resta quello del trade breve.
      const sup = leggiSuperiori(s, tf, supIn, minutiPer(s), price);
      if (sup.contrari.length) {
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: `Kronos a ${etichetta(h!)} sulle candele ${tf} ${pct(k!)}, ma sulle candele superiori vede un calo (${sup.contrari.join(", ")}): il rialzo breve va controcorrente, si aspetta (Triple Screen) · probabilità netta per candela: ${valutate}` });
        continue;
      }
      const ss = sup.sostegno;
      const trend = ss !== null && k !== undefined && ss.k > k && Math.max(stopIn, ss.stopPct) > 0 && ss.k / Math.max(stopIn, ss.stopPct) >= c.rapportoMin ? ss : null;
      const stopPct = trend ? Math.max(stopIn, trend.stopPct) : stopIn;
      // Correttivi: il grafico superiore (prezzo sotto la sua EMA 20) e il Kronos a 5 sedute contrario dimezzano la taglia.
      const up = UP[tf] ?? "1Day";
      const ub = up === "1Day" ? null : barsOf(s, up);
      const eUp = up === "1Day" ? ema(v.closes[s] ?? [], 20) : ub ? ema(ub.map((x) => x.close), 20) : null;
      const correttivi: string[] = [];
      if (!best.breve && !read.entra) correttivi.push(`medie brevi delle candele ${tf} non ancora in ordine: decide Kronos`);
      // Il grafico giornaliero lo pesa la scaletta delle medie (sotto); qui solo le candele superiori intraday.
      if (up !== "1Day" && eUp !== null && price < eUp && !trend) correttivi.push(`grafico ${up === "1Day" ? "giornaliero" : `a ${up}`} sotto la sua media a 20`);
      if (this.forecast && fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia) correttivi.push(`Kronos a ${AGENTS.kronos.horizon} sedute ${pct(fc)}`);
      // Indizi contrari (grafico superiore sotto la sua media, Kronos a 5 sedute al ribasso): sono informazioni sulla
      // direzione, quindi tolgono punti di probabilità (taglia.penalitaIndizio ciascuno) invece di dimezzare la taglia. Se
      // con gli indizi la probabilità scende sotto la soglia non si entra, con il motivo; se resta sopra, si entra con la
      // taglia del rischio. «Medie brevi non in ordine» è già nella soglia più alta (minProbSenzaGrafico): non conta due volte.
      const indizi = correttivi.filter((x) => !/medie brevi/.test(x));
      const penalita = indizi.length * c.taglia.penalitaIndizio;
      const prA = pr === null ? null : pr - penalita;
      const sogliaQui = sogliaDi(s, best.breve || read.entra) + extraVittorie(tf);
      if (penalita > 0 && prA !== null && prA < sogliaQui) {
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: `indizi contrari (${indizi.join(" e ")}): la probabilità scende da ${Math.round(pr! * 100)}% a ${Math.round(prA * 100)}%, sotto la soglia del ${Math.round(sogliaQui * 100)}% · probabilità netta per candela: ${valutate}` });
        continue;
      }
      // Obiettivo: il rialzo che Kronos prevede sull'orizzonte scelto (trade di pochi minuti su candele da 5 minuti, di ore
      // su quelle più lunghe), mai sotto il minimo dei costi; senza Kronos quello dell'ATR.
      // Con Kronos l'obiettivo è il rialzo previsto (mai sotto due volte i costi); senza, il minimo fisso o l'ATR.
      const targetPct = k !== undefined ? Math.max(costoDi(s), k) : read.targetPct;
      // Aspettativa (Thorp): probabilità × guadagno netto − (1 − probabilità) × perdita allo stop (costi compresi) > 0.
      const pE = trend ? trend.pr - penalita : prA;
      const gE = (trend ? trend.k : targetPct) - costoVero(s);
      const aspettativa = pE === null ? null : pE * gE - (1 - pE) * (stopPct + costoVero(s));
      if (aspettativa !== null && aspettativa <= 0) {
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: `aspettativa negativa: ${Math.round(pE! * 100)}% × ${pct(gE)} contro ${Math.round((1 - pE!) * 100)}% × ${pct(-(stopPct + costoVero(s)))} (Thorp: si entra solo se in media il trade rende) · probabilità netta per candela: ${valutate}` });
        continue;
      }
      if (isCrypto(s) && (cryptoNuove >= c.crypto.maxIngressiGiro || cryptoAperte + cryptoNuove >= c.crypto.maxAperte)) {
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: `tetto alle crypto: ${cryptoNuove >= c.crypto.maxIngressiGiro ? `già ${cryptoNuove} ingressi crypto in questo giro (massimo ${c.crypto.maxIngressiGiro}, prima i più probabili)` : `${cryptoAperte + cryptoNuove} operazioni crypto intraday già aperte (massimo ${c.crypto.maxAperte})`}: le crypto si muovono insieme, si aspetta · probabilità netta per candela: ${valutate}` });
        continue;
      }
      if (isCrypto(s)) cryptoNuove++;
      const target = price * (1 + targetPct), stop = price * (1 - stopPct);
      const obiettivoTrend = trend ? price * (1 + trend.k) : null;
      // I livelli si tengono da subito; il blocco "un ingresso al giorno" scatta solo a ordine eseguito (dal diario): se
      // l'allocatore o la gabbia scartano il voto, il titolo resta candidato al giro dopo.
      this.operazioni.set(s, { simbolo: s, candela: tf, giorno: v.today, ingresso: price, obiettivo: target, stop, aperta: v.now.toISOString(), sopraMedia: read.ema20 !== null && price > read.ema20, ...(h !== undefined && k !== undefined ? { orizzonteMin: h } : {}), ...(trend ? { sostegno: { tf: trend.tf, obiettivo: obiettivoTrend!, orizzonteMin: trend.h } } : {}) });
      // Taglia, dal rischio: la fiducia (probabilità con gli indizi, da metà a piena dal 70%), la scaletta delle medie
      // giornaliere, uno stop più largo (trade di trend: stesso rischio in euro) e una serie di perdite di oggi. Il prodotto
      // non scende sotto taglia.pavimento della taglia massima: un trade che ha passato soglia, aspettativa e controlli
      // si fa con una taglia vera. Prima 5-6 riduzioni in fila lo portavano allo 0,2-0,5% del conto e il minimo d'ordine lo
      // scartava (SHEL 67%, SAP 63%, POL 74%: 2-5 $).
      // Soglia e peso sono quelli dell'intraday agent che lavora sul titolo (il suo profilo), altrimenti di serie.
      const minProb = valore("AGENTS.intraday.kronos.minProb", s);
      const fid = prA === null ? 1 : Math.max(0.5, Math.min(1, 0.5 + ((prA - minProb) / Math.max(0.05, 0.7 - minProb)) * 0.5));
      const pru = prudenza(s);
      const fattoriTaglia = fid * pru.f * Math.min(1, stopIn / stopPct) * (inSerie ? c.serieNegativa.fattore : 1);
      const peso = valore("AGENTS.intraday.maxWeight", s) * Math.max(c.taglia.pavimento, fattoriTaglia);
      const ingresso = `${rimbalzi.has(s) ? `${fmtCalo(s)}: ` : ""}${read.entra ? read.pattern : best.breve ? `medie brevi in ordine sulle candele ${tf} (prezzo sopra EMA 9 sopra EMA 20)` : `Kronos anticipa la ripartenza sulle candele ${tf} prima delle medie brevi`}`;
      const superiori = sup.letti.length ? `candele superiori: ${sup.letti.join(", ")}` : "";
      const tipo = trend ? `; trade di trend: le candele ${trend.tf} vedono ${pct(trend.k)} in ${etichetta(trend.h)} (probabilità ${Math.round(trend.pr * 100)}%), obiettivo finale ${num(obiettivoTrend!)}, stop della candela ${trend.tf}` : superiori ? "; trade breve: le candele superiori non sono contrarie ma non vedono un rialzo netto" : "";
      segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: peso, ...(best.prGrezza !== null && best.prGrezza !== undefined ? { misure: { probabilita: best.prGrezza, ...(rimbalzi.has(s) ? { rimbalzo: rimbalzi.get(s)!.calo } : {}), ...(livMedie(s) >= 0 ? { medie: livMedie(s) } : {}) } } : {}), ...(k !== undefined ? {} : fc !== undefined ? { kronos: fc } : {}), perche: `${s} intraday su candele ${tf}${valutate ? ` (scelta per probabilità netta dei costi: ${valutate})` : ""}: ${ingresso}${k !== undefined ? `; Kronos a ${etichetta(h!)} sulle candele ${tf} ${pct(k)} (probabilità ${Math.round((pr ?? 0) * 100)}%)` : fc !== undefined ? `; Kronos ${pct(fc)} a ${AGENTS.kronos.horizon} sedute` : ""}${superiori ? `; ${superiori}` : ""}${tipo}${pru.f < 1 ? `; ${pru.etichetta}: taglia ×${pru.f}` : ""}${indizi.length ? `; indizi contrari: ${indizi.join(" e ")} (−${Math.round(penalita * 100)} punti di probabilità, ${Math.round(prA! * 100)}%)` : ""}${correttivi.length > indizi.length ? `; ${correttivi.find((x) => /medie brevi/.test(x))}` : ""}${fattoriTaglia < c.taglia.pavimento ? `; taglia al pavimento (${Math.round(c.taglia.pavimento * 100)}% della massima)` : ""}${inSerie ? `; dopo ${perditeDiFila} perdite di fila, taglia ridotta` : ""}; obiettivo ${num(target)} (${pct(targetPct)}${k !== undefined ? `, da Kronos in ${etichetta(h!)}` : ""}), stop ${num(stop)} (${pct(-stopPct)}), poi controllo su candele ${controlloDi(s, tf)}, chiusura ${chiusuraDi(s)}` });
      const opNuova = this.operazioni.get(s)!;
      stati.push({ simbolo: s, candela: tf, livelli: { candela: tf, previsione: `${tf}|${barsOf(s, tf)!.at(-1)!.t}`, obiettivo: opNuova.obiettivo, stop: opNuova.stop, ...(opNuova.orizzonteMin !== undefined ? { orizzonteMin: opNuova.orizzonteMin } : {}), sopraMedia: !!opNuova.sopraMedia, ...(opNuova.sostegno ? { sostegno: opNuova.sostegno } : {}) }, ...(h !== undefined && k !== undefined ? { orizzonte: etichetta(trend ? trend.h : h) } : {}), controllo: [`poi candele ${controlloDi(s, tf)}`, superiori].filter(Boolean).join(" · "), fase: "cerca ingresso", ingresso: price, obiettivo: obiettivoTrend ?? target, stop, prezzo: price, motivo: `ingresso votato: ${ingresso}${trend ? ` · trade di trend sulle candele ${trend.tf}` : ""}${valutate ? ` · probabilità netta per candela: ${valutate}` : ""}` });
    }
    if (v.analisi === false) stati.push(...this.ultimeCandidate.filter((x) => !held.has(x.simbolo) && !bloccatoOggi(x.simbolo)));
    else this.ultimeCandidate = stati.filter((x) => x.fase !== "in posizione");
    const n = segnali.filter((x) => x.lato === "buy").length;
    const tempi = this.forecast ? ` · tempi: candele ${(msCandele / 1000).toFixed(1)} s, Kronos ${(msKronos / 1000).toFixed(1)} s su ${serieKronos} serie nuove` : "";
    note.unshift(v.analisi === false ? `${[...mine].length} operazioni aperte seguite; nuove candidate alla prossima analisi d'ingresso (ogni ${AGENTS.analisiMinuti} minuti)${tempi}` : `${[...mine].length} operazioni aperte, ${candidates.length} candidate, ${n} ingressi votati${this.forecast ? ` · candele valutate: ${TFS.filter((tf) => !senzaVantaggio(tf)).join(", ")}${TFS.some((tf) => senzaVantaggio(tf)) ? ` (senza vantaggio misurato, solo misurate: ${TFS.filter((tf) => senzaVantaggio(tf)).join(", ")})` : ""}` : ""}${tempi}`);
    return { segnali, note, intraday: stati };
  }
}
