import type { ProposedOrder } from "../brain/types.ts";
import { maxWeightFor } from "../cage.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, LIMITS, isCrypto } from "../config.ts";
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
    proposte.push({ symbol: s.simbolo, side: "sell", qty: p.qty, why: `${s.agente}: ${s.perche}`, confidence: "alta", expect: "regola di rischio" });
  }
  for (const sc of punteggi) {
    const p = held.get(sc.simbolo);
    if (forced.has(sc.simbolo)) continue;
    if (sc.punteggio <= AGENTS.sellScore && p) {
      proposte.push({ symbol: sc.simbolo, side: "sell", qty: p.qty, why: sc.perche.join(" · "), confidence: conf(-sc.punteggio), expect: `uscita: punteggio ${sc.punteggio.toFixed(2)}` });
    }
  }
  let slots = LIMITS.maxPositions - held.size;
  for (const sc of punteggi) {
    if (sc.punteggio < AGENTS.buyScore) break;
    if (forced.has(sc.simbolo)) continue;
    const wait = view.contesto?.attendi[sc.simbolo];
    if (wait && !held.has(sc.simbolo)) {
      inAttesa.push({ simbolo: sc.simbolo, motivo: wait });
      continue;
    }
    const price = view.prices[sc.simbolo];
    if (!price || price <= 0) continue;
    const p = held.get(sc.simbolo);
    if (!p && slots <= 0) continue;
    const w = maxWeightFor(view.closes[sc.simbolo]).max * rischio * (AGENTS.scaleByScore ? Math.min(1, sc.punteggio) : 1);
    const target = w * equity;
    const have = p ? p.qty * price : 0;
    const delta = target - have;
    if (delta / equity < AGENTS.minAddPct) continue;
    const qty = roundQty(sc.simbolo, delta / price);
    if (qty <= 0 || (isCrypto(sc.simbolo) && qty * price < CRYPTO_MIN_NOTIONAL)) continue;
    if (!p) slots--;
    proposte.push({ symbol: sc.simbolo, side: "buy", qty, why: sc.perche.join(" · "), confidence: conf(sc.punteggio), expect: `tenere circa ${AGENTS.horizonSessions} sedute; peso obiettivo ${(w * 100).toFixed(1)}% del conto` });
  }
  return { proposte, punteggi, rischio, pesi: weights, inAttesa };
}
