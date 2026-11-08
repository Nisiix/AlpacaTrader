import type { IntradayBar } from "../broker/types.ts";
import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { dailyVol, momentum, sma, trendOf } from "../indicators.ts";
import { romeTime } from "../slots.ts";
import { erf } from "./fiducia.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

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
}

// La candela più breve su cui si segue una posizione (per decidere se tenere o vendere) e quella superiore (correttivo).
export const LOWER: Record<string, string> = { "5Min": "1Min", "15Min": "5Min", "1Hour": "15Min", "4Hour": "1Hour" };
export const UP: Record<string, string> = { "5Min": "1Hour", "15Min": "1Hour", "1Hour": "4Hour", "4Hour": "1Day" };

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
const num = (x: number) => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toFixed(5));

export function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

export function atr(bars: IntradayBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!, prev = bars[i - 1]!;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
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
export type IntradayForecast = (bars: Record<string, IntradayBar[]>, stepMinutes: number, horizon: number) => Promise<Record<string, number | number[]>>;

interface Operazione {
  simbolo: string;
  candela: string;
  giorno: string;
  ingresso: number;
  obiettivo: number;
  stop: number;
  aperta?: string; // ISO dell'ingresso (per la durata massima sulle crypto)
  orizzonteMin?: number; // orizzonte della proiezione di Kronos con cui si è entrati
}

export class IntradayAgent implements Agent {
  readonly name = "intraday";
  private operazioni = new Map<string, Operazione>();
  private entrateOggi = new Map<string, string>(); // simbolo -> giorno dell'ultimo ingresso
  // Ultima proiezione intraday per titolo: si ricalcola solo quando chiude una candela nuova.
  private kCache = new Map<string, { chiave: string; path: number[] }>();
  constructor(
    private fetchBars: BarFetcher,
    private forecast: IntradayForecast | null = null,
  ) {}

  async observe(v: AgentView): Promise<AgentReport> {
    const c = AGENTS.intraday;
    const rt = romeTime(v.now);
    const segnali: Signal[] = [];
    const note: string[] = [];
    const stati: IntradayStato[] = [];
    const held = new Map(v.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
    // Le mie operazioni aperte: dal diario (trade aperti votati da "intraday") e dalla memoria del processo.
    const mine = new Set<string>();
    for (const t of v.journal.trade) if (t.stato === "aperto" && t.contesto?.agenti?.includes(this.name) && held.has(t.simbolo)) mine.add(t.simbolo);
    for (const s of this.operazioni.keys()) if (held.has(s)) mine.add(s);
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
    const apertaDa = (s: string) => { const op = this.operazioni.get(s); return op?.aperta ? (v.now.getTime() - Date.parse(op.aperta)) / 60_000 : null; };
    const mustClose = (s: string) => isCrypto(s) ? (apertaDa(s) ?? 0) >= c.cryptoOreMax * 60 : minToClose !== null ? minToClose <= c.minutiPrimaChiusura.uscita : rt.minutes >= minutesOf(c.closeBy.stocks);
    // Minuti a disposizione per arrivare all'obiettivo: crypto la durata massima, azioni fino all'uscita prima della chiusura.
    const minutiPer = (s: string) => isCrypto(s) ? c.cryptoOreMax * 60 - (apertaDa(s) ?? 0) : minToClose !== null ? minToClose - c.minutiPrimaChiusura.uscita : minutesOf(c.closeBy.stocks) - rt.minutes;
    const chiusuraDi = (s: string) => isCrypto(s) ? `al massimo ${c.cryptoOreMax} ore` : `entro ${c.minutiPrimaChiusura.uscita} minuti dalla chiusura della borsa`;

    // Candidate: tutti i titoli e le crypto dell'universo nella finestra degli ingressi. Per un trade che si chiude in
    // giornata non decidono le medie giornaliere (50, 200) né il settimanale: decidono la proiezione di Kronos sulle
    // candele brevi e le medie brevi della candela scelta; il grafico più lungo e il Kronos a 5 sedute pesano solo sulla
    // taglia. Senza Kronos intraday (sidecar spento) vale il Kronos a 5 sedute, come prima.
    const candidates: string[] = [];
    for (const s of AGENTS.universe) {
      if (v.giornata?.obiettivoRaggiunto || v.giornata?.perditaOltre) break; // oggi basta così
      if (held.has(s) || this.entrateOggi.get(s) === v.today) continue;
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
    for (const s of candidates) candTfs.set(s, this.forecast ? TFS : [timeframeFor(v.closes[s])]);
    const tfOfMine = new Map<string, string>();
    for (const s of mine) tfOfMine.set(s, this.operazioni.get(s)?.candela ?? timeframeFor(v.closes[s]));
    // Candele: per i candidati su ogni candela da valutare, per le posizioni sulla loro candela e su quella più breve
    // (si decide se tenere o vendere guardando più da vicino), più la candela superiore per il correttivo.
    const want = new Map<string, Set<string>>();
    const ask = (tf: string, s: string) => { if (tf === "1Day") return; (want.get(tf) ?? want.set(tf, new Set()).get(tf)!).add(s); };
    for (const [s, tfs] of candTfs) for (const tf of tfs) { ask(tf, s); ask(UP[tf] ?? "1Day", s); }
    for (const [s, tf] of tfOfMine) { ask(tf, s); ask(LOWER[tf] ?? tf, s); }
    const barsBy = new Map<string, Record<string, IntradayBar[]>>();
    for (const [tf, syms] of want) {
      try {
        barsBy.set(tf, await this.fetchBars([...syms], tf, c.bars));
      } catch (e) {
        note.push(`candele ${tf} non disponibili: ${(e as Error).message}`);
        barsBy.set(tf, {});
      }
    }
    const barsOf = (s: string, tf: string) => barsBy.get(tf)?.[s];
    // Kronos sulle prossime candele, una proiezione per titolo e candela finché non ne chiude una nuova.
    const kronosOn = async (pairs: { s: string; tf: string }[]) => {
      const out = new Map<string, number[]>();
      if (!this.forecast || !pairs.length) return out;
      const byTf = new Map<string, string[]>();
      for (const p of pairs) byTf.set(p.tf, [...(byTf.get(p.tf) ?? []), p.s]);
      for (const [tf, syms] of byTf) {
        const keyOf = (s: string) => `${tf}|${barsOf(s, tf)!.at(-1)!.t}`;
        const need = syms.filter((s) => this.kCache.get(`${s}|${tf}`)?.chiave !== keyOf(s));
        if (need.length) {
          try {
            const n = profondita(tf);
            const r = await this.forecast(Object.fromEntries(need.map((s) => [s, barsOf(s, tf)!])), tfMinutes(tf), n);
            for (const s of need) if (r[s] !== undefined) this.kCache.set(`${s}|${tf}`, { chiave: keyOf(s), path: Array.isArray(r[s]) ? (r[s] as number[]) : Array.from({ length: n }, () => r[s] as number) });
          } catch (e) {
            note.push(`Kronos intraday non disponibile (${tf}): ${(e as Error).message}`);
          }
        }
        for (const s of syms) { const k = this.kCache.get(`${s}|${tf}`); if (k && k.chiave === keyOf(s)) out.set(`${s}|${tf}`, k.path); }
      }
      return out;
    };
    const probOf = (b: IntradayBar[], k: number, candele: number) => {
      const rets = b.slice(-50).map((x, i, arr) => (i ? x.close / arr[i - 1]!.close - 1 : 0)).slice(1);
      const sd = rets.length > 5 ? Math.sqrt(rets.reduce((a2, x) => a2 + x * x, 0) / rets.length) : null;
      return sd ? 0.5 * (1 + erf(k / (sd * Math.sqrt(candele)) / Math.SQRT2)) : null;
    };
    // Costo di andata e ritorno: il rialzo previsto deve coprirlo `margineCosti` volte.
    const costoDi = (s: string) => (isCrypto(s) ? AGENTS.costi.cryptoAndataRitorno : AGENTS.costi.azioniAndataRitorno) * AGENTS.costi.margineCosti;
    // La coppia candela + orizzonte migliore tra quelle che stanno nel tempo rimasto: prima chi copre i costi, poi la probabilità.
    const migliore = (s: string, tf: string, path: number[], b: IntradayBar[], disponibili: number) => {
      const opz = orizzonti(tf).filter((o) => o.h <= disponibili && o.n <= path.length).map((o) => {
        const k = retAt(path, o.n);
        return { ...o, k, pr: probOf(b, k, o.n), passa: k > 0 && k >= costoDi(s) };
      });
      opz.sort((a, d) => Number(d.passa) - Number(a.passa) || (d.pr ?? 0) - (a.pr ?? 0) || d.k - a.k);
      return opz[0] ?? null;
    };

    // Uscite, vincolanti: obiettivo, stop, media a 20 candele persa, fine giornata; e la candela più breve per decidere:
    // Kronos lì sopra dice se tenere (rialzo probabile: oltre l'obiettivo si lascia correre con lo stop alzato), se
    // incassare prima (calo che azzererebbe il guadagno) o se tagliare la perdita (calo che porta verso lo stop).
    const lowK = await kronosOn([...mine].filter((s) => barsOf(s, LOWER[tfOfMine.get(s)!] ?? tfOfMine.get(s)!)?.length).map((s) => ({ s, tf: LOWER[tfOfMine.get(s)!] ?? tfOfMine.get(s)! })));
    for (const s of mine) {
      const p = held.get(s)!;
      const price = v.prices[s] ?? p.currentPrice;
      const tf = tfOfMine.get(s)!;
      const lo = LOWER[tf] ?? tf;
      const b = barsOf(s, tf) ?? [];
      const read = b.length ? readBars(b, price, isCrypto(s)) : null;
      let op = this.operazioni.get(s);
      if (!op) {
        // Processo ripartito: livelli ricostruiti dal carico e dalle candele di adesso.
        const entry = p.avgEntryPrice;
        const aperta = v.journal.trade.find((t) => t.simbolo === s && t.stato === "aperto")?.apertoIl;
        op = { simbolo: s, candela: tf, giorno: v.today, ...(aperta ? { aperta } : {}), ingresso: entry, obiettivo: entry * (1 + (read?.targetPct ?? (isCrypto(s) ? c.target.crypto : c.target.stocks))), stop: entry * (1 - (read?.stopPct ?? (isCrypto(s) ? c.minStopPct.crypto : c.minStopPct.stocks) * 2)) };
        this.operazioni.set(s, op);
      }
      const gain = price / op.ingresso - 1;
      // Il controllo guarda l'orizzonte con cui si è entrati (almeno tre candele brevi), senza superare il tempo rimasto.
      const kpath = lowK.get(`${s}|${lo}`);
      const ctrlMin = Math.max(tfMinutes(lo) * 3, Math.min(op.orizzonteMin ?? 60, Math.max(minutiPer(s), 0) || tfMinutes(lo) * 3));
      const nl = kpath ? Math.min(kpath.length, nCandele(lo, ctrlMin)) : 0;
      const kl = kpath ? retAt(kpath, nl) : undefined;
      const bl = barsOf(s, lo);
      const pl = kl !== undefined && bl ? probOf(bl, kl, nl) : null;
      const orizzonteCtrl = etichetta(nl * tfMinutes(lo));
      const controllo = kl !== undefined ? `candele ${lo} a ${orizzonteCtrl}: Kronos ${pct(kl)}${pl !== null ? ` (${Math.round(pl * 100)}% al rialzo)` : ""}` : `candele ${lo}: nessuna proiezione`;
      const margine = isCrypto(s) ? AGENTS.protezioneProfitto.margine.crypto : AGENTS.protezioneProfitto.margine.stocks;
      const why = (m: string) => `${s} intraday (${tf}, controllo su ${lo}): ${m}`;
      let motivo: string | null = null;
      const corre = kl !== undefined && kl > 0 && (pl ?? 0) >= 0.6;
      if (price >= op.obiettivo && corre) {
        // Oltre l'obiettivo e la candela più breve vede ancora salire: si lascia correre, lo stop sale a metà strada.
        op.stop = Math.max(op.stop, op.ingresso * (1 + margine), price - (price - op.ingresso) / 2);
      } else if (price >= op.obiettivo) motivo = `obiettivo raggiunto: ${num(price)} ≥ ${num(op.obiettivo)} (${pct(gain)} dall'ingresso)${kl !== undefined ? `; sulle candele ${lo} Kronos non vede altro rialzo` : ""}`;
      if (!motivo) {
        if (v.giornata?.obiettivoRaggiunto && price > op.ingresso) motivo = `obiettivo giornaliero del conto raggiunto: si incassa (${pct(gain)})`;
        else if (price <= op.stop) motivo = `stop intraday: ${num(price)} ≤ ${num(op.stop)} (${pct(gain)})`;
        else if (mustClose(s)) motivo = `${isCrypto(s) ? `${c.cryptoOreMax} ore dall'ingresso, durata massima` : "chiusura della borsa vicina"}: si chiude a ${pct(gain)} dall'ingresso`;
        else if (AGENTS.protezioneProfitto.enabled && kl !== undefined && kl < 0 && gain > margine && (1 + gain) * (1 + kl) - 1 <= margine) motivo = `protezione del profitto: +${(gain * 100).toFixed(2)}% in tasca, ma Kronos vede ${pct(kl)} nei prossimi ${orizzonteCtrl} (candele ${lo}), che lo azzererebbe: si incassa adesso`;
        else if (kl !== undefined && gain < 0 && kl < 0 && (pl ?? 1) <= 0.35 && price * (1 + kl) <= price - (price - op.stop) / 2) motivo = `taglio della perdita: ${pct(gain)} e sulle candele ${lo} Kronos vede ancora ${pct(kl)} (rialzo solo al ${Math.round((pl ?? 0) * 100)}%), metà strada verso lo stop: si esce prima`;
        else if (op.orizzonteMin !== undefined && (apertaDa(s) ?? 0) >= op.orizzonteMin * c.scadenzaOrizzonte && !corre) motivo = `orizzonte di Kronos scaduto (${etichetta(op.orizzonteMin)} × ${c.scadenzaOrizzonte}) senza raggiungere l'obiettivo e senza rialzo ancora probabile: si chiude a ${pct(gain)}`;
        else if (read?.ema20 && b.length >= 2 && b[b.length - 1]!.close < read.ema20 && b[b.length - 2]!.close < read.ema20 && !corre) motivo = `due candele chiuse sotto la media a 20 (${num(read.ema20)}): il movimento è finito (${pct(gain)})`;
      }
      if (motivo) segnali.push({ agente: this.name, simbolo: s, lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, intraday: true, perche: why(motivo) });
      stati.push({ simbolo: s, candela: tf, controllo, fase: "in posizione", ingresso: op.ingresso, obiettivo: op.obiettivo, stop: op.stop, prezzo: price, motivo: motivo ?? `${corre && price >= op.obiettivo ? "oltre l'obiettivo, si lascia correre" : "in corsa"}: obiettivo ${num(op.obiettivo)}, stop ${num(op.stop)}, ${pct(gain)}` });
    }

    // Ingressi: per ogni candidato e ogni candela che sta nel tempo rimasto, 1) medie brevi (EMA 9 sopra EMA 20, prezzo sopra
    // la 9) o rottura/rientro, obiettivo raggiungibile e rapporto obiettivo/stop; 2) Kronos sulle prossime candele, letto a più
    // orizzonti (minuti e ore): si sceglie la coppia candela + orizzonte che copre i costi con la probabilità più alta. 3) In parte il grafico superiore e il Kronos a 5 sedute: contrari, taglia dimezzata.
    interface Prova { tf: string; read: ReturnType<typeof readBars>; breve: boolean; ok: string | null; reward: number; expected: number }
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
        const ok = tfMinutes(tf) > minutiPer(s) ? `la candela ${tf} è più lunga del tempo rimasto (${etichetta(Math.max(0, minutiPer(s)))}): non può completarsi in giornata` : !breve && !read.entra ? `medie brevi non in ordine sulle candele ${tf} (serve EMA 9 sopra EMA 20 e prezzo sopra la 9) e ${read.pattern}` : /troppo esteso/.test(read.pattern) ? read.pattern : reward < 1.2 ? `rapporto obiettivo/stop ${reward.toFixed(2)} troppo basso (${tf})` : expected < read.targetPct * 0.8 ? `obiettivo ${pct(read.targetPct)} non raggiungibile entro la chiusura sulle candele ${tf} (atteso ${pct(expected)})` : null;
        list.push({ tf, read, breve, ok, reward, expected });
      }
      prove.set(s, list);
    }
    // Kronos per le coppie titolo-candela tecnicamente valide (prima le rotture e i rientri), fino a perGiro coppie.
    const pairs = [...prove].flatMap(([s, l]) => l.filter((x) => x.ok === null).map((x) => ({ s, tf: x.tf, rank: x.read.entra ? 0 : 1 }))).sort((a, b) => a.rank - b.rank).slice(0, c.kronos.perGiro);
    const kIn = await kronosOn(pairs);

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
      const scored = list.map((x) => {
        const path = kIn.get(`${s}|${x.tf}`);
        const o = path ? migliore(s, x.tf, path, barsOf(s, x.tf)!, minutiPer(s)) : null;
        return { ...x, k: o?.k, pr: o?.pr ?? null, h: o?.h, passa: o?.passa ?? false };
      });
      const valide = scored.filter((x) => x.ok === null);
      const conK = valide.filter((x) => x.k !== undefined).sort((a, b) => Number(b.passa) - Number(a.passa) || (b.pr ?? 0) - (a.pr ?? 0) || (b.k ?? 0) - (a.k ?? 0));
      const best = conK[0] ?? valide[0] ?? scored[0]!;
      const valutate = this.forecast ? scored.filter((x) => x.pr !== null).map((x) => `${x.tf} a ${etichetta(x.h!)} ${Math.round(x.pr! * 100)}%`).join(" · ") : "";
      const { tf, read, k, pr, h } = best;
      let motivo: string | null = best.ok;
      if (!motivo) {
        if (this.forecast && k === undefined) motivo = "in attesa della proiezione di Kronos sulle candele brevi";
        else if (k !== undefined && (!best.passa || (pr ?? 0) < c.kronos.minProb)) motivo = `Kronos a ${etichetta(h!)} sulle candele ${tf}: ${pct(k)}${pr !== null ? `, probabilità ${Math.round(pr * 100)}%` : ""}: non basta (serve un rialzo di almeno ${pct(costoDi(s))}, ${AGENTS.costi.margineCosti} volte i costi, con probabilità ≥ ${Math.round(c.kronos.minProb * 100)}%)`;
        else if (k === undefined && !(fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia / 2) && !read.entra) motivo = "senza Kronos intraday serve una rottura o un rientro";
      }
      if (motivo) {
        stati.push({ simbolo: s, candela: tf, fase: "cerca ingresso", ingresso: null, obiettivo: null, stop: null, prezzo: price, motivo: `${motivo}${valutate ? ` · probabilità per candela: ${valutate}` : ""}` });
        continue;
      }
      // Correttivi: il grafico superiore (prezzo sotto la sua EMA 20) e il Kronos a 5 sedute contrario dimezzano la taglia.
      const up = UP[tf] ?? "1Day";
      const ub = up === "1Day" ? null : barsOf(s, up);
      const eUp = up === "1Day" ? ema(v.closes[s] ?? [], 20) : ub ? ema(ub.map((x) => x.close), 20) : null;
      const correttivi: string[] = [];
      if (eUp !== null && price < eUp) correttivi.push(`grafico ${up === "1Day" ? "giornaliero" : `a ${up}`} sotto la sua media a 20`);
      if (this.forecast && fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia) correttivi.push(`Kronos a ${AGENTS.kronos.horizon} sedute ${pct(fc)}`);
      const target = price * (1 + read.targetPct), stop = price * (1 - read.stopPct);
      // I livelli si tengono da subito; il blocco "un ingresso al giorno" scatta solo a ordine eseguito (dal diario): se
      // l'allocatore o la gabbia scartano il voto, il titolo resta candidato al giro dopo.
      this.operazioni.set(s, { simbolo: s, candela: tf, giorno: v.today, ingresso: price, obiettivo: target, stop, aperta: v.now.toISOString(), ...(h !== undefined && k !== undefined ? { orizzonteMin: h } : {}) });
      // Taglia: la fiducia in Kronos intraday la scala (al minimo metà, dal 70% piena); ogni correttivo la dimezza.
      const fid = pr === null ? 1 : Math.max(0.5, Math.min(1, 0.5 + ((pr - c.kronos.minProb) / (0.7 - c.kronos.minProb)) * 0.5));
      const peso = c.maxWeight * fid * Math.pow(0.5, correttivi.length);
      const ingresso = read.entra ? read.pattern : `medie brevi in ordine sulle candele ${tf} (prezzo sopra EMA 9 sopra EMA 20)`;
      segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: peso, ...(k !== undefined ? {} : fc !== undefined ? { kronos: fc } : {}), perche: `${s} intraday su candele ${tf}${valutate ? ` (scelta per probabilità: ${valutate})` : ""}: ${ingresso}${k !== undefined ? `; Kronos a ${etichetta(h!)} sulle candele ${tf} ${pct(k)} (probabilità ${Math.round((pr ?? 0) * 100)}%)` : fc !== undefined ? `; Kronos ${pct(fc)} a ${AGENTS.kronos.horizon} sedute` : ""}${correttivi.length ? `; in parte contrari: ${correttivi.join(" e ")}, taglia ridotta` : ""}; obiettivo ${num(target)} (${pct(read.targetPct)}), stop ${num(stop)} (${pct(-read.stopPct)}), poi controllo su candele ${LOWER[tf] ?? tf}, chiusura ${chiusuraDi(s)}` });
      stati.push({ simbolo: s, candela: tf, ...(h !== undefined && k !== undefined ? { orizzonte: etichetta(h) } : {}), controllo: `poi candele ${LOWER[tf] ?? tf}`, fase: "cerca ingresso", ingresso: price, obiettivo: target, stop, prezzo: price, motivo: `ingresso votato: ${ingresso}${valutate ? ` · probabilità per candela: ${valutate}` : ""}` });
    }
    const n = segnali.filter((x) => x.lato === "buy").length;
    note.unshift(`${[...mine].length} operazioni aperte, ${candidates.length} candidate, ${n} ingressi votati${this.forecast ? ` · candele valutate: ${TFS.join(", ")}` : ""}`);
    return { segnali, note, intraday: stati };
  }
}
