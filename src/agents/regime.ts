import { AGENTS, LIMITS } from "../config.ts";
import { dailyVol, sma } from "../indicators.ts";
import type { Agent, AgentReport, AgentView } from "./types.ts";

// Regime di mercato: non dà segnali, dice quanto rischio è ammesso. SPY sotto la media a 200 giorni dimezza
// l'esposizione; volatilità giornaliera alta la dimezza ancora. È il sostituto "morbido" dell'interruttore.
// Una classe di attivi: sotto la media a 200 giorni l'esposizione si dimezza; con volatilità alta si dimezza ancora.
function regimeDi(c: number[] | undefined, price: number | undefined, nome: string, highVol: number): { rischio: number; note: string[] } {
  const note: string[] = [];
  let rischio = 1;
  if (!c || c.length < LIMITS.longSmaDays + 1) return { rischio, note: [`storico di ${nome} insufficiente: regime neutro`] };
  const m200 = sma(c, LIMITS.longSmaDays)!;
  const p = price ?? c[c.length - 1]!;
  if (p < m200) {
    rischio *= AGENTS.regime.bearScale;
    note.push(`${nome} ${p.toFixed(2)} sotto la media a 200 giorni (${m200.toFixed(2)}): mercato debole, esposizione × ${AGENTS.regime.bearScale}`);
  } else note.push(`${nome} sopra la media a 200 giorni (${m200.toFixed(2)}): mercato in salita`);
  const vol = dailyVol(c, LIMITS.volLookbackDays);
  if (vol !== null && vol >= highVol) {
    rischio *= AGENTS.regime.highVolScale;
    note.push(`volatilità giornaliera di ${nome} ${(vol * 100).toFixed(2)}% oltre ${(highVol * 100).toFixed(1)}%: esposizione × ${AGENTS.regime.highVolScale}`);
  }
  return { rischio, note };
}

// Regime di mercato: non dà segnali, dice quanto rischio è ammesso, per classe: le azioni dallo SPY, le crypto dal BTC
// (un mercato azionario debole non dice niente sulle crypto, e viceversa).
export class RegimeAgent implements Agent {
  readonly name = "regime";

  observe(v: AgentView): AgentReport {
    const az = regimeDi(v.closes.SPY, v.prices.SPY, "SPY", AGENTS.regime.highVolDaily);
    const cr = regimeDi(v.closes["BTC/USD"], v.prices["BTC/USD"], "BTC", AGENTS.regime.highVolCrypto);
    const crypto = v.closes["BTC/USD"] ? cr : az;
    return { segnali: [], rischio: az.rischio, rischioCrypto: crypto.rischio, note: [...az.note, ...(v.closes["BTC/USD"] ? cr.note.map((n) => `crypto: ${n}`) : [])] };
  }
}
