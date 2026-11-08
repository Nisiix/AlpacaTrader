// bun run agents [--fake] [--once] [--tick 5] [--port 8787] [--no-dashboard] [--no-crypto] [--no-kronos] [--kronos http://host:porta]
// Il motore degli agenti: processo sempre acceso sul tuo PC. Ogni `tick` minuti legge il conto, interroga gli agenti
// (trend, rientro, regime, orizzonte, uscite, contesto, presa di profitto, i custodi delle crypto, Kronos), passa dalla
// gabbia, invia, e aggiorna la dashboard locale. Kronos: il sidecar Python lo accende il motore da solo, se installato.
import { HorizonAgent } from "../agents/horizon.ts";
import { ClaudeMacro, ContextAgent } from "../agents/context.ts";
import { CustodiAgent } from "../agents/custode.ts";
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
import { parseArgs } from "./args.ts";

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
  if (!args.noCrypto && AGENTS.custodi.enabled) agents.push(new CustodiAgent());

  // Kronos: un sidecar già acceso (--kronos url o KRONOS_URL), altrimenti lo avvia il motore dal venv di tools/kronos.
  let kronos: KronosLink | null = null;
  if (!args.noKronos && !args.fake) {
    const url = args.kronos ?? process.env.KRONOS_URL;
    kronos = url ? { url, ready: true, stato: `attivo su ${url} (indicato a mano)`, stop: () => {} } : await ensureKronos({ root: ROOT, log: (l) => console.log(`${new Date().toISOString()} ${l}`) });
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
  const quit = () => {
    if (stop) return;
    stop = true;
    console.log("chiusura richiesta: finisco il giro in corso e mi fermo");
    dash?.stop();
    kronos?.stop();
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  await runEngine(engine, (args.tick ?? AGENTS.tickMinutes) * 60_000, () => stop, cache);
  kronos?.stop();
  process.exit(0);
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
