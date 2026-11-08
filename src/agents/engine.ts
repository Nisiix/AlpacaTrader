import { join } from "node:path";
import { isProtectiveStop, type Account, type Broker, type MarketClock, type Order, type Position } from "../broker/types.ts";
import { compareWithBenchmarks, type Comparison } from "../benchmark.ts";
import { evaluateBreaker, readBreaker, writeBreaker } from "../breaker.ts";
import { applyCage, lossPct, tradingBlockReason, type Rejection } from "../cage.ts";
import { AGENTS, DAILY_BARS_DAYS, LIMITS, UNIVERSE } from "../config.ts";
import { clientOrderId, sendOne, waitForFills, type ExecOutcome } from "../execute.ts";
import { writeJsonAtomic } from "../fsutil.ts";
import { indicatorsFor } from "../indicators.ts";
import { applyFills, contextFor, learnFromJournal, learningStatus, pruneJournal, readJournal, recordIntent, statsOf, writeJournal, type Stats } from "../journal.ts";
import { activeLessons, learnFromBrokerReject, learnFromStopLoss, pruneLessons, readLessons, writeLessons, type Lesson } from "../lessons.ts";
import { acquireLock, inspectLock, releaseLock, type LockData } from "../lock.ts";
import { Logger, type Redactor } from "../log.ts";
import { romeTime } from "../slots.ts";
import { manageStops, type StopsReport } from "../stops.ts";
import type { Notifier } from "../telegram.ts";
import { agentWeights, allocate, type Score } from "./allocator.ts";
import type { EventBus } from "./bus.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

export interface EngineDeps {
  broker: Broker;
  notifier: Notifier;
  stateDir: string;
  logsDir: string;
  redactor: Redactor;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  agents: Agent[];
  bus: EventBus;
  echo?: boolean;
}

export interface AgentsStatus {
  versione: 1;
  aggiornato: string;
  giro: string;
  mercatoAperto: boolean;
  finestraIngressi: boolean;
  conto: { patrimonio: number; contanti: number; pnlGiorno: number } | null;
  posizioni: { simbolo: string; quantita: number; prezzoCarico: number; prezzoAttuale: number; variazione: number; valore: number }[];
  prezzi: Record<string, number>;
  rischio: number;
  pesi: Record<string, number>;
  agenti: Record<string, { segnali: number; note: string[]; errore?: string }>;
  segnali: Signal[];
  punteggi: Score[];
  ordini: { id: string; simbolo: string; lato: string; quantita: number; esito: string; perche: string }[];
  rifiuti: Rejection[];
  stopSuAlpaca: StopsReport | null;
  acquistiBloccati: string | null;
  lezioniAttive: Lesson[];
  allarmi: string[];
  diario: { stato: string; statistiche: Stats };
  confronto: Comparison | null;
  ultimoRiepilogo: string | null;
  tradeChiusiOggi: { simbolo: string; risultato: number; giorni: number; uscita: string }[];
}

export const statusPath = (stateDir: string) => join(stateDir, "agents-status.json");

interface Snapshot {
  account: Account;
  positions: Position[];
  recentOrders: Order[];
  clock: MarketClock;
  prices: Record<string, number>;
}

// Lo storico giornaliero cambia una volta al giorno: si scarica alla prima passata di ogni data.
export interface EngineCache {
  closesDate?: string;
  closes: Record<string, number[]>;
  ultimoRiepilogo: string | null;
}

export const emptyCache = (): EngineCache => ({ closes: {}, ultimoRiepilogo: null });

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

export function inEntryWindow(now: Date): boolean {
  const rt = romeTime(now);
  return rt.weekday >= 1 && rt.weekday <= 5 && rt.minutes >= minutesOf(AGENTS.entryWindow.from) && rt.minutes <= minutesOf(AGENTS.entryWindow.to);
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

export type TickStatus = "fatto" | "occupato" | "broker-giu";

export interface TickResult {
  status: TickStatus;
  status_file?: AgentsStatus;
  message: string;
}

// Un giro del motore: legge il conto, interroga gli agenti, alloca, passa dalla gabbia, invia, aggiorna stop,
// diario e registro, scrive lo stato per la dashboard. Ogni passo lascia un evento nel registro.
export async function runTick(deps: EngineDeps, cache: EngineCache = emptyCache()): Promise<TickResult> {
  const startedAt = deps.now();
  const rt = romeTime(startedAt);
  const today = rt.date;
  const giro = `agenti-${today}-${String(Math.floor(rt.minutes / 60)).padStart(2, "0")}${String(rt.minutes % 60).padStart(2, "0")}`;
  const log = new Logger(join(deps.logsDir, `agenti-${today}.log`), deps.redactor, deps.echo ?? true);
  const bus = deps.bus;
  const alarms: string[] = [];
  const alarm = async (title: string, detail: string, telegram = true) => {
    alarms.push(`${title}: ${detail}`);
    log.warn(`ALLARME ${title}: ${detail}`);
    bus.emit("allarme", { titolo: title, dettaglio: detail });
    if (telegram) {
      const r = await deps.notifier.send(deps.redactor.apply(`⚠️ Agenti · ${title}\n${detail}`));
      if (!r.ok) log.error(`Telegram non ha ricevuto l'allarme: ${r.error}`);
    }
  };

  // 1. Un solo attore alla volta: se una sveglia classica è in corso, questo giro aspetta il prossimo.
  const existing = inspectLock(deps.stateDir, startedAt);
  if (existing.kind === "alive") {
    bus.emit("nota", { testo: `giro saltato: lock di ${existing.data.runId} (pid ${existing.data.pid}) ancora vivo` });
    return { status: "occupato", message: `Un'altra esecuzione (${existing.data.runId}) ha il lock: giro saltato.` };
  }
  if (existing.kind === "stale") log.warn(`lock morto di ${existing.data?.runId ?? "sconosciuto"} messo da parte: lo riconcilia la prossima sveglia classica`);
  const lock: LockData = { runId: giro, pid: process.pid, startedAt: startedAt.toISOString(), intended: [] };
  if (!acquireLock(deps.stateDir, lock)) return { status: "occupato", message: "Lock preso da un altro processo nello stesso istante: giro saltato." };

  try {
    bus.emit("tick", { giro });
    // 2. Alpaca.
    let snap: Snapshot;
    try {
      snap = await retry(async () => {
        const [account, positions, recent, open, clock] = await Promise.all([deps.broker.getAccount(), deps.broker.getPositions(), deps.broker.getRecentOrders(48), deps.broker.getOpenOrders(), deps.broker.getClock()]);
        const recentOrders = [...recent, ...open.filter((o) => !recent.some((r) => r.id === o.id))];
        const symbols = [...new Set([...UNIVERSE, ...positions.map((p) => p.symbol)])];
        const prices = await deps.broker.getLatestPrices(symbols);
        for (const p of positions) if (!prices[p.symbol] && p.currentPrice > 0) prices[p.symbol] = p.currentPrice;
        return { account, positions, recentOrders, clock, prices };
      }, deps.sleep);
    } catch (e) {
      await alarm("Errore del broker", `Alpaca non risponde: ${(e as Error).message}. Nessun ordine in questo giro.`, false);
      return { status: "broker-giu", message: `Alpaca non risponde: ${(e as Error).message}` };
    }
    bus.emit("conto", { patrimonio: snap.account.equity, contanti: snap.account.cash, pnlGiorno: snap.account.equity - snap.account.lastEquity, mercatoAperto: snap.clock.isOpen });
    bus.emit("prezzi", { prezzi: snap.prices });
    if (cache.closesDate !== today) {
      try {
        cache.closes = await retry(() => deps.broker.getDailyCloses([...UNIVERSE], DAILY_BARS_DAYS), deps.sleep);
        cache.closesDate = today;
      } catch (e) {
        log.warn(`storico non disponibile: ${(e as Error).message}. Senza storico niente acquisti.`);
        if (!cache.closesDate) cache.closes = {};
      }
    }
    const closes = cache.closes;
    const indicators = indicatorsFor(closes, snap.prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays, LIMITS.longSmaDays, LIMITS.rankMomentumDays);

    // 3. Memoria del rischio: interruttore (con riarmo automatico), registro degli errori, diario.
    const lr = readLessons(deps.stateDir, startedAt);
    const lessonsFile = lr.file;
    if (lr.problem) await alarm("Registro degli errori illeggibile", lr.problem);
    const learned: Lesson[] = [];
    for (const o of snap.recentOrders) {
      if (!isProtectiveStop(o) || o.status !== "filled") continue;
      const l = learnFromStopLoss(lessonsFile, `stop-${o.clientOrderId}`, o.symbol, today, `stop su Alpaca eseguito, ${o.filledQty} azioni`);
      if (l) learned.push(l);
    }
    let buyBlock: string | null = null;
    const br = readBreaker(deps.stateDir);
    if (br.kind === "corrupt") {
      buyBlock = `file dell'interruttore illeggibile (${br.error}): acquisti bloccati finché non lanci bun run breaker-reset`;
      await alarm("Interruttore illeggibile", buyBlock);
    } else {
      const ev = evaluateBreaker(br.file, snap.account.equity, snap.account.lastEquity, startedAt.toISOString());
      writeBreaker(deps.stateDir, ev.file);
      buyBlock = ev.buyBlock;
      if (ev.newlyTripped) await alarm("Interruttore scattato", `${ev.newlyTripped}. Acquisti fermi per ${LIMITS.breakerRearmSessions} giorni di borsa; vendite e stop restano attivi.`);
    }
    const lessonsNow = activeLessons(lessonsFile, today);
    const jr = readJournal(deps.stateDir, startedAt);
    const journal = jr.file;
    if (jr.problem) await alarm("Diario dei trade illeggibile", jr.problem);
    const learning = learningStatus(journal, today);

    // 4. Gli agenti guardano, ognuno per conto suo; chi sbaglia non ferma gli altri.
    const view: AgentView = { today, now: startedAt, prices: snap.prices, closes, indicators, positions: snap.positions, account: snap.account, journal };
    const reports: Record<string, AgentReport> = {};
    const agentStatus: AgentsStatus["agenti"] = {};
    await Promise.all(
      deps.agents.map(async (a) => {
        try {
          const r = await a.observe(view);
          reports[a.name] = r;
          agentStatus[a.name] = { segnali: r.segnali.length, note: r.note ?? [] };
          bus.emit("agente", { agente: a.name, segnali: r.segnali.length, rischio: r.rischio ?? null, note: r.note ?? [] });
          for (const s of r.segnali) bus.emit("segnale", { ...s });
          if (r.rischio !== undefined) bus.emit("rischio", { agente: a.name, rischio: r.rischio, note: r.note ?? [] });
        } catch (e) {
          agentStatus[a.name] = { segnali: 0, note: [], errore: (e as Error).message };
          log.error(`agente ${a.name}: ${(e as Error).message}`);
          bus.emit("agente", { agente: a.name, errore: (e as Error).message });
        }
      }),
    );
    const weights = agentWeights(journal, today, deps.agents.map((a) => a.name));
    const alloc = allocate(view, reports, weights);
    bus.emit("allocazione", { rischio: alloc.rischio, pesi: weights, punteggi: alloc.punteggi, proposte: alloc.proposte });

    // 5. Gabbia: gli acquisti solo nella finestra di ingresso, le vendite e gli stop sempre a mercato aperto.
    const entry = inEntryWindow(startedAt);
    const cage = applyCage({ today, slotKind: entry ? "open" : "mid", marketOpen: snap.clock.isOpen, latenessMin: 0, account: snap.account, positions: snap.positions, prices: snap.prices, closes, recentOrders: snap.recentOrders, lessons: lessonsNow, buyBlock, proposals: alloc.proposte });
    for (const x of cage.rejected) {
      log.warn(`rifiutato ${x.side} ${x.qty} ${x.symbol} [${x.source}]: ${x.reason}`);
      bus.emit("rifiuto", { simbolo: x.symbol, lato: x.side, quantita: x.qty, origine: x.source, motivo: x.reason });
    }
    // Gli acquisti hanno un ID al giorno (un solo ingresso per titolo al giorno), le vendite uno per giro.
    const runIdFor = (side: string) => (side === "buy" ? `agenti-${today}` : giro);
    for (const o of cage.orders) {
      const sc = alloc.punteggi.find((p) => p.simbolo === o.symbol);
      const proposed = alloc.proposte.find((p) => p.symbol === o.symbol && p.side === o.side);
      const ctx = contextFor(indicators[o.symbol], snap.prices[o.symbol], o.source === "modello" ? (proposed?.confidence ?? null) : null, o.source === "modello" ? (proposed?.expect ?? "") : "", o.why);
      if (o.source === "modello" && sc) ctx.agenti = sc.agenti;
      recordIntent(journal, { id: clientOrderId(runIdFor(o.side), o.symbol, o.side), simbolo: o.symbol, lato: o.side, origine: o.source === "modello" ? "agenti" : o.source, data: today, contesto: ctx });
    }
    if (cage.orders.length) writeJournal(deps.stateDir, journal);

    // 6. Invio.
    lock.intended = cage.orders.map((o) => ({ clientOrderId: clientOrderId(runIdFor(o.side), o.symbol, o.side), symbol: o.symbol, side: o.side, qty: o.qty }));
    const outcomes: ExecOutcome[] = [];
    for (const plan of cage.orders) {
      const out = await sendOne(deps.broker, runIdFor(plan.side), plan, log, deps.sleep);
      outcomes.push(out);
      bus.emit("ordine", { id: out.id, simbolo: plan.symbol, lato: plan.side, quantita: plan.qty, origine: plan.source, esito: out.kind, stato: "order" in out ? out.order.status : undefined, errore: "error" in out ? out.error : undefined, perche: plan.why });
      if (out.kind === "inviato") {
        const r = await deps.notifier.send(deps.redactor.apply(`🤖 Agenti · ${plan.side === "buy" ? "COMPRA" : "VENDE"} ${plan.qty} ${plan.symbol}\n${plan.why}`));
        if (!r.ok) log.error(`Telegram non ha ricevuto l'ordine: ${r.error}`);
      }
    }
    const uncertain = outcomes.filter((o) => o.kind === "incerto");
    if (uncertain.length) await alarm("Esito incerto", `Alpaca non ha confermato: ${uncertain.map((o) => o.id).join(", ")}. L'ID impedisce i doppioni; il prossimo giro verifica.`);
    const failed = outcomes.filter((o) => o.kind === "fallito");
    if (failed.length) await alarm("Ordini rifiutati da Alpaca", failed.map((o) => `${o.id}: ${o.kind === "fallito" ? o.error : ""}`).join("\n"));
    for (const o of outcomes) {
      const l = o.kind === "inviato" && o.plan.source === "stop-loss" ? learnFromStopLoss(lessonsFile, `stop-${o.id}`, o.plan.symbol, today, o.plan.why) : o.kind === "fallito" ? learnFromBrokerReject(lessonsFile, o.plan.symbol, o.plan.side, today, o.error) : null;
      if (l) learned.push(l);
    }

    // 7. Stop su Alpaca, diario, lezioni.
    let stops: StopsReport | null = null;
    let positions = snap.positions;
    if (!tradingBlockReason({ slotKind: "mid", marketOpen: snap.clock.isOpen, latenessMin: 0, account: snap.account })) {
      await waitForFills(deps.broker, outcomes.filter((o) => o.kind === "inviato").map((o) => o.id), deps.sleep, log);
      try {
        const [pos, open] = await Promise.all([deps.broker.getPositions(), deps.broker.getOpenOrders()]);
        positions = pos;
        stops = await manageStops(deps.broker, giro, pos, open, log, closes);
      } catch (e) {
        stops = { ok: [], placed: [], cancelled: [], errors: [`Alpaca non risponde: ${(e as Error).message}`] };
      }
      for (const s of stops.placed) bus.emit("stop", { azione: "piazzato", dettaglio: s });
      for (const s of stops.cancelled) bus.emit("stop", { azione: "tolto", dettaglio: s });
      if (stops.errors.length) await alarm("Stop su Alpaca non a posto", stops.errors.join("\n"));
    }
    let filled = snap.recentOrders;
    try {
      filled = await deps.broker.getRecentOrders(24 * 7);
    } catch (e) {
      log.warn(`diario: ordini della settimana non leggibili: ${(e as Error).message}`);
    }
    const fills = applyFills(journal, filled);
    for (const t of fills.opened) bus.emit("trade", { stato: "aperto", simbolo: t.simbolo, quantita: t.comprate, prezzo: t.costo / t.comprate, agenti: t.contesto?.agenti ?? [] });
    for (const t of fills.closed) bus.emit("trade", { stato: "chiuso", simbolo: t.simbolo, risultato: t.risultato ?? 0, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto", agenti: t.contesto?.agenti ?? [] });
    learned.push(...learnFromJournal(lessonsFile, journal, today));
    pruneLessons(lessonsFile, today);
    writeLessons(deps.stateDir, lessonsFile);
    pruneJournal(journal, today);
    writeJournal(deps.stateDir, journal);
    for (const l of learned) {
      log.info(`lezione nuova: ${l.motivo} (fino al ${l.finoAl})`);
      bus.emit("nota", { testo: `lezione: ${l.motivo} (fino al ${l.finoAl})` });
    }

    // 8. Conto finale, confronto, stato per la dashboard.
    let account = snap.account;
    if (outcomes.length || stops?.placed.length || stops?.cancelled.length) {
      try {
        account = await deps.broker.getAccount();
      } catch {}
    }
    const bm = compareWithBenchmarks(deps.stateDir, today, account.equity, snap.prices.SPY, snap.prices.TLT);
    const status: AgentsStatus = {
      versione: 1,
      aggiornato: deps.now().toISOString(),
      giro,
      mercatoAperto: snap.clock.isOpen,
      finestraIngressi: entry && snap.clock.isOpen,
      conto: { patrimonio: account.equity, contanti: account.cash, pnlGiorno: account.equity - account.lastEquity },
      posizioni: positions.map((p) => ({ simbolo: p.symbol, quantita: p.qty, prezzoCarico: p.avgEntryPrice, prezzoAttuale: p.currentPrice, variazione: lossPct(p), valore: p.marketValue })),
      prezzi: snap.prices,
      rischio: alloc.rischio,
      pesi: weights,
      agenti: agentStatus,
      segnali: Object.values(reports).flatMap((r) => r.segnali),
      punteggi: alloc.punteggi,
      ordini: outcomes.map((o) => ({ id: o.id, simbolo: o.plan.symbol, lato: o.plan.side, quantita: o.plan.qty, esito: "order" in o ? `${o.kind} (${o.order.status})` : `${o.kind}: ${o.error}`, perche: o.plan.why })),
      rifiuti: cage.rejected,
      stopSuAlpaca: stops,
      acquistiBloccati: buyBlock,
      lezioniAttive: activeLessons(lessonsFile, today),
      allarmi: alarms,
      diario: { stato: learning.motivo, statistiche: statsOf(journal.trade) },
      confronto: bm.cmp,
      ultimoRiepilogo: cache.ultimoRiepilogo,
      tradeChiusiOggi: fills.closed.map((t) => ({ simbolo: t.simbolo, risultato: t.risultato ?? 0, giorni: t.giorni ?? 0, uscita: t.motivoUscita ?? "sconosciuto" })),
    };
    writeJsonAtomic(statusPath(deps.stateDir), status);
    log.info(`giro ${giro}: ${status.segnali.length} segnali, ${alloc.proposte.length} proposte, ${outcomes.length} ordini, ${cage.rejected.length} rifiuti, rischio ${alloc.rischio}`);

    // 9. Riepilogo del giorno su Telegram, una volta, dopo la chiusura.
    if (rt.minutes >= minutesOf(AGENTS.summaryAfter) && cache.ultimoRiepilogo !== today && rt.weekday >= 1 && rt.weekday <= 5) {
      cache.ultimoRiepilogo = today;
      status.ultimoRiepilogo = today;
      writeJsonAtomic(statusPath(deps.stateDir), status);
      const r = await deps.notifier.send(deps.redactor.apply(summaryText(status)));
      if (!r.ok) log.error(`Telegram non ha ricevuto il riepilogo: ${r.error}`);
    }
    bus.prune(today);
    return { status: "fatto", status_file: status, message: `giro ${giro} completato` };
  } finally {
    releaseLock(deps.stateDir);
  }
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

export function summaryText(s: AgentsStatus): string {
  const lines = [`📊 Agenti · riepilogo ${s.aggiornato.slice(0, 10)}`];
  if (s.conto) lines.push(`Patrimonio ${s.conto.patrimonio.toFixed(2)} $ (oggi ${s.conto.pnlGiorno >= 0 ? "+" : ""}${s.conto.pnlGiorno.toFixed(2)} $), contanti ${s.conto.contanti.toFixed(2)} $`);
  if (s.confronto) lines.push(`Dal ${s.confronto.dal}: conto ${pct(s.confronto.conto)}, SPY ${pct(s.confronto.spy)}${s.confronto.misto ? `, 60/40 ${pct(s.confronto.misto.rendimento)}` : ""}`);
  lines.push(`Posizioni: ${s.posizioni.length ? s.posizioni.map((p) => `${p.simbolo} ${p.quantita} (${pct(p.variazione)})`).join(", ") : "nessuna"}`);
  lines.push(`Rischio ammesso ${(s.rischio * 100).toFixed(0)}% · pesi ${Object.entries(s.pesi).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (s.tradeChiusiOggi.length) lines.push(`Trade chiusi oggi: ${s.tradeChiusiOggi.map((t) => `${t.simbolo} ${pct(t.risultato)} in ${t.giorni} g (${t.uscita})`).join("; ")}`);
  lines.push(`Diario: ${s.diario.stato}`);
  if (s.acquistiBloccati) lines.push(`Acquisti bloccati: ${s.acquistiBloccati}`);
  if (s.allarmi.length) lines.push(`Allarmi: ${s.allarmi.join(" | ")}`);
  return lines.join("\n");
}

// Il ciclo: un giro ogni tickMinutes, finché il processo vive. Fuori orario il giro è solo lettura.
export async function runEngine(deps: EngineDeps, tickMs: number, shouldStop: () => boolean = () => false): Promise<void> {
  const cache = emptyCache();
  while (!shouldStop()) {
    const t0 = deps.now().getTime();
    try {
      const r = await runTick(deps, cache);
      if (deps.echo ?? true) console.log(`${deps.now().toISOString()} ${r.message}`);
    } catch (e) {
      console.error(`${deps.now().toISOString()} giro fallito: ${(e as Error).message}`);
      deps.bus.emit("allarme", { titolo: "Giro fallito", dettaglio: (e as Error).message });
    }
    const wait = Math.max(5_000, tickMs - (deps.now().getTime() - t0));
    await deps.sleep(wait);
  }
}
