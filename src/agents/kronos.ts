import { AGENTS, LIMITS } from "../config.ts";
import { sma } from "../indicators.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// Kronos (modello per candele, tools/kronos/server.py) come agente: chiede al sidecar il rendimento previsto a
// `horizon` sedute per tutto l'universo e tiene solo le previsioni più nette (topShare), e solo se vanno nel verso
// del trend di lungo periodo. Zero-shot ha mostrato un filo di informazione soltanto così; senza sidecar tace.
export interface KronosForecast {
  simbolo: string;
  rendimentoPrevisto: number; // a `horizon` sedute
}

export type Fetcher = (symbols: string[], horizon: number) => Promise<KronosForecast[]>;

// Per il motore: le proiezioni come mappa simbolo → rendimento previsto, da passare alla vista degli agenti.
export function forecasterFor(url: string): (symbols: string[]) => Promise<Record<string, number>> {
  const f = httpFetcher(url);
  return async (symbols) => Object.fromEntries((await f(symbols, AGENTS.kronos.horizon)).map((x) => [x.simbolo, x.rendimentoPrevisto]));
}

export function httpFetcher(url: string): Fetcher {
  return async (symbols, horizon) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/forecast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols, horizon }),
      signal: AbortSignal.timeout(AGENTS.kronos.timeoutMs),
    });
    if (!res.ok) throw new Error(`Kronos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { forecasts: Record<string, { pred_ret: number }> };
    return Object.entries(data.forecasts ?? {}).map(([simbolo, f]) => ({ simbolo, rendimentoPrevisto: Number(f.pred_ret) }));
  };
}

export class KronosAgent implements Agent {
  readonly name = "kronos";
  constructor(private fetcher: Fetcher) {}

  async observe(v: AgentView): Promise<AgentReport> {
    let fc: KronosForecast[];
    if (v.previsioni) fc = Object.entries(v.previsioni).map(([simbolo, rendimentoPrevisto]) => ({ simbolo, rendimentoPrevisto }));
    else {
      try {
        fc = await this.fetcher([...AGENTS.universe], AGENTS.kronos.horizon);
      } catch (e) {
        return { segnali: [], note: [`Kronos non disponibile: ${(e as Error).message}`] };
      }
    }
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
    const ups = sane.filter((f) => f.rendimentoPrevisto >= AGENTS.kronos.anticipaSoglia && above200(f.simbolo)).sort((a, b) => b.rendimentoPrevisto - a.rendimentoPrevisto);
    const upsAll = sane.filter((f) => f.rendimentoPrevisto >= AGENTS.kronos.anticipaSoglia).length;
    const downs = sane.filter((f) => f.rendimentoPrevisto <= -AGENTS.kronos.anticipaSoglia).sort((a, b) => a.rendimentoPrevisto - b.rendimentoPrevisto);
    const keepUp = Math.max(1, Math.round(ups.length * AGENTS.kronos.topShare));
    const keepDown = Math.max(1, Math.round(downs.length * AGENTS.kronos.topShare));
    const segnali: Signal[] = [];
    const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    for (const f of ups.slice(0, keepUp)) {
      // Rialzo anticipato: si compra solo con il trend di lungo periodo positivo (sopra la media a 200); la forza cresce con la proiezione.
      segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "buy", forza: Math.min(1, 0.5 + f.rendimentoPrevisto * 5), orizzonteSedute: AGENTS.kronos.horizon, kronos: f.rendimentoPrevisto, perche: `Kronos anticipa ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute, tra i rialzi più netti, con trend di lungo periodo positivo` });
    }
    for (const f of downs.slice(0, keepDown)) {
      if (held.has(f.simbolo)) segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "sell", forza: 0.5, orizzonteSedute: AGENTS.kronos.horizon, kronos: f.rendimentoPrevisto, perche: `Kronos anticipa ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute su un titolo in portafoglio` });
    }
    return { segnali, note: [`${sane.length} previsioni usabili${scartate ? ` (${scartate} scartate perché oltre ±${(AGENTS.kronos.maxAbs * 100).toFixed(0)}%)` : ""}, ${upsAll} rialzi (${ups.length} sopra la media a 200) e ${downs.length} ribassi oltre la soglia, votati ${segnali.length}`] };
  }
}
