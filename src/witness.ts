import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isObject, readJson, writeJsonAtomic, type ReadResult } from "./fsutil.ts";
import { RUN_ID_RE } from "./slots.ts";

export interface WitnessOrder {
  id: string; // client_order_id
  simbolo: string;
  lato: string;
  quantita: number;
  origine: string;
  perche: string;
  stato: string;
}

// Il testimone: la verità sulle intenzioni della sveglia, per la sveglia dopo. Campi in italiano semplice.
export interface Witness {
  versione: 1;
  sveglia: string;
  tipo: string;
  iniziataAlle: string;
  finitaAlle: string;
  esito: "completata" | "completata con problemi";
  appunto: string;
  conto: { patrimonio: number; contanti: number; pnlGiorno: number; aggiornato?: boolean } | null;
  posizioni: { simbolo: string; quantita: number; prezzoCarico: number; prezzoAttuale: number; variazione: string }[];
  ordiniInviati: WitnessOrder[];
  ordiniGiaPresenti: WitnessOrder[];
  ordiniIncerti: WitnessOrder[];
  ordiniFalliti: (WitnessOrder & { errore: string })[];
  ordiniRifiutati: { simbolo: string; lato: string; quantita: number; origine: string; motivo: string }[];
  ragionamento: string;
  pianoProssima: string;
  prossimaSveglia: string;
  allarmi: string[];
}

export function isWitness(v: unknown): v is Witness {
  return isObject(v) && v.versione === 1 && typeof v.sveglia === "string" && RUN_ID_RE.test(v.sveglia) && typeof v.finitaAlle === "string";
}

export const witnessPath = (stateDir: string) => join(stateDir, "witness.json");

export function readWitness(stateDir: string): ReadResult<Witness> {
  return readJson(witnessPath(stateDir), isWitness);
}

export function writeWitness(stateDir: string, w: Witness): void {
  writeJsonAtomic(witnessPath(stateDir), w);
  const hist = join(stateDir, "history");
  mkdirSync(hist, { recursive: true });
  let p = join(hist, `${w.sveglia}.json`);
  for (let n = 2; existsSync(p); n++) p = join(hist, `${w.sveglia}_${n}.json`);
  writeJsonAtomic(p, w);
}

// Se witness.json è rotto, l'ultima copia buona in history/ dice almeno QUALE sveglia è stata fatta.
export function latestFromHistory(stateDir: string): Witness | null {
  const hist = join(stateDir, "history");
  let files: string[];
  try {
    files = readdirSync(hist).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}(_\d+)?\.json$/.test(f));
  } catch {
    return null;
  }
  files.sort().reverse();
  for (const f of files) {
    const r = readJson(join(hist, f), isWitness);
    if (r.kind === "ok") return r.value;
  }
  return null;
}

// Avanzi di scritture interrotte (file temporaneo scritto a metà, mai rinominato).
export function removeLeftoverTemps(stateDir: string): string[] {
  const removed: string[] = [];
  for (const dir of [stateDir, join(stateDir, "history")]) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {}
    for (const f of files) {
      if (!/\.json\.tmp-\d+-/.test(f) || f.startsWith("fake-broker")) continue;
      try {
        unlinkSync(join(dir, f));
        removed.push(f);
      } catch {}
    }
  }
  return removed;
}
