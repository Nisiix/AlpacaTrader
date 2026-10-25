// bun run once [--slot HH:MM] [--force] [--fake]: una sveglia, in un processo nuovo, senza memoria.
import { buildDeps } from "../deps.ts";
import { runWake } from "../wake.ts";
import { parseArgs } from "./args.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const deps = await buildDeps(args);
  for (const w of deps.warnings) console.log(`ATTENZIONE: ${deps.redactor.apply(w)}`);
  const res = await runWake(deps, { slot: args.slot, force: args.force });
  console.log(deps.redactor.apply(`[${res.status}] ${res.message}`));
  process.exit(res.status === "busy" ? 3 : 0);
} catch (e) {
  // Niente stack con possibili valori dentro: solo il messaggio.
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
