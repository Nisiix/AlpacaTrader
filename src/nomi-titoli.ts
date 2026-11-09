import { join } from "node:path";
import type { Broker } from "./broker/types.ts";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";

// I nomi dei titoli e delle crypto (Apple, Bitcoin...) accanto ai codici nella dashboard. Si chiedono ad Alpaca una volta
// sola per simbolo, pochi per giro, e si tengono in state/nomi-titoli.json.
const percorso = (stateDir: string) => join(stateDir, "nomi-titoli.json");
// Simboli per cui Alpaca ha dato errore: non si richiedono più fino al prossimo avvio.
const falliti = new Set<string>();

// Il nome leggibile: senza «Common Stock», classi azionarie e coppia in dollari.
export function nomeBreve(nome: string): string {
  return nome
    .replace(/\s*\/\s*US Dollar$/i, "")
    .replace(/\s+(Common Stock|Ordinary Shares|American Depositary Shares?|Class [A-C] (Common Stock|Ordinary Shares|Capital Stock)|Capital Stock)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function nomiTitoli(stateDir: string, broker: Broker, simboli: string[], perGiro = 25): Promise<Record<string, string>> {
  const r = readJson(percorso(stateDir), (v): v is Record<string, string> => isObject(v));
  const nomi: Record<string, string> = r.kind === "ok" ? r.value : {};
  if (!broker.getAssetName) return nomi;
  const mancanti = [...new Set(simboli)].filter((s) => !(s in nomi) && !falliti.has(s)).slice(0, perGiro);
  let nuovi = 0;
  for (const s of mancanti) {
    try {
      const n = await broker.getAssetName(s);
      nomi[s] = n ? nomeBreve(n) : "";
      nuovi++;
    } catch {
      falliti.add(s); // si riprova al prossimo avvio
    }
  }
  if (nuovi) writeJsonAtomic(percorso(stateDir), nomi);
  return nomi;
}
