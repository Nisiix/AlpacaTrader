import { AGENTS } from "../config.ts";
import { soloIntraday } from "./posizioni.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// Presa di profitto: vincolante, una volta per trade. Con frazione 1 chiude la posizione al guadagno obiettivo;
// con frazione 0,5 ne vende metà e lascia correre il resto con il trend (la tecnica classica per alzare la quota di
// trade vinti senza rinunciare alle corse lunghe).
export class TakeProfitAgent implements Agent {
  readonly name = "profitto";
  constructor(
    private target = AGENTS.takeProfit.pct,
    private fraction = AGENTS.takeProfit.fraction,
  ) {}

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    for (const p of v.positions) {
      if (p.qty <= 0 || p.avgEntryPrice <= 0) continue;
      const price = v.prices[p.symbol] ?? p.currentPrice;
      const gain = price / p.avgEntryPrice - 1;
      if (gain < this.target) continue;
      if (soloIntraday(v.journal, p.symbol)) continue; // l'intraday ha il suo obiettivo
      // Kronos anticipa altro rialzo: si lascia correre (se la proiezione gira, ci pensano la protezione del profitto e le uscite).
      const fc = v.previsioni?.[p.symbol];
      if (fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia) continue;
      const trade = v.journal.trade.find((t) => t.simbolo === p.symbol && t.stato === "aperto");
      // Già alleggerito una volta (quantità in mano sotto quella comprata): si lascia correre il resto.
      if (this.fraction < 1 && trade && trade.quantita < trade.comprate - 1e-9) continue;
      segnali.push({ agente: this.name, simbolo: p.symbol, lato: "sell", forza: 1, orizzonteSedute: 1, vincolante: true, frazione: this.fraction, perche: `guadagno ${(gain * 100).toFixed(1)}% oltre l'obiettivo del ${(this.target * 100).toFixed(0)}%: ${this.fraction < 1 ? `si incassa il ${(this.fraction * 100).toFixed(0)}% e il resto corre col trend` : "si incassa"}` });
    }
    return { segnali };
  }
}
