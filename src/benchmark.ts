import { join } from "node:path";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";

// Punti di partenza per confrontare il conto con "compra SPY e tieni" e con un 60/40 SPY/TLT comprato e tenuto.
// Il 60/40 è il riferimento giusto per una strategia che passa molto tempo in contanti e obbligazioni.
export interface BenchmarkFile {
  versione: 1;
  dal: string;
  patrimonio: number;
  spy: number;
  // Aggiunti dopo: un file vecchio li riceve al primo giro, e il 60/40 parte da quel giorno.
  dalMisto?: string;
  spyMisto?: number;
  tlt?: number;
  patrimonioMisto?: number;
}

const isBenchmark = (v: unknown): v is BenchmarkFile => isObject(v) && v.versione === 1 && typeof v.patrimonio === "number" && typeof v.spy === "number" && typeof v.dal === "string";

export const benchmarkPath = (stateDir: string) => join(stateDir, "benchmark.json");

export interface Comparison {
  dal: string;
  conto: number; // rendimento, es. 0.012 = +1,2%
  spy: number;
  misto?: { dal: string; conto: number; rendimento: number }; // 60/40 e conto dalla stessa data
}

export const MIX = { spy: 0.6, tlt: 0.4 };

// Il primo giro fissa il punto di partenza; un file rotto si rifà da adesso e lo si dice.
export function compareWithBenchmarks(stateDir: string, today: string, equity: number, spyPrice: number | undefined, tltPrice: number | undefined): { cmp: Comparison | null; note?: string } {
  if (!spyPrice || equity <= 0) return { cmp: null };
  const r = readJson(benchmarkPath(stateDir), isBenchmark);
  let note: string | undefined;
  let b: BenchmarkFile;
  let dirty = false;
  if (r.kind === "ok") b = r.value;
  else {
    if (r.kind === "corrupt") note = `confronto con SPY illeggibile (${r.error}): riparto da oggi`;
    b = { versione: 1, dal: today, patrimonio: equity, spy: spyPrice };
    dirty = true;
  }
  if (b.tlt === undefined && tltPrice) {
    Object.assign(b, { dalMisto: today, spyMisto: spyPrice, tlt: tltPrice, patrimonioMisto: equity });
    dirty = true;
  }
  if (dirty) writeJsonAtomic(benchmarkPath(stateDir), b);
  const cmp: Comparison = { dal: b.dal, conto: equity / b.patrimonio - 1, spy: spyPrice / b.spy - 1 };
  if (b.tlt && b.spyMisto && b.dalMisto && b.patrimonioMisto && tltPrice) {
    cmp.misto = { dal: b.dalMisto, conto: equity / b.patrimonioMisto - 1, rendimento: MIX.spy * (spyPrice / b.spyMisto - 1) + MIX.tlt * (tltPrice / b.tlt - 1) };
  }
  return { cmp, note };
}
