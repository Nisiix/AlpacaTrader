import { AGENTS } from "../config.ts";
import type { Trade } from "../journal.ts";

// Il coordinatore dell'apprendimento: una sola misura, prudente, per giudicare chi impara (calibrazione del capo,
// formazione in sala caffè, giudizi).
// - Finestra: contano solo gli ultimi `finestra` trade chiusi (gli errori vecchi escono di scena).
// - Campione minimo: `minTradePersona` per una persona, `minTradeSquadra` per una squadra. Con 5 trade una percentuale di
//   vittorie del 51% ha un margine di ±22 punti: non è un giudizio, è rumore.
// - Media con la squadra: la percentuale di vittorie di una persona si avvicina a quella della squadra in proporzione a
//   quanti pochi trade ha ((vinti + k × squadra) / (trade + k)).
// - Aspettativa: si guarda prima il guadagno medio per trade e il rapporto tra guadagni e perdite (profit factor); il 51%
//   di vittorie è un vincolo, non lo scopo (un 60% di vittorie con incassi piccoli e stop pieni perde soldi).
export interface Campione {
  n: number;
  vinti: number;
  q: number; // percentuale di vittorie grezza
  qS: number; // percentuale di vittorie con la media della squadra
  media: number; // guadagno medio per trade (frazione del capitale investito)
  pf: number | null; // profit factor: guadagni / perdite in dollari (null senza perdite)
  sufficiente: boolean;
}
const pnl = (t: Trade) => (t.incassato ?? 0) - (t.costo ?? 0);
export const tipoTrade = (t: Trade): "trading" | "intraday" => (t.contesto?.tipo ?? (t.contesto?.livelli ? "intraday" : "trading"));
export const ultimi = (ts: Trade[], n = AGENTS.apprendimento.finestra) => [...ts].sort((a, b) => (a.chiusoIl ?? "").localeCompare(b.chiusoIl ?? "")).slice(-n);

export function campione(ts: Trade[], squadra: Trade[] | null, minimo: number): Campione {
  const a = AGENTS.apprendimento;
  const w = ultimi(ts);
  const n = w.length;
  const vinti = w.filter((t) => pnl(t) > 0).length;
  const q = n ? vinti / n : 0;
  const sq = squadra ? ultimi(squadra) : null;
  const qSq = sq?.length ? sq.filter((t) => pnl(t) > 0).length / sq.length : AGENTS.calibrazione.obiettivo;
  const qS = squadra ? (vinti + a.forzaSquadra * qSq) / (n + a.forzaSquadra) : q;
  const media = n ? w.reduce((s, t) => s + pnl(t) / Math.max(t.costo, 1e-9), 0) / n : 0;
  const guadagni = w.filter((t) => pnl(t) > 0).reduce((s, t) => s + pnl(t), 0);
  const perdite = -w.filter((t) => pnl(t) <= 0).reduce((s, t) => s + pnl(t), 0);
  return { n, vinti, q, qS, media, pf: perdite > 0 ? guadagni / perdite : null, sufficiente: n >= minimo };
}

// Va reso più selettivo? (aspettativa negativa o vittorie sotto l'obiettivo). Può tornare verso la base? (aspettativa
// positiva e vittorie sopra la soglia buona). Le due soglie sono vicine: allentare è facile quanto stringere.
export const daStringere = (c: Campione) => c.sufficiente && (c.media < 0 || c.qS < AGENTS.calibrazione.obiettivo);
export const daAllentare = (c: Campione) => c.sufficiente && c.media > 0 && c.qS >= AGENTS.calibrazione.buono;
export const descrivi = (c: Campione) => `${c.vinti} vinti su ${c.n} (${Math.round(c.q * 100)}%${c.qS !== c.q ? `, ${Math.round(c.qS * 100)}% con la media della squadra` : ""}), guadagno medio ${(c.media * 100).toFixed(2)}% a trade${c.pf !== null ? `, profit factor ${c.pf.toFixed(2)}` : ""}`;
