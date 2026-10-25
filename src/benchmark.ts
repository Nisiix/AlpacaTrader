import { join } from "node:path";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";

// Punto di partenza per confrontare il conto con "compra SPY e tieni".
export interface BenchmarkFile {
  versione: 1;
  dal: string;
  patrimonio: number;
  spy: number;
}

const isBenchmark = (v: unknown): v is BenchmarkFile => isObject(v) && v.versione === 1 && typeof v.patrimonio === "number" && typeof v.spy === "number" && typeof v.dal === "string";

export const benchmarkPath = (stateDir: string) => join(stateDir, "benchmark.json");

export interface Comparison {
  dal: string;
  conto: number; // rendimento, es. 0.012 = +1,2%
  spy: number;
}

// Il primo giro fissa il punto di partenza; un file rotto si rifà da adesso e lo si dice.
export function compareWithSpy(stateDir: string, today: string, equity: number, spyPrice: number | undefined): { cmp: Comparison | null; note?: string } {
  if (!spyPrice || equity <= 0) return { cmp: null };
  const r = readJson(benchmarkPath(stateDir), isBenchmark);
  let note: string | undefined;
  let b: BenchmarkFile;
  if (r.kind === "ok") b = r.value;
  else {
    if (r.kind === "corrupt") note = `confronto con SPY illeggibile (${r.error}): riparto da oggi`;
    b = { versione: 1, dal: today, patrimonio: equity, spy: spyPrice };
    writeJsonAtomic(benchmarkPath(stateDir), b);
  }
  return { cmp: { dal: b.dal, conto: equity / b.patrimonio - 1, spy: spyPrice / b.spy - 1 }, note };
}
