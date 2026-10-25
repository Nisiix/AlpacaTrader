import { BrokerError, DuplicateOrderError, isProtectiveStop, type Broker, type Order } from "./broker/types.ts";
import type { PlannedOrder } from "./cage.ts";
import { SUBMIT_VERIFY_DELAYS_MS } from "./config.ts";
import type { Logger } from "./log.ts";

export function clientOrderId(runId: string, symbol: string, side: string): string {
  return `${runId}-${symbol}-${side}`;
}

export type ExecOutcome =
  | { kind: "inviato"; plan: PlannedOrder; id: string; order: Order; note?: string }
  | { kind: "gia-presente"; plan: PlannedOrder; id: string; order: Order }
  | { kind: "fallito"; plan: PlannedOrder; id: string; error: string }
  | { kind: "incerto"; plan: PlannedOrder; id: string; error: string };

const isTransient = (e: unknown) => e instanceof BrokerError && e.transient && !(e instanceof DuplicateOrderError);

async function findExisting(broker: Broker, id: string, log: Logger): Promise<Order | null | "errore"> {
  try {
    return await broker.getOrderByClientId(id);
  } catch (e) {
    log.warn(`verifica di ${id} non riuscita: ${(e as Error).message}`);
    return "errore";
  }
}

// Invia un ordine senza mai duplicarlo. Il client_order_id deterministico fa sì che
// anche un nuovo tentativo dopo un timeout venga scartato da Alpaca se il primo era arrivato.
export async function sendOne(broker: Broker, runId: string, plan: PlannedOrder, log: Logger, sleep: (ms: number) => Promise<void>): Promise<ExecOutcome> {
  const id = clientOrderId(runId, plan.symbol, plan.side);
  const before = await findExisting(broker, id, log);
  if (before && before !== "errore") {
    log.info(`ordine ${id} già presente su Alpaca (stato ${before.status}): non lo rimando`);
    return { kind: "gia-presente", plan, id, order: before };
  }

  // Le azioni coperte da uno stop su Alpaca non si possono vendere: prima si toglie lo stop.
  if (plan.side === "sell") await releaseStops(broker, plan.symbol, log, sleep);

  let lastError = "";
  for (let attempt = 0; attempt <= SUBMIT_VERIFY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(SUBMIT_VERIFY_DELAYS_MS[attempt - 1]!);
      const found = await findExisting(broker, id, log);
      if (found === "errore") continue;
      if (found) {
        log.info(`ordine ${id} confermato da Alpaca dopo l'errore di rete (stato ${found.status})`);
        return { kind: "inviato", plan, id, order: found, note: "confermato dopo un timeout" };
      }
    }
    try {
      const order = await broker.submitOrder({ symbol: plan.symbol, side: plan.side, qty: plan.qty, clientOrderId: id });
      log.info(`inviato ${id}: ${plan.side} ${plan.qty} ${plan.symbol} (stato ${order.status})`);
      return { kind: "inviato", plan, id, order };
    } catch (e) {
      if (e instanceof DuplicateOrderError) {
        const found = await findExisting(broker, id, log);
        if (found && found !== "errore") {
          log.info(`Alpaca ha rifiutato il doppione ${id}: l'ordine c'era già`);
          return { kind: "gia-presente", plan, id, order: found };
        }
        return { kind: "incerto", plan, id, error: "Alpaca dice doppione ma non riesco a leggere l'ordine" };
      }
      lastError = (e as Error).message;
      if (!isTransient(e)) {
        log.error(`ordine ${id} rifiutato da Alpaca: ${lastError}`);
        return { kind: "fallito", plan, id, error: lastError };
      }
      log.warn(`invio di ${id}: errore temporaneo (${lastError}), verifico prima di riprovare`);
    }
  }
  log.error(`ordine ${id}: esito incerto dopo tutti i tentativi (${lastError})`);
  return { kind: "incerto", plan, id, error: lastError };
}

async function releaseStops(broker: Broker, symbol: string, log: Logger, sleep: (ms: number) => Promise<void>) {
  try {
    let stops = (await broker.getOpenOrders()).filter((o) => o.symbol === symbol && isProtectiveStop(o));
    if (stops.length === 0) return;
    for (const o of stops) {
      await broker.cancelOrder(o.id);
      log.info(`tolto lo stop su Alpaca ${o.clientOrderId} per poter vendere ${symbol}`);
    }
    // La cancellazione su Alpaca è asincrona: aspetto che risulti.
    for (let i = 0; i < 5; i++) {
      stops = (await broker.getOpenOrders()).filter((o) => o.symbol === symbol && isProtectiveStop(o));
      if (stops.length === 0) return;
      await sleep(1_000);
    }
    log.warn(`lo stop su ${symbol} risulta ancora aperto: la vendita potrebbe essere rifiutata`);
  } catch (e) {
    log.warn(`non riesco a togliere lo stop su ${symbol}: ${(e as Error).message}`);
  }
}

// Aspetta (poco) che gli ordini a mercato risultino eseguiti, così gli stop si piazzano sulle quantità giuste.
export async function waitForFills(broker: Broker, ids: string[], sleep: (ms: number) => Promise<void>, log: Logger) {
  let pending = [...ids];
  for (let i = 0; i < 5 && pending.length; i++) {
    const still: string[] = [];
    for (const id of pending) {
      try {
        const o = await broker.getOrderByClientId(id);
        if (o && !["filled", "canceled", "rejected", "expired"].includes(o.status)) still.push(id);
      } catch {
        still.push(id);
      }
    }
    pending = still;
    if (pending.length) await sleep(2_000);
  }
  if (pending.length) log.warn(`ordini non ancora eseguiti: ${pending.join(", ")}; gli stop su questi titoli si sistemano alla prossima sveglia`);
}
