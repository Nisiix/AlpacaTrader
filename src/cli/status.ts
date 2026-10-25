// bun run status [--fake]: stampa lock, ultimo testimone e conto. Mai le chiavi.
import { buildDeps } from "../deps.ts";
import { readLockForStatus } from "../lock.ts";
import { describeRunId } from "../slots.ts";
import { readWitness } from "../witness.ts";
import { parseArgs } from "./args.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const deps = await buildDeps(args);
  const out: string[] = [];

  const lock = readLockForStatus(deps.stateDir);
  if (!lock) out.push("Lock: nessuno (nessuna sveglia in corso o interrotta)");
  else if (!lock.data) out.push("Lock: presente ma illeggibile (sveglia interrotta? la prossima riconcilia)");
  else out.push(`Lock: sveglia ${lock.data.runId}, pid ${lock.data.pid}, partita ${lock.data.startedAt}, ordini previsti ${lock.data.intended.length}`);

  const w = readWitness(deps.stateDir);
  if (w.kind === "missing") out.push("Ultimo testimone: nessuno");
  else if (w.kind === "corrupt") out.push(`Ultimo testimone: illeggibile (${w.error})`);
  else {
    const t = w.value;
    out.push(`Ultimo testimone: ${describeRunId(t.sveglia)} · ${t.esito}`, `  ${t.appunto}`, `  Prossima: ${describeRunId(t.prossimaSveglia)}`);
  }

  try {
    const [a, pos] = await Promise.all([deps.broker.getAccount(), deps.broker.getPositions()]);
    out.push(`Conto (${deps.broker.name}): patrimonio ${a.equity.toFixed(2)} $, contanti ${a.cash.toFixed(2)} $, P&L giorno ${(a.equity - a.lastEquity).toFixed(2)} $`);
    for (const p of pos) out.push(`  ${p.symbol}: ${p.qty} @ ${p.avgEntryPrice.toFixed(2)} (ora ${p.currentPrice.toFixed(2)})`);
  } catch (e) {
    out.push(`Conto: non leggibile (${(e as Error).message})`);
  }
  console.log(deps.redactor.apply(out.join("\n")));
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
