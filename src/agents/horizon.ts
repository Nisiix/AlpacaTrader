import { AGENTS, LIMITS } from "../config.ts";
import { momentum, sma } from "../indicators.ts";
import { addTradingDays } from "../slots.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// Orizzonte: a horizonSessions sedute dall'ingresso (un trimestre) il trade si rimette in discussione. Se il titolo ha
// perso slancio (sotto la media a 50 o momentum a 20 sedute negativo) chiede di uscire; se il trend regge non dice niente
// e il titolo resta finché dura (la letteratura sul momentum: continuazione da 1 a 12 mesi).
export class HorizonAgent implements Agent {
  readonly name = "orizzonte";

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    for (const t of v.journal.trade) {
      if (t.stato !== "aperto") continue;
      const held = v.positions.find((p) => p.symbol === t.simbolo && p.qty > 0);
      if (!held) continue;
      const due = addTradingDays(t.apertoIl.slice(0, 10), AGENTS.horizonSessions);
      if (v.today < due) continue;
      const c = v.closes[t.simbolo];
      const m50 = c ? sma(c, LIMITS.trendSmaDays) : null;
      const mom = c ? momentum(c, 20) : null;
      const price = v.prices[t.simbolo] ?? held.currentPrice;
      const tired = (m50 !== null && price < m50) || (mom !== null && mom < 0);
      if (!tired) continue;
      const gain = ((price / (t.costo / t.comprate) - 1) * 100).toFixed(1);
      segnali.push({ agente: this.name, simbolo: t.simbolo, lato: "sell", forza: 0.8, orizzonteSedute: AGENTS.horizonSessions, perche: `${AGENTS.horizonSessions} sedute dall'ingresso (${t.apertoIl.slice(0, 10)}, ${gain}%) e slancio finito: si esce` });
    }
    return { segnali };
  }
}
