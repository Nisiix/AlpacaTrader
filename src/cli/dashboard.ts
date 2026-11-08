// bun run dashboard [--fake] [--port 8787]: solo la dashboard, in lettura, sullo stato esistente (senza motore).
import { AGENTS } from "../config.ts";
import { startDashboard } from "../dashboard/server.ts";
import { dirs } from "../deps.ts";
import { parseArgs } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const { stateDir } = dirs(args);
const d = startDashboard({ port: args.port ?? AGENTS.dashboardPort, stateDir });
console.log(`dashboard su ${d.url} (stato: ${stateDir}). Ctrl-C per fermarla.`);
