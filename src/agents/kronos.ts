import { AGENTS, LIMITS } from "../config.ts";
import { sma } from "../indicators.ts";
import { controTendenza, pesoControTendenza } from "./fiducia.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// Kronos (modello per candele, tools/kronos/server.py) come agente: chiede al sidecar il rendimento previsto a
// `horizon` sedute per tutto l'universo e tiene solo le previsioni più nette (topShare), e solo se vanno nel verso
// del trend di lungo periodo. Zero-shot ha mostrato un filo di informazione soltanto così; senza sidecar tace.
export interface KronosForecast {
  simbolo: string;
  rendimentoPrevisto: number; // a `horizon` sedute
}

export class KronosAgent implements Agent {
  readonly name = "kronos";

  async observe(v: AgentView): Promise<AgentReport> {
    // Le proiezioni del giorno le calcola il motore (sidecar e cervello delle previsioni) e arrivano nella vista.
    const fc: KronosForecast[] = Object.entries(v.previsioni ?? {}).map(([simbolo, rendimentoPrevisto]) => ({ simbolo, rendimentoPrevisto }));
    if (!fc.length) return { segnali: [], note: [v.previsioni ? "nessuna proiezione per i titoli di oggi" : "nessuna proiezione: Kronos in avvio o non installato"] };
    // Le proiezioni assurde (oltre maxAbs) sono rumore: fuori. Rialzi e ribassi si classificano separatamente, così i
    // ribassi enormi di qualche piccola non nascondono i rialzi credibili.
    const sane = fc.filter((f) => Number.isFinite(f.rendimentoPrevisto) && Math.abs(f.rendimentoPrevisto) <= AGENTS.kronos.maxAbs);
    const scartate = fc.length - sane.length;
    // Il trend di lungo periodo (sopra la media a 200) si controlla prima di scegliere i più netti: altrimenti il posto
    // del migliore va sprecato su un titolo che poi non si può comprare e gli altri rialzi non vengono neanche guardati.
    const above200 = (s: string) => {
      const c = v.closes[s];
      const m200 = c ? sma(c, LIMITS.longSmaDays) : null;
      const price = v.prices[s] ?? c?.[c.length - 1];
      return m200 !== null && price !== undefined && price > m200;
    };
    // Sotto la 200 si vota solo con una proiezione netta e una probabilità di successo sufficiente (contro tendenza).
    const contro = (f: KronosForecast) => !above200(f.simbolo) && controTendenza(v.closes[f.simbolo], f.rendimentoPrevisto).ok;
    const ups = sane.filter((f) => f.rendimentoPrevisto >= AGENTS.kronos.anticipaSoglia && (above200(f.simbolo) || contro(f))).sort((a, b) => b.rendimentoPrevisto - a.rendimentoPrevisto);
    const upsAll = sane.filter((f) => f.rendimentoPrevisto >= AGENTS.kronos.anticipaSoglia).length;
    const downs = sane.filter((f) => f.rendimentoPrevisto <= -AGENTS.kronos.anticipaSoglia).sort((a, b) => a.rendimentoPrevisto - b.rendimentoPrevisto);
    const keepUp = Math.max(1, Math.round(ups.length * AGENTS.kronos.topShare));
    const keepDown = Math.max(1, Math.round(downs.length * AGENTS.kronos.topShare));
    const segnali: Signal[] = [];
    const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    for (const f of ups.slice(0, keepUp)) {
      if (contro(f)) {
        const ct = controTendenza(v.closes[f.simbolo], f.rendimentoPrevisto);
        segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "buy", forza: Math.min(0.8, 0.4 + f.rendimentoPrevisto * 5), orizzonteSedute: AGENTS.kronos.horizon, kronos: f.rendimentoPrevisto, pesoMassimo: pesoControTendenza(), perche: `contro tendenza: Kronos anticipa ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute sotto la media a 200, ${ct.motivo.replace(/^Kronos [^ ]+ /, "")}; taglia ridotta, si esce con lo stop o quando la proiezione gira` });
        continue;
      }
      // Rialzo anticipato con il trend di lungo periodo positivo (sopra la media a 200): la forza cresce con la proiezione.
      segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "buy", forza: Math.min(1, 0.5 + f.rendimentoPrevisto * 5), orizzonteSedute: AGENTS.kronos.horizon, kronos: f.rendimentoPrevisto, perche: `Kronos anticipa ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute, tra i rialzi più netti, con trend di lungo periodo positivo` });
    }
    for (const f of downs.slice(0, keepDown)) {
      if (held.has(f.simbolo)) segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "sell", forza: 0.5, orizzonteSedute: AGENTS.kronos.horizon, kronos: f.rendimentoPrevisto, perche: `Kronos anticipa ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute su un titolo in portafoglio` });
    }
    return { segnali, note: [`${sane.length} previsioni usabili${scartate ? ` (${scartate} scartate perché oltre ±${(AGENTS.kronos.maxAbs * 100).toFixed(0)}%)` : ""}, ${upsAll} rialzi (${ups.length} sopra la media a 200) e ${downs.length} ribassi oltre la soglia, votati ${segnali.length}`] };
  }
}
