import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, LIMITS, SECTORS, isCrypto, sectorOf } from "../config.ts";
import { EVENTS, eventBlockFor, type MarketEvent } from "../events.ts";
import { isObject, writeJsonAtomic } from "../fsutil.ts";
import { dailyVol, momentum, sma } from "../indicators.ts";
import type { Agent, AgentReport, AgentView, MarketContext, Outlook } from "./types.ts";

// Il contesto economico, prima di ogni trade. Due fonti che si sommano:
// 1. regole sui dati di mercato (SPY e media a 200, volatilità, trend dei settori, oro e obbligazioni come termometro
//    della paura) e sul calendario di Fed e trimestrali (events.ts): sempre disponibili;
// 2. una lettura della situazione economica da `claude -p` con ricerca web, ogni refreshHours, in cache su file.
// Il risultato: esposizione ammessa, settori in cui oggi si aspetta la candela successiva, proiezioni di cui fidarsi.
export interface MacroSource {
  readonly name: string;
  read(today: string): Promise<MacroReading | null>;
}

export interface MacroReading {
  aggiornato: string;
  generale: Outlook;
  settori: Partial<Record<string, Outlook>>;
  motivo: string;
}

// Settori rifugio: non misurano la voglia di rischio del mercato.
const RIPARO = new Set(["oro", "obbligazioni"]);
const BASE_SECTORS = new Set([...Object.values(SECTORS), "crypto"]);

const worst = (a: Outlook, b: Outlook): Outlook => (a === "sfavorevole" || b === "sfavorevole" ? "sfavorevole" : a === "neutro" || b === "neutro" ? "neutro" : "favorevole");

export function marketRules(v: AgentView, events: MarketEvent[] = EVENTS): MacroReading {
  const reasons: string[] = [];
  let generale: Outlook = "favorevole";
  const spy = v.closes.SPY;
  if (spy && spy.length >= LIMITS.longSmaDays + 1) {
    const m200 = sma(spy, LIMITS.longSmaDays)!;
    const price = v.prices.SPY ?? spy[spy.length - 1]!;
    const vol = dailyVol(spy, LIMITS.volLookbackDays) ?? 0;
    if (price < m200) {
      generale = "sfavorevole";
      reasons.push("SPY sotto la media a 200 giorni");
    } else if (vol >= AGENTS.regime.highVolDaily) {
      generale = "neutro";
      reasons.push(`volatilità di SPY ${(vol * 100).toFixed(2)}% al giorno`);
    }
    // Oro e obbligazioni lunghe che salgono insieme mentre SPY perde slancio: il mercato cerca riparo.
    const gld = v.closes.GLD ? momentum(v.closes.GLD, 20) : null;
    const tlt = v.closes.TLT ? momentum(v.closes.TLT, 20) : null;
    const spyMom = momentum(spy, 20);
    if (gld !== null && tlt !== null && spyMom !== null && gld > 0.02 && tlt > 0.02 && spyMom < 0) {
      generale = worst(generale, "neutro");
      reasons.push("oro e obbligazioni in salita con SPY in calo: mercato in cerca di riparo");
    }
  } else reasons.push("storico di SPY insufficiente");
  // Settori: sfavorevole se la maggioranza dei suoi titoli è sotto la media a 50. Il settore crypto si misura su
  // tutto l'universo crypto del giorno (non solo BTC ed ETH), così il contesto segue lo stesso universo degli agenti.
  const settori: Partial<Record<string, Outlook>> = {};
  const ampiezza: number[] = [];
  const bySector = new Map<string, string[]>();
  for (const s of new Set([...Object.keys(SECTORS), ...AGENTS.universe])) bySector.set(sectorOf(s), [...(bySector.get(sectorOf(s)) ?? []), s]);
  for (const [sec, syms] of bySector) {
    let above = 0, total = 0;
    for (const s of syms) {
      const c = v.closes[s];
      const m = c ? sma(c, LIMITS.trendSmaDays) : null;
      const p = v.prices[s] ?? c?.[c.length - 1];
      if (m === null || m === undefined || p === undefined) continue;
      total++;
      if (p > m) above++;
    }
    if (!total) continue;
    const share = above / total;
    settori[sec] = share >= 0.5 ? (share === 1 ? "favorevole" : "neutro") : "sfavorevole";
    if (settori[sec] === "sfavorevole") reasons.push(`${sec}: ${above} su ${total} sopra la media a 50 giorni`);
    // Nell'ampiezza contano solo i settori di base (indici, tecnologia, crypto): un titolo portato dall'esplorazione in un
    // settore nuovo (finanza, salute…) non deve pesare quanto un intero settore.
    if (!RIPARO.has(sec) && BASE_SECTORS.has(sec)) ampiezza.push(share);
  }
  // Il clima generale non può essere «favorevole» se i mercati a rischio sono quasi tutti sotto la media a 50, anche con
  // SPY sopra la 200: si guarda l'ampiezza, settore per settore con lo stesso peso (le 20 crypto non pesano più degli indici).
  // Oro e obbligazioni sono rifugi: salgono quando la paura sale, quindi non entrano nel conto.
  if (ampiezza.length) {
    const media = ampiezza.reduce((a, x) => a + x, 0) / ampiezza.length;
    const giudizio: Outlook = media < AGENTS.context.breadthUnfavorable ? "sfavorevole" : media < AGENTS.context.breadthNeutral ? "neutro" : "favorevole";
    if (giudizio !== "favorevole") reasons.unshift(`mercati a rischio sopra la media a 50: ${Math.round(media * 100)}% (media dei settori)`);
    generale = worst(generale, giudizio);
  }
  // Fed nei prossimi giorni: tutto neutro; trimestrale vicina: quel titolo lo decide eventBlockFor nella gabbia.
  const fedSoon = events.some((e) => e.kind === "fed" && e.date >= v.today && e.date <= addDaysStr(v.today, AGENTS.context.waitDaysBeforeEvent));
  if (fedSoon) {
    generale = worst(generale, "neutro");
    reasons.push("decisione della Fed nei prossimi giorni");
  }
  return { aggiornato: v.now.toISOString(), generale, settori, motivo: reasons.join("; ") || "nessun segnale di allarme dai dati di mercato" };
}

function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export class ContextAgent implements Agent {
  readonly name = "contesto";
  constructor(
    private macro: MacroSource | null = null,
    private events: MarketEvent[] = EVENTS,
  ) {}

  async assess(v: AgentView): Promise<MarketContext> {
    let reading: MacroReading | null = null;
    let problem: string | null = null;
    if (this.macro) {
      try {
        reading = await this.macro.read(v.today);
      } catch (e) {
        problem = `${this.macro.name} non disponibile: ${(e as Error).message}`;
      }
    }
    return this.assessWith(v, reading, problem);
  }

  // La parte sincrona: regole sui dati più, se c'è, la lettura esterna già ottenuta.
  assessWith(v: AgentView, reading: MacroReading | null, problem: string | null = null): MarketContext {
    const rules = marketRules(v, this.events);
    let fonte = "regole";
    let generale = rules.generale;
    const settori: Record<string, Outlook> = { ...(rules.settori as Record<string, Outlook>) };
    const motivi = [rules.motivo];
    // Fear & Greed delle crypto: con avidità estrema il settore crypto non è "favorevole" (euforia = prudenza).
    const fg = v.fonti?.paura;
    if (fg) {
      motivi.push(`Fear & Greed crypto ${fg.valore} (${fg.classe})`);
      if (fg.valore >= 80) settori.crypto = worst(settori.crypto ?? "favorevole", "neutro");
    }
    if (reading && this.macro) {
      fonte = `regole + ${this.macro.name}`;
      generale = worst(generale, reading.generale);
      for (const [sec, o] of Object.entries(reading.settori)) if (o) settori[sec] = worst(settori[sec] ?? "favorevole", o);
      motivi.push(`${this.macro.name}: ${reading.motivo}`);
    }
    if (problem) motivi.push(problem);
    const attendi: Record<string, string> = {};
    const fidati: Record<string, boolean> = {};
    const fedNear = this.events.some((e) => e.kind === "fed" && e.date >= v.today && e.date <= addDaysStr(v.today, AGENTS.context.waitDaysBeforeEvent));
    const symbols = new Set([...AGENTS.universe, ...v.positions.map((p) => p.symbol)]);
    for (const s of symbols) {
      const sec = sectorOf(s);
      const o = worst(generale, settori[sec] ?? "favorevole");
      const ev = eventBlockFor(s, v.today, this.events);
      const fc = v.previsioni?.[s];
      const anticipaRialzo = fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia;
      const anticipaRibasso = fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia;
      // Il contesto corrente non decide da solo: se Kronos anticipa un rialzo, il settore debole non ferma l'ingresso;
      // se anticipa un ribasso, si aspetta anche con contesto buono. Gli eventi (Fed, trimestrali) bloccano comunque.
      if (ev) attendi[s] = ev;
      else if (anticipaRibasso) attendi[s] = `Kronos anticipa un ribasso (${(fc * 100).toFixed(1)}% a ${AGENTS.kronos.horizon} sedute): si aspetta`;
      else if (o === "sfavorevole" && !anticipaRialzo) attendi[s] = `contesto sfavorevole (${sec}) e nessun rialzo anticipato da Kronos: si aspetta la candela successiva`;
      // Della proiezione ci si fida sempre, salvo eventi in arrivo (trimestrale del titolo, Fed nei prossimi giorni per azioni ed ETF):
      // con contesto non favorevole è lei a decidere.
      fidati[s] = !ev && !(fedNear && !isCrypto(s)); // la Fed non tocca le proiezioni delle crypto
    }
    return { aggiornato: v.now.toISOString(), fonte, generale, settori, motivo: motivi.join(" · "), attendi, fidatiDellaProiezione: fidati };
  }

  async observe(v: AgentView): Promise<AgentReport> {
    const c = v.contesto ?? (await this.assess(v));
    const rischio = c.generale === "sfavorevole" ? AGENTS.context.unfavorableScale : c.generale === "neutro" ? AGENTS.context.neutralScale : 1;
    const waiting = Object.keys(c.attendi);
    return { segnali: [], rischio, contesto: c, note: [`${c.generale} (${c.fonte}): ${c.motivo}`, ...(waiting.length ? [`in attesa della candela successiva: ${waiting.join(", ")}`] : [])] };
  }
}

// Lettura della situazione economica con `claude -p` e ricerca web, in cache su file per refreshHours.
export const MACRO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["generale", "settori", "motivo", "datiVerificati"],
  properties: {
    // false se la ricerca web non ha funzionato: la lettura allora non conta (senza dati non si abbassa il rischio).
    datiVerificati: { type: "boolean" },
    generale: { type: "string", enum: ["favorevole", "neutro", "sfavorevole"] },
    settori: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries([...new Set(Object.values(SECTORS))].map((s) => [s, { type: "string", enum: ["favorevole", "neutro", "sfavorevole"] }])),
    },
    motivo: { type: "string" },
  },
};

export const MACRO_PROMPT = `Sei l'analista macro di un agente di paper trading. Cerca sul web le notizie economiche degli ultimi giorni
(banche centrali, inflazione, lavoro, dazi e geopolitica, trimestrali, liquidità) e rispondi SOLO con JSON conforme allo schema:
generale (favorevole|neutro|sfavorevole) per chi compra azioni USA, oro, obbligazioni lunghe e crypto nelle prossime settimane;
settori: lo stesso giudizio per indici, tecnologia, oro, obbligazioni, crypto; motivo: tre frasi in italiano con i fatti che pesano;
datiVerificati: true solo se hai davvero letto notizie recenti con la ricerca web, false se la ricerca non era disponibile
(in quel caso il tuo giudizio non verrà usato). "Sfavorevole" significa che oggi è meglio non aprire posizioni nuove e aspettare.
Sii prudente ma non pessimista per abitudine.`;

export type Runner = (args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export class ClaudeMacro implements MacroSource {
  readonly name = "claude";
  constructor(
    private stateDir: string,
    private runner: Runner,
    private now: () => Date = () => new Date(),
    private timeoutMs = 240_000,
  ) {}

  private get path() {
    return join(this.stateDir, "macro.json");
  }

  private cached(): MacroReading | null {
    if (!existsSync(this.path)) return null;
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8"));
      if (isObject(v) && typeof v.aggiornato === "string" && typeof v.generale === "string" && isObject(v.settori) && typeof v.motivo === "string") return v as unknown as MacroReading;
    } catch {}
    return null;
  }

  private get errorPath() {
    return join(this.stateDir, "macro-errore.json");
  }

  // Dopo un errore claude non si richiama a ogni giro (ogni 5 minuti): si riprova dopo retryMinutes, e intanto valgono
  // le regole sui dati con l'ultimo motivo noto.
  private recentError(): string | null {
    try {
      const e = JSON.parse(readFileSync(this.errorPath, "utf8"));
      if (isObject(e) && typeof e.quando === "string" && this.now().getTime() - Date.parse(e.quando) < AGENTS.context.retryMinutes * 60_000) return String(e.motivo ?? "errore");
    } catch {}
    return null;
  }

  private fail(motivo: string, c: MacroReading | null): MacroReading | null {
    try {
      writeJsonAtomic(this.errorPath, { quando: this.now().toISOString(), motivo });
    } catch {}
    if (c) return c; // meglio una lettura vecchia che niente
    throw new Error(motivo);
  }

  async read(_today: string): Promise<MacroReading | null> {
    const c = this.cached();
    if (c && this.now().getTime() - Date.parse(c.aggiornato) < AGENTS.context.refreshHours * 3600_000) return c;
    const recent = this.recentError();
    if (recent) {
      if (c) return c;
      throw new Error(`${recent} (si riprova tra poco, intanto valgono le regole)`);
    }
    // --allowedTools pre-autorizza la ricerca: in modalità -p senza terminale i permessi non si possono chiedere.
    const args = ["claude", "-p", "--output-format", "json", "--json-schema", JSON.stringify(MACRO_SCHEMA), "--tools", "WebSearch", "--allowedTools", "WebSearch", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", MACRO_PROMPT];
    const res = await this.runner(args, `Oggi è ${_today}. Valuta la situazione economica attuale per un investitore in azioni USA, oro, obbligazioni lunghe e crypto. Rispondi solo con il JSON.`, this.timeoutMs);
    let env: any;
    try {
      env = JSON.parse(res.stdout);
    } catch {
      const err = (res.stderr || res.stdout || "").trim().split("\n").pop()?.slice(0, 160);
      return this.fail(`claude non ha risposto con JSON (codice ${res.code}${err ? `: ${err}` : ""})`, c);
    }
    let out: any = env?.structured_output ?? null;
    if (!out && typeof env?.result === "string") {
      try {
        out = JSON.parse(env.result.match(/\{[\s\S]*\}/)?.[0] ?? "null");
      } catch {
        out = null;
      }
    }
    if (!isObject(out) || !["favorevole", "neutro", "sfavorevole"].includes(String(out.generale))) {
      // Il motivo vero (accesso scaduto, limite raggiunto, schema rifiutato…) sta nel campo result della risposta.
      const why = env?.is_error || env?.subtype !== "success" ? String(env?.result ?? env?.subtype ?? "").replace(/\s+/g, " ").slice(0, 160) : "";
      return this.fail(`risposta di claude non valida${why ? `: ${why}` : ""}`, c);
    }
    // Senza notizie verificate il giudizio non vale: meglio le sole regole che un "neutro" per mancanza di dati.
    if (out.datiVerificati === false) return this.fail(`ricerca web non disponibile (${String(out.motivo ?? "").slice(0, 120)})`, c);
    const reading: MacroReading = { aggiornato: this.now().toISOString(), generale: out.generale as Outlook, settori: (isObject(out.settori) ? out.settori : {}) as Partial<Record<string, Outlook>>, motivo: String(out.motivo ?? "") };
    writeJsonAtomic(this.path, reading);
    try {
      if (existsSync(this.errorPath)) writeJsonAtomic(this.errorPath, { quando: "1970-01-01T00:00:00Z", motivo: "" });
    } catch {}
    return reading;
  }
}
