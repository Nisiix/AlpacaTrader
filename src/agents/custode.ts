import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { dailyVol, momentum, rsi, sma, trendOf } from "../indicators.ts";
import { stopPctFor } from "../stops.ts";
import { controTendenza, pesoControTendenza } from "./fiducia.ts";
import { crowdAdjustment } from "./fonti.ts";
import { clamp01, type Agent, type AgentReport, type AgentView, type Signal } from "./types.ts";

// I custodi: un investitore per ogni crypto che il motore segue. Ognuno guarda un solo titolo e ragiona come un
// professionista dentro le regole del motore: una tesi (perché il titolo merita attenzione), un piano (quando e come
// entrare, quando uscire) e il rischio dichiarato (lo stop scalato sulla volatilità). I custodi nascono per le crypto in
// portafoglio e per le migliori candidate del trend; muoiono quando il titolo esce dal radar. Votano come gli altri
// agenti: l'allocatore somma, la gabbia decide. Niente ordini da qui.
export type CustodeFase = "osserva" | "pronto" | "in posizione" | "in uscita" | "attende";

// Il dossier: quello che il custode studia tra un giro e l'altro per prepararsi alla prossima mossa. Quattro fonti, ognuna
// con un voto da 0 a 1, e una probabilità complessiva che il titolo sia favorevole all'ingresso (o alla tenuta).
export interface Dossier {
  aggiornato: string;
  probabilita: number; // 0..1
  tecnica: { punteggio: number; pattern: string[] };
  kronos: { punteggio: number | null; nota: string };
  notizie: { punteggio: number | null; titoli: { titolo: string; fonte: string; quando: string }[]; nota: string };
  contesto: { punteggio: number; nota: string };
  // La memoria storica del titolo: come sono andati i trade passati degli agenti su questo simbolo (dal diario).
  memoria: Memoria;
  prossimaAzione: string;
}

export interface Memoria {
  trade: number;
  vinti: number;
  media: number | null; // risultato medio per trade (frazione)
  daStop: number; // uscite per stop
  giorniMedi: number | null;
  ultimo: { chiusoIl: string; risultato: number; uscita: string } | null;
  // Quale tipo d'ingresso ha reso di più su questo titolo: "rientro" (vicino alla media a 20) o "trend" (ingresso ordinato).
  ingressoMigliore: "rientro" | "trend" | null;
  lezione: string; // una riga in italiano
  // Come la memoria modula il custode: moltiplicatore della forza d'ingresso e peso massimo (se ridotto).
  forza: number;
  pesoMassimo: number | null;
}

// La memoria del titolo dal diario: i criteri del motore restano la fonte principale, la storia li affina.
export function symbolMemory(journal: AgentView["journal"], symbol: string): Memoria {
  const closed = journal.trade.filter((t) => t.simbolo === symbol && t.stato === "chiuso" && t.risultato !== undefined);
  const n = closed.length;
  const empty: Memoria = { trade: 0, vinti: 0, media: null, daStop: 0, giorniMedi: null, ultimo: null, ingressoMigliore: null, lezione: "nessun trade passato su questo titolo: si seguono i criteri del motore", forza: 1, pesoMassimo: null };
  if (!n) return empty;
  const res = closed.map((t) => t.risultato!);
  const vinti = res.filter((r) => r > 0).length;
  const media = res.reduce((a, b) => a + b, 0) / n;
  const daStop = closed.filter((t) => /stop/i.test(t.motivoUscita ?? "")).length;
  const giorni = closed.map((t) => t.giorni ?? 0);
  const last = [...closed].sort((a, b) => (a.chiusoIl ?? "").localeCompare(b.chiusoIl ?? "")).at(-1)!;
  const byKind = (re: RegExp) => closed.filter((t) => re.test(t.contesto?.perche ?? ""));
  const rientro = byKind(/rientro|media a 20|punto d'ingresso/i), trend = byKind(/ingresso ordinato|sopra le medie/i);
  const avg = (ts: typeof closed) => (ts.length ? ts.reduce((a, t) => a + t.risultato!, 0) / ts.length : null);
  const mr = avg(rientro), mt = avg(trend);
  const ingressoMigliore = mr !== null && mt !== null ? (mr >= mt ? "rientro" : "trend") : mr !== null && rientro.length >= 2 ? "rientro" : mt !== null && trend.length >= 2 ? "trend" : null;
  let forza = 1, pesoMassimo: number | null = null, lezione: string;
  const pctS = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  if (n >= 3 && media < 0 && vinti / n < 0.5) {
    forza = 0.7;
    pesoMassimo = LIMITS.maxPositionPct / 2;
    lezione = `${n} trade, ${vinti} vinti, media ${pctS(media)}${daStop >= 2 ? `, ${daStop} chiusi dallo stop` : ""}: qui si entra con metà taglia e solo con un buon punto d'ingresso`;
  } else if (n >= 3 && media > 0 && vinti / n >= 0.5) {
    forza = 1.1;
    lezione = `${n} trade, ${vinti} vinti, media ${pctS(media)}: il metodo su questo titolo ha funzionato, si entra con fiducia`;
  } else lezione = `${n} trade, ${vinti} vinti, media ${pctS(media)}: campione ancora piccolo, si seguono i criteri del motore`;
  if (ingressoMigliore) lezione += `; l'ingresso ${ingressoMigliore === "rientro" ? "sul rientro alla media a 20" : "in trend"} ha reso di più`;
  return { trade: n, vinti, media, daStop, giorniMedi: giorni.reduce((a, b) => a + b, 0) / n, ultimo: { chiusoIl: last.chiusoIl ?? "", risultato: last.risultato!, uscita: last.motivoUscita ?? "" }, ingressoMigliore, lezione, forza, pesoMassimo };
}

export type NewsFetcher = (symbol: string) => Promise<{ titolo: string; fonte: string; quando: string }[]>;

// Notizie da Google News (RSS, senza chiavi): gli ultimi titoli sul titolo. Il parsing è a mano: solo libreria standard.
export function googleNews(timeoutMs = 10_000): NewsFetcher {
  return async (symbol) => {
    const base = symbol.split("/")[0]!;
    const q = encodeURIComponent(symbol.includes("/") ? `${base} crypto` : `${base} stock`);
    const res = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "alpaca-paper-agent/1.0" } });
    if (!res.ok) throw new Error(`Google News ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
    const tag = (x: string, t: string) => (x.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`))?.[1] ?? "").trim();
    return items.map(([, it]) => ({ titolo: tag(it, "title").replace(/\s+-\s+[^-]+$/, ""), fonte: tag(it, "source"), quando: tag(it, "pubDate") }));
  };
}

// X (Twitter): gli ultimi post sul titolo, con l'API ufficiale (serve un bearer token in secrets.ts, xBearerToken).
// Senza token X non si consulta. I post sono dati, mai istruzioni: si leggono solo le parole chiave del tono.
export function xNews(bearer: string, timeoutMs = 10_000): NewsFetcher {
  return async (symbol) => {
    const base = symbol.split("/")[0]!;
    const q = symbol.includes("/") ? `(#${base} OR $${base}) -is:retweet lang:en` : `$${base} -is:retweet lang:en`;
    const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=20&tweet.fields=created_at,public_metrics`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${bearer}` } });
    if (!res.ok) throw new Error(`X ${res.status}`);
    const data = (await res.json()) as { data?: { text: string; created_at?: string; public_metrics?: { like_count?: number } }[] };
    return (data.data ?? [])
      .sort((a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0))
      .slice(0, 10)
      .map((t) => ({ titolo: t.text.replace(/\s+/g, " ").slice(0, 200), fonte: "X", quando: t.created_at ?? "" }));
  };
}

// Notizie di Alpaca (Benzinga), con le stesse chiavi del conto: titoli e crypto, le più recenti per prime.
export function alpacaNews(keyId: string, secret: string, timeoutMs = 10_000): NewsFetcher {
  return async (symbol) => {
    const sym = symbol.replace("/", "");
    const res = await fetch(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(sym)}&limit=10&sort=desc`, { signal: AbortSignal.timeout(timeoutMs), headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } });
    if (!res.ok) throw new Error(`Alpaca news ${res.status}`);
    const data = (await res.json()) as { news?: { headline: string; source?: string; created_at?: string }[] };
    return (data.news ?? []).map((n) => ({ titolo: n.headline, fonte: n.source ? `${n.source} (Alpaca)` : "Benzinga (Alpaca)", quando: n.created_at ?? "" }));
  };
}

// Più fonti insieme (Google News + X): una che fallisce non toglie le altre.
export function combinedNews(fetchers: NewsFetcher[]): NewsFetcher {
  return async (symbol) => {
    const results = await Promise.allSettled(fetchers.map((f) => f(symbol)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<NewsFetcher>>> => r.status === "fulfilled").flatMap((r) => r.value);
    if (!ok.length && results.some((r) => r.status === "rejected")) throw new Error(results.map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "")).filter(Boolean).join("; "));
    return ok;
  };
}

const POS = /rally|record|all-time high|surge|soar|approv|etf|partnership|upgrade|adoption|launch|inflow|bullish|breakout|gain|jump|accumulat|moon|pump|buy the dip|strong/i;
const NEG = /hack|exploit|crash|plunge|lawsuit|sues|ban|delist|outage|liquidat|bearish|dump|fraud|probe|outflow|drop|slump|fall|sell-off|selloff|rug|scam|short it|collapse/i;
export function newsScore(titoli: { titolo: string }[]): number | null {
  if (!titoli.length) return null;
  let net = 0;
  for (const t of titoli) net += (POS.test(t.titolo) ? 1 : 0) - (NEG.test(t.titolo) ? 1 : 0);
  return Math.max(0, Math.min(1, 0.5 + net * 0.08));
}

// Funzione di ripartizione della normale: P(rendimento > 0) dato il rendimento atteso e la volatilità sull'orizzonte.
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// Analisi tecnica del grafico: struttura, rotture, rientri, eccessi. Ogni pattern pesa; il totale va da 0 a 1.
export function technicalRead(closes: number[] | undefined, price: number | null): { punteggio: number; pattern: string[] } {
  if (!closes || closes.length < 60 || price === null) return { punteggio: 0.5, pattern: ["storico insufficiente"] };
  const pattern: string[] = [];
  let score = 0.5;
  const m20 = sma(closes, 20)!, m50 = sma(closes, 50)!, m200 = closes.length >= 200 ? sma(closes, 200) : null;
  const last20 = closes.slice(-20), prev20 = closes.slice(-40, -20);
  if (Math.max(...last20) > Math.max(...prev20) && Math.min(...last20) > Math.min(...prev20)) { score += 0.12; pattern.push("massimi e minimi crescenti"); }
  else if (Math.max(...last20) < Math.max(...prev20) && Math.min(...last20) < Math.min(...prev20)) { score -= 0.12; pattern.push("massimi e minimi calanti"); }
  if (price >= Math.max(...closes.slice(-21, -1))) { score += 0.1; pattern.push("rottura dei massimi a 20 sedute"); }
  if (price > m50 && m200 !== null && m50 > m200) { score += 0.1; pattern.push("medie allineate al rialzo (50 sopra 200)"); }
  else if (m200 !== null && m50 < m200) { score -= 0.1; pattern.push("media 50 sotto la 200"); }
  const d20 = price / m20 - 1, d50 = price / m50 - 1;
  if (Math.abs(d20) <= 0.02 && price > m50) { score += 0.08; pattern.push("rientro sulla media a 20: punto d'ingresso ordinato"); }
  if (d50 > 0.15) { score -= 0.1; pattern.push(`esteso: ${(d50 * 100).toFixed(0)}% sopra la media a 50`); }
  const r = rsi(closes, 14);
  if (r !== null && r > 75) { score -= 0.08; pattern.push(`RSI(14) ${r.toFixed(0)}: ipercomprato`); }
  else if (r !== null && r < 30) { score += 0.04; pattern.push(`RSI(14) ${r.toFixed(0)}: ipervenduto`); }
  const v20 = dailyVol(closes, 20), v60 = dailyVol(closes, 60);
  if (v20 !== null && v60 !== null && v20 < v60 * 0.7) { score += 0.05; pattern.push("volatilità in compressione: spesso precede un movimento"); }
  const m3 = momentum(closes, 63);
  if (m3 !== null) { score += Math.max(-0.1, Math.min(0.1, m3 * 0.3)); pattern.push(`slancio a 3 mesi ${(m3 * 100).toFixed(0)}%`); }
  return { punteggio: Math.max(0, Math.min(1, score)), pattern };
}

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
  dossier?: Dossier;
}

interface Custode {
  simbolo: string;
  dalle: string;
  inattivoDa: number; // giri senza posizione né candidatura
  dossier?: Dossier;
  notizie?: { quando: number; titoli: { titolo: string; fonte: string; quando: string }[]; errore?: string };
}

const pct = (x: number | null, d = 1) => (x === null ? "n.d." : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const num = (x: number | null) => (x === null ? "n.d." : x >= 100 ? x.toFixed(2) : x.toFixed(4));
export const custodeName = (symbol: string) => `custode ${symbol}`;

export class CustodiAgent implements Agent {
  readonly name = "custodi";
  private custodi = new Map<string, Custode>();
  // Notizie dal web: assente nei test e nel finto; nel vero Google News, aggiornate ogni ora per titolo.
  constructor(private news: NewsFetcher | null = null, private newsRefreshMs = 60 * 60_000) {}

  // Lo studio del custode: tecnica, Kronos, notizie, contesto → probabilità e prossima azione.
  private async study(c: Custode, v: AgentView, closes: number[] | undefined, price: number | null, fase: CustodeFase, livelli: CustodeStato["livelli"]): Promise<Dossier> {
    const s = c.simbolo;
    const tecnica = technicalRead(closes, price);
    const fc = v.previsioni?.[s];
    const vol = closes ? dailyVol(closes, LIMITS.volLookbackDays) : null;
    const kr = fc !== undefined && vol ? phi(fc / (vol * Math.sqrt(AGENTS.kronos.horizon))) : null;
    const kronos = { punteggio: kr, nota: fc === undefined ? "nessuna proiezione" : `Kronos ${fc >= 0 ? "+" : ""}${(fc * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute: probabilità di rialzo ${kr === null ? "n.d." : `${(kr * 100).toFixed(0)}%`}` };
    if (this.news && (!c.notizie || Date.now() - c.notizie.quando > this.newsRefreshMs)) {
      try {
        c.notizie = { quando: Date.now(), titoli: await this.news(s) };
      } catch (e) {
        c.notizie = { quando: Date.now(), titoli: c.notizie?.titoli ?? [], errore: (e as Error).message };
      }
    }
    const titoli = c.notizie?.titoli ?? [];
    const ns = newsScore(titoli);
    const daX = titoli.filter((t) => t.fonte === "X").length;
    const notizie = { punteggio: ns, titoli: titoli.slice(0, 8), nota: !this.news ? "notizie non consultate" : c.notizie?.errore ? `notizie non raggiungibili (${c.notizie.errore})` : ns === null ? "nessuna notizia recente" : `${titoli.length} tra notizie${daX ? ` e post su X (${daX})` : ""}, tono ${ns > 0.6 ? "favorevole" : ns < 0.4 ? "sfavorevole" : "neutro"}` };
    const o = v.contesto?.generale ?? "neutro";
    const wait = v.contesto?.attendi[s];
    const crowd = crowdAdjustment(v.fonti, s, fc);
    const cs = Math.max(0, Math.min(1, (wait ? 0.2 : o === "favorevole" ? 0.8 : o === "neutro" ? 0.5 : 0.2) + crowd.delta));
    const contesto = { punteggio: cs, nota: [wait ? wait : `contesto ${o}`, ...crowd.nota].join(" · ") };
    const memoria = symbolMemory(v.journal, s);
    // Pesi: Kronos 45 (la fonte principale per anticipare), tecnica 25, notizie 15, contesto 15; le fonti mancanti
    // ridistribuiscono il loro peso.
    const parts: [number, number | null][] = [[0.45, kronos.punteggio], [0.25, tecnica.punteggio], [0.15, notizie.punteggio], [0.15, contesto.punteggio]];
    const wsum = parts.reduce((a, [w, x]) => a + (x === null ? 0 : w), 0);
    const probabilita = wsum ? parts.reduce((a, [w, x]) => a + (x === null ? 0 : w * x), 0) / wsum : 0.5;
    const p = Math.round(probabilita * 100);
    const m20 = livelli.media20, m50 = livelli.media50;
    let prossimaAzione: string;
    if (fase === "in posizione") prossimaAzione = p >= 55 ? `Tenere: ${p}% favorevole. Si esce solo sotto la media a 50 (${num(m50)}) o con lo stop (${num(livelli.stop)}).` : `Tenere con prudenza: ${p}% favorevole. Un'altra chiusura debole e si riduce; stop a ${num(livelli.stop)}.`;
    else if (fase === "in uscita") prossimaAzione = "Uscire al prossimo giro utile: il trend che reggeva la posizione è finito.";
    else if (fase === "attende") prossimaAzione = `Nessun ingresso finché ${wait ? "il contesto non cambia" : "il titolo non rientra nei criteri"}; intanto si studia: ${p}% favorevole.`;
    else if (p >= 60) prossimaAzione = `Entrare al prossimo giro se il prezzo tiene sopra la media a 20 (${num(m20)}): ${p}% favorevole. Stop a ${num(livelli.stop)}.`;
    else if (p >= 45) prossimaAzione = `Aspettare una conferma (chiusura sopra ${num(m20)} o rottura dei massimi a 20 sedute): ${p}% favorevole, non basta per la taglia piena.`;
    else prossimaAzione = `Restare fuori: ${p}% favorevole. Si rivaluta al prossimo giro.`;
    return { aggiornato: v.now.toISOString(), probabilita, tecnica, kronos, notizie, contesto, memoria, prossimaAzione };
  }

  // Candidate: tutti i titoli e le crypto dell'universo in trend (sopra le medie, momentum a 12 mesi positivo; per le
  // crypto anche a 3 mesi). Nessun numero fisso: tanti custodi quanti sono i titoli che meritano attenzione, nessuno se
  // il mercato non offre niente. Il tetto in configurazione è solo una sicurezza.
  private candidates(v: AgentView): string[] {
    const out: { s: string; mom: number }[] = [];
    for (const s of AGENTS.universe) {
      const c = v.closes[s];
      const t = trendOf(c, LIMITS.trendSmaDays, LIMITS.longSmaDays);
      if (!c || !t) continue;
      const fc = v.previsioni?.[s];
      // Sotto la media a 200 solo contro tendenza: Kronos netto e probabilità di successo sufficiente.
      if (t.close <= t.long) {
        if (controTendenza(c, fc).ok) out.push({ s, mom: fc! });
        continue;
      }
      const kronosUp = fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia;
      const inTrend = t.close > t.sma && (momentum(c, AGENTS.absMomentum.days) ?? -1) > AGENTS.absMomentum.min && (!isCrypto(s) || (momentum(c, AGENTS.cryptoMomentumDays) ?? -1) > 0);
      // Candidata per trend, oppure perché Kronos anticipa un rialzo netto (sopra la 200): il custode nasce e studia.
      if (!inTrend && !kronosUp) continue;
      out.push({ s, mom: (momentum(c, LIMITS.rankMomentumDays) ?? 0) + (kronosUp ? fc : 0) });
    }
    return out.sort((a, b) => b.mom - a.mom).slice(0, AGENTS.custodi.maxCandidates).map((x) => x.s);
  }

  async observe(v: AgentView): Promise<AgentReport> {
    const held = new Map(v.positions.filter((p) => p.qty > 0 && AGENTS.universe.includes(p.symbol)).map((p) => [p.symbol, p]));
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
      const mine: Signal[] = [];
      const st = this.judge(c, v, held.get(c.simbolo), cands.has(c.simbolo), mine);
      c.dossier = await this.study(c, v, v.closes[c.simbolo], st.livelli.prezzo, st.fase, st.livelli);
      st.dossier = c.dossier;
      // Il dossier modula la forza del voto d'ingresso (mai le uscite, che sono regole): 50% → invariata, 80% → +30%, 30% → -20%.
      for (const sg of mine) {
        if (sg.lato === "buy") {
          const m = c.dossier.memoria;
          sg.forza = clamp01(sg.forza * (0.5 + c.dossier.probabilita) * m.forza);
          if (m.pesoMassimo !== null) sg.pesoMassimo = Math.min(sg.pesoMassimo ?? Infinity, m.pesoMassimo);
          // Se la storia dice che qui ha reso solo il rientro, un ingresso "in trend" esteso vale meno.
          if (m.ingressoMigliore === "rientro" && !/vicino alla media/.test(sg.perche)) sg.forza = clamp01(sg.forza * 0.8);
          if (m.trade) sg.perche += ` · memoria: ${m.lezione}`;
        }
        sg.perche += ` · dossier ${Math.round(c.dossier.probabilita * 100)}% favorevole`;
      }
      segnali.push(...mine);
      stati.push(st);
    }
    const inPos = stati.filter((s) => s.fase === "in posizione" || s.fase === "in uscita").length;
    return { segnali, custodi: stati, note: [stati.length ? `${stati.length} custodi attivi (${inPos} in posizione): ${stati.map((s) => `${s.simbolo} ${s.fase}`).join(", ")}` : "nessun titolo in trend da seguire"] };
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
      const fcPos = v.previsioni?.[s];
      const kronosTiene = fcPos !== undefined && fcPos >= AGENTS.kronos.anticipaSoglia;
      // In posizione: il trend regge finché il prezzo sta sopra la media a 50; sotto la 20 si stringe l'attenzione.
      // Se Kronos anticipa ancora un rialzo, la perdita della media a 50 non fa uscire: si tiene con lo stop.
      if (m50 !== null && price !== null && price < m50 && kronosTiene) {
        return { ...base, fase: "in posizione", piano: `Tenere nonostante la media a ${LIMITS.trendSmaDays} persa: Kronos anticipa ${pct(fcPos!)} a ${AGENTS.kronos.horizon} sedute. Si esce con lo stop (${num(stop)}) o quando la proiezione gira.`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop a ${num(stop)}.` };
      }
      if (m50 !== null && price !== null && price < m50) {
        segnali.push({ agente, simbolo: s, lato: "sell", forza: 0.9, orizzonteSedute: horizon, perche: `${s} sotto la media a ${LIMITS.trendSmaDays} giorni (${num(m50)}): il trend che giustificava la posizione è finito` });
        return { ...base, fase: "in uscita", piano: `Uscire: il prezzo ${num(price)} ha perso la media a ${LIMITS.trendSmaDays} giorni. Si vende e si torna a osservare.`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop su Alpaca a ${num(stop)}.` };
      }
      if (mom3 !== null && mom3 <= 0 && !kronosTiene) {
        segnali.push({ agente, simbolo: s, lato: "sell", forza: 0.6, orizzonteSedute: horizon, perche: `${s} con rendimento a 3 mesi tornato negativo (${pct(mom3)}): lo slancio è finito` });
        return { ...base, fase: "in uscita", piano: `Ridurre: lo slancio a 3 mesi è negativo, il trend di fondo regge ancora sopra la media a ${LIMITS.trendSmaDays}.`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop a ${num(stop)}.` };
      }
      const warn = m20 !== null && price !== null && price < m20;
      return { ...base, fase: "in posizione", piano: `Tenere finché il prezzo resta sopra la media a ${LIMITS.trendSmaDays} giorni (${num(m50)}). ${warn ? `Attenzione: sotto la media a ${AGENTS.custodi.pullbackSmaDays} giorni (${num(m20)}), si osserva senza agire.` : `Uscita normale sul trend; presa di profitto parziale secondo le regole del motore.`}`, stato: `In posizione da ${c.dalle}, ${pct(gain, 2)} dal carico ${num(carico)}; stop a ${num(stop)}.` };
    }
    if (!candidate) return { ...base, fase: "attende", piano: "Nessun ingresso: il titolo non rispetta più i criteri (medie, momentum). Il custode resta in ascolto qualche giro, poi lascia.", stato: `Fuori dai criteri da ${c.inattivoDa} giri.` };
    const fc = v.previsioni?.[s];
    // Kronos prima del contesto: un ribasso anticipato ferma l'ingresso anche in trend; un rialzo anticipato lo rafforza.
    if (fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia) return { ...base, fase: "attende", piano: `Aspettare: Kronos anticipa un ribasso (${pct(fc)} a ${AGENTS.kronos.horizon} sedute). Si rientra quando la proiezione torna positiva.`, stato: "Trend intatto ma proiezione contraria: fermo." };
    if (v.contesto?.attendi[s]) return { ...base, fase: "attende", piano: `Aspettare: ${v.contesto.attendi[s]}.`, stato: "Pronto a entrare appena il contesto lo permette." };
    // Contro tendenza (sotto la 200): si entra solo con Kronos netto e probabilità sufficiente, a taglia ridotta.
    if (m200 !== null && price !== null && price <= m200) {
      const ct = controTendenza(closes, fc);
      if (!ct.ok) return { ...base, fase: "attende", piano: `Aspettare: sotto la media a ${LIMITS.longSmaDays} si entra solo contro tendenza con Kronos netto; ${ct.motivo}.`, stato: "Fuori dal trend di lungo periodo." };
      segnali.push({ agente, simbolo: s, lato: "buy", forza: 0.55, orizzonteSedute: AGENTS.kronos.horizon, kronos: fc, pesoMassimo: pesoControTendenza(), perche: `${s} contro tendenza: sotto la media a ${LIMITS.longSmaDays} giorni ma ${ct.motivo}; taglia ridotta (${Math.round(pesoControTendenza() * 100)}% massimo), stop a ${num(stop)}, si tiene finché Kronos vede il rialzo` });
      return { ...base, fase: "pronto", piano: `Entrare contro tendenza a taglia ridotta: ${ct.motivo}. Stop iniziale a ${num(stop)} (${pct(-stopPct)}); si esce con lo stop o quando Kronos non vede più il rialzo.`, stato: `Candidata contro tendenza dal ${c.dalle}, in attesa che allocatore e gabbia confermino.` };
    }
    const spinta = fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia ? 1.15 : 1;
    // Candidata: ingresso migliore vicino alla media a 20 giorni; troppo lontano dalla 50 si aspetta un rientro.
    if (dist50 !== null && dist50 > AGENTS.custodi.extendedPct) {
      segnali.push({ agente, simbolo: s, lato: "buy", forza: 0.25, orizzonteSedute: horizon, perche: `${s} in trend ma ${pct(dist50)} sopra la media a ${LIMITS.trendSmaDays} giorni: ingresso solo a taglia ridotta, meglio aspettare un rientro` });
      return { ...base, fase: "osserva", piano: `Aspettare un rientro verso la media a ${AGENTS.custodi.pullbackSmaDays} giorni (${num(m20)}): il prezzo è ${pct(dist50)} sopra la ${LIMITS.trendSmaDays}, troppo esteso per entrare pieno.`, stato: `Candidata dal ${c.dalle}, non in portafoglio.` };
    }
    const nearPullback = m20 !== null && price !== null && price <= m20 * 1.02;
    const forza = Math.min(1, (nearPullback ? 0.8 : 0.6) * spinta);
    const sotto50 = m50 !== null && price !== null && price < m50;
    segnali.push({ agente, simbolo: s, lato: "buy", forza: sotto50 ? Math.min(forza, 0.6) : forza, orizzonteSedute: horizon, kronos: fc, perche: `${s} ${sotto50 ? `sotto la media a ${LIMITS.trendSmaDays} ma sopra la ${LIMITS.longSmaDays}, rialzo anticipato da Kronos ${pct(fc!)}` : `in trend (${pct(mom3)} a 3 mesi, ${pct(mom12, 0)} a 12)`}, ${nearPullback ? `vicino alla media a ${AGENTS.custodi.pullbackSmaDays} giorni: buon punto d'ingresso` : `${pct(dist50)} ${dist50 !== null && dist50 >= 0 ? "sopra" : "sotto"} la media a ${LIMITS.trendSmaDays}: ingresso ${sotto50 ? "prudente" : "ordinato"}`}${spinta > 1 && !sotto50 ? `, Kronos anticipa ${pct(fc!)}` : ""}` });
    return { ...base, fase: "pronto", piano: `Entrare ${nearPullback ? "ora, sul rientro verso la media a 20 giorni" : "con ordine a mercato, taglia piena dal motore"}; stop iniziale a ${num(stop)} (${pct(-stopPct)}). Uscita quando il prezzo chiude sotto la media a ${LIMITS.trendSmaDays} giorni.`, stato: `Candidata dal ${c.dalle}, in attesa che l'allocatore e la gabbia confermino.` };
  }
}
