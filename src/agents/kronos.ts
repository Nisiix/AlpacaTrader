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
    const valid = fc.filter((f) => Number.isFinite(f.rendimentoPrevisto)).sort((a, b) => Math.abs(b.rendimentoPrevisto) - Math.abs(a.rendimentoPrevisto));
    const keep = Math.max(1, Math.round(valid.length * AGENTS.kronos.topShare));
    const segnali: Signal[] = [];
    const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
    for (const f of valid.slice(0, keep)) {
      const c = v.closes[f.simbolo];
      const m200 = c ? sma(c, LIMITS.longSmaDays) : null;
      const price = v.prices[f.simbolo] ?? c?.[c.length - 1];
      if (m200 === null || price === undefined) continue;
      const up = f.rendimentoPrevisto > 0;
      if (up && price > m200) segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "buy", forza: 0.5, orizzonteSedute: AGENTS.kronos.horizon, perche: `Kronos prevede ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute, tra le previsioni più nette, con trend di lungo periodo positivo` });
      else if (!up && held.has(f.simbolo)) segnali.push({ agente: this.name, simbolo: f.simbolo, lato: "sell", forza: 0.5, orizzonteSedute: AGENTS.kronos.horizon, perche: `Kronos prevede ${(f.rendimentoPrevisto * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute su un titolo in portafoglio` });
    }
    return { segnali, note: [`${valid.length} previsioni, tenute le ${keep} più nette`] };
  }
}
