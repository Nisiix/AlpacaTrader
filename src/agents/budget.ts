import { AGENTS } from "../config.ts";
import type { Position } from "../broker/types.ts";

// Guadagni non ancora incassati delle posizioni aperte (solo quelle in guadagno): non sono ancora profitto da reinvestire.
export const guadagniAperti = (positions: Position[], prices: Record<string, number> = {}) =>
  positions.reduce((a, p) => a + Math.max(0, ((prices[p.symbol] ?? p.currentPrice) - p.avgEntryPrice) * p.qty), 0);

// Budget dell'intraday con il profitto reinvestito (intraday.budget.reinvesti).
// Sul capitale di partenza vale la quota di serie (50%); il profitto accumulato da allora si aggiunge al budget per la
// parte `reinvesti.quota` (1 = tutto), fino a `reinvesti.tetto` del conto. Profitto accumulato = patrimonio meno i
// guadagni non ancora incassati delle posizioni aperte (le perdite aperte invece contano), meno il capitale di partenza:
// un guadagno che può ancora sparire non allarga il budget. Sotto il capitale di partenza resta la quota del conto.
// Esempio, partenza 1000 $, quota 50%: a 1000 $ budget 500 $; a 1100 $ incassati budget 500 + 100 = 600 $ (54,5% del
// conto); a 900 $ budget 450 $. Restituisce la quota del conto (0–1) e il profitto reinvestito in dollari.
export function quotaBudget(equity: number, capitaleBase: number | undefined, quota: number = AGENTS.intraday.budget.quota, nonIncassato = 0): { quota: number; reinvestito: number } {
  const r = AGENTS.intraday.budget.reinvesti;
  if (!r.enabled || !capitaleBase || capitaleBase <= 0 || !(equity > 0)) return { quota, reinvestito: 0 };
  const profitto = Math.max(0, equity - Math.max(0, nonIncassato) - capitaleBase);
  const q = Math.max(quota, Math.min(r.tetto, (quota * Math.min(equity, capitaleBase) + profitto * r.quota) / equity));
  return { quota: q, reinvestito: Math.max(0, q * equity - quota * Math.min(equity, capitaleBase)) };
}
