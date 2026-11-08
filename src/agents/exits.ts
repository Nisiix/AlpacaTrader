import { AGENTS, LIMITS } from "../config.ts";
import { dailyVol } from "../indicators.ts";
import { stopPctFor } from "../stops.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

export interface ExitPolicy {
  mode: "trend" | "obiettivo";
  stopMode: "volatilita" | "fisso";
  trailAtr: number; // modalità trend: stop che segue il massimo a trailAtr × ATR
  stopPct: number; // perdita massima dal carico (stopMode fisso)
  targetPct: number; // guadagno a cui si incassa, se la proiezione non dice di continuare
  targetBySymbol?: Record<string, number>; // obiettivi diversi per titolo (dove le barriere pagano di più)
  giveBackPct: number; // quanto può restituire dal massimo chi continua
  lockPct: number; // sotto carico + lockPct non si scende più, una volta oltre l'obiettivo
}

// Le regole di uscita del conto, come agente con segnali vincolanti. La proiezione (Kronos, se c'è) decide solo
// se oltre l'obiettivo si incassa o si lascia correre con lo stop che segue; con proiezione negativa si esce subito.
export class ExitAgent implements Agent {
  readonly name = "uscite";
  constructor(private policy: ExitPolicy = AGENTS.exit) {}

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    const { giveBackPct, lockPct } = this.policy;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    for (const p of v.positions) {
      if (p.qty <= 0 || p.avgEntryPrice <= 0) continue;
      const price = v.prices[p.symbol] ?? p.currentPrice;
      const gain = price / p.avgEntryPrice - 1;
      const trade = v.journal.trade.find((t) => t.simbolo === p.symbol && t.stato === "aperto");
      const peak = Math.max(trade?.massimo ?? 0, price, p.avgEntryPrice);
      const forecast = v.previsioni?.[p.symbol];
      const sell = (perche: string) => segnali.push({ agente: this.name, simbolo: p.symbol, lato: "sell", forza: 1, orizzonteSedute: 0, perche, vincolante: true });
      // Il rientro ha le sue uscite brevi: qui restano solo lo stop e la proiezione.
      const soloRientro = trade?.contesto?.agenti?.length === 1 && trade.contesto.agenti[0] === "rientro";
      const stopPct = this.policy.stopMode === "fisso" ? this.policy.stopPct : stopPctFor(v.closes[p.symbol]);
      if (gain <= -stopPct) {
        sell(`perdita ${pct(gain)} oltre lo stop del ${pct(stopPct)}${this.policy.stopMode === "fisso" ? "" : " (scalato sulla volatilità)"}`);
        continue;
      }
      if (forecast !== undefined && forecast < 0) {
        sell(`proiezione negativa (${pct(forecast)}) su un titolo in portafoglio: si esce ${gain >= 0 ? "in guadagno" : "limitando la perdita"} (${pct(gain)})`);
        continue;
      }
      if (soloRientro) continue;
      if (this.policy.mode === "trend") {
        // Si lascia correre: l'uscita normale è quella di trend della gabbia. Con trailAtr > 0 si esce anche se dal massimo
        // il prezzo torna indietro di trailAtr × ATR (ATR ≈ prezzo × volatilità).
        if (this.policy.trailAtr <= 0) continue;
        const vol = (v.closes[p.symbol] ? dailyVol(v.closes[p.symbol]!, LIMITS.volLookbackDays) : null) ?? LIMITS.fallbackDailyVol;
        const trail = Math.min(0.25, this.policy.trailAtr * vol);
        if (peak > p.avgEntryPrice && price <= peak * (1 - trail)) sell(`dal massimo ${peak.toFixed(2)} il prezzo è sceso del ${pct(1 - price / peak)} (oltre ${this.policy.trailAtr} ATR = ${pct(trail)}): il trend si è girato, si esce a ${pct(gain)}`);
        continue;
      }
      const targetPct = this.policy.targetBySymbol?.[p.symbol] ?? this.policy.targetPct;
      const peakGain = peak / p.avgEntryPrice - 1;
      if (peakGain < targetPct) continue; // sotto l'obiettivo decide il resto del motore (trend, orizzonte, stop)
      const expectsMore = forecast !== undefined && forecast > 0;
      if (!expectsMore) {
        sell(`guadagno ${pct(gain)} oltre l'obiettivo del ${pct(targetPct)} e nessuna proiezione di ulteriore rialzo: si incassa`);
        continue;
      }
      const floor = Math.max(p.avgEntryPrice * (1 + lockPct), peak * (1 - giveBackPct));
      if (price <= floor) sell(`dal massimo ${peak.toFixed(2)} il prezzo è tornato a ${price.toFixed(2)}: si incassa ${pct(gain)} prima di restituire più del ${pct(giveBackPct)}`);
    }
    const targets = Object.entries(this.policy.targetBySymbol ?? {}).map(([k, t]) => `${k} ${pct(t)}`).join(", ");
    const stopNote = this.policy.stopMode === "fisso" ? `stop ${pct(this.policy.stopPct)}` : `stop sulla volatilità (${pct(LIMITS.stop.minPct)}-${pct(LIMITS.stop.maxPct)})`;
    const exitNote = this.policy.mode === "trend" ? (this.policy.trailAtr > 0 ? `uscita anche a ${this.policy.trailAtr} ATR dal massimo` : "nessun obiettivo: esce il trend della gabbia") : `obiettivo ${pct(this.policy.targetPct)}${targets ? ` (${targets})` : ""}, restituzione massima ${pct(giveBackPct)}`;
    return { segnali, note: segnali.length ? undefined : [`${stopNote}, ${exitNote}`] };
  }
}
