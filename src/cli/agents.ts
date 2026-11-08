// bun run agents [--fake] [--once] [--tick 5] [--port 8787] [--no-dashboard] [--kronos http://127.0.0.1:8765]
// Il motore degli agenti: processo sempre acceso sul tuo PC. Ogni `tick` minuti legge il conto, interroga gli agenti
// (trend, rientro, regime, orizzonte, Kronos se c'è), passa dalla gabbia, invia, e aggiorna la dashboard locale.
import { HorizonAgent } from "../agents/horizon.ts";
import { KronosAgent, httpFetcher } from "../agents/kronos.ts";
import { PullbackAgent } from "../agents/pullback.ts";
import { RegimeAgent } from "../agents/regime.ts";
import { TrendAgent } from "../agents/trend.ts";
import { EventBus } from "../agents/bus.ts";
import { runEngine, runTick, type EngineDeps } from "../agents/engine.ts";
import type { Agent } from "../agents/types.ts";
import { AGENTS } from "../config.ts";
import { startDashboard } from "../dashboard/server.ts";
import { buildDeps } from "../deps.ts";
import { parseArgs } from "./args.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const deps = await buildDeps(args);
  for (const w of deps.warnings) console.warn(w);
  const bus = new EventBus(deps.stateDir, deps.now);
  const agents: Agent[] = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent()];
  const kronosUrl = args.kronos ?? process.env.KRONOS_URL;
  if (kronosUrl) agents.push(new KronosAgent(httpFetcher(kronosUrl)));
  const engine: EngineDeps = { ...deps, agents, bus, echo: true };
  console.log(`motore degli agenti${args.fake ? " (finto)" : ""}: ${agents.map((a) => a.name).join(", ")} · stato in ${deps.stateDir}`);

  let dash: ReturnType<typeof startDashboard> | null = null;
  if (!args.noDashboard && !args.once) {
    dash = startDashboard({ port: args.port ?? AGENTS.dashboardPort, stateDir: deps.stateDir, bus });
    console.log(`dashboard su ${dash.url}`);
  }
  if (args.once) {
    const r = await runTick(engine);
    console.log(r.message);
    process.exit(r.status === "fatto" ? 0 : 1);
  }
  let stop = false;
  const quit = () => {
    if (stop) return;
    stop = true;
    console.log("chiusura richiesta: finisco il giro in corso e mi fermo");
    dash?.stop();
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  await runEngine(engine, (args.tick ?? AGENTS.tickMinutes) * 60_000, () => stop);
  process.exit(0);
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
