import { AGENTS } from "../config.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// Presa di profitto: chiede di vendere una posizione che ha raggiunto il guadagno obiettivo (di serie +2%).
// Opzionale: nel trend following taglia le corse buone, e il backtest misura quanto costa.
export class TakeProfitAgent implements Agent {
  readonly name = "profitto";
  constructor(private target = AGENTS.takeProfit.pct) {}

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    for (const p of v.positions) {
      if (p.qty <= 0 || p.avgEntryPrice <= 0) continue;
      const price = v.prices[p.symbol] ?? p.currentPrice;
      const gain = price / p.avgEntryPrice - 1;
      if (gain >= this.target) segnali.push({ agente: this.name, simbolo: p.symbol, lato: "sell", forza: 1, orizzonteSedute: 1, perche: `guadagno ${(gain * 100).toFixed(1)}% oltre l'obiettivo del ${(this.target * 100).toFixed(0)}%: si incassa` });
    }
    return { segnali };
  }
}
