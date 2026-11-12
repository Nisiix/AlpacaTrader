import { join } from "node:path";
import { getPath, paramOf, validate } from "../agent-settings.ts";
import { AGENTS } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { JournalFile, Trade } from "../journal.ts";
import { chiavePersona, leggiRegistro, nomeDi, type Reparto } from "./persone.ts";

// Il profilo di ogni persona dello staff: le sue impostazioni, a sé stanti. Riguardano solo come la persona sceglie
// (quanto è selettiva) e quanto investe (taglia): le regole del mercato (medie del trend, finestre di momentum, uscite
// del rientro) sono del motore, uguali per tutti, così un trade si gestisce con le stesse regole con cui è stato aperto.
// Partono da quelle di serie e si cambiano a mano dalla scheda, con la calibrazione del capo sulla soglia d'ingresso e
// con la ricalibrazione in sala caffè (dopo una prova in ombra). L'obiettivo del giorno sale dopo i successi e scende
// dopo i fallimenti. Valgono sul titolo su cui la persona lavora. Kronos resta quello generale, uguale per tutti.

export const PERSONALI: Record<Reparto, string[]> = {
  trading: ["AGENTS.custodi.minProbabilita", "AGENTS.custodi.extendedPct", "AGENTS.pullback.rsiEntry", "AGENTS.pullback.maxWeight"],
  intraday: ["AGENTS.intraday.kronos.minProb", "AGENTS.intraday.maxWeight"],
};
// Ogni persona ha tutte e due le serie: può prendere un'operazione di più giorni o una intraday.
export const TUTTI_PERSONALI = [...PERSONALI.trading, ...PERSONALI.intraday];
export const tipoDi = (chiave: string): Reparto => (PERSONALI.intraday.includes(chiave) ? "intraday" : "trading");
// La chiave della calibrazione personale per tipo d'operazione: p:Nome (più giorni), p:Nome|intraday.
export const chiaveCalibrazione = (p: string, tipo: Reparto) => (tipo === "intraday" ? `${p}|intraday` : p);
// La soglia che la calibrazione del capo sposta per ogni persona (un passo = più selettiva).
export const CALIBRATA: Record<Reparto, { chiave: string; passo: number; limite: number }> = {
  trading: { chiave: "AGENTS.custodi.minProbabilita", passo: 0.025, limite: 0.75 },
  intraday: { chiave: "AGENTS.intraday.kronos.minProb", passo: 0.025, limite: 0.7 },
};
// Obiettivo del giorno personale: di serie 10%, +1 punto dopo un giorno in cui l'ha toccato, −1 dopo un giorno chiuso in
// perdita; tra 3% e 25%. La difesa scatta se, toccato l'obiettivo, il guadagno dei suoi trade torna a metà.
export const OBIETTIVO = { diSerie: 0.1, passo: 0.01, min: 0.03, max: 0.25, pavimento: 0.5 };

interface Giorno { data: string; picco: number; pct: number; trade: number }
export interface Profilo {
  valori: Record<string, unknown>; // impostazioni cambiate a mano
  obiettivo: number;
  giorno?: Giorno;
  storia: { data: string; pct: number; obiettivo: number; esito: "successo" | "fallimento" | "pari" }[];
  ricalibrazioni?: { quando: string; motivo: string; cambi: string[] }[]; // fatte in sala caffè
  // Prova in ombra: impostazioni proposte in sala caffè, non ancora in uso; si adottano solo se sui trade chiusi da `dal`
  // in poi avrebbero fatto meglio di quelle in uso.
  prova?: { valori: Record<string, number>; base: Record<string, number>; dal: string; scade: string; motivo: string; cambi: string[] };
}
interface File { versione: 1; persone: Record<string, Profilo> }
const percorso = (stateDir: string) => join(stateDir, "profili.json");
export function leggiProfili(stateDir: string): File {
  const r = readJson(percorso(stateDir), (v): v is File => isObject(v) && v.versione === 1 && isObject(v.persone));
  return r.kind === "ok" ? r.value : { versione: 1, persone: {} };
}
const nuovo = (): Profilo => ({ valori: {}, obiettivo: OBIETTIVO.diSerie, storia: [] });
const profiloDi = (f: File, p: string) => (f.persone[p] ??= nuovo());

// Le impostazioni in vigore, per titolo: quelle della persona che ci lavora (giro per giro).
let perSimbolo: Record<string, Record<string, unknown>> = {};
export function valore<T = number>(chiave: string, simbolo: string): T {
  const v = perSimbolo[simbolo]?.[chiave];
  return (v !== undefined ? v : getPath(chiave)) as T;
}

// Passi di calibrazione personali (dal file del capo, chiavi p:Nome).
function passiCalibrazione(stateDir: string): Record<string, number> {
  const r = readJson(join(stateDir, "calibrazione.json"), (v): v is { voci: Record<string, { passi: number }> } => isObject(v) && isObject(v.voci));
  const out: Record<string, number> = {};
  if (r.kind === "ok") for (const [k, v] of Object.entries(r.value.voci)) if (k.startsWith("p:") && v.passi) out[k] = v.passi; // p:Nome e p:Nome|intraday
  return out;
}

// Il valore calibrato: la base della persona (a mano o di serie) più i passi, mai oltre il limite né i limiti della scheda.
export function calibrato(base: number, passi: number, rep: Reparto): number {
  const c = CALIBRATA[rep];
  const p = paramOf(c.chiave);
  let v = Math.min(base + passi * c.passo, Math.max(c.limite, base));
  if (p?.min !== undefined) v = Math.max(v, p.min);
  if (p?.max !== undefined) v = Math.min(v, p.max);
  return Math.round(v * 10000) / 10000;
}

// Le impostazioni di una persona: per ogni parametro valore di squadra, personale (a mano), calibrato e in vigore.
export function impostazioniDi(stateDir: string, p: string) {
  const reg = leggiRegistro(stateDir);
  const prof = leggiProfili(stateDir).persone[p] ?? nuovo();
  const tuttiPassi = passiCalibrazione(stateDir);
  return {
    reparto: reg.staff[nomeDi(p)]?.reparto ?? null,
    simbolo: reg.staff[nomeDi(p)]?.simbolo ?? null,
    parametri: TUTTI_PERSONALI.map((chiave) => {
      const par = paramOf(chiave)!;
      const tipo = tipoDi(chiave);
      const squadra = getPath(chiave);
      const personale = prof.valori[chiave];
      const base = personale !== undefined ? personale : squadra;
      const passi = chiave === CALIBRATA[tipo].chiave ? (tuttiPassi[chiaveCalibrazione(p, tipo)] ?? 0) : 0;
      const attuale = passi ? calibrato(Number(base), passi, tipo) : base;
      return { ...par, gruppo: tipo === "intraday" ? "Operazioni intraday" : "Operazioni di più giorni", squadra, personale: personale ?? null, passi, attuale, cambiato: personale !== undefined };
    }),
    obiettivo: { attuale: prof.obiettivo, diSerie: OBIETTIVO.diSerie, min: OBIETTIVO.min, max: OBIETTIVO.max, storia: prof.storia.slice(-10), giorno: prof.giorno ?? null },
    ricalibrazioni: (prof.ricalibrazioni ?? []).slice(-5),
    prova: prof.prova ?? null,
  };
}

// Salva le impostazioni cambiate a mano (vuoto = torna come la squadra) e l'obiettivo del giorno.
export function salvaImpostazioni(stateDir: string, p: string, valori: Record<string, unknown>, obiettivo?: unknown): { ok: true } | { ok: false; errori: string[] } {
  const reg = leggiRegistro(stateDir);
  const m = reg.staff[nomeDi(p)];
  if (!m) return { ok: false, errori: [`persona sconosciuta: ${nomeDi(p)}`] };
  const ammessi = new Set(TUTTI_PERSONALI);
  const errori: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valori)) {
    if (!ammessi.has(k)) { errori.push(`${k}: non è un'impostazione personale`); continue; }
    if (v === null || v === undefined || v === "") continue;
    const r = validate(k, v);
    if (!r.ok) { errori.push(r.errore); continue; }
    if (r.value !== getPath(k)) out[k] = r.value;
  }
  let ob: number | undefined;
  if (obiettivo !== undefined && obiettivo !== null && obiettivo !== "") {
    const n = Number(obiettivo);
    if (!Number.isFinite(n) || n < OBIETTIVO.min || n > OBIETTIVO.max) errori.push(`Obiettivo del giorno: tra ${OBIETTIVO.min * 100}% e ${OBIETTIVO.max * 100}%`);
    else ob = n;
  }
  if (errori.length) return { ok: false, errori };
  const f = leggiProfili(stateDir);
  const prof = profiloDi(f, p);
  prof.valori = out;
  if (ob !== undefined) prof.obiettivo = ob;
  writeJsonAtomic(percorso(stateDir), f);
  return { ok: true };
}

// A ogni giro: le impostazioni in vigore per titolo, dalle persone che ci lavorano (assegnazioni del giro prima).
export function preparaProfili(stateDir: string): void {
  const reg = leggiRegistro(stateDir);
  const f = leggiProfili(stateDir);
  const passi = passiCalibrazione(stateDir);
  const voci = readJson(join(stateDir, "calibrazione.json"), (v): v is { voci: Record<string, { passi: number }> } => isObject(v) && isObject(v.voci));
  const squadra: Partial<Record<Reparto, number>> = voci.kind === "ok" ? { trading: voci.value.voci["custodi (squadra)"]?.passi ?? 0, intraday: voci.value.voci["intraday"]?.passi ?? 0 } : {};
  perSimbolo = {};
  for (const [n, m] of Object.entries(reg.staff)) {
    if (!m.simbolo) continue;
    const p = chiavePersona(n);
    const valori: Record<string, unknown> = Object.fromEntries(Object.entries(f.persone[p]?.valori ?? {}).filter(([k]) => TUTTI_PERSONALI.includes(k)));
    for (const tipo of ["trading", "intraday"] as Reparto[]) {
      // Tetto: i passi della persona più quelli della sua squadra non superano maxPassiTotali.
      const cal = CALIBRATA[tipo]; const n = Math.min(passi[chiaveCalibrazione(p, tipo)] ?? 0, Math.max(0, AGENTS.apprendimento.maxPassiTotali - (squadra[tipo] ?? 0)));
      if (n) valori[cal.chiave] = calibrato(Number(valori[cal.chiave] ?? getPath(cal.chiave)), n, tipo);
    }
    perSimbolo[m.simbolo] = { ...(perSimbolo[m.simbolo] ?? {}), ...valori };
  }
}

// La giornata di ogni persona: guadagno dei suoi trade di oggi (chiusi oggi o aperti) sul capitale che ci ha messo,
// massimo toccato, obiettivo e difesa. Al cambio di giorno l'obiettivo si aggiusta con l'esito di ieri.
export interface GiornataPersona { pct: number; pnl: number; capitale: number; picco: number; obiettivo: number; raggiunto: boolean; difesa: boolean; trade: number }
// La giornata parte dall'inizio del giorno: per un trade aperto prima di oggi il punto di partenza è l'ultima chiusura
// giornaliera (`inizio`), non il prezzo d'ingresso, così i guadagni dei giorni passati non contano come guadagni di oggi.
export function giornataPersone(stateDir: string, journal: JournalFile, prezzi: Record<string, number>, today: string, giornoDi: (iso: string) => string, inizio: (simbolo: string) => number | undefined = () => undefined): { perPersona: Record<string, GiornataPersona>; difesa: Record<string, string>; note: string[] } {
  const f = leggiProfili(stateDir);
  const note: string[] = [];
  const perPersona: Record<string, GiornataPersona> = {};
  const difesa: Record<string, string> = {};
  let cambiato = false;
  const attivi = journal.trade.filter((t) => t.contesto?.persone?.some((p) => p.startsWith("p:")) && (t.stato === "aperto" || (t.chiusoIl && giornoDi(t.chiusoIl) === today)));
  const per = new Map<string, Trade[]>();
  for (const t of attivi) for (const p of t.contesto!.persone!) if (p.startsWith("p:")) per.set(p, [...(per.get(p) ?? []), t]);
  // Cambio di giorno: l'esito di ieri aggiusta l'obiettivo.
  for (const [p, prof] of Object.entries(f.persone)) {
    if (!prof.giorno || prof.giorno.data === today) continue;
    const g = prof.giorno;
    const esito: Profilo["storia"][number]["esito"] = g.trade && g.picco >= prof.obiettivo ? "successo" : g.trade && g.pct < 0 ? "fallimento" : "pari";
    const prima = prof.obiettivo;
    if (esito === "successo") prof.obiettivo = Math.min(OBIETTIVO.max, Math.round((prof.obiettivo + OBIETTIVO.passo) * 1000) / 1000);
    if (esito === "fallimento") prof.obiettivo = Math.max(OBIETTIVO.min, Math.round((prof.obiettivo - OBIETTIVO.passo) * 1000) / 1000);
    if (g.trade) prof.storia = [...prof.storia, { data: g.data, pct: g.pct, obiettivo: prima, esito }].slice(-30);
    if (prima !== prof.obiettivo) note.push(`${nomeDi(p)}: obiettivo del giorno ${Math.round(prima * 100)}% → ${Math.round(prof.obiettivo * 100)}% dopo ${esito === "successo" ? "un giorno in cui l'ha toccato" : "un giorno chiuso in perdita"}`);
    delete prof.giorno;
    cambiato = true;
  }
  for (const [p, ts] of per) {
    let capitale = 0, pnl = 0;
    for (const t of ts) {
      const carico = t.costo / Math.max(t.comprate, 1e-9);
      const ora = prezzi[t.simbolo] ?? carico;
      const diOggi = giornoDi(t.apertoIl) === today;
      const base = diOggi ? carico : (inizio(t.simbolo) ?? carico);
      if (t.stato === "aperto") {
        const q = t.quantita;
        capitale += diOggi ? t.costo : q * base;
        pnl += diOggi ? t.incassato + q * ora - t.costo : q * (ora - base);
      } else {
        capitale += diOggi ? t.costo : t.vendute * base;
        pnl += diOggi ? t.incassato - t.costo : t.incassato - t.vendute * base;
      }
    }
    const pct = capitale > 0 ? pnl / capitale : 0;
    const prof = profiloDi(f, p);
    const picco = Math.max(prof.giorno?.data === today ? prof.giorno.picco : 0, pct);
    if (!prof.giorno || prof.giorno.data !== today || prof.giorno.picco !== picco || Math.abs(prof.giorno.pct - pct) > 1e-6 || prof.giorno.trade !== ts.length) {
      prof.giorno = { data: today, picco, pct, trade: ts.length };
      cambiato = true;
    }
    const raggiunto = AGENTS.daily.enabled && picco >= prof.obiettivo;
    const inDifesa = raggiunto && pct <= prof.obiettivo * OBIETTIVO.pavimento;
    perPersona[p] = { pct, pnl, capitale, picco, obiettivo: prof.obiettivo, raggiunto, difesa: inDifesa, trade: ts.length };
    if (inDifesa) for (const t of ts.filter((t) => t.stato === "aperto")) difesa[t.simbolo] = `${nomeDi(p)} ha toccato il suo obiettivo del giorno (${(picco * 100).toFixed(1)}% ≥ ${Math.round(prof.obiettivo * 100)}%) ed è tornato a ${(pct * 100).toFixed(1)}%, sotto metà obiettivo`;
  }
  if (cambiato) writeJsonAtomic(percorso(stateDir), f);
  return { perPersona, difesa, note };
}

// La ricalibrazione in sala caffè: nuovi valori personali (nei limiti della scheda), con il motivo. Restituisce i cambi.
export function ricalibraPersona(stateDir: string, p: string, nuovi: Record<string, unknown>, motivo: string, now: Date): string[] {
  const f = leggiProfili(stateDir);
  const prof = profiloDi(f, p);
  const cambi: string[] = [];
  for (const [k, v] of Object.entries(nuovi)) {
    const r = validate(k, v);
    if (!r.ok) continue;
    const prima = prof.valori[k] ?? getPath(k);
    if (r.value === prima) continue;
    if (r.value === getPath(k)) delete prof.valori[k];
    else prof.valori[k] = r.value;
    const par = paramOf(k)!;
    const fmt = (x: unknown) => (par.tipo === "percento" ? `${Math.round(Number(x) * 1000) / 10}%` : String(x));
    cambi.push(`${par.etichetta}: ${fmt(prima)} → ${fmt(r.value)}`);
  }
  if (cambi.length) {
    prof.ricalibrazioni = [...(prof.ricalibrazioni ?? []), { quando: now.toISOString(), motivo, cambi }].slice(-10);
    writeJsonAtomic(percorso(stateDir), f);
  }
  return cambi;
}
// I valori in vigore di una persona (personali o di serie), per i parametri del suo reparto.
export function valoriDi(stateDir: string, p: string, rep: Reparto): Record<string, number> {
  const prof = leggiProfili(stateDir).persone[p];
  return Object.fromEntries(PERSONALI[rep].map((k) => [k, Number(prof?.valori[k] ?? getPath(k))]));
}

// ---------- Prova in ombra ----------
// Le impostazioni ricalibrate in sala caffè non valgono subito (sarebbe scegliere la variante andata meglio per caso):
// restano in prova e si confrontano con quelle in uso sui trade che si chiudono da quel momento (fuori campione), con le
// misure salvate all'ingresso: con le nuove soglie quel trade sarebbe stato preso? con la nuova taglia quanto avrebbe
// reso? Dopo almeno PROVA.minTrade trade del tipo interessato si adottano se il risultato è almeno pari, altrimenti si
// scartano; senza abbastanza trade entro PROVA.giorni si scartano.
export const PROVA = { minTrade: 15, giorni: 30 };
const fmtValore = (k: string, x: unknown) => (paramOf(k)?.tipo === "percento" ? `${Math.round(Number(x) * 1000) / 10}%` : String(x));

export function proponiProva(stateDir: string, p: string, nuovi: Record<string, number>, motivo: string, now: Date): string[] {
  const f = leggiProfili(stateDir);
  const prof = profiloDi(f, p);
  const attuali = { ...valoriDi(stateDir, p, "trading"), ...valoriDi(stateDir, p, "intraday") };
  const valori: Record<string, number> = {}, base: Record<string, number> = {};
  const cambi: string[] = [];
  for (const [k, v] of Object.entries(nuovi)) {
    if (!TUTTI_PERSONALI.includes(k) || !validate(k, v).ok || v === attuali[k]) continue;
    valori[k] = v; base[k] = attuali[k]!;
    cambi.push(`${paramOf(k)!.etichetta}: ${fmtValore(k, attuali[k])} → ${fmtValore(k, v)}`);
  }
  if (!cambi.length) return [];
  prof.prova = { valori, base, dal: now.toISOString(), scade: new Date(now.getTime() + PROVA.giorni * 86_400_000).toISOString(), motivo, cambi };
  writeJsonAtomic(percorso(stateDir), f);
  return cambi;
}

// Con queste impostazioni il trade sarebbe stato preso, e con che taglia (rispetto a quella usata)?
function conImpostazioni(t: Trade, set: Record<string, number>, usate: Record<string, number>): number | null {
  const m = t.contesto?.misure ?? {};
  const intraday = (t.contesto?.tipo ?? (t.contesto?.livelli ? "intraday" : "trading")) === "intraday";
  if (intraday) {
    if (m.probabilita !== undefined && set["AGENTS.intraday.kronos.minProb"] !== undefined && m.probabilita < set["AGENTS.intraday.kronos.minProb"]!) return null;
    const k = "AGENTS.intraday.maxWeight";
    return set[k] !== undefined && usate[k] ? set[k]! / usate[k]! : 1;
  }
  if (m.probabilita !== undefined && set["AGENTS.custodi.minProbabilita"] !== undefined && m.probabilita < set["AGENTS.custodi.minProbabilita"]!) return null;
  const dist = t.contesto?.distanzaMedia;
  if (dist !== null && dist !== undefined && set["AGENTS.custodi.extendedPct"] !== undefined && dist > set["AGENTS.custodi.extendedPct"]!) return null;
  const rientro = t.contesto?.agenti?.length === 1 && t.contesto.agenti[0] === "rientro";
  if (rientro && m.rsi2 !== undefined && set["AGENTS.pullback.rsiEntry"] !== undefined && m.rsi2 >= set["AGENTS.pullback.rsiEntry"]!) return null;
  const k = "AGENTS.pullback.maxWeight";
  return rientro && set[k] !== undefined && usate[k] ? set[k]! / usate[k]! : 1;
}

export function valutaProve(stateDir: string, journal: JournalFile, now: Date): string[] {
  const f = leggiProfili(stateDir);
  const note: string[] = [];
  let cambiato = false;
  for (const [p, prof] of Object.entries(f.persone)) {
    const pr = prof.prova;
    if (!pr) continue;
    const tipi = new Set(Object.keys(pr.valori).map(tipoDi));
    const ts = journal.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl && t.chiusoIl > pr.dal && tipi.has(t.contesto?.tipo ?? (t.contesto?.livelli ? "intraday" : "trading")));
    if (ts.length < PROVA.minTrade) {
      if (now.toISOString() > pr.scade) { delete prof.prova; cambiato = true; note.push(`${nomeDi(p)}: prova in ombra scartata (solo ${ts.length} trade in ${PROVA.giorni} giorni)`); }
      continue;
    }
    let vecchio = 0, nuovoR = 0;
    for (const t of ts) {
      const r = (t.incassato - t.costo) / Math.max(t.costo, 1e-9);
      const usate = { ...pr.base, ...(t.contesto?.impostazioni ?? {}) };
      const a = conImpostazioni(t, { ...usate, ...pr.base }, usate), b = conImpostazioni(t, { ...usate, ...pr.valori }, usate);
      if (a !== null) vecchio += r * a;
      if (b !== null) nuovoR += r * b;
    }
    const esito = `su ${ts.length} trade: con le nuove ${(nuovoR * 100).toFixed(2)}%, con quelle in uso ${(vecchio * 100).toFixed(2)}%`;
    if (nuovoR >= vecchio) {
      prof.valori = { ...prof.valori, ...pr.valori };
      prof.ricalibrazioni = [...(prof.ricalibrazioni ?? []), { quando: now.toISOString(), motivo: `${pr.motivo}; adottate dopo la prova in ombra (${esito})`, cambi: pr.cambi }].slice(-10);
      note.push(`${nomeDi(p)}: impostazioni della sala caffè adottate dopo la prova in ombra (${esito})`);
    } else note.push(`${nomeDi(p)}: impostazioni della sala caffè scartate dopo la prova in ombra (${esito})`);
    delete prof.prova;
    cambiato = true;
  }
  if (cambiato) writeJsonAtomic(percorso(stateDir), f);
  return note;
}
