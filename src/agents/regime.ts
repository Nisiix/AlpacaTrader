import { AGENTS, LIMITS } from "../config.ts";
import { dailyVol, sma } from "../indicators.ts";
import type { Agent, AgentReport, AgentView } from "./types.ts";

// Regime di mercato: non dà segnali, dice quanto rischio è ammesso. SPY sotto la media a 200 giorni dimezza
// l'esposizione; volatilità giornaliera alta la dimezza ancora. È il sostituto "morbido" dell'interruttore.
export class RegimeAgent implements Agent {
  readonly name = "regime";

  observe(v: AgentView): AgentReport {
    const c = v.closes.SPY;
    const note: string[] = [];
    let rischio = 1;
    if (!c || c.length < LIMITS.longSmaDays + 1) return { segnali: [], rischio, note: ["storico di SPY insufficiente: regime neutro"] };
    const m200 = sma(c, LIMITS.longSmaDays)!;
    const price = v.prices.SPY ?? c[c.length - 1]!;
    if (price < m200) {
      rischio *= AGENTS.regime.bearScale;
      note.push(`SPY ${price.toFixed(2)} sotto la media a 200 giorni (${m200.toFixed(2)}): mercato debole, esposizione × ${AGENTS.regime.bearScale}`);
    } else note.push(`SPY sopra la media a 200 giorni (${m200.toFixed(2)}): mercato in salita`);
    const vol = dailyVol(c, LIMITS.volLookbackDays);
    if (vol !== null && vol >= AGENTS.regime.highVolDaily) {
      rischio *= AGENTS.regime.highVolScale;
      note.push(`volatilità giornaliera di SPY ${(vol * 100).toFixed(2)}% oltre ${AGENTS.regime.highVolDaily * 100}%: esposizione × ${AGENTS.regime.highVolScale}`);
    }
    return { segnali: [], rischio, note };
  }
}
