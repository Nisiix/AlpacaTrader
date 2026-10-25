import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { BrainError, type Brain, type Decision } from "./brain/types.ts";
import type { Account, Broker, MarketClock, Order, Position } from "./broker/types.ts";
import { applyCage, lossPct } from "./cage.ts";
import { CLOCK_SKEW_ALARM_MIN, MAX_LATENESS_MIN, UNIVERSE } from "./config.ts";
import { sendOne, clientOrderId, type ExecOutcome } from "./execute.ts";
import { acquireLock, findOrphanClaims, flattenLock, inspectLock, releaseLock, updateLock, type LockData } from "./lock.ts";
import { Logger, type Redactor } from "./log.ts";
import { reconcile } from "./reconcile.ts";
import { alarmText, endOfRunText } from "./report.ts";
import { describeRunId, findSlot, latenessMinutes, latestSlotToday, missedSlots, nextSlotAfter, romeTime, runIdFor } from "./slots.ts";
import type { Notifier } from "./telegram.ts";
import { latestFromHistory, readWitness, removeLeftoverTemps, writeWitness, type Witness, type WitnessOrder } from "./witness.ts";

export interface WakeDeps {
  broker: Broker;
  brain: Brain;
  notifier: Notifier;
  stateDir: string;
  logsDir: string;
  redactor: Redactor;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  echo?: boolean;
}

export interface WakeOptions {
  slot?: string; // HH:MM
  force?: boolean;
}

export type WakeStatus = "done" | "no-slot" | "too-early" | "busy" | "already-done";

export interface WakeResult {
  status: WakeStatus;
  runId?: string;
  witness?: Witness;
  message: string;
}

interface Snapshot {
  account: Account;
  positions: Position[];
  recentOrders: Order[];
  clock: MarketClock;
  prices: Record<string, number>;
}

async function retry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, delays = [2_000, 5_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delays.length) throw e;
      await sleep(delays[i]!);
    }
  }
}

async function snapshot(broker: Broker, sleep: (ms: number) => Promise<void>): Promise<Snapshot> {
  return retry(async () => {
    const [account, positions, recentOrders, clock] = await Promise.all([broker.getAccount(), broker.getPositions(), broker.getRecentOrders(48), broker.getClock()]);
    const symbols = [...new Set([...UNIVERSE, ...positions.map((p) => p.symbol)])];
    const prices = await broker.getLatestPrices(symbols);
    // Per le posizioni il prezzo corrente di Alpaca vale come fallback.
    for (const p of positions) if (!prices[p.symbol] && p.currentPrice > 0) prices[p.symbol] = p.currentPrice;
    return { account, positions, recentOrders, clock, prices };
  }, sleep);
}

function resolveRun(now: Date, opts: WakeOptions): { runId: string; label: string; kind: ReturnType<typeof findSlot> } | { error: WakeStatus; message: string } {
  if (opts.slot) {
    const slot = findSlot(opts.slot);
    if (!slot) throw new Error(`--slot ${opts.slot} non esiste. Sveglie valide: 09:00 15:30 18:30 21:40`);
    return { runId: runIdFor(romeTime(now).date, slot), label: slot.label, kind: slot };
  }
  const latest = latestSlotToday(now);
  if (!latest) return { error: "no-slot", message: "Oggi non c'è ancora nessuna sveglia (o è weekend)." };
  return { runId: latest.runId, label: latest.slot.label, kind: latest.slot };
}

export async function runWake(deps: WakeDeps, opts: WakeOptions = {}): Promise<WakeResult> {
  const startedAt = deps.now();
  const r = resolveRun(startedAt, opts);
  if ("error" in r) return { status: r.error, message: r.message };
  const { runId } = r;
  const slot = r.kind!;
  const localLateness = latenessMinutes(runId, startedAt);
  if (localLateness < 0) return { status: "too-early", runId, message: `La sveglia ${describeRunId(runId)} non è ancora arrivata.` };

  const log = new Logger(join(deps.logsDir, `${runId}.log`), deps.redactor, deps.echo ?? true);
  const alarms: string[] = [];
  const alarm = async (title: string, detail: string) => {
    alarms.push(`${title}: ${detail}`);
    log.warn(`ALLARME ${title}: ${detail}`);
    const res = await deps.notifier.send(deps.redactor.apply(alarmText(runId, title, detail)));
    if (!res.ok) log.error(`Telegram non ha ricevuto l'allarme: ${res.error}`);
  };
  log.info(`=== sveglia ${runId} (${slot.label}) pid ${process.pid}, broker ${deps.broker.name}, cervello ${deps.brain.name}${opts.force ? ", --force" : ""}`);

  // 1. Lock della sveglia prima: se c'è, è morta a metà (o è ancora viva).
  const existing = inspectLock(deps.stateDir, startedAt);
  if (existing.kind === "alive") {
    const msg = `Un'altra sveglia (${existing.data.runId}, pid ${existing.data.pid}) è in corso: questa si ferma senza fare niente.`;
    await alarm("Sveglia doppia", msg);
    return { status: "busy", runId, message: msg };
  }

  // 2. Il mio lock, subito: dentro ci metto i lock morti da riconciliare, così se muoio anch'io non si perdono.
  const lock: LockData = { runId, pid: process.pid, startedAt: startedAt.toISOString(), intended: [] };
  if (!acquireLock(deps.stateDir, lock)) {
    const msg = "Un'altra sveglia ha preso il lock nello stesso istante: questa si ferma senza fare niente.";
    await alarm("Sveglia doppia", msg);
    return { status: "busy", runId, message: msg };
  }
  const claims = [...(existing.kind === "stale" ? [{ path: existing.claimedPath, data: existing.data }] : []), ...findOrphanClaims(deps.stateDir)];
  if (claims.length) {
    const dead = claims.flatMap((c) => (c.data ? flattenLock(c.data) : [null]));
    lock.inherited = dead.filter((d): d is LockData => d !== null);
    updateLock(deps.stateDir, lock);
    mkdirSync(join(deps.stateDir, "history"), { recursive: true });
    for (const c of claims) {
      try {
        renameSync(c.path, join(deps.stateDir, "history", `lock-interrotto-${c.data?.runId ?? "illeggibile"}-${startedAt.getTime()}-${Math.random().toString(36).slice(2, 6)}.json`));
      } catch {}
    }
    let recent: Order[] = [];
    try {
      recent = await retry(() => deps.broker.getRecentOrders(48), deps.sleep);
    } catch (e) {
      log.error(`riconciliazione: ordini recenti non leggibili: ${(e as Error).message}`);
    }
    for (const d of dead) {
      const rec = await reconcile(deps.broker, d, recent);
      log.info(`riconciliazione con Alpaca:\n${rec.summary}`);
      await alarm(`Sveglia precedente interrotta (${rec.previousRunId})`, rec.summary);
    }
    lock.inherited = [];
    updateLock(deps.stateDir, lock);
  }
  const removed = removeLeftoverTemps(deps.stateDir);
  if (removed.length) log.warn(`tolti file temporanei di scritture interrotte: ${removed.join(", ")}`);

  // 3. Testimone. Se è rotto non lo uso come contesto, ma l'ultima copia in history/ dice quale sveglia è stata fatta.
  const wr = readWitness(deps.stateDir);
  let prev: Witness | null = null;
  let lastDone: Witness | null = null;
  if (wr.kind === "corrupt") {
    lastDone = latestFromHistory(deps.stateDir);
    await alarm(
      "Testimone illeggibile",
      `state/witness.json non è valido (${wr.error}). Vale come nessun testimone: vado avanti con i dati di Alpaca.` + (lastDone ? ` Dalla copia in history/ l'ultima sveglia fatta è ${lastDone.sveglia}.` : ""),
    );
  }
  if (wr.kind === "ok") prev = lastDone = wr.value;
  if (lastDone && lastDone.sveglia >= runId && !opts.force) {
    releaseLock(deps.stateDir);
    const msg = lastDone.sveglia === runId ? `La sveglia ${runId} è già stata fatta. Usa --force per rifarla.` : `L'ultima sveglia fatta (${lastDone.sveglia}) è più nuova di ${runId}. Usa --force per rifarla.`;
    log.info(msg);
    return { status: "already-done", runId, message: msg };
  }
  const missed = lastDone ? missedSlots(lastDone.sveglia, runId) : [];
  if (missed.length) {
    await alarm("Sveglie saltate", `${missed.map(describeRunId).join("\n")}\nMacchina spenta o offline? Non le recupero: un ordine di ore fa non ha più senso.`);
  }

  // 4. Alpaca.
  let snap: Snapshot | null = null;
  try {
    snap = await snapshot(deps.broker, deps.sleep);
    log.info(`conto: patrimonio ${snap.account.equity}, contanti ${snap.account.cash}, posizioni ${snap.positions.length}, ordini 48h ${snap.recentOrders.length}, mercato ${snap.clock.isOpen ? "aperto" : "chiuso"}`);
  } catch (e) {
    await alarm("Errore del broker", `Alpaca non risponde: ${(e as Error).message}. Nessun ordine in questa sveglia.`);
  }

  // L'ora vera è quella di Alpaca: se la macchina sbaglia, il ritardo si misura con l'orologio del broker.
  let lateness = localLateness;
  if (snap) {
    const brokerNow = new Date(snap.clock.timestamp);
    const skewMin = Math.round((brokerNow.getTime() - deps.now().getTime()) / 60_000);
    if (Number.isFinite(skewMin) && Math.abs(skewMin) >= CLOCK_SKEW_ALARM_MIN) {
      lateness = latenessMinutes(runId, brokerNow);
      await alarm("Orologio sbagliato", `L'orologio della macchina differisce da quello di Alpaca di ${skewMin} minuti. Uso l'ora di Alpaca.`);
    }
  }
  if (lateness > MAX_LATENESS_MIN) {
    await alarm("Sveglia in ritardo", `Parte con ${lateness} minuti di ritardo sull'orario ${slot.time}: nessun ordine, solo lettura del conto.`);
  }

  // Ordini rimasti incerti nella sveglia prima: chiedo ad Alpaca com'è finita e lo dico.
  const stillUncertain: WitnessOrder[] = [];
  if (prev?.ordiniIncerti?.length) {
    const lines: string[] = [];
    for (const o of prev.ordiniIncerti) {
      try {
        const found = await deps.broker.getOrderByClientId(o.id);
        lines.push(found ? `${o.id} risulta partito (stato ${found.status})` : `${o.id} risulta NON partito`);
      } catch (e) {
        stillUncertain.push(o);
        lines.push(`${o.id} ancora incerto: ${(e as Error).message}`);
      }
    }
    await alarm("Verifica ordini incerti", lines.join("\n"));
  }

  // 5. Cervello.
  let decision: Decision = { orders: [], reasoning: "", plan_next: prev?.pianoProssima ?? "" };
  if (snap) {
    try {
      decision = await deps.brain.decide({ runId, slotKind: slot.kind, slotLabel: slot.label, previousWitness: prev, ...snap });
      log.info(`decisione del cervello: ${JSON.stringify(decision)}`);
    } catch (e) {
      const why = e instanceof BrainError ? e.message : `errore imprevisto: ${(e as Error).message}`;
      decision = { orders: [], reasoning: "Il cervello non ha dato una risposta valida: nessun ordine del modello. Lo stop loss resta attivo.", plan_next: prev?.pianoProssima ?? "" };
      await alarm("Errore del cervello", `${why}. Vado avanti senza ordini del modello; lo stop loss resta attivo.`);
    }
  } else {
    decision.reasoning = "Alpaca non ha risposto: niente decisione, niente ordini.";
  }

  // 6. Gabbia.
  const cage = snap
    ? applyCage({ slotKind: slot.kind, marketOpen: snap.clock.isOpen, latenessMin: lateness, account: snap.account, positions: snap.positions, prices: snap.prices, recentOrders: snap.recentOrders, proposals: decision.orders })
    : { orders: [], rejected: decision.orders.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello" as const, reason: "broker non raggiungibile" })) };
  for (const x of cage.rejected) log.warn(`rifiutato ${x.side} ${x.qty} ${x.symbol} [${x.source}]: ${x.reason}`);

  // 7. Intenzioni nel lock, poi invio.
  lock.intended = cage.orders.map((o) => ({ clientOrderId: clientOrderId(runId, o.symbol, o.side), symbol: o.symbol, side: o.side, qty: o.qty }));
  updateLock(deps.stateDir, lock);
  const outcomes: ExecOutcome[] = [];
  for (const plan of cage.orders) outcomes.push(await sendOne(deps.broker, runId, plan, log, deps.sleep));
  const uncertain = outcomes.filter((o) => o.kind === "incerto");
  if (uncertain.length) await alarm("Errore del broker", `Esito incerto per: ${uncertain.map((o) => o.id).join(", ")}. Alpaca non risponde; la prossima sveglia verifica, l'ID impedisce i doppioni.`);
  const failed = outcomes.filter((o) => o.kind === "fallito");
  if (failed.length) await alarm("Ordini rifiutati da Alpaca", failed.map((o) => `${o.id}: ${o.kind === "fallito" ? o.error : ""}`).join("\n"));

  // 8. Conto aggiornato per il resoconto (se Alpaca risponde).
  let account = snap?.account ?? null;
  let positions = snap?.positions ?? [];
  let accountFresh = true;
  if (snap && outcomes.length) {
    try {
      [account, positions] = await Promise.all([deps.broker.getAccount(), deps.broker.getPositions()]);
    } catch (e) {
      accountFresh = false;
      log.warn(`conto finale non leggibile, uso quello iniziale: ${(e as Error).message}`);
    }
  }

  // 9. Testimone nuovo.
  const wo = (o: ExecOutcome): WitnessOrder => ({ id: o.id, simbolo: o.plan.symbol, lato: o.plan.side, quantita: o.plan.qty, origine: o.plan.source, perche: o.plan.why, stato: "order" in o ? o.order.status + (o.kind === "inviato" && o.note ? ` (${o.note})` : "") : o.kind });
  const sent = outcomes.filter((o) => o.kind === "inviato");
  const problems = alarms.length > 0 || !snap;
  const next = nextSlotAfter(runId);
  const witness: Witness = {
    versione: 1,
    sveglia: runId,
    tipo: slot.label,
    iniziataAlle: startedAt.toISOString(),
    finitaAlle: deps.now().toISOString(),
    esito: problems ? "completata con problemi" : "completata",
    appunto: `${slot.label}: ${sent.length} ordini inviati, ${cage.rejected.length} rifiutati${uncertain.length ? `, ${uncertain.length} con esito incerto da verificare` : ""}. Prossima sveglia ${describeRunId(next)}: ${decision.plan_next || "nessun piano"}`,
    conto: account ? { patrimonio: account.equity, contanti: account.cash, pnlGiorno: account.equity - account.lastEquity, aggiornato: accountFresh } : null,
    posizioni: positions.map((p) => ({ simbolo: p.symbol, quantita: p.qty, prezzoCarico: p.avgEntryPrice, prezzoAttuale: p.currentPrice, variazione: `${(lossPct(p) * 100).toFixed(2)}%` })),
    ordiniInviati: sent.map(wo),
    ordiniGiaPresenti: outcomes.filter((o) => o.kind === "gia-presente").map(wo),
    ordiniIncerti: [...uncertain.map(wo), ...stillUncertain],
    ordiniFalliti: failed.map((o) => ({ ...wo(o), errore: o.kind === "fallito" ? o.error : "" })),
    ordiniRifiutati: cage.rejected.map((x) => ({ simbolo: x.symbol, lato: x.side, quantita: x.qty, origine: x.source, motivo: x.reason })),
    ragionamento: decision.reasoning,
    pianoProssima: decision.plan_next,
    prossimaSveglia: next,
    allarmi: alarms,
  };
  writeWitness(deps.stateDir, witness);
  log.info(`testimone scritto: ${witness.appunto}`);

  // 10. Resoconto e via il lock.
  const res = await deps.notifier.send(deps.redactor.apply(endOfRunText(witness)));
  if (!res.ok) log.error(`Telegram non ha ricevuto il resoconto: ${res.error}`);
  releaseLock(deps.stateDir);
  log.info(`=== fine sveglia ${runId}`);
  return { status: "done", runId, witness, message: witness.appunto };
}
