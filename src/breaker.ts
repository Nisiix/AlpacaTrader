import { join } from "node:path";
import { LIMITS } from "./config.ts";
import { addTradingDays } from "./slots.ts";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";

// Interruttore sulla perdita: una volta scattato blocca gli acquisti per breakerRearmSessions giorni di borsa
// (o finché non lanci breaker-reset), poi si riarma da solo ripartendo dal patrimonio di quel momento.
export interface BreakerFile {
  versione: 1;
  massimo: number; // patrimonio massimo visto
  scattato: null | { il: string; motivo: string };
}

const isBreaker = (v: unknown): v is BreakerFile => isObject(v) && v.versione === 1 && typeof v.massimo === "number" && (v.scattato === null || isObject(v.scattato));

export const breakerPath = (stateDir: string) => join(stateDir, "breaker.json");

export type BreakerRead = { kind: "ok"; file: BreakerFile | null } | { kind: "corrupt"; error: string };

export function readBreaker(stateDir: string): BreakerRead {
  const r = readJson(breakerPath(stateDir), isBreaker);
  if (r.kind === "ok") return { kind: "ok", file: r.value };
  if (r.kind === "missing") return { kind: "ok", file: null };
  return { kind: "corrupt", error: r.error };
}

export function writeBreaker(stateDir: string, file: BreakerFile) {
  writeJsonAtomic(breakerPath(stateDir), file);
}

export interface BreakerResult {
  file: BreakerFile;
  buyBlock: string | null;
  newlyTripped: string | null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function evaluateBreaker(file: BreakerFile | null, equity: number, lastEquity: number, nowIso: string): BreakerResult {
  const f: BreakerFile = file ? structuredClone(file) : { versione: 1, massimo: equity, scattato: null };
  // Riarmo automatico: passati i giorni di borsa previsti, il massimo riparte da oggi e gli acquisti tornano possibili.
  if (f.scattato && nowIso.slice(0, 10) >= addTradingDays(f.scattato.il.slice(0, 10), LIMITS.breakerRearmSessions)) {
    f.scattato = null;
    f.massimo = equity;
  }
  f.massimo = Math.max(f.massimo, equity);
  const dd = f.massimo > 0 ? 1 - equity / f.massimo : 0;
  let newlyTripped: string | null = null;
  if (!f.scattato && dd >= LIMITS.maxDrawdownPct) {
    f.scattato = { il: nowIso, motivo: `perdita del ${pct(dd)} dal massimo di ${f.massimo.toFixed(2)} $ (limite ${pct(LIMITS.maxDrawdownPct)})` };
    newlyTripped = f.scattato.motivo;
  }
  if (f.scattato) return { file: f, newlyTripped, buyBlock: `interruttore scattato il ${f.scattato.il.slice(0, 10)}: ${f.scattato.motivo}. Si riarma da solo il ${addTradingDays(f.scattato.il.slice(0, 10), LIMITS.breakerRearmSessions)}, o prima con bun run breaker-reset` };
  const day = lastEquity > 0 ? 1 - equity / lastEquity : 0;
  if (day >= LIMITS.maxDailyLossPct) return { file: f, newlyTripped, buyBlock: `perdita di oggi ${pct(day)} oltre il limite di ${pct(LIMITS.maxDailyLossPct)}: niente acquisti fino a domani` };
  return { file: f, newlyTripped, buyBlock: null };
}
