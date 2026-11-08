// bun run sweep [--days 2600] [--crypto]: ottimizzazione prudente del motore. Griglia di pochi parametri robusti, scelta
// sulla prima parte dello storico (addestramento) e verifica sulla seconda (prova), così quello che sembra buono per caso
// si vede subito. Stampa le configurazioni ordinate per quota di trade vinti nella prova, con rendimento e perdita massima.
import { runAgentsBacktest } from "../agents/backtest.ts";
import { ContextAgent } from "../agents/context.ts";
import { ExitAgent } from "../agents/exits.ts";
import { HorizonAgent } from "../agents/horizon.ts";
import { PullbackAgent } from "../agents/pullback.ts";
import { RegimeAgent } from "../agents/regime.ts";
import { TakeProfitAgent } from "../agents/takeprofit.ts";
import { TrendAgent } from "../agents/trend.ts";
import type { Agent } from "../agents/types.ts";
import { AGENTS, LIMITS, UNIVERSE, enableCrypto } from "../config.ts";
import { buildDeps } from "../deps.ts";
import { parseArgs } from "./args.ts";

interface Combo {
  tp: "no" | "tutta 5%" | "metà 5%" | "metà 8%" | "metà 3%";
  trail: number;
  stopMult: number;
  absDays: number;
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--days");
  const days = i >= 0 ? Number(argv.splice(i, 2)[1]) : 2600;
  const args = parseArgs(argv);
  if (args.crypto) enableCrypto();
  const deps = await buildDeps(args);
  const byDate = await deps.broker.getDailyClosesByDate([...new Set([...UNIVERSE, ...AGENTS.universe])], days);
  const equities = Object.keys(byDate).filter((s) => !s.includes("/"));
  const firstOf = (sym: string) => byDate[sym]?.[0]?.date ?? "9999";
  const gridStart = equities.reduce((m, s) => (firstOf(s) > m ? firstOf(s) : m), "0000");
  const grid = (byDate.SPY ?? []).map((b) => b.date).filter((d) => d >= gridStart);
  const closes: Record<string, number[]> = {};
  for (const [sym, bars] of Object.entries(byDate)) {
    const m = new Map(bars.map((b) => [b.date, b.close]));
    let last: number | undefined;
    const out: number[] = [];
    for (const d of grid) {
      const c = m.get(d) ?? last;
      if (c === undefined) continue;
      out.push(c);
      last = c;
    }
    if (out.length === grid.length) closes[sym] = out;
  }
  const n = grid.length;
  const warm = AGENTS.absMomentum.days + 1;
  const split = Math.floor(n * 0.6);
  const slice = (a: number, b: number) => Object.fromEntries(Object.entries(closes).map(([s, c]) => [s, c.slice(a, b)]));
  const train = slice(0, split);
  const test = slice(split - warm, n);
  console.log(`Storico ${grid[0]} → ${grid[n - 1]} (${n} sedute). Addestramento fino a ${grid[split - 1]}, prova da ${grid[split]} (${n - split} sedute).`);

  const combos: Combo[] = [];
  for (const tp of ["no", "tutta 5%", "metà 5%", "metà 8%", "metà 3%"] as const) for (const trail of [0, 5]) for (const stopMult of [2.5, 3.5]) for (const absDays of [126, 252]) combos.push({ tp, trail, stopMult, absDays });

  const agentsFor = (c: Combo): Agent[] => {
    const list: Agent[] = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent(), new ContextAgent(null, []), new ExitAgent({ ...AGENTS.exit, trailAtr: c.trail })];
    if (c.tp === "tutta 5%") list.push(new TakeProfitAgent(0.05, 1));
    if (c.tp === "metà 5%") list.push(new TakeProfitAgent(0.05, 0.5));
    if (c.tp === "metà 8%") list.push(new TakeProfitAgent(0.08, 0.5));
    if (c.tp === "metà 3%") list.push(new TakeProfitAgent(0.03, 0.5));
    return list;
  };
  const baseStop = LIMITS.stop.volMultiple;
  const baseAbs = AGENTS.absMomentum.days;
  const rows: { c: Combo; tr: ReturnType<typeof runAgentsBacktest>; te: ReturnType<typeof runAgentsBacktest> }[] = [];
  const p = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const w = (r: ReturnType<typeof runAgentsBacktest>) => (r.stats.trade ? `${((r.stats.vinti / r.stats.trade) * 100).toFixed(0)}%` : "–");
  for (const c of combos) {
    LIMITS.stop.volMultiple = c.stopMult;
    AGENTS.absMomentum.days = c.absDays;
    const tr = runAgentsBacktest(train, 100_000, grid[0], agentsFor(c));
    const te = runAgentsBacktest(test, 100_000, grid[split - warm], agentsFor(c));
    rows.push({ c, tr, te });
    console.log(`${c.tp.padEnd(9)} trail ${c.trail} stop×${c.stopMult} abs ${c.absDays} | addestr.: vinti ${w(tr)} attesa ${p(tr.stats.attesa ?? 0)} rend ${p(tr.totalReturn)} DD ${p(-tr.maxDrawdown)} (${tr.stats.trade} trade) | prova: vinti ${w(te)} attesa ${p(te.stats.attesa ?? 0)} rend ${p(te.totalReturn)} DD ${p(-te.maxDrawdown)} (${te.stats.trade} trade) giorni+ ${te.daily.giorniPositivi}/${te.daily.giorniPositivi + te.daily.giorniNegativi}`);
  }
  LIMITS.stop.volMultiple = baseStop;
  AGENTS.absMomentum.days = baseAbs;
  // Scelta prudente: tra le configurazioni che in addestramento battono la base per quota di vinti E non perdono attesa
  // né rendimento oltre il 20%, quella con più vinti; poi si guarda cosa fa nella prova.
  const base = rows.find((r) => r.c.tp === "no" && r.c.trail === 0 && r.c.stopMult === 2.5 && r.c.absDays === 252)!;
  const win = (r: typeof base, k: "tr" | "te") => (r[k].stats.trade ? r[k].stats.vinti / r[k].stats.trade : 0);
  const ok = rows.filter((r) => win(r, "tr") > win(base, "tr") && r.tr.totalReturn >= base.tr.totalReturn * 0.8 && r.tr.maxDrawdown <= base.tr.maxDrawdown * 1.2);
  ok.sort((a, b) => win(b, "tr") - win(a, "tr"));
  console.log(`\nBase (nessuna presa di profitto, stop ×2.5, abs 252): addestr. vinti ${w(base.tr)} rend ${p(base.tr.totalReturn)} | prova vinti ${w(base.te)} rend ${p(base.te.totalReturn)} DD ${p(-base.te.maxDrawdown)}`);
  console.log(`Configurazioni che in addestramento alzano i vinti senza perdere più del 20% di rendimento né aggravare la perdita massima: ${ok.length}`);
  for (const r of ok.slice(0, 8)) console.log(`  ${r.c.tp} trail ${r.c.trail} stop×${r.c.stopMult} abs ${r.c.absDays} → prova: vinti ${w(r.te)} (base ${w(base.te)}) attesa ${p(r.te.stats.attesa ?? 0)} rend ${p(r.te.totalReturn)} (base ${p(base.te.totalReturn)}) DD ${p(-r.te.maxDrawdown)} giorni+ ${((r.te.daily.giorniPositivi / (r.te.daily.giorniPositivi + r.te.daily.giorniNegativi)) * 100).toFixed(0)}%`);
}

main().catch((e) => {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
});
