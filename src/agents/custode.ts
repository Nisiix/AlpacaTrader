import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { dailyVol, momentum, sma, trendOf } from "../indicators.ts";
import { stopPctFor } from "../stops.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

// I custodi: un investitore per ogni crypto che il motore segue. Ognuno guarda un solo titolo e ragiona come un
// professionista dentro le regole del motore: una tesi (perché il titolo merita attenzione), un piano (quando e come
// entrare, quando uscire) e il rischio dichiarato (lo stop scalato sulla volatilità). I custodi nascono per le crypto in
// portafoglio e per le migliori candidate del trend; muoiono quando il titolo esce dal radar. Votano come gli altri
// agenti: l'allocatore somma, la gabbia decide. Niente ordini da qui.
export type CustodeFase = "osserva" | "pronto" | "in posizione" | "in uscita" | "attende";

export interface CustodeStato {
  simbolo: string;
  agente: string; // "custode SOL/USD"
  fase: CustodeFase;
  tesi: string;
  piano: string;
  rischio: string;
  stato: string; // una riga su dove siamo adesso
  dalle: string; // data in cui il custode ha preso in carico il titolo
  livelli: { prezzo: number | null; media20: number | null; media50: number | null; media200: number | null; stop: number | null; carico: number | null };
  numeri: { momentum3m: number | null; momentum12m: number | null; distanzaMedia50: number | null; volGiornaliera: number | null; guadagno: number | null };
}

interface Custode {
  simbolo: string;
  dalle: string;
  inattivoDa: number; // giri senza posizione né candidatura
}

const pct = (x: number | null, d = 1) => (x === null ? "n.d." : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const num = (x: number | null) => (x === null ? "n.d." : x >= 100 ? x.toFixed(2) : x.toFixed(4));
export const custodeName = (symbol: string) => `custode ${symbol}`;

export class CustodiAgent implements Agent {
  readonly name = "custodi";
  private custodi = new Map<string, Custode>();

  // Candidate: crypto dell'universo in trend (sopra le medie, momentum 12 e 3 mesi positivi), le migliori per momentum a 6 mesi.
  private candidates(v: AgentView): string[] {
    const out: { s: string; mom: number }[] = [];
    for (const s of AGENTS.universe) {
      if (!isCrypto(s)) continue;
      const c = v.closes[s];
      const t = trendOf(c, LIMITS.trendSmaDays, LIMITS.longSmaDays);
      if (!c || !t || t.close <= t.sma || t.close <= t.long) continue;
      if ((momentum(c, AGENTS.absMomentum.days) ?? -1) <= AGENTS.absMomentum.min) continue;
      if ((momentum(c, AGENTS.cryptoMomentumDays) ?? -1) <= 0) continue;
      out.push({ s, mom: momentum(c, LIMITS.rankMomentumDays) ?? 0 });
    }
    return out.sort((a, b) => b.mom - a.mom).slice(0, AGENTS.custodi.maxCandidates).map((x) => x.s);
  }

  observe(v: AgentView): AgentReport {
    const held = new Map(v.positions.filter((p) => p.qty > 0 && isCrypto(p.symbol)).map((p) => [p.symbol, p]));
    const cands = new Set(this.candidates(v));
    const active = new Set([...held.keys(), ...cands]);
    for (const s of active) if (!this.custodi.has(s)) this.custodi.set(s, { simbolo: s, dalle: v.today, inattivoDa: 0 });
    for (const [s, c] of this.custodi) {
      c.inattivoDa = active.has(s) ? 0 : c.inattivoDa + 1;
      if (c.inattivoDa > AGENTS.custodi.keepIdleTicks) this.custodi.delete(s);
    }
    const segnali: Signal[] = [];
    const stati: CustodeStato[] = [];
    for (const c of [...this.custodi.values()].sort((a, b) => a.simbolo.localeCompare(b.simbolo))) {
      const st = this.judge(c, v, held.get(c.simbolo), cands.has(c.simbolo), segnali);
      stati.push(st);
    }
    const inPos = stati.filter((s) => s.fase === "in posizione" || s.fase === "in uscita").length;
    return { segnali, custodi: stati, note: [stati.length ? `${stati.length} custodi attivi (${inPos} in posizione): ${stati.map((s) => `${s.simbolo} ${s.fase}`).join(", ")}` : "nessuna crypto in trend da seguire"] };
  }

  private judge(c: Custode, v: AgentView, pos: AgentView["positions"][number] | undefined, candidate: boolean, segnali: Signal[]): CustodeStato {
    const s = c.simbolo;
    const closes = v.closes[s];
    const price = v.prices[s] ?? closes?.at(-1) ?? null;
    const m20 = closes ? sma(closes, AGENTS.custodi.pullbackSmaDays) : null;
    const m50 = closes ? sma(closes, LIMITS.trendSmaDays) : null;
    const m200 = closes ? sma(closes, LIMITS.longSmaDays) : null;
    const mom3 = closes ? momentum(closes, AGENTS.cryptoMomentumDays) : null;
    const mom12 = closes ? momentum(closes, AGENTS.absMomentum.days) : null;
    const dist50 = price !== null && m50 ? price / m50 - 1 : null;
    const stopPct = stopPctFor(closes);
    const vol = closes ? dailyVol(closes, LIMITS.volLookbackDays) : null;
    const carico = pos?.avgEntryPrice ?? null;
    const stop = carico !== null ? carico * (1 - stopPct) : price !== null ? price * (1 - stopPct) : null;
    const gain = pos && price !== null ? price / pos.avgEntryPrice - 1 : null;
    const agente = custodeName(s);
    const horizon = AGENTS.horizonSessions;
    const tesi = `${s}: ${m50 !== null && m200 !== null && price !== null && price > m50 && price > m200 ? `sopra le medie a ${LIMITS.trendSmaDays} e ${LIMITS.longSmaDays} giorni` : "trend non confermato"}, ${pct(mom3)} a 3 mesi e ${pct(mom12, 0)} a 12 mesi: ${candidate || pos ? "un trend che vale la pena seguire" : "fuori dai criteri del motore"}.`;
    const rischio = `Stop a ${pct(-stopPct)} dal carico (volatilità), ${stop !== null ? `cioè ${num(stop)}` : "da calcolare"}; peso massimo ${(LIMITS.maxPositionPct * 100).toFixed(0)}% del conto, mai più di ${LIMITS.maxPositions} posizioni.`;
    const base = { simbolo: s, agente, tesi, rischio, dalle: c.dalle, livelli: { prezzo: price, media20: m20, media50: m50, media200: m200, stop, carico }, numeri: { momentum3m: mom3, momentum12m: mom12, distanzaMedia50: dist50, volGiornaliera: vol, guadagno: gain } };

    if (pos) {
      // In posizione: il trend regge finché il prezzo sta sopra la media a 50; sotto la 20 si stringe l'attenzione.
      if (m50 !== null && price !== null && price < m50) {
        segnali.push({ agente, simbolo: s, lato: "sell", forza: 0.9, orizzonteSedute: horizon, perche: `${s} sotto la media a ${LIMITS.trendSmaDays} giorni (${num(m50)}): il trend che giustificava la posizione è finito` });
        return { ...base, fase: "in uscita", piano: `Uscire: il prezzo ${num(price)} ha perso la media a ${LIMITS.trendSmaDays} giorni. Si vende e si torna a osservare.`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop su Alpaca a ${num(stop)}.` };
      }
      if (mom3 !== null && mom3 <= 0) {
        segnali.push({ agente, simbolo: s, lato: "sell", forza: 0.6, orizzonteSedute: horizon, perche: `${s} con rendimento a 3 mesi tornato negativo (${pct(mom3)}): lo slancio è finito` });
        return { ...base, fase: "in uscita", piano: `Ridurre: lo slancio a 3 mesi è negativo, il trend di fondo regge ancora sopra la media a ${LIMITS.trendSmaDays}.`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop a ${num(stop)}.` };
      }
      const warn = m20 !== null && price !== null && price < m20;
      return { ...base, fase: "in posizione", piano: `Tenere finché il prezzo resta sopra la media a ${LIMITS.trendSmaDays} giorni (${num(m50)}). ${warn ? `Attenzione: sotto la media a ${AGENTS.custodi.pullbackSmaDays} giorni (${num(m20)}), si osserva senza agire.` : `Uscita normale sul trend; presa di profitto parziale secondo le regole del motore.`}`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop a ${num(stop)}.` };
    }
    if (!candidate) return { ...base, fase: "attende", piano: "Nessun ingresso: il titolo non rispetta più i criteri (medie, momentum). Il custode resta in ascolto qualche giro, poi lascia.", stato: `Fuori dai criteri da ${c.inattivoDa} giri.` };
    if (v.contesto?.attendi[s]) return { ...base, fase: "attende", piano: `Aspettare: ${v.contesto.attendi[s]}.`, stato: "Pronto a entrare appena il contesto lo permette." };
    // Candidata: ingresso migliore vicino alla media a 20 giorni; troppo lontano dalla 50 si aspetta un rientro.
    if (dist50 !== null && dist50 > AGENTS.custodi.extendedPct) {
      segnali.push({ agente, simbolo: s, lato: "buy", forza: 0.25, orizzonteSedute: horizon, perche: `${s} in trend ma ${pct(dist50)} sopra la media a ${LIMITS.trendSmaDays} giorni: ingresso solo a taglia ridotta, meglio aspettare un rientro` });
      return { ...base, fase: "osserva", piano: `Aspettare un rientro verso la media a ${AGENTS.custodi.pullbackSmaDays} giorni (${num(m20)}): il prezzo è ${pct(dist50)} sopra la ${LIMITS.trendSmaDays}, troppo esteso per entrare pieno.`, stato: `Candidata dal ${c.dalle}, non in portafoglio.` };
    }
    const nearPullback = m20 !== null && price !== null && price <= m20 * 1.02;
    const forza = nearPullback ? 0.8 : 0.6;
    segnali.push({ agente, simbolo: s, lato: "buy", forza, orizzonteSedute: horizon, perche: `${s} in trend (${pct(mom3)} a 3 mesi, ${pct(mom12, 0)} a 12), ${nearPullback ? `vicino alla media a ${AGENTS.custodi.pullbackSmaDays} giorni: buon punto d'ingresso` : `${pct(dist50)} sopra la media a ${LIMITS.trendSmaDays}: ingresso ordinato`}` });
    return { ...base, fase: "pronto", piano: `Entrare ${nearPullback ? "ora, sul rientro verso la media a 20 giorni" : "con ordine a mercato, taglia piena dal motore"}; stop iniziale a ${num(stop)} (${pct(-stopPct)}). Uscita quando il prezzo chiude sotto la media a ${LIMITS.trendSmaDays} giorni.`, stato: `Candidata dal ${c.dalle}, in attesa che l'allocatore e la gabbia confermino.` };
  }
}
