import { BRAIN_VOTES } from "../config.ts";
import { BrainError, type Brain, type BrainInput, type Decision, type ProposedOrder } from "./types.ts";

// Il modello, a parità di dati, non risponde sempre uguale. Lo interroghiamo più volte in parallelo
// e passa alla gabbia solo l'ordine (titolo + lato) proposto da almeno `quorum` risposte valide.
export class VotingBrain implements Brain {
  readonly name: string;
  constructor(private inner: Brain, private calls = BRAIN_VOTES.calls, private quorum = BRAIN_VOTES.quorum) {
    this.name = `${inner.name} × ${calls} (maggioranza ${quorum})`;
  }

  async decide(input: BrainInput): Promise<Decision> {
    const results = await Promise.allSettled(Array.from({ length: this.calls }, () => this.inner.decide(input)));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const errors = results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error)?.message ?? r.reason)] : []));
    // Con meno risposte del quorum nessun ordine può avere la maggioranza: lo trattiamo come un cervello che non ha risposto.
    if (ok.length < this.quorum) throw new BrainError(`solo ${ok.length} risposte valide su ${this.calls} (servono ${this.quorum}): ${errors.join(" | ").slice(0, 300)}`);
    return majority(ok, this.quorum, this.calls);
  }
}

export function majority(decisions: Decision[], quorum: number, calls = decisions.length): Decision {
  const groups = new Map<string, ProposedOrder[]>();
  for (const d of decisions) {
    // Ogni risposta vota una volta per titolo e lato, anche se ripete l'ordine.
    const once = new Map<string, ProposedOrder>();
    for (const o of d.orders) once.set(`${o.symbol}-${o.side}`, o);
    for (const [k, o] of once) groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const orders: ProposedOrder[] = [];
  const dropped: string[] = [];
  for (const [k, list] of groups) {
    if (list.length < quorum) { dropped.push(`${k} (${list.length}/${calls})`); continue; }
    // Quantità: la mediana bassa, cioè la più prudente tra quelle centrali.
    const qty = [...list.map((o) => o.qty)].sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)]!;
    orders.push({ ...list[0]!, qty });
  }
  const first = decisions[0]!;
  const note = `Voto: ${decisions.length}/${calls} risposte valide, ${orders.length} ordini con la maggioranza${dropped.length ? `, scartati per mancanza di accordo: ${dropped.join(", ")}` : ""}.`;
  return { orders, reasoning: `${first.reasoning} ${note}`.trim(), plan_next: first.plan_next };
}
