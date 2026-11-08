import { AGENTS, LIMITS } from "../config.ts";
import { momentum, sma } from "../indicators.ts";
import { addTradingDays } from "../slots.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// Orizzonte: a 20 sedute dall'ingresso il trade si rimette in discussione. Se il titolo ha perso slancio
// (sotto la media a 50 o momentum a 20 sedute negativo) chiede di uscire; altrimenti lascia che il trend
// lo tenga in portafoglio (il segnale di vendita è debole e il trend, se è ancora forte, lo supera).
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
      const gain = ((price / (t.costo / t.comprate) - 1) * 100).toFixed(1);
      segnali.push({
        agente: this.name,
        simbolo: t.simbolo,
        lato: "sell",
        forza: tired ? 0.8 : 0.4,
        orizzonteSedute: AGENTS.horizonSessions,
        perche: `${AGENTS.horizonSessions} sedute dall'ingresso (${t.apertoIl.slice(0, 10)}, ${gain}%): ${tired ? "slancio finito, si esce" : "ancora in trend, si tiene solo se il trend lo conferma"}`,
      });
    }
    return { segnali };
  }
}
