import { join } from "node:path";
import { getPath, paramOf, setPath } from "../agent-settings.ts";
import { AGENTS } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { JournalFile } from "../journal.ts";
import { regolaSuperata, SQUADRA_CUSTODI } from "./capo.ts";

// La calibrazione del capo ufficio: quando un agente vince meno del 51% dei suoi trade chiusi, il capo rende più
// selettivo il suo parametro d'ingresso di un passo; quando torna a vincere almeno il 60%, lo riavvicina di un passo al
// valore di base. Mai oltre: il parametro non scende sotto il valore di base (quello di serie o scelto nella scheda)
// e non sale oltre il limite della calibrazione, dentro i limiti della scheda. Dopo ogni passo si giudicano solo i trade
// chiusi da lì in poi (almeno minTrade), così una correzione ha il tempo di dare risultati.
export interface Calibrabile {
  chiave: string; // parametro della scheda
  passo: number; // segno = direzione più selettiva
  limite: number; // valore estremo raggiungibile dalla calibrazione
}

export const CALIBRABILI: Record<string, Calibrabile> = {
  intraday: { chiave: "AGENTS.intraday.kronos.minProb", passo: 0.025, limite: 0.7 },
  [SQUADRA_CUSTODI]: { chiave: "AGENTS.custodi.minProbabilita", passo: 0.05, limite: 0.65 },
  kronos: { chiave: "AGENTS.kronos.controTendenza.minFiducia", passo: 0.05, limite: 0.8 },
  rientro: { chiave: "AGENTS.pullback.rsiEntry", passo: -1, limite: 4 },
};
// Ogni trading agent ha anche la sua soglia personale, sopra quella della squadra.
const PERSONALE: Omit<Calibrabile, "chiave"> = { passo: 0.05, limite: 0.7 };

interface Voce {
  passi: number;
  dal: string; // ISO: da qui si contano i trade per il prossimo giudizio
  motivo: string;
}
interface File {
  versione: 1;
  voci: Record<string, Voce>;
}
export interface RigaCalibrazione {
  agente: string;
  etichetta: string;
  base: number;
  attuale: number;
  passi: number;
  motivo: string;
  dal: string;
}

const percorso = (stateDir: string) => join(stateDir, "calibrazione.json");
function leggi(stateDir: string): File {
  const r = readJson(percorso(stateDir), (v): v is File => isObject(v) && v.versione === 1 && isObject(v.voci));
  return r.kind === "ok" ? r.value : { versione: 1, voci: {} };
}

// Aggiorna le voci dai trade chiusi (una volta per giro, vale dal giro dopo). Restituisce le note dei cambiamenti.
export function aggiornaCalibrazione(stateDir: string, journal: JournalFile, now: Date): string[] {
  const c = AGENTS.calibrazione;
  if (!c.enabled) return [];
  const f = leggi(stateDir);
  const note: string[] = [];
  const chiusi = journal.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl && !regolaSuperata(t));
  const per = new Map<string, typeof chiusi>();
  for (const t of chiusi) {
    const ag = t.contesto?.agenti ?? [];
    for (const a of ag) per.set(a, [...(per.get(a) ?? []), t]);
    if (ag.some((a) => a.startsWith("custode "))) per.set(SQUADRA_CUSTODI, [...(per.get(SQUADRA_CUSTODI) ?? []), t]);
  }
  for (const [agente, ts] of per) {
    if (!CALIBRABILI[agente] && !agente.startsWith("custode ")) continue;
    const v = f.voci[agente] ?? { passi: 0, dal: "", motivo: "" };
    const nuovi = ts.filter((t) => !v.dal || t.chiusoIl! > v.dal);
    if (nuovi.length < c.minTrade) continue;
    const vinti = nuovi.filter((t) => t.incassato - t.costo > 0).length;
    const q = vinti / nuovi.length;
    const max = c.maxPassi;
    if (q < c.obiettivo && v.passi < max) {
      f.voci[agente] = { passi: v.passi + 1, dal: now.toISOString(), motivo: `${vinti} vinti su ${nuovi.length} (${Math.round(q * 100)}%), sotto il ${Math.round(c.obiettivo * 100)}%: ingressi più selettivi di un passo` };
      note.push(`capo ufficio: ${agente} ricalibrato, ${f.voci[agente]!.motivo}`);
    } else if (q >= c.buono && v.passi > 0) {
      f.voci[agente] = { passi: v.passi - 1, dal: now.toISOString(), motivo: `${vinti} vinti su ${nuovi.length} (${Math.round(q * 100)}%): torna di un passo verso il valore di base` };
      note.push(`capo ufficio: ${agente} ricalibrato, ${f.voci[agente]!.motivo}`);
    }
  }
  if (note.length) writeJsonAtomic(percorso(stateDir), f);
  return note;
}

const spingi = (base: number, passi: number, cal: Omit<Calibrabile, "chiave">, chiave: string) => {
  const p = paramOf(chiave);
  let v = base + passi * cal.passo;
  v = cal.passo > 0 ? Math.min(v, Math.max(cal.limite, base)) : Math.max(v, Math.min(cal.limite, base));
  if (p?.min !== undefined) v = Math.max(v, p.min);
  if (p?.max !== undefined) v = Math.min(v, p.max);
  return Math.round(v * 10000) / 10000;
};

// Applica le voci ai parametri del motore (dopo le impostazioni della scheda, a ogni giro). Restituisce le righe per la
// dashboard: valore di base, valore calibrato, passi, motivo.
export function applicaCalibrazione(stateDir: string): RigaCalibrazione[] {
  const f = leggi(stateDir);
  const righe: RigaCalibrazione[] = [];
  AGENTS.custodi.minProbabilitaPer = {};
  if (!AGENTS.calibrazione.enabled) return righe;
  for (const [agente, cal] of Object.entries(CALIBRABILI)) {
    const v = f.voci[agente];
    const base = Number(getPath(cal.chiave));
    const attuale = v?.passi ? spingi(base, v.passi, cal, cal.chiave) : base;
    if (v?.passi) setPath(cal.chiave, attuale);
    righe.push({ agente, etichetta: paramOf(cal.chiave)?.etichetta ?? cal.chiave, base, attuale, passi: v?.passi ?? 0, motivo: v?.motivo ?? "", dal: v?.dal ?? "" });
  }
  // Soglie personali dei trading agents: sopra quella (già calibrata) della squadra.
  const squadra = AGENTS.custodi.minProbabilita;
  for (const [agente, v] of Object.entries(f.voci)) {
    if (!agente.startsWith("custode ") || !v.passi) continue;
    const sym = agente.slice("custode ".length);
    const attuale = spingi(squadra, v.passi, PERSONALE, "AGENTS.custodi.minProbabilita");
    AGENTS.custodi.minProbabilitaPer[sym] = attuale;
    righe.push({ agente, etichetta: "Probabilità minima del dossier per votare l'acquisto", base: squadra, attuale, passi: v.passi, motivo: v.motivo, dal: v.dal });
  }
  return righe;
}
