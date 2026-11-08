// bun run agents [--fake] [--once] [--tick 5] [--port 8787] [--no-dashboard] [--no-crypto] [--no-kronos] [--kronos http://host:porta]
// Il motore degli agenti: processo sempre acceso sul tuo PC. Ogni `tick` minuti legge il conto, interroga gli agenti
// (trend, rientro, regime, orizzonte, uscite, contesto, presa di profitto, i custodi delle crypto, Kronos), passa dalla
// gabbia, invia, e aggiorna la dashboard locale. Kronos: il sidecar Python lo accende il motore da solo, se installato.
import { HorizonAgent } from "../agents/horizon.ts";
import { ClaudeMacro, ContextAgent } from "../agents/context.ts";
import { CustodiAgent, combinedNews, googleNews, xNews } from "../agents/custode.ts";
import { loadSecrets } from "../deps.ts";
import { IntradayAgent } from "../agents/intraday.ts";
import { ExitAgent } from "../agents/exits.ts";
import { spawnRunner } from "../brain/claude.ts";
import { KronosAgent } from "../agents/kronos.ts";
import { PullbackAgent } from "../agents/pullback.ts";
import { RegimeAgent } from "../agents/regime.ts";
import { TakeProfitAgent } from "../agents/takeprofit.ts";
import { TrendAgent } from "../agents/trend.ts";
import { EventBus } from "../agents/bus.ts";
import { emptyCache, runEngine, runTick, valutaTitolo, type EngineDeps } from "../agents/engine.ts";
import { coingeckoTop } from "../agents/universe.ts";
import type { Agent } from "../agents/types.ts";
import { AGENTS, enableCrypto } from "../config.ts";
import { startDashboard } from "../dashboard/server.ts";
import { ROOT, buildDeps } from "../deps.ts";
import { ensureKronos, pathForecaster, type KronosLink } from "../kronos-sidecar.ts";
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.ts";

// Codice di uscita che chiede ad avvia-bot.cmd di rilanciare il motore.
const RESTART_CODE = 75;

try {
  const args = parseArgs(process.argv.slice(2));
  // Le crypto (BTC/USD, ETH/USD di base; poi l'universo del giorno: top per capitalizzazione ∩ coppie Alpaca) lavorano
  // con la stessa logica dei titoli, 24 ore su 24, anche a borsa chiusa.
  if (!args.noCrypto) enableCrypto();
  const deps = await buildDeps(args);
  for (const w of deps.warnings) console.warn(w);
  const bus = new EventBus(deps.stateDir, deps.now);
  const agents: Agent[] = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent()];
  if (AGENTS.exit.enabled) agents.push(new ExitAgent());
  // Il contesto economico: regole sui dati sempre; la lettura con claude e ricerca web solo nel vero, se abilitata.
  if (AGENTS.context.enabled) agents.push(new ContextAgent(AGENTS.context.useClaude && !args.fake ? new ClaudeMacro(deps.stateDir, spawnRunner, deps.now) : null));
  if (args.profitto || AGENTS.takeProfit.enabled) agents.push(new TakeProfitAgent());
  // I custodi studiano il loro titolo tra un giro e l'altro: nel vero leggono anche le notizie (Google News), nel finto no.
  if (AGENTS.custodi.enabled) {
    const xToken = args.fake ? "" : (await loadSecrets(false))?.xBearerToken ?? "";
    agents.push(new CustodiAgent(args.fake ? null : combinedNews([googleNews(), ...(xToken ? [xNews(xToken)] : [])])));
    if (!args.fake) console.log(`notizie: Google News${xToken ? " + X" : " (X: nessun token in secrets.ts)"}`);
  }
  // Intraday: operazioni che si chiudono in giornata, su candele scelte dall'agente (5 min / 15 min / 4 ore).
  if (AGENTS.intraday.enabled) agents.push(new IntradayAgent((s, tf, n) => deps.broker.getIntradayBars(s, tf, n)));

  // Kronos: un sidecar già acceso (--kronos url o KRONOS_URL), altrimenti lo avvia il motore dal venv di tools/kronos.
  let kronos: KronosLink | null = null;
  if (!args.noKronos && !args.fake) {
    const url = args.kronos ?? process.env.KRONOS_URL;
    // Le righe del sidecar finiscono anche in logs/kronos-AAAA-MM-GG.log, per capire cosa fa a finestra chiusa.
    const kronosLog = (l: string) => {
      const line = `${new Date().toISOString()} ${l}`;
      console.log(line);
      try {
        mkdirSync(deps.logsDir, { recursive: true });
        appendFileSync(join(deps.logsDir, `kronos-${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
      } catch {}
    };
    kronos = url ? { url, ready: true, stato: `attivo su ${url} (indicato a mano)`, stop: () => {} } : await ensureKronos({ root: ROOT, log: kronosLog });
    agents.push(new KronosAgent(async () => []));
  }
  const cache = emptyCache();
  const engine: EngineDeps = {
    ...deps,
    agents,
    bus,
    echo: true,
    forecaster: kronos ? pathForecaster(kronos) : undefined,
    kronosStato: kronos ? () => kronos!.stato : undefined,
    // Nel finto niente rete: solo le coppie del broker finto.
    cryptoUniverse: args.noCrypto ? undefined : { fetchTop: args.fake ? null : coingeckoTop() },
  };
  console.log(`motore degli agenti${args.fake ? " (finto)" : ""}: ${agents.map((a) => a.name).join(", ")} · stato in ${deps.stateDir}${kronos ? ` · kronos ${kronos.stato}` : ""}`);

  let dash: ReturnType<typeof startDashboard> | null = null;
  if (!args.noDashboard && !args.once) {
    dash = startDashboard({ port: args.port ?? AGENTS.dashboardPort, stateDir: deps.stateDir, bus, valuta: (s) => valutaTitolo(engine, cache, s) });
    console.log(`dashboard su ${dash.url}`);
  }
  if (args.once) {
    const r = await runTick(engine, cache);
    console.log(r.message);
    kronos?.stop();
    process.exit(r.status === "fatto" ? 0 : 1);
  }
  let stop = false;
  let exitCode = 0;
  const quit = (code = 0) => {
    if (stop) return;
    stop = true;
    exitCode = code;
    console.log(code === RESTART_CODE ? "riavvio richiesto: finisco il giro in corso e riparto (avvia-bot.cmd rilancia il motore)" : "chiusura richiesta: finisco il giro in corso e mi fermo");
    dash?.stop();
    kronos?.stop();
    setTimeout(() => process.exit(code), 20_000).unref();
  };
  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  // Riavvio dall'applicazione (Impostazioni → «Riavvia il motore», o il file state/riavvio.richiesta): il processo esce con
  // codice 75 e avvia-bot.cmd lo rilancia, così il codice e le chiavi nuove entrano in uso senza toccare il PC.
  const restartFile = join(deps.stateDir, "riavvio.richiesta");
  const watcher = setInterval(() => {
    if (!existsSync(restartFile)) return;
    try {
      unlinkSync(restartFile);
    } catch {}
    quit(RESTART_CODE);
  }, 5_000);
  watcher.unref();
  await runEngine(engine, (args.tick ?? AGENTS.tickMinutes) * 60_000, () => stop, cache);
  kronos?.stop();
  process.exit(exitCode);
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
