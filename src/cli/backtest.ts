// bun run backtest [--fake] [--days 500]: rigioca la gabbia e il metodo dichiarato sulle chiusure storiche di Alpaca.
import { runBacktest } from "../backtest.ts";
import { UNIVERSE } from "../config.ts";
import { buildDeps } from "../deps.ts";
import { parseArgs } from "./args.ts";

try {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--days");
  const days = i >= 0 ? Number(argv.splice(i, 2)[1]) : 500;
  const deps = await buildDeps(parseArgs(argv));
  const closes = await deps.broker.getDailyCloses([...UNIVERSE], days);
  const r = runBacktest(closes);
  const p = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  console.log(`Backtest su ${r.days} giorni di borsa (${deps.broker.name})`);
  console.log(`Rendimento: ${p(r.totalReturn)} · SPY compra e tieni: ${p(r.spyReturn)} · perdita massima dal picco: ${p(-r.maxDrawdown)}`);
  console.log(`Ordini: ${r.trades} · stop loss scattati: ${r.stopOuts} · acquisti fermati dal registro degli errori: ${r.blockedByLessons} · interruttore scattato: ${r.breakerTrips} volte`);
  console.log("Rifiuti della gabbia per motivo:");
  for (const [k, v] of Object.entries(r.rejectedByCage).sort((a, b) => b[1] - a[1])) console.log(`  ${v} × ${k}`);
  console.log("Limiti: ordini alla chiusura, stop controllato una volta al giorno, niente costi né slippage.");
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
