// bun run chiudi-posizioni [--fake]: chiude tutte le posizioni del conto paper (vendita a mercato) dopo aver tolto gli
// stop su Alpaca. Serve per ripartire da zero: le posizioni aperte con una vecchia versione del bot si chiudono e gli
// agenti ricominciano con i criteri di oggi al giro successivo. A borsa chiusa l'ordine sui titoli resta in coda e si
// esegue all'apertura; le crypto si chiudono subito. Solo paper: l'endpoint è fisso nel codice.
import { isProtectiveStop } from "../broker/types.ts";
import { buildDeps } from "../deps.ts";
import { clientOrderId } from "../execute.ts";
import { parseArgs } from "./args.ts";

try {
  const args = parseArgs(process.argv.slice(2));
  const deps = await buildDeps(args);
  const runId = `chiusura-${deps.now().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  const open = await deps.broker.getOpenOrders();
  for (const o of open) {
    if (!isProtectiveStop(o)) continue;
    await deps.broker.cancelOrder(o.id);
    console.log(`stop tolto: ${o.symbol} ${o.qty}`);
  }
  const positions = (await deps.broker.getPositions()).filter((p) => p.qty > 0);
  if (!positions.length) {
    console.log("nessuna posizione aperta: niente da chiudere");
    process.exit(0);
  }
  const lines: string[] = [];
  for (const p of positions) {
    try {
      const o = await deps.broker.submitOrder({ symbol: p.symbol, side: "sell", qty: p.qty, clientOrderId: clientOrderId(runId, p.symbol, "sell") });
      const l = `VENDE ${p.qty} ${p.symbol} (carico ${p.avgEntryPrice.toFixed(2)}, ora ${p.currentPrice.toFixed(2)}) → ${o.status}`;
      console.log(l);
      lines.push(l);
    } catch (e) {
      const l = `${p.symbol}: ordine rifiutato: ${(e as Error).message}`;
      console.error(l);
      lines.push(l);
    }
  }
  const msg = `🧹 Chiusura delle posizioni ereditate (${runId})\n${lines.join("\n")}\nGli agenti ripartono con i criteri di oggi al prossimo giro.`;
  const r = await deps.notifier.send(deps.redactor.apply(msg));
  if (!r.ok) console.log(`Telegram non ha ricevuto l'avviso: ${deps.redactor.apply(r.error ?? "")}`);
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
