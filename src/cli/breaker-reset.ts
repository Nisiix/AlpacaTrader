// bun run breaker-reset [--fake]: riarma l'interruttore sulla perdita. Il nuovo massimo è il patrimonio di adesso.
import { writeBreaker } from "../breaker.ts";
import { buildDeps } from "../deps.ts";
import { parseArgs } from "./args.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const deps = await buildDeps(args);
  const a = await deps.broker.getAccount();
  writeBreaker(deps.stateDir, { versione: 1, massimo: a.equity, scattato: null });
  const msg = `Interruttore riarmato a mano: nuovo massimo ${a.equity.toFixed(2)} $. Gli acquisti riprendono dal prossimo giro.`;
  console.log(msg);
  const res = await deps.notifier.send(`⚠️ ${msg}`);
  if (!res.ok) console.log(`Telegram non ha ricevuto l'avviso: ${deps.redactor.apply(res.error ?? "")}`);
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
