import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { rsi, sma } from "../indicators.ts";
import { addTradingDays } from "../slots.ts";
import { type Agent, type AgentReport, type AgentView, type Signal } from "./types.ts";

// Rientro = mean reversion di Connors, come comparto separato a breve orizzonte: compra un titolo sopra la media a 200
// quando l'RSI(2) scende sotto 10 (ipervenduto di breve), con taglia piccola; esce quando l'RSI(2) torna sopra 70 o
// dopo maxHoldSessions sedute. Gli obiettivi brevi stanno bene qui, non sul trend.
// Le chiusure sono solo giornate concluse: la giornata in corso si aggiunge con il prezzo di adesso (le crypto sempre, i
// titoli a borsa aperta). A borsa chiusa il prezzo è quello dell'ultima chiusura, che c'è già.
const conAdesso = (c: number[], price: number, v: AgentView, s: string) => (isCrypto(s) || v.mercatoAperto !== false ? [...c, price] : c);

export class PullbackAgent implements Agent {
  readonly name = "rientro";

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    const { rsiDays, rsiEntry, rsiExit, maxHoldSessions, maxWeight } = AGENTS.pullback;
    const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    for (const s of AGENTS.universe) {
      if (held.has(s)) continue;
      const c = v.closes[s];
      if (!c || c.length < LIMITS.longSmaDays + 1) continue;
      const m200 = sma(c, LIMITS.longSmaDays);
      const price = v.prices[s] ?? c[c.length - 1]!;
      const r = rsi(conAdesso(c, price, v, s), rsiDays);
      if (m200 === null || r === null || price <= m200 || r >= rsiEntry) continue;
      segnali.push({ agente: this.name, simbolo: s, lato: "buy", forza: 0.7, orizzonteSedute: maxHoldSessions, pesoMassimo: maxWeight, perche: `RSI(${rsiDays}) a ${r.toFixed(0)} sopra la media a 200: ipervenduto di breve, rientro con taglia ridotta` });
    }
    // Le uscite valgono solo per i trade aperti dal rientro da solo: quelli del trend li gestisce il trend.
    for (const t of v.journal.trade) {
      if (t.stato !== "aperto" || !held.has(t.simbolo)) continue;
      const agenti = t.contesto?.agenti ?? [];
      if (agenti.length !== 1 || agenti[0] !== this.name) continue;
      const c = v.closes[t.simbolo];
      const price = v.prices[t.simbolo] ?? c?.[c.length - 1];
      const r = c && price ? rsi(conAdesso(c, price, v, t.simbolo), rsiDays) : null;
      const due = addTradingDays(t.apertoIl.slice(0, 10), maxHoldSessions);
      if (r !== null && r >= rsiExit) segnali.push({ agente: this.name, simbolo: t.simbolo, lato: "sell", forza: 1, orizzonteSedute: 0, vincolante: true, perche: `RSI(${rsiDays}) a ${r.toFixed(0)}: il rientro ha fatto il suo lavoro` });
      else if (v.today >= due) segnali.push({ agente: this.name, simbolo: t.simbolo, lato: "sell", forza: 1, orizzonteSedute: 0, vincolante: true, perche: `${maxHoldSessions} sedute dal rientro senza RSI sopra ${rsiExit}: si esce` });
    }
    return { segnali };
  }
}
