import type { ProposedOrder } from "../brain/types.ts";
import { maxWeightFor } from "../cage.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, LIMITS, isCrypto } from "../config.ts";
import { dailyVol } from "../indicators.ts";
import { roundQty } from "../broker/types.ts";
import { learningStatus, statsOf, type JournalFile } from "../journal.ts";
import type { AgentReport, AgentView, Signal } from "./types.ts";

export interface Score {
  simbolo: string;
  punteggio: number;
  compra: number;
  vende: number;
  agenti: string[];
  perche: string[];
  // Se tutti i voti di acquisto vengono da comparti a taglia ridotta, il peso massimo che chiedono.
  pesoMassimo?: number;
  // Se tutti i voti di acquisto sono intraday, l'operazione lo è (si chiude in giornata).
  intraday?: boolean;
  // La proiezione di Kronos più netta tra i voti d'acquisto.
  kronos?: number;
  // Probabilità che la proiezione si avveri (decide la taglia).
  fiducia?: number | null;
}

export interface Allocation {
  proposte: ProposedOrder[];
  punteggi: Score[];
  rischio: number;
  pesi: Record<string, number>;
  // Titoli che avrebbero un punteggio da acquisto ma il contesto dice di aspettare la candela successiva.
  inAttesa: { simbolo: string; motivo: string }[];
}

// Peso di ogni agente dai risultati del diario: parte da 1; scende se l'agente ha votato ingressi che perdono
// (campione almeno indicativo), sale se vince con campione affidabile. Finché la raccolta dati non è finita, tutti 1.
export function agentWeights(journal: JournalFile, today: string, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const active = learningStatus(journal, today).attivo;
  for (const n of names) {
    out[n] = AGENTS.weights.base;
    if (!active) continue;
    const s = statsOf(journal.trade.filter((t) => t.contesto?.agenti?.includes(n)));
    if (s.attesa === null) continue;
    if (s.attesa < 0 && (s.campione === "indicativo" || s.campione === "affidabile")) out[n] = AGENTS.weights.losing;
    else if (s.attesa > 0 && s.campione === "affidabile") out[n] = AGENTS.weights.winning;
  }
  return out;
}

export function scoreSignals(signals: Signal[], weights: Record<string, number>): Score[] {
  const by = new Map<string, Score>();
  for (const s of signals) {
    if (s.vincolante) continue;
    const sc = by.get(s.simbolo) ?? { simbolo: s.simbolo, punteggio: 0, compra: 0, vende: 0, agenti: [], perche: [] };
    const w = (weights[s.agente] ?? AGENTS.weights.base) * s.forza;
    if (s.lato === "buy") {
      sc.compra += w;
      sc.intraday = sc.compra === w ? !!s.intraday : sc.intraday && !!s.intraday;
      if (s.kronos !== undefined && (sc.kronos === undefined || s.kronos > sc.kronos)) sc.kronos = s.kronos;
      // Un voto senza limite di taglia (es. il trend) toglie il limite; se tutti i voti lo hanno, vale il più piccolo.
      if (s.pesoMassimo === undefined) sc.pesoMassimo = Infinity;
      else if (sc.pesoMassimo !== Infinity) sc.pesoMassimo = Math.min(sc.pesoMassimo ?? Infinity, s.pesoMassimo);
    } else sc.vende += w;
    sc.punteggio = sc.compra - sc.vende;
    if (!sc.agenti.includes(s.agente)) sc.agenti.push(s.agente);
    sc.perche.push(`${s.agente}: ${s.perche}`);
    by.set(s.simbolo, sc);
  }
  for (const sc of by.values()) if (sc.pesoMassimo === Infinity) delete sc.pesoMassimo;
  return [...by.values()].sort((a, b) => b.punteggio - a.punteggio);
}

// Fiducia nella proiezione di Kronos: P(rendimento > 0) = Φ(atteso / (volatilità × √orizzonte)). Da lì il fattore di taglia.
export function kronosConfidence(view: AgentView, symbol: string): { p: number | null; factor: number } {
  const fc = view.previsioni?.[symbol];
  const vol = view.closes[symbol] ? dailyVol(view.closes[symbol]!, LIMITS.volLookbackDays) : null;
  const c = AGENTS.sizing;
  if (fc === undefined || vol === null || vol <= 0) return { p: null, factor: c.noForecast };
  const z = fc / (vol * Math.sqrt(AGENTS.kronos.horizon));
  const p = 0.5 * (1 + erf(z / Math.SQRT2));
  const t = Math.max(0, Math.min(1, (p - 0.5) / (c.fullAt - 0.5)));
  return { p, factor: c.minFactor + (1 - c.minFactor) * t };
}
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// Volatilità annua attesa del portafoglio: √252 × corr × Σ peso × volatilità giornaliera (corr < 1 sconta la diversificazione).
export function portfolioVol(weights: Record<string, number>, closes: Record<string, number[]>): number {
  let sum = 0;
  for (const [s, w] of Object.entries(weights)) sum += w * ((closes[s] ? dailyVol(closes[s]!, LIMITS.volLookbackDays) : null) ?? LIMITS.fallbackDailyVol);
  return Math.sqrt(252) * AGENTS.volTarget.corr * sum;
}

// Dai punteggi agli ordini proposti. La gabbia (applyCage) resta a valle: qui si decide solo quanto si vorrebbe.
export function allocate(view: AgentView, reports: Record<string, AgentReport>, weights: Record<string, number>): Allocation {
  const signals = Object.values(reports).flatMap((r) => r.segnali);
  const rischio = Object.values(reports).reduce((a, r) => a * (r.rischio ?? 1), 1);
  const punteggi = scoreSignals(signals, weights);
  const proposte: ProposedOrder[] = [];
  const inAttesa: { simbolo: string; motivo: string }[] = [];
  const held = new Map(view.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const equity = view.account.equity;
  const conf = (x: number) => (x >= 1 ? "alta" : x >= 0.7 ? "media" : "bassa");

  // Prima le regole vincolanti (stop, obiettivo, proiezione contraria): vendono tutto, senza voto.
  const forced = new Set<string>();
  for (const s of signals) {
    if (!s.vincolante || s.lato !== "sell" || forced.has(s.simbolo)) continue;
    const p = held.get(s.simbolo);
    if (!p) continue;
    forced.add(s.simbolo);
    const qty = s.frazione && s.frazione < 1 ? roundQty(s.simbolo, p.qty * s.frazione) : p.qty;
    if (qty <= 0) continue;
    proposte.push({ symbol: s.simbolo, side: "sell", qty, why: `${s.agente}: ${s.perche}`, confidence: "alta", expect: s.frazione && s.frazione < 1 ? "presa di profitto parziale" : "regola di rischio" });
  }
  for (const sc of punteggi) {
    const p = held.get(sc.simbolo);
    if (forced.has(sc.simbolo)) continue;
    if (sc.punteggio <= AGENTS.sellScore && p) {
      proposte.push({ symbol: sc.simbolo, side: "sell", qty: p.qty, why: sc.perche.join(" · "), confidence: conf(-sc.punteggio), expect: `uscita: punteggio ${sc.punteggio.toFixed(2)}` });
    }
  }
  // Prima i pesi obiettivo di chi si vuole comprare, poi un solo fattore di scala se la volatilità di portafoglio supera l'obiettivo.
  let slots = LIMITS.maxPositions - held.size;
  const wanted: { sc: Score; w: number; p?: { qty: number } }[] = [];
  for (const sc of punteggi) {
    if (sc.punteggio < AGENTS.buyScore) break;
    if (forced.has(sc.simbolo)) continue;
    // Titoli azionari a borsa chiusa (o fuori finestra, salvo intraday): non si propongono e non occupano un posto,
    // così i posti liberi vanno alle crypto, che trattano sempre.
    if (!isCrypto(sc.simbolo) && (view.mercatoAperto === false || (view.finestraIngressi === false && !sc.intraday))) continue;
    const wait = view.contesto?.attendi[sc.simbolo];
    if (wait && !held.has(sc.simbolo)) {
      inAttesa.push({ simbolo: sc.simbolo, motivo: wait });
      continue;
    }
    const price = view.prices[sc.simbolo];
    if (!price || price <= 0) continue;
    const p = held.get(sc.simbolo);
    if (!p && slots <= 0) continue;
    let w = maxWeightFor(view.closes[sc.simbolo]).max * rischio * (AGENTS.scaleByScore ? Math.min(1, sc.punteggio) : 1);
    if (sc.pesoMassimo !== undefined) w = Math.min(w, sc.pesoMassimo);
    // Taglia proporzionale alla fiducia nella proiezione di Kronos: più è probabile che il rialzo si avveri, più si investe.
    if (AGENTS.sizing.byKronos) {
      const f = kronosConfidence(view, sc.simbolo);
      sc.fiducia = f.p;
      w *= f.factor;
    }
    if (!p) slots--;
    wanted.push({ sc, w, p });
  }
  let scale = 1;
  if (AGENTS.volTarget.enabled && equity > 0) {
    const heldW: Record<string, number> = {};
    for (const p of held.values()) if (!wanted.some((x) => x.sc.simbolo === p.symbol)) heldW[p.symbol] = (p.qty * (view.prices[p.symbol] ?? p.currentPrice)) / equity;
    const newW: Record<string, number> = Object.fromEntries(wanted.map((x) => [x.sc.simbolo, x.w]));
    const volHeld = portfolioVol(heldW, view.closes);
    const volNew = portfolioVol(newW, view.closes);
    const room = Math.max(0, AGENTS.volTarget.annual - volHeld);
    if (volNew > room) scale = volNew > 0 ? room / volNew : 0;
  }
  for (const { sc, w, p } of wanted) {
    const price = view.prices[sc.simbolo]!;
    const target = w * scale * equity;
    const have = p ? p.qty * price : 0;
    const delta = target - have;
    if (delta / equity < AGENTS.minAddPct) continue;
    const qty = roundQty(sc.simbolo, delta / price);
    if (qty <= 0 || (isCrypto(sc.simbolo) && qty * price < CRYPTO_MIN_NOTIONAL)) continue;
    proposte.push({ symbol: sc.simbolo, side: "buy", qty, why: sc.perche.join(" · "), confidence: conf(sc.punteggio), expect: `${sc.intraday ? "intraday: " : ""}peso obiettivo ${(w * scale * 100).toFixed(1)}% del conto${sc.fiducia !== undefined ? ` (fiducia nella proiezione ${sc.fiducia === null ? "n.d." : `${(sc.fiducia * 100).toFixed(0)}%`})` : ""}${scale < 1 ? ` (ridotto per la volatilità di portafoglio, obiettivo ${(AGENTS.volTarget.annual * 100).toFixed(0)}% annuo)` : ""}`, intraday: sc.intraday || undefined, kronos: sc.kronos });
  }
  return { proposte, punteggi, rischio, pesi: weights, inAttesa };
}
