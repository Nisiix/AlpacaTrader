// bun run backtest [--fake] [--days 500] [--riarmo 5]: rigioca sulle chiusure storiche di Alpaca prima la gabbia con il
// metodo trend (le sveglie), poi il motore degli agenti (trend, rientro, regime, orizzonte, pesi dal diario).
import { runAgentsBacktest } from "../agents/backtest.ts";
import { ContextAgent } from "../agents/context.ts";
import { ExitAgent } from "../agents/exits.ts";
import { HorizonAgent } from "../agents/horizon.ts";
import { PullbackAgent } from "../agents/pullback.ts";
import { RegimeAgent } from "../agents/regime.ts";
import { TakeProfitAgent } from "../agents/takeprofit.ts";
import { TrendAgent } from "../agents/trend.ts";
import { runBacktest } from "../backtest.ts";
import { AGENTS, UNIVERSE, enableCrypto } from "../config.ts";
import { buildDeps } from "../deps.ts";
import { parseArgs } from "./args.ts";

try {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--days");
  const days = i >= 0 ? Number(argv.splice(i, 2)[1]) : 500;
  const j = argv.indexOf("--riarmo");
  const reset = j >= 0 ? Number(argv.splice(j, 2)[1]) : null;
  const args = parseArgs(argv);
  if (args.crypto) enableCrypto();
  const deps = await buildDeps(args);
  // Titoli e crypto non hanno gli stessi giorni: tutto allineato sulle sedute di SPY (per le crypto vale la chiusura di quel giorno).
  const byDate = await deps.broker.getDailyClosesByDate([...new Set([...UNIVERSE, ...AGENTS.universe])], days);
  const grid = (byDate.SPY ?? []).map((b) => b.date);
  const closes: Record<string, number[]> = {};
  for (const [sym, bars] of Object.entries(byDate)) {
    const m = new Map(bars.map((b) => [b.date, b.close]));
    let last: number | undefined;
    const out: number[] = [];
    for (const d of grid) {
      const c = m.get(d) ?? last;
      if (c === undefined) continue; // la serie inizia dopo: si parte dal primo giorno disponibile
      out.push(c);
      last = c;
    }
    if (out.length === grid.length) closes[sym] = out;
    else console.warn(`${sym}: storico più corto (${out.length} di ${grid.length} sedute), escluso dal backtest`);
  }
  const r = runBacktest(closes, 100_000, undefined, reset);
  const p = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  console.log(`Backtest su ${r.days} giorni di borsa (${deps.broker.name})`);
  console.log(`Rendimento: ${p(r.totalReturn)} · SPY compra e tieni: ${p(r.spyReturn)} · 60/40 SPY/TLT: ${p(r.mixReturn)} · perdita massima dal picco: ${p(-r.maxDrawdown)}`);
  if (reset !== null) console.log(`Interruttore riarmato in automatico dopo ${reset} giorni di borsa (nella realtà lo riarmi tu).`);
  console.log(`Ordini: ${r.trades} · uscite di trend: ${r.trendExits} · stop scattati: ${r.stopOuts} · acquisti fermati dal registro degli errori: ${r.blockedByLessons} · interruttore scattato: ${r.breakerTrips} volte`);
  console.log("Rifiuti della gabbia per motivo:");
  for (const [k, v] of Object.entries(r.rejectedByCage).sort((a, b) => b[1] - a[1])) console.log(`  ${v} × ${k}`);
  console.log("Limiti: ordini alla chiusura, stop controllato una volta al giorno, niente costi né slippage.");

  const st = (s: { trade: number; vinti: number; attesa: number | null; campione: string }) => `${s.trade} trade, ${s.vinti} vinti, attesa ${s.attesa === null ? "–" : p(s.attesa)} (${s.campione})`;
  const base = () => [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent(), new ContextAgent(null, [])];
  const ex = AGENTS.exit;
  const variants: [string, () => ReturnType<typeof runAgentsBacktest>][] = [
    ["trend, rientro, regime, orizzonte, contesto (regole), pesi dal diario; stop della gabbia 5-10%", () => runAgentsBacktest(closes, 100_000, undefined, base())],
    [`gli stessi + presa di profitto secca a +${(AGENTS.takeProfit.pct * 100).toFixed(0)}%`, () => runAgentsBacktest(closes, 100_000, undefined, [...base(), new TakeProfitAgent()])],
    [`gli stessi + uscite: stop -${(ex.stopPct * 100).toFixed(0)}%, incasso a +${(ex.targetPct * 100).toFixed(0)}% (senza proiezioni)`, () => runAgentsBacktest(closes, 100_000, undefined, [...base(), new ExitAgent()])],
    [`gli stessi + uscite: stop -${(ex.stopPct * 100).toFixed(0)}%, incasso a +4% (senza proiezioni)`, () => runAgentsBacktest(closes, 100_000, undefined, [...base(), new ExitAgent({ ...ex, targetPct: 0.04 })])],
  ];
  for (const [label, run] of variants) {
  const a = run();
  console.log(`\nMotore degli agenti (${label}) sugli stessi ${a.days} giorni`);
  console.log(`Rendimento: ${p(a.totalReturn)} · SPY: ${p(a.spyReturn)} · 60/40: ${p(a.mixReturn)} · perdita massima dal picco: ${p(-a.maxDrawdown)} · esposizione media ${(a.avgExposure * 100).toFixed(0)}%`);
  console.log(`Acquisti ${a.buys} · vendite ${a.sells} (dagli agenti ${a.agentSells}, di cui regole di uscita ${a.exitRuleSells}; uscite di trend ${a.trendExits}; stop della gabbia ${a.stopOuts}) · interruttore scattato ${a.breakerTrips} volte · durata media ${a.avgHoldDays.toFixed(0)} giorni`);
  console.log(`Trade chiusi: ${st(a.stats)}${a.learningFrom ? ` · il diario pesa gli agenti dal ${a.learningFrom}` : " · diario mai attivo (troppo pochi trade)"}`);
  for (const [k, v] of Object.entries(a.perAgent)) console.log(`  ${k}: ${st(v)} · peso finale ${a.finalWeights[k] ?? 1}`);
  console.log("Rifiuti della gabbia per motivo:");
  for (const [k, v] of Object.entries(a.rejectedByCage).sort((x, y) => y[1] - x[1])) console.log(`  ${v} × ${k}`);
  }
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
