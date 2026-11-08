import { AGENTS, LIMITS } from "../config.ts";
import { dailyVol, sma } from "../indicators.ts";

// La fiducia nella proiezione di Kronos: P(rendimento > 0 a fine orizzonte) = Φ(atteso / (volatilità × √orizzonte)).
// Un +4% su un titolo che si muove del 5% al giorno vale meno di un +4% su uno che si muove dell'1%.
export function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function kronosProb(closes: number[] | undefined, fc: number | undefined): number | null {
  if (fc === undefined || !closes) return null;
  const vol = dailyVol(closes, LIMITS.volLookbackDays);
  if (vol === null || vol <= 0) return null;
  const z = fc / (vol * Math.sqrt(AGENTS.kronos.horizon));
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Ingresso contro tendenza (sotto la media a 200): ammesso solo se Kronos è netto (≥ minRendimento), la proiezione non è
// fuori misura e la probabilità di successo è almeno minFiducia. Taglia ridotta (pesoFattore del peso massimo) e uscite
// con i criteri di sempre: stop sulla volatilità, si tiene finché Kronos vede il rialzo, si esce quando la proiezione gira.
export function controTendenza(closes: number[] | undefined, fc: number | undefined): { ok: boolean; p: number | null; motivo: string } {
  const c = AGENTS.kronos.controTendenza;
  const p = kronosProb(closes, fc);
  const pp = p === null ? "n.d." : `${Math.round(p * 100)}%`;
  if (!c.enabled) return { ok: false, p, motivo: "ingressi contro tendenza spenti" };
  if (fc === undefined) return { ok: false, p, motivo: "nessuna proiezione" };
  if (Math.abs(fc) > AGENTS.kronos.maxAbs) return { ok: false, p, motivo: "proiezione fuori misura" };
  if (fc < c.minRendimento) return { ok: false, p, motivo: `Kronos ${(fc * 100).toFixed(1)}% sotto il minimo per andare contro tendenza (${(c.minRendimento * 100).toFixed(1)}%)` };
  if (p === null || p < c.minFiducia) return { ok: false, p, motivo: `probabilità di successo ${pp} sotto il minimo (${Math.round(c.minFiducia * 100)}%)` };
  return { ok: true, p, motivo: `Kronos ${fc >= 0 ? "+" : ""}${(fc * 100).toFixed(1)}% con probabilità di successo ${pp}` };
}

export const sotto200 = (closes: number[] | undefined, price: number | undefined) => {
  if (!closes || price === undefined) return false;
  const m = sma(closes, LIMITS.longSmaDays);
  return m !== null && price <= m;
};

// Il peso massimo di un ingresso contro tendenza.
export const pesoControTendenza = () => LIMITS.maxPositionPct * AGENTS.kronos.controTendenza.pesoFattore;
