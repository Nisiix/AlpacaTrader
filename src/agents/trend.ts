import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { momentum, trendOf } from "../indicators.ts";
import { clamp01, type Agent, type AgentReport, type AgentView, type Signal } from "./types.ts";

// Il metodo dichiarato, come agente: compra chi chiude sopra le medie a 50 e 200 giorni, più forte chi ha
// più momentum a 6 mesi; chiede di vendere chi ha chiuso sotto la 50. Orizzonte 20 sedute. Medie e finestre sono regole
// del motore, uguali per tutti (Impostazioni → Generali → Trend).
export class TrendAgent implements Agent {
  readonly name = "trend";

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    const candidates: { s: string; mom: number; breve: number; lunga: number }[] = [];
    const filtered: string[] = [];
    // Si compra solo nell'universo degli agenti; si sorveglia anche ciò che è in portafoglio da prima (es. IWM, TLT).
    for (const s of new Set([...AGENTS.universe, ...held])) {
      const c = v.closes[s];
      const breve = LIMITS.trendSmaDays, lunga = LIMITS.longSmaDays;
      const t = trendOf(c, breve, lunga);
      if (!c || t === null) continue;
      if (t.close > t.sma && t.close > t.long && (v.prices[s] ?? t.close) > t.sma) {
        if (!AGENTS.universe.includes(s)) continue;
        // Momentum assoluto: rendimento a 12 mesi positivo, altrimenti liquidità. Crypto: anche a 3 mesi.
        const abs = momentum(c, AGENTS.absMomentum.days);
        if (abs === null || abs <= AGENTS.absMomentum.min) {
          filtered.push(`${s} (12 mesi ${abs === null ? "n.d." : `${(abs * 100).toFixed(0)}%`})`);
          continue;
        }
        if (isCrypto(s) && (momentum(c, AGENTS.cryptoMomentumDays) ?? -1) <= 0) {
          filtered.push(`${s} (3 mesi negativi)`);
          continue;
        }
        candidates.push({ s, mom: momentum(c, LIMITS.rankMomentumDays) ?? 0, breve, lunga });
      }
      else if (held.has(s) && t.close < t.sma) {
        // Kronos anticipa ancora un rialzo: la posizione si tiene (lo stop resta), il trend aspetta.
        const fc = v.previsioni?.[s];
        if (fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia) continue;
        segnali.push({ agente: this.name, simbolo: s, lato: "sell", forza: 1, orizzonteSedute: AGENTS.horizonSessions, perche: `chiusura ${t.close.toFixed(2)} sotto la media a ${breve} giorni (${t.sma.toFixed(2)}): il trend è finito` });
      }
    }
    candidates.sort((a, b) => b.mom - a.mom);
    const top = candidates.slice(0, LIMITS.maxPositions);
    top.forEach(({ s, mom, breve, lunga }, i) => {
      // Il primo in classifica vale 1, l'ultimo 0,5; con momentum negativo si scende ancora.
      const rank = top.length > 1 ? 1 - (0.5 * i) / (top.length - 1) : 1;
      const forza = clamp01(rank * (mom >= 0 ? 1 : 0.6));
      segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza, orizzonteSedute: AGENTS.horizonSessions, perche: `sopra le medie a ${breve} e ${lunga} giorni, momentum a 6 mesi ${(mom * 100).toFixed(1)}% (${i + 1}° su ${candidates.length})` });
    });
    return { segnali, note: [`${candidates.length} titoli in trend su ${AGENTS.universe.length}${filtered.length ? ` · fermati dal momentum assoluto: ${filtered.join(", ")}` : ""}`] };
  }
}
