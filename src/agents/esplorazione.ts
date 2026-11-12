import { join } from "node:path";
import type { Bar } from "../broker/types.ts";
import { AGENTS, LIMITS, RADAR_SECTORS, isCrypto, sectorOf } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import { dailyVol, momentum, sma } from "../indicators.ts";
import type { Presenza } from "./caffe.ts";
import { technicalRead } from "./custode.ts";
import { controTendenza, pesoControTendenza, plausibile } from "./fiducia.ts";
import type { AgentReport, AgentView, Signal } from "./types.ts";

// L'esplorazione: gli agenti in sala caffè non pensano solo al loro titolo. A turno passano in rassegna il radar (azioni e
// ETF liquidi fuori dall'universo, crypto rimaste fuori dal tetto di coppie), con gli stessi criteri del motore:
// 1. trend di lungo periodo positivo (sopra la media a 200) e momentum a 12 mesi positivo, grafico in ordine;
// 2. Kronos al rialzo oltre la soglia, proiezione non fuori misura (Kronos resta la fonte principale).
// Chi trova un'opportunità torna alla scrivania: il titolo entra nell'universo per qualche giorno (così prezzi, contesto,
// custodi, gabbia e uscite lo trattano come tutti gli altri) e lo scopritore lo vota a ogni giro finché l'opportunità
// regge. Il voto passa da punteggi, richiami del capo, lezioni della sala caffè, allocatore e gabbia come ogni altro.

export interface Scoperta {
  simbolo: string;
  settore: string;
  scopritore: string; // chiave della postazione: c:SOL/USD, i:DOT/USD, a:regime
  agente: string; // nome con cui vota (custode SOL/USD, intraday, regime)
  trovata: string; // ISO
  validaFino: string; // AAAA-MM-GG
  kronos: number;
  tecnica: { punteggio: number; pattern: string[] };
  motivo: string;
  stato: "attiva" | "comprata" | "scaduta" | "svanita";
}

export interface EsplorazioneFile {
  versione: 1;
  giorno: string; // giorno dei titoli esaminati
  ultimoGiro: string | null; // ISO
  esaminati: string[]; // oggi
  scoperte: Scoperta[];
  ultimoEsito: string | null;
}

export const esplorazionePath = (stateDir: string) => join(stateDir, "esplorazione.json");
const isFile = (v: unknown): v is EsplorazioneFile => isObject(v) && v.versione === 1 && Array.isArray(v.scoperte) && Array.isArray(v.esaminati);
export function readEsplorazione(stateDir: string, today: string): EsplorazioneFile {
  const r = readJson(esplorazionePath(stateDir), isFile);
  const f: EsplorazioneFile = r.kind === "ok" ? r.value : { versione: 1, giorno: today, ultimoGiro: null, esaminati: [], scoperte: [], ultimoEsito: null };
  if (f.giorno !== today) {
    f.giorno = today;
    f.esaminati = [];
  }
  return f;
}
export const writeEsplorazione = (stateDir: string, f: EsplorazioneFile) => writeJsonAtomic(esplorazionePath(stateDir), f);

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Le scoperte ancora attive (non scadute, non comprate, non svanite): i loro titoli stanno nell'universo.
export const attive = (f: EsplorazioneFile, today: string) => f.scoperte.filter((s) => s.stato === "attiva" && s.validaFino >= today);

// Il radar: tutto quello che il motore non segue già.
export function radar(universe: string[], cryptoFuori: string[] = []): string[] {
  const inU = new Set(universe);
  return [...Object.keys(RADAR_SECTORS), ...cryptoFuori].filter((s) => !inU.has(s));
}

// Il filtro tecnico, con le regole del motore: sopra la media a 200, momentum a 12 mesi positivo, lettura del grafico.
export function technicalGate(closes: number[] | undefined): { ok: boolean; contro?: boolean; tecnica: { punteggio: number; pattern: string[] }; motivo: string } {
  const none = { punteggio: 0, pattern: [] as string[] };
  if (!closes || closes.length < LIMITS.longSmaDays + 1) return { ok: false, tecnica: none, motivo: "storico insufficiente" };
  const price = closes[closes.length - 1]!;
  const m200 = sma(closes, LIMITS.longSmaDays)!;
  // Sotto la 200 si guarda lo stesso: entra solo se Kronos è netto con probabilità sufficiente (contro tendenza).
  if (price <= m200) return { ok: false, contro: true, tecnica: technicalRead(closes, price), motivo: "sotto la media a 200" };
  const mom = momentum(closes, AGENTS.absMomentum.days);
  if (mom !== null && mom <= AGENTS.absMomentum.min) return { ok: false, tecnica: none, motivo: "momentum a 12 mesi negativo" };
  const t = technicalRead(closes, price);
  if (t.punteggio < AGENTS.esplorazione.minTecnica) return { ok: false, tecnica: t, motivo: `grafico debole (${Math.round(t.punteggio * 100)}%)` };
  return { ok: true, tecnica: t, motivo: t.pattern.join(", ") };
}

// Il filtro per l'intraday: il titolo si muove abbastanza in una giornata (volatilità a 20 giorni) per coprire i costi.
export function intradayGate(simbolo: string, closes: number[] | undefined): { ok: boolean; vol: number | null; motivo: string } {
  const v = closes && closes.length >= LIMITS.volLookbackDays + 1 ? dailyVol(closes, LIMITS.volLookbackDays) : null;
  const min = isCrypto(simbolo) ? AGENTS.esplorazione.intraday.volMin.crypto : AGENTS.esplorazione.intraday.volMin.azioni;
  if (v === null) return { ok: false, vol: null, motivo: "storico insufficiente" };
  if (v < min) return { ok: false, vol: v, motivo: `volatilità giornaliera ${pct(v)} sotto ${pct(min)}: si muove troppo poco per l'intraday` };
  return { ok: true, vol: v, motivo: `volatilità giornaliera ${pct(v)}: si muove abbastanza per l'intraday` };
}

// Chi va a cercare: gli agenti in pausa, gli investitori prima (custodi e operatori intraday), poi gli altri.
function scoutFor(simbolo: string, presenti: Presenza[], busy: Set<string>): Presenza | null {
  // Chi è in formazione impara, non esplora; tra gli altri prima i trading agents liberi dello staff.
  const free = presenti.filter((p) => !busy.has(p.chiave) && !p.formazione);
  const staff = free.find((p) => p.chiave.startsWith("p:") && p.reparto !== "intraday");
  if (staff) return staff;
  const sec = sectorOf(simbolo);
  const same = (p: Presenza) => (p.chiave.startsWith("c:") || p.chiave.startsWith("i:")) && sectorOf(p.chiave.slice(2)) === sec;
  const sameClass = (p: Presenza) => (p.chiave.startsWith("c:") || p.chiave.startsWith("i:")) && isCrypto(p.chiave.slice(2)) === isCrypto(simbolo);
  return free.find(same) ?? free.find(sameClass) ?? free.find((p) => p.chiave.startsWith("c:") || p.chiave.startsWith("i:")) ?? free[0] ?? null;
}
// Chi trova il titolo lo vota col suo ruolo: un trading agent (persona dello staff o vecchia postazione c:) come trading
// agent di quel titolo, un intraday agent come intraday, un agente generale col suo nome.
const agentOf = (p: Presenza, simbolo: string) => (p.chiave.startsWith("p:") ? (p.reparto === "intraday" ? "intraday" : `custode ${simbolo}`) : p.chiave.startsWith("c:") ? `custode ${p.chiave.slice(2)}` : p.chiave.startsWith("i:") ? "intraday" : p.nome);

export interface GiroEsplorazione {
  esaminati: string[];
  nuove: Scoperta[];
  scartati: { simbolo: string; motivo: string }[];
  bars: Record<string, Bar[]>;
  previsioni: Record<string, number>;
  messaggio: string;
}

// Un giro di esplorazione: prende i prossimi titoli del radar, legge le candele, filtra, chiede a Kronos, assegna.
export async function explore(input: {
  now: Date;
  today: string;
  file: EsplorazioneFile;
  presenti: Presenza[];
  universe: string[];
  cryptoFuori: string[];
  getBars: (symbols: string[]) => Promise<Record<string, Bar[]>>;
  forecast: ((symbols: string[], bars: Record<string, Bar[]>) => Promise<Record<string, number>>) | null;
}): Promise<GiroEsplorazione | null> {
  const c = AGENTS.esplorazione;
  const f = input.file;
  if (!c.enabled || !input.presenti.length) return null;
  if (f.ultimoGiro && input.now.getTime() - Date.parse(f.ultimoGiro) < c.everyMinutes * 60_000) return null;
  const oggi = f.scoperte.filter((s) => s.trovata.slice(0, 10) === input.today).length;
  if (oggi >= c.maxScoperte) return null;
  const done = new Set(f.esaminati);
  const queue = radar(input.universe, input.cryptoFuori).filter((s) => !done.has(s));
  f.ultimoGiro = input.now.toISOString();
  // Radar finito: si ricomincia da capo (i prezzi cambiano durante la giornata; Kronos resta quello di oggi).
  if (!queue.length) {
    f.esaminati = [];
    queue.push(...radar(input.universe, input.cryptoFuori));
    if (!queue.length) {
      f.ultimoEsito = "radar vuoto: tutti i titoli sono già seguiti";
      return { esaminati: [], nuove: [], scartati: [], bars: {}, previsioni: {}, messaggio: f.ultimoEsito };
    }
  }
  const batch = queue.slice(0, c.perGiro);
  const bars = await input.getBars(batch); // se fallisce si riprova al prossimo giro di esplorazione
  f.esaminati.push(...batch);
  const scartati: GiroEsplorazione["scartati"] = [];
  const passa: string[] = [];
  const intraday = AGENTS.puntaIntraday;
  for (const s of batch) {
    if (intraday) {
      const gi = intradayGate(s, bars[s]?.map((b) => b.close));
      if (gi.ok) passa.push(s);
      else scartati.push({ simbolo: s, motivo: gi.motivo });
      continue;
    }
    const g = technicalGate(bars[s]?.map((b) => b.close));
    if (g.ok || (g.contro && AGENTS.kronos.controTendenza.enabled)) passa.push(s);
    else scartati.push({ simbolo: s, motivo: g.motivo });
  }
  let previsioni: Record<string, number> = {};
  if (passa.length && input.forecast) {
    try {
      previsioni = await input.forecast(passa, bars);
    } catch (e) {
      for (const s of passa) scartati.push({ simbolo: s, motivo: `Kronos non disponibile: ${(e as Error).message}` });
      passa.length = 0;
    }
  } else if (passa.length) for (const s of passa.splice(0)) scartati.push({ simbolo: s, motivo: "senza Kronos non si entra" });
  const nuove: Scoperta[] = [];
  // Con il motore intraday lo scopritore non resta alla scrivania (non vota): può scoprire ancora.
  const busy = new Set(intraday ? [] : attive(f, input.today).map((s) => s.scopritore));
  for (const s of passa) {
    const fc = previsioni[s];
    if (fc === undefined || !Number.isFinite(fc)) scartati.push({ simbolo: s, motivo: "nessuna proiezione" });
    else if (!plausibile(fc, bars[s]?.map((b) => b.close))) scartati.push({ simbolo: s, motivo: `proiezione fuori misura (${pct(fc)}): oltre ${AGENTS.kronos.zMax} volte la volatilità del titolo` });
    else if (intraday && fc <= -AGENTS.kronos.anticipaSoglia) scartati.push({ simbolo: s, motivo: `Kronos a ${AGENTS.kronos.horizon} sedute ${pct(fc)}: calo netto, niente intraday al rialzo` });
    else if (intraday) {
      if (oggi + nuove.length >= c.maxScoperte) break;
      const who = scoutFor(s, input.presenti, busy);
      if (!who) break;
      busy.add(who.chiave);
      const gi = intradayGate(s, bars[s]!.map((b) => b.close));
      nuove.push({ simbolo: s, settore: sectorOf(s), scopritore: who.chiave, agente: "intraday", trovata: input.now.toISOString(), validaFino: addDays(input.today, c.giorniValida - 1), kronos: fc, tecnica: { punteggio: 0, pattern: [] }, motivo: `per l'intraday: ${gi.motivo}; Kronos a ${AGENTS.kronos.horizon} sedute ${pct(fc)}, non contrario: lo valutano gli intraday agents sulle candele`, stato: "attiva" });
    }
    else if (fc < AGENTS.kronos.anticipaSoglia) scartati.push({ simbolo: s, motivo: `Kronos ${pct(fc)}: nessun rialzo oltre la soglia` });
    else if (technicalGate(bars[s]!.map((b) => b.close)).contro && !controTendenza(bars[s]!.map((b) => b.close), fc).ok) scartati.push({ simbolo: s, motivo: `sotto la media a 200: ${controTendenza(bars[s]!.map((b) => b.close), fc).motivo}` });
    else {
      if (oggi + nuove.length >= c.maxScoperte) break;
      const who = scoutFor(s, input.presenti, busy);
      if (!who) break;
      busy.add(who.chiave);
      const g = technicalGate(bars[s]!.map((b) => b.close));
      nuove.push({
        simbolo: s, settore: sectorOf(s), scopritore: who.chiave, agente: agentOf(who, s), trovata: input.now.toISOString(), validaFino: addDays(input.today, c.giorniValida - 1), kronos: fc, tecnica: g.tecnica,
        motivo: `${g.contro ? `contro tendenza (sotto la media a 200, ${controTendenza(bars[s]!.map((b) => b.close), fc).motivo.replace(/^Kronos [^ ]+ /, "")})` : `sopra la media a 200, ${g.tecnica.pattern.slice(0, 2).join(", ") || "grafico in ordine"}`}; Kronos anticipa ${pct(fc)} a ${AGENTS.kronos.horizon} sedute`,
        stato: "attiva",
      });
    }
  }
  f.scoperte.push(...nuove);
  // Tieni il file corto: le scoperte chiuse da più di una settimana si dimenticano.
  const keep = addDays(input.today, -7);
  f.scoperte = f.scoperte.filter((s) => s.stato === "attiva" || s.trovata.slice(0, 10) >= keep);
  const messaggio = `esplorati ${batch.join(", ")}: ${nuove.length ? `trovati ${nuove.map((n) => `${n.simbolo} (Kronos ${pct(n.kronos)}, da ${n.agente})`).join(", ")}` : "nessuna opportunità"}${scartati.length ? ` · scartati: ${scartati.map((x) => `${x.simbolo} ${x.motivo}`).join("; ")}` : ""}`;
  f.ultimoEsito = messaggio;
  return { esaminati: batch, nuove, scartati, bars, previsioni, messaggio };
}

// A ogni giro: le scoperte si ricontrollano (comprate, scadute, svanite) e lo scopritore vota quelle che reggono.
export function scoutVotes(f: EsplorazioneFile, v: AgentView, reports: Record<string, AgentReport>): { note: string[]; esploratori: Map<string, string> } {
  const note: string[] = [];
  const esploratori = new Map<string, string>();
  const held = new Set(v.positions.filter((p) => p.qty > 0).map((p) => p.symbol));
  for (const s of f.scoperte) {
    if (s.stato !== "attiva") continue;
    if (s.validaFino < v.today) {
      s.stato = "scaduta";
      note.push(`esplorazione: ${s.simbolo} scaduta senza ingresso, esce dal radar`);
      continue;
    }
    if (held.has(s.simbolo)) {
      s.stato = "comprata";
      note.push(`esplorazione: ${s.simbolo} comprato; da ora lo segue ${AGENTS.puntaIntraday ? "l'intraday agent che l'ha preso" : "il suo custode"}`);
      continue;
    }
    const fc = v.previsioni?.[s.simbolo];
    const c = v.closes[s.simbolo];
    // Motore che punta all'intraday: nessun voto di più giorni (non aprirebbe nulla); il titolo resta nell'universo e lo
    // valutano gli intraday agents sulle candele. Si lascia solo con un calo netto di Kronos a 5 sedute, e mai se in questo
    // giro gli intraday agents lo hanno votato (prima NOW, votato al 75%, usciva dall'universo nello stesso giro).
    if (AGENTS.puntaIntraday) {
      const votato = (reports.intraday?.segnali ?? []).some((x) => x.simbolo === s.simbolo && x.lato === "buy");
      if (fc !== undefined && fc <= -AGENTS.kronos.anticipaSoglia && !votato) {
        s.stato = "svanita";
        note.push(`esplorazione: ${s.simbolo} lasciato, Kronos a ${AGENTS.kronos.horizon} sedute ora vede ${pct(fc)}`);
      }
      continue;
    }
    const m200 = c ? sma(c, LIMITS.longSmaDays) : null;
    const price = v.prices[s.simbolo] ?? c?.[c.length - 1];
    if (fc !== undefined && fc < AGENTS.kronos.anticipaSoglia) {
      s.stato = "svanita";
      note.push(`esplorazione: ${s.simbolo} lasciato, Kronos ora vede ${pct(fc)}`);
      continue;
    }
    const k = fc ?? s.kronos;
    const contro = m200 !== null && price !== undefined && price <= m200;
    if (contro && !controTendenza(c, k).ok) {
      s.stato = "svanita";
      note.push(`esplorazione: ${s.simbolo} lasciato, sotto la media a 200 senza Kronos abbastanza netto (${controTendenza(c, k).motivo})`);
      continue;
    }
    const forza = Math.min(1, (0.5 + k * 5) * (0.75 + 0.25 * s.tecnica.punteggio));
    const sig: Signal = { agente: s.agente, simbolo: s.simbolo, lato: "buy", forza, orizzonteSedute: AGENTS.kronos.horizon, kronos: k, ...(contro ? { pesoMassimo: pesoControTendenza() } : {}), perche: `esplorazione dalla sala caffè: ${s.simbolo} ${s.motivo.replace(/Kronos anticipa [^;]+/, `Kronos anticipa ${pct(k)} a ${AGENTS.kronos.horizon} sedute`)}` };
    const home = s.agente.startsWith("custode ") ? "custodi" : s.agente === "intraday" ? "intraday" : s.scopritore.slice(2);
    (reports[home] ??= { segnali: [] }).segnali.push(sig);
    esploratori.set(s.scopritore, `opera su ${s.simbolo} (scoperto in sala caffè)`);
  }
  return { note, esploratori };
}
