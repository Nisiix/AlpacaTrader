import { join } from "node:path";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";

// Gli agenti come persone: ognuno ha un nome, un ruolo e la sua scheda di impostazioni. Gli agenti generali hanno un
// nome fisso; ogni trading agent (uno per titolo seguito) e ogni operatore della sala intraday riceve un nome libero la
// prima volta che compare e lo tiene (state/persone.json), così resta la stessa persona da un giorno all'altro.
export interface Persona {
  nome: string;
  ruolo: string;
}

export const PERSONE_FISSE: Record<string, Persona> = {
  capo: { nome: "Roberto", ruolo: "Capo ufficio: giudica i risultati e ricalibra chi sbaglia" },
  "a:trend": { nome: "Marco", ruolo: "Trend: compra i titoli in tendenza" },
  "a:rientro": { nome: "Giulia", ruolo: "Rientro: compra i ritracciamenti dentro un trend" },
  "a:regime": { nome: "Paolo", ruolo: "Regime: legge il clima del mercato e dosa il rischio" },
  "a:orizzonte": { nome: "Sara", ruolo: "Orizzonte: quanto tenere una posizione" },
  "a:uscite": { nome: "Luca", ruolo: "Uscite: stop e protezione del profitto" },
  "a:profitto": { nome: "Davide", ruolo: "Presa di profitto parziale" },
  "a:contesto": { nome: "Elena", ruolo: "Contesto economico: settori, Fed, notizie" },
  "a:kronos": { nome: "Chiara", ruolo: "Kronos: vota sulle proiezioni a 5 sedute" },
  "a:intraday": { nome: "Andrea", ruolo: "Capo della sala intraday" },
};

const NOMI = ["Alessandro", "Beatrice", "Carlo", "Diana", "Emanuele", "Federica", "Giorgio", "Ilaria", "Lorenzo", "Martina", "Nicola", "Olivia", "Pietro", "Rebecca", "Simone", "Teresa", "Valerio", "Alice", "Bruno", "Camilla", "Daniele", "Eleonora", "Filippo", "Greta", "Jacopo", "Lucia", "Matteo", "Noemi", "Riccardo", "Silvia", "Tommaso", "Vittoria", "Edoardo", "Francesca", "Gabriele", "Irene", "Leonardo", "Marta", "Sofia", "Stefano", "Arianna", "Cristian", "Elisa", "Fabio", "Giada", "Ivan", "Laura", "Mattia", "Nadia", "Oscar", "Rita", "Samuele", "Tiziana", "Ugo", "Vanessa", "Zeno", "Anna", "Enrico", "Monica", "Raffaele"];
const fisse = new Set(Object.values(PERSONE_FISSE).map((p) => p.nome));

const registroPath = (stateDir: string) => join(stateDir, "persone.json");
type Registro = { versione: 1; nomi: Record<string, string> };

// Nomi di tutte le persone di questo giro: chiavi come quelle dell'ufficio ('capo', 'a:trend', 'c:AAPL', 'i:BTC/USD').
export function persone(stateDir: string, trading: string[], intraday: string[]): Record<string, Persona> {
  const r = readJson(registroPath(stateDir), (v): v is Registro => isObject(v) && v.versione === 1 && isObject(v.nomi));
  const reg: Registro = r.kind === "ok" ? r.value : { versione: 1, nomi: {} };
  const usati = new Set(Object.values(reg.nomi));
  let cambiato = false;
  const assegna = (k: string) => {
    if (reg.nomi[k]) return reg.nomi[k]!;
    const liberi = NOMI.filter((n) => !usati.has(n) && !fisse.has(n));
    const nome = liberi.length ? liberi[0]! : `${NOMI[Object.keys(reg.nomi).length % NOMI.length]} ${Math.floor(Object.keys(reg.nomi).length / NOMI.length) + 1}`;
    reg.nomi[k] = nome; usati.add(nome); cambiato = true;
    return nome;
  };
  const out: Record<string, Persona> = { ...PERSONE_FISSE };
  for (const s of [...trading].sort()) out[`c:${s}`] = { nome: assegna(`c:${s}`), ruolo: `Trading agent di ${s}: lo segue e decide quando entrare e uscire` };
  for (const s of [...intraday].sort()) out[`i:${s}`] = { nome: assegna(`i:${s}`), ruolo: `Operatore intraday su ${s}, nella squadra di Andrea` };
  if (cambiato) writeJsonAtomic(registroPath(stateDir), reg);
  return out;
}
