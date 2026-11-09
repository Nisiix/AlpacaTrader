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

// Dove sta il prezzo rispetto alle medie giornaliere a 50 e 200: la scaletta della prudenza (AGENTS.prudenzaMedie).
export type LivelloMedie = "sopra" | "sotto50" | "sotto200" | "sottoEntrambe";
export function livelloMedie(closes: number[] | undefined, price: number | null | undefined): { livello: LivelloMedie; etichetta: string } | null {
  if (!closes || price === null || price === undefined || price <= 0) return null;
  const m50 = sma(closes, LIMITS.trendSmaDays), m200 = sma(closes, LIMITS.longSmaDays);
  if (m50 === null || m200 === null) return null;
  const s50 = price < m50, s200 = price <= m200;
  const livello: LivelloMedie = s50 && s200 ? "sottoEntrambe" : s200 ? "sotto200" : s50 ? "sotto50" : "sopra";
  const etichetta = { sopra: `sopra le medie a ${LIMITS.trendSmaDays} e ${LIMITS.longSmaDays}`, sotto50: `sotto la media a ${LIMITS.trendSmaDays} (sopra la ${LIMITS.longSmaDays})`, sotto200: `sotto la media a ${LIMITS.longSmaDays} (sopra la ${LIMITS.trendSmaDays})`, sottoEntrambe: `sotto le medie a ${LIMITS.trendSmaDays} e ${LIMITS.longSmaDays}` }[livello];
  return { livello, etichetta };
}

// Rimbalzo di breve (media a 50 facoltativa): prezzo sotto la media a 50 giorni e un calo netto improvviso: nell'ultimo
// giorno (la giornata conclusa o quella in corso, oltre caloMin o caloVol × volatilità giornaliera), negli ultimi
// `giorni` giorni (soglia × fattoreGiorni) o nelle ultime `ore` ore (dal massimo delle candele da 1 ora, se ci sono).
// È solo la premessa: se e quando entrare, l'obiettivo e la durata li decidono le candele brevi e Kronos su quelle
// candele (intraday agents).
export function caloNetto(simbolo: string, closes: number[] | undefined, price: number | null | undefined, orarie?: number[]): { ok: boolean; calo: number | null; soglia: number | null; quando: string | null } {
  const r = AGENTS.rimbalzo;
  const no = { ok: false, calo: null, soglia: null, quando: null };
  if (!r.enabled || !closes || closes.length < LIMITS.trendSmaDays + r.giorni + 1 || price === null || price === undefined || price <= 0) return no;
  const m50 = sma(closes, LIMITS.trendSmaDays);
  if (m50 === null || price >= m50) return no;
  const ieri = closes.at(-1)!, prima = closes.at(-2)!;
  const vol = dailyVol(closes, LIMITS.volLookbackDays) ?? LIMITS.fallbackDailyVol;
  const soglia = Math.max(isCrypto(simbolo) ? r.caloMin.crypto : r.caloMin.stocks, r.caloVol * vol);
  const giorno = Math.min(prima > 0 ? ieri / prima - 1 : 0, ieri > 0 ? price / ieri - 1 : 0);
  if (giorno <= -soglia) return { ok: true, calo: giorno, soglia, quando: "nell'ultimo giorno" };
  const base = closes.at(-1 - r.giorni)!;
  const giorni = base > 0 ? price / base - 1 : 0;
  if (giorni <= -soglia * r.fattoreGiorni) return { ok: true, calo: giorni, soglia: soglia * r.fattoreGiorni, quando: `negli ultimi ${r.giorni} giorni` };
  const alto = orarie?.length ? Math.max(...orarie.slice(-r.ore)) : null;
  const ore = alto && alto > 0 ? price / alto - 1 : 0;
  if (ore <= -soglia) return { ok: true, calo: ore, soglia, quando: `nelle ultime ${r.ore} ore` };
  return { ok: false, calo: giorno, soglia, quando: null };
}

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
