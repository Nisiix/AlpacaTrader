import { AGENTS, LIMITS, UNIVERSE } from "../config.ts";
import { momentum, trendOf } from "../indicators.ts";
import { clamp01, type Agent, type AgentReport, type AgentView, type Signal } from "./types.ts";

// Il metodo dichiarato, come agente: compra chi chiude sopra le medie a 50 e 200 giorni, più forte chi ha
// più momentum a 6 mesi; chiede di vendere chi ha chiuso sotto la 50. Orizzonte 20 sedute.
export class TrendAgent implements Agent {
  readonly name = "trend";

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    const candidates: { s: string; mom: number }[] = [];
    for (const s of UNIVERSE) {
      const c = v.closes[s];
      const t = trendOf(c, LIMITS.trendSmaDays, LIMITS.longSmaDays);
      if (!c || t === null) continue;
      if (t.close > t.sma && t.close > t.long && (v.prices[s] ?? t.close) > t.sma) candidates.push({ s, mom: momentum(c, LIMITS.rankMomentumDays) ?? 0 });
      else if (held.has(s) && t.close < t.sma) segnali.push({ agente: this.name, simbolo: s, lato: "sell", forza: 1, orizzonteSedute: AGENTS.horizonSessions, perche: `chiusura ${t.close.toFixed(2)} sotto la media a ${LIMITS.trendSmaDays} giorni (${t.sma.toFixed(2)}): il trend è finito` });
    }
    candidates.sort((a, b) => b.mom - a.mom);
    const top = candidates.slice(0, LIMITS.maxPositions);
    top.forEach(({ s, mom }, i) => {
      // Il primo in classifica vale 1, l'ultimo 0,5; con momentum negativo si scende ancora.
      const rank = top.length > 1 ? 1 - (0.5 * i) / (top.length - 1) : 1;
      const forza = clamp01(rank * (mom >= 0 ? 1 : 0.6));
      segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza, orizzonteSedute: AGENTS.horizonSessions, perche: `sopra le medie a ${LIMITS.trendSmaDays} e ${LIMITS.longSmaDays} giorni, momentum a 6 mesi ${(mom * 100).toFixed(1)}% (${i + 1}° su ${candidates.length})` });
    });
    return { segnali, note: [`${candidates.length} titoli in trend su ${UNIVERSE.length}`] };
  }
}
