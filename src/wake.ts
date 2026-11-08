import { mkdirSync, renameSync } from "node:fs";
import { applyAgentSettings } from "./agent-settings.ts";
import { hostname } from "node:os";
import { join } from "node:path";
import { BrainError, type Brain, type Decision } from "./brain/types.ts";
import { isProtectiveStop, type Account, type Broker, type MarketClock, type Order, type Position } from "./broker/types.ts";
import { compareWithBenchmarks, type Comparison } from "./benchmark.ts";
import { evaluateBreaker, readBreaker, writeBreaker } from "./breaker.ts";
import { applyCage, lossPct, tradingBlockReason } from "./cage.ts";
import { staleCalendar, upcomingEvents } from "./events.ts";
import { CLOCK_SKEW_ALARM_MIN, DAILY_BARS_DAYS, LIMITS, MAX_LATENESS_MIN, UNIVERSE } from "./config.ts";
import { sendOne, clientOrderId, waitForFills, type ExecOutcome } from "./execute.ts";
import { indicatorsFor } from "./indicators.ts";
import { applyFills, contextFor, journalForBrain, learnFromJournal, learningStatus, pruneJournal, readJournal, recordIntent, statsOf, writeJournal, type Trade } from "./journal.ts";
import { activeLessons, learnFromBrokerReject, learnFromStopLoss, pruneLessons, readLessons, writeLessons, type Lesson } from "./lessons.ts";
import { manageStops, type StopsReport } from "./stops.ts";
import { acquireLock, findOrphanClaims, flattenLock, inspectLock, releaseLock, updateLock, type LockData } from "./lock.ts";
import { Logger, type Redactor } from "./log.ts";
import { reconcile } from "./reconcile.ts";
import { alarmText, endOfRunText, weeklyText } from "./report.ts";
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
  recentOrders: Order[]; // ultime 48 ore più tutti gli ordini ancora aperti
  clock: MarketClock;
  prices: Record<string, number>;
  closes: Record<string, number[]>;
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

async function snapshot(broker: Broker, sleep: (ms: number) => Promise<void>, log: Logger): Promise<Snapshot> {
  const snap = await retry(async () => {
    const [account, positions, recent, open, clock] = await Promise.all([broker.getAccount(), broker.getPositions(), broker.getRecentOrders(48), broker.getOpenOrders(), broker.getClock()]);
    const recentOrders = [...recent, ...open.filter((o) => !recent.some((r) => r.id === o.id))];
    const symbols = [...new Set([...UNIVERSE, ...positions.map((p) => p.symbol)])];
    const prices = await broker.getLatestPrices(symbols);
    // Per le posizioni il prezzo corrente di Alpaca vale come fallback.
    for (const p of positions) if (!prices[p.symbol] && p.currentPrice > 0) prices[p.symbol] = p.currentPrice;
    return { account, positions, recentOrders, clock, prices, closes: {} as Record<string, number[]> };
  }, sleep);
  // Senza storico la gabbia non compra (metodo non verificabile), ma vendite e stop vanno avanti.
  try {
    snap.closes = await retry(() => broker.getDailyCloses([...UNIVERSE], DAILY_BARS_DAYS), sleep);
  } catch (e) {
    log.warn(`storico prezzi non disponibile: ${(e as Error).message}. Niente acquisti in questa sveglia.`);
  }
  return snap;
}

function resolveRun(now: Date, opts: WakeOptions): { runId: string; label: string; kind: ReturnType<typeof findSlot> } | { error: WakeStatus; message: string } {
  if (opts.slot) {
    const slot = findSlot(opts.slot);
    if (!slot) throw new Error(`--slot ${opts.slot} non esiste. Sveglie valide: 09:00 15:40 18:30 21:40`);
    return { runId: runIdFor(romeTime(now).date, slot), label: slot.label, kind: slot };
  }
  const latest = latestSlotToday(now);
  if (!latest) return { error: "no-slot", message: "Oggi non c'è ancora nessuna sveglia (o è weekend)." };
  return { runId: latest.runId, label: latest.slot.label, kind: latest.slot };
}

export async function runWake(deps: WakeDeps, opts: WakeOptions = {}): Promise<WakeResult> {
  // Le impostazioni cambiate dalla dashboard valgono anche per le sveglie classiche.
  applyAgentSettings(deps.stateDir);
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
  const lock: LockData = { runId, pid: process.pid, host: hostname(), startedAt: startedAt.toISOString(), intended: [] };
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

  // 4. Alpaca.
  let snap: Snapshot | null = null;
  try {
    snap = await snapshot(deps.broker, deps.sleep, log);
    log.info(`conto: patrimonio ${snap.account.equity}, contanti ${snap.account.cash}, posizioni ${snap.positions.length}, ordini 48h ${snap.recentOrders.length}, mercato ${snap.clock.isOpen ? "aperto" : "chiuso"}`);
  } catch (e) {
    await alarm("Errore del broker", `Alpaca non risponde: ${(e as Error).message}. Nessun ordine in questa sveglia.`);
  }

  // Sveglie saltate. Se su Alpaca ci sono ordini con il loro ID, non erano saltate: sono morte senza lasciare traccia qui.
  if (missed.length) {
    const lines = missed.map((id) => {
      const theirs = snap?.recentOrders.filter((o) => o.clientOrderId.startsWith(`${id}-`)) ?? [];
      return theirs.length ? `${describeRunId(id)}: NON lasciò il testimone, ma su Alpaca ha questi ordini: ${theirs.map((o) => `${o.side.toUpperCase()} ${o.qty} ${o.symbol} (${o.status})`).join(", ")}` : describeRunId(id);
    });
    await alarm("Sveglie saltate", `${lines.join("\n")}\nMacchina spenta o offline? Non le recupero: un ordine di ore fa non ha più senso.`);
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

  // Memoria del rischio: registro degli errori e interruttore. Li scrive il codice, li applica la gabbia.
  const today = romeTime(deps.now()).date;
  const lr = readLessons(deps.stateDir, deps.now());
  const lessonsFile = lr.file;
  if (lr.problem) await alarm("Registro degli errori illeggibile", lr.problem);
  const learned: Lesson[] = [];
  if (snap) {
    for (const o of snap.recentOrders) {
      if (!isProtectiveStop(o) || o.status !== "filled") continue;
      const l = learnFromStopLoss(lessonsFile, `stop-${o.clientOrderId}`, o.symbol, today, `stop su Alpaca eseguito, ${o.filledQty} azioni`);
      if (l) learned.push(l);
    }
  }
  let buyBlock: string | null = null;
  if (snap) {
    const br = readBreaker(deps.stateDir);
    if (br.kind === "corrupt") {
      buyBlock = `file dell'interruttore illeggibile (${br.error}): acquisti bloccati finché non lanci bun run breaker-reset`;
      await alarm("Interruttore illeggibile", buyBlock);
    } else {
      const ev = evaluateBreaker(br.file, snap.account.equity, snap.account.lastEquity, deps.now().toISOString());
      writeBreaker(deps.stateDir, ev.file);
      buyBlock = ev.buyBlock;
      if (ev.newlyTripped) await alarm("Interruttore scattato", `${ev.newlyTripped}. Acquisti bloccati finché non lanci bun run breaker-reset; vendite e stop restano attivi.`);
    }
    if (buyBlock) log.warn(`acquisti bloccati: ${buyBlock}`);
  }
  const lessonsNow = activeLessons(lessonsFile, today);
  const indicators = snap ? indicatorsFor(snap.closes, snap.prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays) : {};
  const events = upcomingEvents(today);
  // Il calendario degli eventi si aggiorna a mano: il lunedì mattina ricordo cosa manca.
  const stale = staleCalendar(today);
  if (stale.length && slot.kind === "briefing" && new Date(`${today}T12:00:00Z`).getUTCDay() === 1) {
    await alarm("Calendario eventi da aggiornare", `In src/events.ts: ${stale.join(", ")}. Senza la data il blocco degli acquisti prima di Fed e trimestrali non può scattare.`);
  }

  // Diario dei trade: raccoglie sempre, ma arriva al modello solo a raccolta finita.
  const jr = readJournal(deps.stateDir, deps.now());
  const journal = jr.file;
  if (jr.problem) await alarm("Diario dei trade illeggibile", jr.problem);
  const learning = learningStatus(journal, today);
  log.info(`diario: ${learning.motivo}`);

  // 5. Cervello.
  let decision: Decision = { orders: [], reasoning: "", plan_next: prev?.pianoProssima ?? "" };
  if (snap) {
    try {
      decision = await deps.brain.decide({ runId, slotKind: slot.kind, slotLabel: slot.label, previousWitness: prev, ...snap, indicators, events, lessons: lessonsNow, buyBlock, journal: learning.attivo ? journalForBrain(journal) : null });
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
    ? applyCage({ today, slotKind: slot.kind, marketOpen: snap.clock.isOpen, latenessMin: lateness, account: snap.account, positions: snap.positions, prices: snap.prices, closes: snap.closes, recentOrders: snap.recentOrders, lessons: lessonsNow, buyBlock, proposals: decision.orders })
    : { orders: [], rejected: decision.orders.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello" as const, reason: "broker non raggiungibile" })) };
  for (const x of cage.rejected) log.warn(`rifiutato ${x.side} ${x.qty} ${x.symbol} [${x.source}]: ${x.reason}`);

  // Il contesto di ogni ordine va nel diario prima dell'invio: se la sveglia muore dopo, non si perde.
  for (const o of cage.orders) {
    const proposed = decision.orders.find((p) => p.symbol === o.symbol && p.side === o.side);
    const context = contextFor(indicators[o.symbol], snap?.prices[o.symbol], o.source === "modello" ? (proposed?.confidence ?? null) : null, o.source === "modello" ? (proposed?.expect ?? "") : "", o.why);
    recordIntent(journal, { id: clientOrderId(runId, o.symbol, o.side), simbolo: o.symbol, lato: o.side, origine: o.source, data: today, contesto: context });
  }
  if (cage.orders.length) writeJournal(deps.stateDir, journal);

  // 7. Intenzioni nel lock, poi invio.
  lock.intended = cage.orders.map((o) => ({ clientOrderId: clientOrderId(runId, o.symbol, o.side), symbol: o.symbol, side: o.side, qty: o.qty }));
  updateLock(deps.stateDir, lock);
  const outcomes: ExecOutcome[] = [];
  for (const plan of cage.orders) outcomes.push(await sendOne(deps.broker, runId, plan, log, deps.sleep));
  const uncertain = outcomes.filter((o) => o.kind === "incerto");
  if (uncertain.length) await alarm("Errore del broker", `Esito incerto per: ${uncertain.map((o) => o.id).join(", ")}. Alpaca non risponde; la prossima sveglia verifica, l'ID impedisce i doppioni.`);
  const failed = outcomes.filter((o) => o.kind === "fallito");
  if (failed.length) await alarm("Ordini rifiutati da Alpaca", failed.map((o) => `${o.id}: ${o.kind === "fallito" ? o.error : ""}`).join("\n"));

  // Il registro impara da questa sveglia: stop loss eseguiti e rifiuti ripetuti di Alpaca.
  for (const o of outcomes) {
    const l =
      o.kind === "inviato" && o.plan.source === "stop-loss" ? learnFromStopLoss(lessonsFile, `stop-${o.id}`, o.plan.symbol, today, o.plan.why)
      : o.kind === "fallito" ? learnFromBrokerReject(lessonsFile, o.plan.symbol, o.plan.side, today, o.error)
      : null;
    if (l) learned.push(l);
  }
  pruneLessons(lessonsFile, today);
  writeLessons(deps.stateDir, lessonsFile);
  for (const l of learned) log.info(`lezione nuova: ${l.motivo} (fino al ${l.finoAl})`);

  // Stop su Alpaca: uno per posizione, solo quando si possono fare ordini.
  let stops: StopsReport | null = null;
  if (snap && !tradingBlockReason({ slotKind: slot.kind, marketOpen: snap.clock.isOpen, latenessMin: lateness, account: snap.account })) {
    await waitForFills(deps.broker, outcomes.filter((o) => o.kind === "inviato").map((o) => o.id), deps.sleep, log);
    try {
      const [pos, open] = await Promise.all([deps.broker.getPositions(), deps.broker.getOpenOrders()]);
      stops = await manageStops(deps.broker, runId, pos, open, log, snap.closes);
    } catch (e) {
      stops = { ok: [], placed: [], cancelled: [], errors: [`Alpaca non risponde: ${(e as Error).message}`] };
    }
    if (stops.errors.length) await alarm("Stop su Alpaca non a posto", `${stops.errors.join("\n")}\nLo stop loss del codice resta attivo alle sveglie.`);
  }

  // Il diario legge gli ordini eseguiti di una settimana: copre il weekend e le sveglie saltate.
  let closedNow: Trade[] = [];
  if (snap) {
    let filled = snap.recentOrders;
    try {
      filled = await retry(() => deps.broker.getRecentOrders(24 * 7), deps.sleep);
    } catch (e) {
      log.warn(`diario: ordini della settimana non leggibili, uso quelli delle 48 ore: ${(e as Error).message}`);
    }
    const fills = applyFills(journal, filled);
    closedNow = fills.closed;
    for (const t of fills.opened) log.info(`diario: aperto trade ${t.simbolo} (${t.comprate} a ${(t.costo / t.comprate).toFixed(2)})`);
    for (const t of closedNow) log.info(`diario: chiuso trade ${t.simbolo}: ${((t.risultato ?? 0) * 100).toFixed(2)}% in ${t.giorni} giorni (${t.motivoUscita})`);
    const statLessons = learnFromJournal(lessonsFile, journal, today);
    for (const l of statLessons) log.info(`lezione nuova dal diario: ${l.motivo} (fino al ${l.finoAl})`);
    learned.push(...statLessons);
    if (statLessons.length) writeLessons(deps.stateDir, lessonsFile);
    pruneJournal(journal, today);
    writeJournal(deps.stateDir, journal);
  }

  // 8. Conto aggiornato per il resoconto (se Alpaca risponde).
  let account = snap?.account ?? null;
  let positions = snap?.positions ?? [];
  let accountFresh = true;
  if (snap && (outcomes.length || stops?.placed.length || stops?.cancelled.length)) {
    try {
      [account, positions] = await Promise.all([deps.broker.getAccount(), deps.broker.getPositions()]);
    } catch (e) {
      accountFresh = false;
      log.warn(`conto finale non leggibile, uso quello iniziale: ${(e as Error).message}`);
    }
  }

  let confronto: Comparison | null = null;
  if (account) {
    const bm = compareWithBenchmarks(deps.stateDir, today, account.equity, snap?.prices.SPY, snap?.prices.TLT);
    confronto = bm.cmp;
    if (bm.note) log.warn(bm.note);
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
    stopSuAlpaca: stops ? { attivi: [...stops.ok, ...stops.placed], piazzati: stops.placed, tolti: stops.cancelled, errori: stops.errors } : null,
    lezioniAttive: activeLessons(lessonsFile, today),
    lezioniNuove: learned,
    acquistiBloccati: buyBlock,
    confronto,
    tradeChiusi: closedNow.map((t) => ({ simbolo: t.simbolo, risultato: t.risultato ?? 0, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto" })),
    diario: { stato: learning.motivo, statistiche: statsOf(journal.trade) },
  };
  writeWitness(deps.stateDir, witness);
  log.info(`testimone scritto: ${witness.appunto}`);

  // 10. Resoconto e via il lock.
  const res = await deps.notifier.send(deps.redactor.apply(endOfRunText(witness)));
  if (!res.ok) log.error(`Telegram non ha ricevuto il resoconto: ${res.error}`);
  // Il venerdì sera, dopo la chiusura, il riepilogo della settimana.
  if (slot.kind === "close" && new Date(`${today}T12:00:00Z`).getUTCDay() === 5) {
    const wk = await deps.notifier.send(deps.redactor.apply(weeklyText(runId, journal, today, learning.motivo, confronto)));
    if (!wk.ok) log.error(`Telegram non ha ricevuto il riepilogo settimanale: ${wk.error}`);
  }
  releaseLock(deps.stateDir);
  log.info(`=== fine sveglia ${runId}`);
  return { status: "done", runId, witness, message: witness.appunto };
}
