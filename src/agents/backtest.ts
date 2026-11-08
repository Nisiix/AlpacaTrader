import { evaluateBreaker, type BreakerFile } from "../breaker.ts";
import { applyCage } from "../cage.ts";
import { MIX } from "../benchmark.ts";
import { AGENTS, BACKTEST, LIMITS, UNIVERSE } from "../config.ts";
import { sma } from "../indicators.ts";
import { indicatorsFor } from "../indicators.ts";
import { emptyJournal, learnFromJournal, learningStatus, statsOf, type JournalFile, type Stats, type Trade } from "../journal.ts";
import { activeLessons, emptyLessons, learnFromStopLoss } from "../lessons.ts";
import { addTradingDays } from "../slots.ts";
import { agentWeights, allocate } from "./allocator.ts";
import { ContextAgent } from "./context.ts";
import { HorizonAgent } from "./horizon.ts";
import { PullbackAgent } from "./pullback.ts";
import { RegimeAgent } from "./regime.ts";
import { TrendAgent } from "./trend.ts";
import type { Agent, AgentReport, AgentView } from "./types.ts";

export interface AgentsBacktestResult {
  days: number;
  totalReturn: number;
  spyReturn: number;
  mixReturn: number;
  maxDrawdown: number;
  buys: number;
  sells: number;
  trendExits: number; // uscite di trend della gabbia
  stopOuts: number;
  agentSells: number; // vendite decise dagli agenti (punteggi e regole di uscita)
  exitRuleSells: number; // di cui per le regole di uscita (stop -2%, obiettivo, proiezione)
  breakerTrips: number;
  rejectedByCage: Record<string, number>;
  // Esposizione media (quota del conto investita) e giorni con almeno una posizione.
  avgExposure: number;
  // Statistiche dei trade chiusi, in tutto e per agente che ha votato l'ingresso.
  stats: Stats;
  perAgent: Record<string, Stats>;
  finalWeights: Record<string, number>;
  learningFrom: string | null; // da quando il diario ha iniziato a pesare gli agenti
  avgHoldDays: number;
  costs: number; // costi pagati in totale (frazione del capitale iniziale)
  gtaaReturn: number; // Faber GTAA sullo stesso universo e periodo, stessi costi
  // Il complessivo giorno per giorno: quanto spesso si chiude in positivo e quanto si perde quando va male.
  daily: DailyStats;
}

export interface DailyStats {
  giorni: number;
  giorniInvestiti: number; // con almeno una posizione
  giorniPositivi: number; // variazione > 0
  giorniNegativi: number;
  giorniPiatti: number; // nessuna posizione o variazione nulla
  mediaGiornaliera: number; // frazione del conto
  mediaGiornoPositivo: number;
  mediaGiornoNegativo: number;
  peggiorGiorno: number;
  migliorGiorno: number;
  serieNegativaMassima: number; // giorni consecutivi in perdita
  settimanePositive: number;
  settimane: number;
  mesiPositivi: number;
  mesi: number;
  profittoTrade: number; // somma in $ dei risultati dei trade chiusi
  profittoTradeVinti: number;
  perditaTradePersi: number;
}

export function dailyStats(equity: number[], dates: string[], trades: Trade[]): DailyStats {
  const d: DailyStats = { giorni: 0, giorniInvestiti: 0, giorniPositivi: 0, giorniNegativi: 0, giorniPiatti: 0, mediaGiornaliera: 0, mediaGiornoPositivo: 0, mediaGiornoNegativo: 0, peggiorGiorno: 0, migliorGiorno: 0, serieNegativaMassima: 0, settimanePositive: 0, settimane: 0, mesiPositivi: 0, mesi: 0, profittoTrade: 0, profittoTradeVinti: 0, perditaTradePersi: 0 };
  let streak = 0, sum = 0, sumPos = 0, sumNeg = 0;
  const weekKey = (date: string) => {
    const t = new Date(`${date}T12:00:00Z`);
    const day = (t.getUTCDay() + 6) % 7; // lunedì = 0
    t.setUTCDate(t.getUTCDate() - day);
    return t.toISOString().slice(0, 10);
  };
  const byWeek = new Map<string, number>();
  const byMonth = new Map<string, number>();
  for (let i = 1; i < equity.length; i++) {
    const r = equity[i]! / equity[i - 1]! - 1;
    d.giorni++;
    sum += r;
    if (r > 1e-9) {
      d.giorniPositivi++;
      sumPos += r;
      streak = 0;
    } else if (r < -1e-9) {
      d.giorniNegativi++;
      sumNeg += r;
      streak++;
      d.serieNegativaMassima = Math.max(d.serieNegativaMassima, streak);
    } else {
      d.giorniPiatti++;
      streak = 0;
    }
    d.peggiorGiorno = Math.min(d.peggiorGiorno, r);
    d.migliorGiorno = Math.max(d.migliorGiorno, r);
    const date = dates[i]!;
    byWeek.set(weekKey(date), (byWeek.get(weekKey(date)) ?? 0) + r);
    byMonth.set(date.slice(0, 7), (byMonth.get(date.slice(0, 7)) ?? 0) + r);
  }
  d.mediaGiornaliera = d.giorni ? sum / d.giorni : 0;
  d.mediaGiornoPositivo = d.giorniPositivi ? sumPos / d.giorniPositivi : 0;
  d.mediaGiornoNegativo = d.giorniNegativi ? sumNeg / d.giorniNegativi : 0;
  d.settimane = byWeek.size;
  d.settimanePositive = [...byWeek.values()].filter((x) => x > 0).length;
  d.mesi = byMonth.size;
  d.mesiPositivi = [...byMonth.values()].filter((x) => x > 0).length;
  for (const t of trades) {
    if (t.stato !== "chiuso") continue;
    const pnl = t.incassato - t.costo;
    d.profittoTrade += pnl;
    if (pnl > 0) d.profittoTradeVinti += pnl;
    else d.perditaTradePersi += pnl;
  }
  return d;
}

// Faber GTAA (2007): ogni titolo dell'universo a peso uguale quando il prezzo è sopra la media a 10 mesi (210 sedute),
// altrimenti liquidità; ribilanciamento a fine mese (ogni 21 sedute). È il confronto onesto per un sistema di trend.
export function gtaaBenchmark(closes: Record<string, number[]>, symbols: string[], first: number, len: number, startEquity = 100_000): number {
  const syms = symbols.filter((s) => closes[s]);
  let cash = startEquity;
  const pos = new Map<string, number>();
  for (let day = first; day < len; day++) {
    const price = (s: string) => closes[s]![day]!;
    if ((day - first) % 21 !== 0) continue;
    const equity = cash + [...pos].reduce((a, [s, q]) => a + q * price(s), 0);
    const inTrend = syms.filter((s) => {
      const m = sma(closes[s]!.slice(0, day + 1), 210);
      return m !== null && price(s) > m;
    });
    const target = inTrend.length ? equity / syms.length : 0;
    for (const s of syms) {
      const want = inTrend.includes(s) ? target / price(s) : 0;
      const have = pos.get(s) ?? 0;
      const delta = want - have;
      if (Math.abs(delta * price(s)) < equity * 0.005) continue;
      cash -= delta * price(s) + Math.abs(delta * price(s)) * (BACKTEST.costBps / 10_000);
      pos.set(s, want);
    }
  }
  const last = len - 1;
  const final = cash + [...pos].reduce((a, [s, q]) => a + q * closes[s]![last]!, 0);
  return final / startEquity - 1;
}

// Il motore degli agenti rigiocato sulle chiusure: ogni seduta vale una passata nella finestra di ingresso,
// con esecuzione alla chiusura. Stessa convenzione del backtest della gabbia (la chiusura di oggi è l'ultima nota):
// ottimista sui buchi intraday, niente costi né slippage, calendario eventi assente.
export function runAgentsBacktest(closes: Record<string, number[]>, startEquity = 100_000, startDate = "2026-01-05", agents: Agent[] = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent(), new ContextAgent(null, [])]): AgentsBacktestResult {
  const SYMBOLS = [...new Set([...UNIVERSE, ...AGENTS.universe])];
  const len = Math.min(...SYMBOLS.filter((s) => closes[s]).map((s) => closes[s]!.length));
  const positions = new Map<string, { qty: number; avg: number }>();
  const journal: JournalFile = emptyJournal();
  const lessons = emptyLessons();
  let cash = startEquity;
  let lastEquity = startEquity;
  let breaker: BreakerFile | null = null;
  let peak = startEquity;
  let date = startDate;
  let exposureSum = 0;
  let weights: Record<string, number> = {};
  const equityCurve: number[] = [startEquity];
  const dateCurve: string[] = [startDate];
  const r: AgentsBacktestResult = { days: 0, totalReturn: 0, spyReturn: 0, mixReturn: 0, maxDrawdown: 0, buys: 0, sells: 0, trendExits: 0, stopOuts: 0, agentSells: 0, exitRuleSells: 0, breakerTrips: 0, rejectedByCage: {}, avgExposure: 0, stats: statsOf([]), perAgent: {}, finalWeights: {}, learningFrom: null, avgHoldDays: 0, costs: 0, gtaaReturn: 0, daily: dailyStats([startEquity], [startDate], []) };
  // Si parte quando ci sono abbastanza barre per la media a 200 e per il momentum a 12 mesi.
  const first = Math.max(LIMITS.longSmaDays, AGENTS.absMomentum.days + 1);
  const cost = (value: number) => {
    const c = Math.abs(value) * (BACKTEST.costBps / 10_000);
    r.costs += c / startEquity;
    return c;
  };
  const names = agents.map((a) => a.name);

  for (let day = first; day < len; day++, date = addTradingDays(date, 1)) {
    const prices: Record<string, number> = {};
    for (const s of SYMBOLS) if (closes[s]) prices[s] = closes[s]![day]!;
    const equity = cash + [...positions].reduce((a, [s, p]) => a + p.qty * prices[s]!, 0);
    const ev = evaluateBreaker(breaker, equity, lastEquity, `${date}T20:00:00Z`);
    breaker = ev.file;
    if (ev.newlyTripped) r.breakerTrips++;
    const hist: Record<string, number[]> = {};
    for (const s of SYMBOLS) if (closes[s]) hist[s] = closes[s]!.slice(0, day + 1);
    const pos = [...positions].map(([symbol, p]) => ({ symbol, qty: p.qty, avgEntryPrice: p.avg, currentPrice: prices[symbol]!, marketValue: p.qty * prices[symbol]! }));
    for (const t of journal.trade) if (t.stato === "aperto" && prices[t.simbolo]) t.massimo = Math.max(t.massimo ?? 0, prices[t.simbolo]!);
    const account = { equity, lastEquity, cash, status: "ACTIVE" };
    const view: AgentView = { today: date, now: new Date(`${date}T14:00:00Z`), prices, closes: hist, indicators: indicatorsFor(hist, prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays), positions: pos, account, journal };
    const reports: Record<string, AgentReport> = {};
    // Nel backtest il contesto usa solo le regole sui dati (il calendario eventi non ha storico): sincrono.
    const ctx = agents.find((a): a is ContextAgent => a instanceof ContextAgent);
    if (ctx) view.contesto = ctx.assessWith(view, null);
    for (const a of agents) {
      if (a instanceof ContextAgent) {
        const c = view.contesto!;
        reports[a.name] = { segnali: [], rischio: c.generale === "sfavorevole" ? AGENTS.context.unfavorableScale : c.generale === "neutro" ? AGENTS.context.neutralScale : 1, contesto: c };
        continue;
      }
      reports[a.name] = a.observe(view) as AgentReport; // gli altri agenti del backtest sono sincroni
    }
    weights = agentWeights(journal, date, names);
    if (!r.learningFrom && learningStatus(journal, date).attivo) r.learningFrom = date;
    const alloc = allocate(view, reports, weights);
    const cage = applyCage({ today: date, events: [], slotKind: "open", marketOpen: true, latenessMin: 0, account, positions: pos, prices, closes: hist, recentOrders: [], lessons: activeLessons(lessons, date), buyBlock: ev.buyBlock, proposals: alloc.proposte });
    for (const x of cage.rejected) {
      const k = x.reason.split(":")[0]!.replace(/[0-9.,%$]+/g, "#").slice(0, 60);
      r.rejectedByCage[k] = (r.rejectedByCage[k] ?? 0) + 1;
    }
    for (const o of cage.orders) {
      const price = prices[o.symbol]!;
      const p = positions.get(o.symbol) ?? { qty: 0, avg: 0 };
      const open = journal.trade.find((t) => t.simbolo === o.symbol && t.stato === "aperto");
      if (o.side === "buy") {
        p.avg = (p.avg * p.qty + price * o.qty) / (p.qty + o.qty);
        p.qty += o.qty;
        cash -= o.qty * price + cost(o.qty * price);
        r.buys++;
        const agenti = alloc.punteggi.find((s) => s.simbolo === o.symbol)?.agenti ?? [];
        if (open) {
          open.comprate += o.qty;
          open.costo += o.qty * price;
          open.quantita += o.qty;
        } else {
          journal.trade.push({ id: `bt-${date}-${o.symbol}`, simbolo: o.symbol, stato: "aperto", apertoIl: `${date}T20:00:00Z`, comprate: o.qty, costo: o.qty * price, vendute: 0, incassato: 0, quantita: o.qty, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: o.why, agenti } });
        }
      } else {
        p.qty -= o.qty;
        cash += o.qty * price - cost(o.qty * price);
        r.sells++;
        if (o.source === "uscita-trend") r.trendExits++;
        if (o.source === "modello") r.agentSells++;
        if (o.source === "modello" && o.why.startsWith("uscite:")) r.exitRuleSells++;
        if (o.source === "stop-loss") {
          r.stopOuts++;
          learnFromStopLoss(lessons, `bt-${o.symbol}-${date}`, o.symbol, date, o.why);
        }
        if (open) {
          const q = Math.min(o.qty, open.quantita);
          open.vendute += q;
          open.incassato += q * price;
          open.quantita -= q;
          if (open.quantita <= 0) {
            const entry = open.costo / open.comprate;
            const exit = open.incassato / open.vendute;
            Object.assign(open, { stato: "chiuso", chiusoIl: `${date}T20:00:00Z`, prezzoIngresso: entry, prezzoUscita: exit, risultato: exit / entry - 1, giorni: Math.round((Date.parse(date) - Date.parse(open.apertoIl)) / 86_400_000), motivoUscita: o.source === "modello" ? `agenti: ${o.why}` : o.source });
          }
        }
      }
      if (p.qty > 0) positions.set(o.symbol, p);
      else positions.delete(o.symbol);
    }
    learnFromJournal(lessons, journal, date);
    const after = cash + [...positions].reduce((a, [s, p]) => a + p.qty * prices[s]!, 0);
    exposureSum += after > 0 ? 1 - cash / after : 0;
    peak = Math.max(peak, after);
    r.maxDrawdown = Math.max(r.maxDrawdown, 1 - after / peak);
    lastEquity = after;
    r.days++;
    equityCurve.push(after);
    dateCurve.push(date);
    if (day === first) {
      // Il primo giorno investito non ha un "ieri": la curva parte da qui.
      equityCurve.splice(0, equityCurve.length - 1);
      dateCurve.splice(0, dateCurve.length - 1);
    }
  }
  r.totalReturn = lastEquity / startEquity - 1;
  r.daily = dailyStats(equityCurve, dateCurve, journal.trade);
  const spy = closes.SPY;
  r.spyReturn = spy && len > first ? spy[len - 1]! / spy[first]! - 1 : 0;
  const tlt = closes.TLT;
  r.mixReturn = spy && tlt && len > first ? MIX.spy * r.spyReturn + MIX.tlt * (tlt[len - 1]! / tlt[first]! - 1) : 0;
  r.avgExposure = r.days ? exposureSum / r.days : 0;
  r.stats = statsOf(journal.trade);
  const byAgent: Record<string, Trade[]> = {};
  for (const t of journal.trade) if (t.stato === "chiuso") for (const a of t.contesto?.agenti ?? []) (byAgent[a] ??= []).push(t);
  r.perAgent = Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, statsOf(v)]));
  r.finalWeights = weights;
  const closed = journal.trade.filter((t) => t.stato === "chiuso");
  r.avgHoldDays = closed.length ? closed.reduce((a, t) => a + (t.giorni ?? 0), 0) / closed.length : 0;
  r.gtaaReturn = gtaaBenchmark(closes, SYMBOLS.filter((s) => !s.includes("/")), first, len, startEquity);
  return r;
}
