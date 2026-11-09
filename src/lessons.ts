import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "./config.ts";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";
import { addDays } from "./slots.ts";

// Il registro degli errori: lo scrive il codice, non il modello, e la gabbia lo applica.
export interface Lesson {
  id: string;
  tipo: "stop-loss" | "rifiuto-alpaca" | "statistica";
  simbolo: string; // "*" = qualsiasi titolo con quel tipo di ingresso
  setup?: string;
  campione?: number; // trade chiusi su cui si basa una lezione statistica
  lato: "buy" | "sell"; // il lato bloccato
  dal: string; // YYYY-MM-DD
  finoAl: string; // incluso
  // Pausa a ore (stop loss, rifiuti di Alpaca): vale fino a questo istante invece che fino a fine giornata di finoAl.
  finoAlle?: string;
  motivo: string;
}

export interface RejectEvent {
  simbolo: string;
  lato: string;
  data: string;
  errore: string;
}

export interface LessonsFile {
  versione: 1;
  lezioni: Lesson[];
  rifiuti: RejectEvent[];
}

const isLessonsFile = (v: unknown): v is LessonsFile => isObject(v) && v.versione === 1 && Array.isArray(v.lezioni) && Array.isArray(v.rifiuti);

export const lessonsPath = (stateDir: string) => join(stateDir, "lessons.json");
export const emptyLessons = (): LessonsFile => ({ versione: 1, lezioni: [], rifiuti: [] });

// Un registro rotto si mette da parte (non si cancella) e si riparte vuoti, dicendolo.
export function readLessons(stateDir: string, now: Date): { file: LessonsFile; problem?: string } {
  const p = lessonsPath(stateDir);
  const r = readJson(p, isLessonsFile);
  if (r.kind === "ok") return { file: r.value };
  if (r.kind === "missing") return { file: emptyLessons() };
  const aside = `${p}.illeggibile-${now.getTime()}`;
  try {
    if (existsSync(p)) renameSync(p, aside);
  } catch {}
  return { file: emptyLessons(), problem: `registro degli errori illeggibile (${r.error}), messo da parte in ${aside}: riparto vuoto` };
}

export function writeLessons(stateDir: string, file: LessonsFile) {
  writeJsonAtomic(lessonsPath(stateDir), file);
}

export function activeLessons(file: LessonsFile, today: string, now?: Date): Lesson[] {
  return file.lezioni.filter((l) => (l.finoAlle && now ? Date.parse(l.finoAlle) > now.getTime() : l.finoAl >= today));
}

const ore = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
const oraRoma = (iso: string) => new Date(iso).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });

// Dopo uno stop loss una pausa di qualche ora (non giorni): non si rientra subito in quello che ha appena fatto male;
// dopo, il rientro lo valuta l'agente con più margine (probabilità più alta, proiezione nuova).
export function learnFromStopLoss(file: LessonsFile, id: string, symbol: string, today: string, detail: string, now: Date): Lesson | null {
  if (file.lezioni.some((l) => l.id === id)) return null;
  const fino = ore(now, LIMITS.stopLossPausaOre);
  const l: Lesson = { id, tipo: "stop-loss", simbolo: symbol, lato: "buy", dal: today, finoAl: today, finoAlle: fino, motivo: `stop loss su ${symbol} (${detail}): pausa di ${LIMITS.stopLossPausaOre} ore (fino alle ${oraRoma(fino)}), poi si rientra solo con più margine` };
  file.lezioni.push(l);
  return l;
}

// Le lezioni di sicurezza scritte prima delle pause a ore bloccavano un titolo per giorni: diventano pause a ore che
// partono da adesso (quelle di giorni passati sono già finite). Restituisce true se ha cambiato qualcosa.
export function pauseAOre(file: LessonsFile, today: string, now: Date): boolean {
  let cambiato = false;
  for (const l of file.lezioni) {
    if (l.finoAlle || (l.tipo !== "stop-loss" && l.tipo !== "rifiuto-alpaca") || l.finoAl < today) continue;
    const h = l.tipo === "stop-loss" ? LIMITS.stopLossPausaOre : LIMITS.brokerRejectPausaOre;
    l.finoAlle = l.dal === today ? ore(now, h) : now.toISOString();
    l.finoAl = today;
    l.motivo = l.motivo.replace(/: (niente riacquisto|non ci riprovo) per \d+ giorni di borsa/, `: pausa fino alle ${oraRoma(l.finoAlle)}`);
    cambiato = true;
  }
  return cambiato;
}

// Alpaca rifiuta due volte lo stesso titolo-lato: smettiamo di riprovarci per un po'.
export function learnFromBrokerReject(file: LessonsFile, symbol: string, side: string, today: string, error: string, now: Date): Lesson | null {
  // Rifiuti per quantità (briciole, arrotondamenti, saldo frazionario) sono un nostro errore tecnico, non una lezione sul titolo.
  if (/qty must be|insufficient balance|insufficient qty|fractional|quantità troppo piccola|saldo insufficiente/i.test(error)) return null;
  file.rifiuti.push({ simbolo: symbol, lato: side, data: today, errore: error.slice(0, 200) });
  const since = addDays(today, -LIMITS.brokerRejectWindowDays * 2);
  const same = file.rifiuti.filter((e) => e.simbolo === symbol && e.lato === side && e.data >= since);
  if (same.length < 2) return null;
  if (activeLessons(file, today, now).some((l) => l.simbolo === symbol && l.lato === side)) return null;
  const fino = ore(now, LIMITS.brokerRejectPausaOre);
  const l: Lesson = {
    id: `rifiuto-${symbol}-${side}-${today}`,
    tipo: "rifiuto-alpaca",
    simbolo: symbol,
    lato: side === "sell" ? "sell" : "buy",
    dal: today,
    finoAl: today,
    finoAlle: fino,
    motivo: `Alpaca ha rifiutato ${same.length} volte ${side} ${symbol} (ultimo errore: ${error.slice(0, 80)}): pausa di ${LIMITS.brokerRejectPausaOre} ore (fino alle ${oraRoma(fino)})`,
  };
  file.lezioni.push(l);
  return l;
}

// Tiene il file piccolo: via ciò che è scaduto da più di 60 giorni.
export function pruneLessons(file: LessonsFile, today: string) {
  const cut = addDays(today, -60);
  file.lezioni = file.lezioni.filter((l) => l.finoAl >= cut);
  file.rifiuti = file.rifiuti.filter((e) => e.data >= cut);
}
