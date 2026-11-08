import type { ProposedOrder } from "../brain/types.ts";
import { maxWeightFor } from "../cage.ts";
import { AGENTS, LIMITS } from "../config.ts";
import { learningStatus, statsOf, type JournalFile } from "../journal.ts";
import type { AgentReport, AgentView, Signal } from "./types.ts";

export interface Score {
  simbolo: string;
  punteggio: number;
  compra: number;
  vende: number;
  agenti: string[];
  perche: string[];
}

export interface Allocation {
  proposte: ProposedOrder[];
  punteggi: Score[];
  rischio: number;
  pesi: Record<string, number>;
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
    const sc = by.get(s.simbolo) ?? { simbolo: s.simbolo, punteggio: 0, compra: 0, vende: 0, agenti: [], perche: [] };
    const w = (weights[s.agente] ?? AGENTS.weights.base) * s.forza;
    if (s.lato === "buy") sc.compra += w;
    else sc.vende += w;
    sc.punteggio = sc.compra - sc.vende;
    if (!sc.agenti.includes(s.agente)) sc.agenti.push(s.agente);
    sc.perche.push(`${s.agente}: ${s.perche}`);
    by.set(s.simbolo, sc);
  }
  return [...by.values()].sort((a, b) => b.punteggio - a.punteggio);
}

// Dai punteggi agli ordini proposti. La gabbia (applyCage) resta a valle: qui si decide solo quanto si vorrebbe.
export function allocate(view: AgentView, reports: Record<string, AgentReport>, weights: Record<string, number>): Allocation {
  const signals = Object.values(reports).flatMap((r) => r.segnali);
  const rischio = Object.values(reports).reduce((a, r) => a * (r.rischio ?? 1), 1);
  const punteggi = scoreSignals(signals, weights);
  const proposte: ProposedOrder[] = [];
  const held = new Map(view.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const equity = view.account.equity;
  const conf = (x: number) => (x >= 1 ? "alta" : x >= 0.7 ? "media" : "bassa");

  for (const sc of punteggi) {
    const p = held.get(sc.simbolo);
    if (sc.punteggio <= AGENTS.sellScore && p) {
      proposte.push({ symbol: sc.simbolo, side: "sell", qty: p.qty, why: sc.perche.join(" · "), confidence: conf(-sc.punteggio), expect: `uscita: punteggio ${sc.punteggio.toFixed(2)}` });
    }
  }
  let slots = LIMITS.maxPositions - held.size;
  for (const sc of punteggi) {
    if (sc.punteggio < AGENTS.buyScore) break;
    const price = view.prices[sc.simbolo];
    if (!price || price <= 0) continue;
    const p = held.get(sc.simbolo);
    if (!p && slots <= 0) continue;
    const w = maxWeightFor(view.closes[sc.simbolo]).max * rischio * Math.min(1, sc.punteggio);
    const target = w * equity;
    const have = p ? p.qty * price : 0;
    const delta = target - have;
    if (delta / equity < AGENTS.minAddPct) continue;
    const qty = Math.floor(delta / price);
    if (qty < 1) continue;
    if (!p) slots--;
    proposte.push({ symbol: sc.simbolo, side: "buy", qty, why: sc.perche.join(" · "), confidence: conf(sc.punteggio), expect: `tenere circa ${AGENTS.horizonSessions} sedute; peso obiettivo ${(w * 100).toFixed(1)}% del conto` });
  }
  return { proposte, punteggi, rischio, pesi: weights };
}
