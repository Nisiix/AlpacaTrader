import { AGENTS, LIMITS, UNIVERSE } from "../config.ts";
import { sma } from "../indicators.ts";
import { type Agent, type AgentReport, type AgentView, type Signal } from "./types.ts";

// Rientro sul trend: un titolo sopra la media a 200 giorni che dopo una corsa torna vicino alla media a 50.
// Compra "sul ritracciamento" invece che sui massimi: è il complemento del trend puro.
export class PullbackAgent implements Agent {
  readonly name = "rientro";

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    const { nearPct, runUpPct, lookback } = AGENTS.pullback;
    for (const s of UNIVERSE) {
      const c = v.closes[s];
      if (!c || c.length < LIMITS.longSmaDays + lookback) continue;
      const m50 = sma(c, LIMITS.trendSmaDays);
      const m200 = sma(c, LIMITS.longSmaDays);
      const price = v.prices[s] ?? c[c.length - 1]!;
      if (m50 === null || m200 === null || price <= m200) continue;
      const near = price >= m50 && price <= m50 * (1 + nearPct);
      if (!near) continue;
      // Nelle ultime `lookback` sedute il titolo doveva essere ben sopra la sua media a 50 di allora.
      let ranUp = false;
      for (let i = c.length - lookback; i < c.length; i++) {
        const mm = sma(c.slice(0, i + 1), LIMITS.trendSmaDays);
        if (mm !== null && c[i]! >= mm * (1 + runUpPct)) {
          ranUp = true;
          break;
        }
      }
      if (!ranUp) continue;
      const dist = price / m50 - 1;
      segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza: 0.7, orizzonteSedute: AGENTS.horizonSessions, perche: `sopra la media a 200, tornato a ${(dist * 100).toFixed(1)}% dalla media a 50 dopo una corsa di almeno il ${runUpPct * 100}%` });
    }
    return { segnali };
  }
}
