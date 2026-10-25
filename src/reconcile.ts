import type { Broker, Order } from "./broker/types.ts";
import type { LockData } from "./lock.ts";

export interface ReconcileResult {
  previousRunId: string;
  sent: Order[];
  notSent: { clientOrderId: string; symbol: string; side: string; qty: number }[];
  unknown: { clientOrderId: string; error: string }[];
  summary: string;
}

// Chiede ad Alpaca quali ordini della sveglia morta sono partiti davvero. Non rimanda niente:
// un ordine di ore fa non ha più senso, decide la sveglia di adesso.
export async function reconcile(broker: Broker, lock: LockData | null, recentOrders: Order[]): Promise<ReconcileResult> {
  const sent: Order[] = [];
  const notSent: ReconcileResult["notSent"] = [];
  const unknown: ReconcileResult["unknown"] = [];
  const runId = lock?.runId ?? "?";

  if (lock) {
    for (const it of lock.intended) {
      try {
        const o = await broker.getOrderByClientId(it.clientOrderId);
        if (o) sent.push(o);
        else notSent.push(it);
      } catch (e) {
        unknown.push({ clientOrderId: it.clientOrderId, error: (e as Error).message });
      }
    }
    // Ordini col prefisso della sveglia morta che non erano nel lock (non dovrebbe succedere, ma la verità è Alpaca).
    for (const o of recentOrders) {
      if (o.clientOrderId.startsWith(`${runId}-`) && !sent.some((s) => s.clientOrderId === o.clientOrderId) && !lock.intended.some((i) => i.clientOrderId === o.clientOrderId)) sent.push(o);
    }
  }

  const lines: string[] = [];
  if (!lock) lines.push("Il lock era illeggibile: non so quale sveglia fosse né cosa volesse fare. Controlla gli ordini recenti qui sotto.");
  else if (lock.intended.length === 0 && sent.length === 0) lines.push(`La sveglia ${runId} è morta prima di decidere ordini: nessun ordine partito.`);
  for (const o of sent) lines.push(`partito: ${o.side.toUpperCase()} ${o.qty} ${o.symbol} (stato ${o.status}, id ${o.clientOrderId})`);
  for (const o of notSent) lines.push(`NON partito: ${o.side.toUpperCase()} ${o.qty} ${o.symbol} (id ${o.clientOrderId}), non lo rimando`);
  for (const o of unknown) lines.push(`esito sconosciuto: ${o.clientOrderId} (${o.error})`);
  if (!lock && recentOrders.length) for (const o of recentOrders.slice(0, 10)) lines.push(`recente: ${o.side.toUpperCase()} ${o.qty} ${o.symbol} (${o.status}, id ${o.clientOrderId})`);
  return { previousRunId: runId, sent, notSent, unknown, summary: lines.join("\n") };
}
