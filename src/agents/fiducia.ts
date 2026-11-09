import { AGENTS, LIMITS, isCrypto } from "../config.ts";
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

// Rimbalzo di breve (media a 50 facoltativa): prezzo sotto la media a 50, calo netto nell'ultimo giorno (la giornata
// conclusa o quella in corso, oltre caloMin o caloVol × volatilità giornaliera) e Kronos che anticipa un rialzo
// temporaneo di almeno minRendimento con probabilità di successo ≥ minFiducia. L'obiettivo è il rialzo previsto.
export function rimbalzo(simbolo: string, closes: number[] | undefined, price: number | null | undefined, fc: number | undefined): { ok: boolean; p: number | null; calo: number | null; obiettivo: number | null; motivo: string } {
  const r = AGENTS.rimbalzo;
  const no = (motivo: string, p: number | null = null, calo: number | null = null) => ({ ok: false, p, calo, obiettivo: null, motivo });
  if (!r.enabled) return no("rimbalzi spenti");
  if (!closes || closes.length < LIMITS.trendSmaDays + 2 || price === null || price === undefined || price <= 0) return no("dati insufficienti");
  const m50 = sma(closes, LIMITS.trendSmaDays);
  if (m50 === null || price >= m50) return no("sopra la media a 50: vale il trend");
  const ieri = closes.at(-1)!, prima = closes.at(-2)!;
  const calo = Math.min(prima > 0 ? ieri / prima - 1 : 0, ieri > 0 ? price / ieri - 1 : 0);
  const crypto = isCrypto(simbolo);
  const vol = dailyVol(closes, LIMITS.volLookbackDays) ?? LIMITS.fallbackDailyVol;
  const soglia = Math.max(crypto ? r.caloMin.crypto : r.caloMin.stocks, r.caloVol * vol);
  const p = kronosProb(closes, fc);
  const pp = p === null ? "n.d." : `${Math.round(p * 100)}%`;
  const f = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  if (calo > -soglia) return no(`nessun calo netto nell'ultimo giorno (${f(calo)}, serve oltre ${f(-soglia)})`, p, calo);
  if (fc === undefined) return no("nessuna proiezione di Kronos", p, calo);
  if (Math.abs(fc) > AGENTS.kronos.maxAbs) return no("proiezione fuori misura", p, calo);
  const minR = crypto ? r.minRendimento.crypto : r.minRendimento.stocks;
  if (fc < minR) return no(`calo del ${f(calo)} ma Kronos ${f(fc)} sotto il minimo per il rimbalzo (${f(minR)})`, p, calo);
  if (p === null || p < r.minFiducia) return no(`calo del ${f(calo)}, Kronos ${f(fc)} ma probabilità di successo ${pp} sotto il minimo (${Math.round(r.minFiducia * 100)}%)`, p, calo);
  return { ok: true, p, calo, obiettivo: fc, motivo: `calo del ${f(calo)} nell'ultimo giorno e Kronos anticipa ${f(fc)} a ${AGENTS.kronos.horizon} sedute con probabilità di successo ${pp}` };
}

// Il peso massimo di un rimbalzo di breve.
export const pesoRimbalzo = () => LIMITS.maxPositionPct * AGENTS.rimbalzo.pesoFattore;

export const sotto200 = (closes: number[] | undefined, price: number | undefined) => {
  if (!closes || price === undefined) return false;
  const m = sma(closes, LIMITS.longSmaDays);
  return m !== null && price <= m;
};

// Il peso massimo di un ingresso contro tendenza.
export const pesoControTendenza = () => LIMITS.maxPositionPct * AGENTS.kronos.controTendenza.pesoFattore;

// Anche entro ±maxAbs una proiezione può essere fuori misura per quel titolo: −20% in 5 sedute su Visa (volatilità
// giornaliera 1,3%) sono quasi 7 deviazioni standard. Oltre kronos.zMax volte la volatilità sull'orizzonte è rumore.
export function plausibile(f: number, closes: number[] | undefined): boolean {
  if (!Number.isFinite(f) || Math.abs(f) > AGENTS.kronos.maxAbs) return false;
  const vol = closes && closes.length > 21 ? dailyVol(closes, LIMITS.volLookbackDays) : null;
  return vol === null || vol <= 0 || Math.abs(f) / (vol * Math.sqrt(AGENTS.kronos.horizon)) <= AGENTS.kronos.zMax;
}
