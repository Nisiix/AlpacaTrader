import { join } from "node:path";
import { AGENTS } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";

// Gli agenti come persone. Gli agenti generali hanno un nome fisso. I trading agents e gli intraday agents sono uno
// staff di persone (state/persone.json) che non appartengono a un titolo: il motore trova le occasioni con i suoi
// criteri (dossier, Kronos, candele, regole) e ogni occasione viene presa da una persona libera, la più brava per
// risultati (a parità, quella in sala caffè da più tempo). Chi non ha un'occasione sta in sala caffè; chi è in formazione
// ci resta finché il capo non lo fa rientrare. Una posizione aperta tiene sempre una persona alla scrivania.
export interface Persona {
  nome: string;
  ruolo: string;
  reparto?: Reparto;
  simbolo?: string | null; // il titolo su cui lavora ora (null: in sala caffè)
}
export type Reparto = "trading" | "intraday";

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
  "a:intraday": { nome: "Andrea", ruolo: "Capo degli intraday agents" },
};

const NOMI = ["Alessandro", "Beatrice", "Carlo", "Diana", "Emanuele", "Federica", "Giorgio", "Ilaria", "Lorenzo", "Martina", "Nicola", "Olivia", "Pietro", "Rebecca", "Simone", "Teresa", "Valerio", "Alice", "Bruno", "Camilla", "Daniele", "Eleonora", "Filippo", "Greta", "Jacopo", "Lucia", "Matteo", "Noemi", "Riccardo", "Silvia", "Tommaso", "Vittoria", "Edoardo", "Francesca", "Gabriele", "Irene", "Leonardo", "Marta", "Sofia", "Stefano", "Arianna", "Cristian", "Elisa", "Fabio", "Giada", "Ivan", "Laura", "Mattia", "Nadia", "Oscar", "Rita", "Samuele", "Tiziana", "Ugo", "Vanessa", "Zeno", "Anna", "Enrico", "Monica", "Raffaele"];
const fisse = new Set(Object.values(PERSONE_FISSE).map((p) => p.nome));

export interface Membro {
  reparto: Reparto;
  simbolo: string | null;
  dal: string; // da quando lavora su quel titolo o da quando è libero
}
export interface Registro {
  versione: 2;
  staff: Record<string, Membro>; // per nome
  vecchi: Record<string, string>; // dalla versione 1: c:SYM / i:SYM → nome (per attribuire i trade passati)
}
const registroPath = (stateDir: string) => join(stateDir, "persone.json");

export function leggiRegistro(stateDir: string): Registro {
  const r = readJson(registroPath(stateDir), (v): v is Record<string, unknown> => isObject(v));
  if (r.kind === "ok" && r.value.versione === 2 && isObject(r.value.staff)) return r.value as unknown as Registro;
  // Versione 1 (una persona per titolo): le persone restano, libere, nel reparto in cui lavoravano.
  const vecchi = r.kind === "ok" && r.value.versione === 1 && isObject(r.value.nomi) ? (r.value.nomi as Record<string, string>) : {};
  const staff: Record<string, Membro> = {};
  for (const [k, n] of Object.entries(vecchi)) if (!staff[n]) staff[n] = { reparto: k.startsWith("i:") ? "intraday" : "trading", simbolo: null, dal: new Date(0).toISOString() };
  return { versione: 2, staff, vecchi };
}
const scrivi = (stateDir: string, reg: Registro) => writeJsonAtomic(registroPath(stateDir), reg);

export const chiavePersona = (nome: string) => `p:${nome}`;
export const nomeDi = (k: string) => (k.startsWith("p:") ? k.slice(2) : k);

// Le chiavi di persona di un trade: quelle salvate all'ingresso; per i trade di prima, la persona che allora seguiva il
// titolo (registro della versione 1); gli agenti generali con la loro chiave (a:nome).
export function personeDelTrade(t: { simbolo: string; contesto?: { agenti?: string[]; persone?: string[] } | null }, vecchi: Record<string, string>): string[] {
  if (t.contesto?.persone?.length) return t.contesto.persone;
  return (t.contesto?.agenti ?? []).map((a) => (a.startsWith("custode ") ? (vecchi[`c:${a.slice(8)}`] ? chiavePersona(vecchi[`c:${a.slice(8)}`]!) : null) : a === "intraday" ? (vecchi[`i:${t.simbolo}`] ? chiavePersona(vecchi[`i:${t.simbolo}`]!) : null) : `a:${a}`)).filter((k): k is string => !!k);
}

export interface Bisogno {
  simbolo: string;
  tiene: boolean; // posizione aperta o in uscita: serve sempre una persona
  voto: boolean; // c'è un voto d'acquisto in questo giro
  preferita?: string; // chiave di persona che l'ha trovato (esplorazione)
}
export interface Assegnazione {
  chi: Record<string, string>; // c:SYM / i:SYM → p:Nome
  senzaPersona: string[]; // c:SYM / i:SYM con un voto ma nessuna persona disponibile
  note: string[];
  reg: Registro;
}

// Assegna le occasioni del giro alle persone. `sospesi`: chi è in formazione. `punteggio`: più alto = più bravo.
// `rientro(p, desk, reparto, scrivania)`: il capo fa rientrare una persona in formazione per questa occasione? (motivo o null)
export function assegnaPersone(input: {
  stateDir: string;
  now: Date;
  bisogni: Record<Reparto, Bisogno[]>;
  sospesi: string[]; // chi è in formazione, da chi c'è da più tempo
  punteggio: (p: string) => number;
  rientro: (p: string, desk: string, reparto: Reparto, scrivania: number) => string | null;
}): Assegnazione {
  const reg = leggiRegistro(input.stateDir);
  const now = input.now.toISOString();
  const sospesi = new Set(input.sospesi);
  const chi: Record<string, string> = {};
  const senzaPersona: string[] = [];
  const note: string[] = [];
  let cambiato = false;
  const usati = new Set([...Object.keys(reg.staff), ...Object.values(reg.vecchi)]);
  const assumi = (reparto: Reparto) => {
    const liberi = NOMI.filter((n) => !usati.has(n) && !fisse.has(n));
    const nome = liberi[0] ?? `${NOMI[Object.keys(reg.staff).length % NOMI.length]} ${Math.floor(Object.keys(reg.staff).length / NOMI.length) + 1}`;
    usati.add(nome);
    reg.staff[nome] = { reparto, simbolo: null, dal: now };
    cambiato = true;
    return nome;
  };
  for (const reparto of ["trading", "intraday"] as Reparto[]) {
    const pref = reparto === "trading" ? "c:" : "i:";
    const bisogni = [...input.bisogni[reparto]].sort((a, b) => Number(b.tiene) - Number(a.tiene) || Number(b.voto) - Number(a.voto));
    const servono = new Set(bisogni.map((b) => b.simbolo));
    // Chi è in formazione lascia la scrivania; chi lavora su un titolo che non ha più bisogno di lui torna libero.
    for (const [n, m] of Object.entries(reg.staff)) {
      if (m.reparto !== reparto || m.simbolo === null) continue;
      if (sospesi.has(chiavePersona(n)) || !servono.has(m.simbolo)) { m.simbolo = null; m.dal = now; cambiato = true; }
    }
    // Chi c'era resta sul suo titolo.
    for (const [n, m] of Object.entries(reg.staff)) if (m.reparto === reparto && m.simbolo !== null) chi[`${pref}${m.simbolo}`] = chiavePersona(n);
    const dimensione = reparto === "trading" ? AGENTS.persone.trading : AGENTS.persone.intraday;
    const liberi = () => Object.entries(reg.staff).filter(([n, m]) => m.reparto === reparto && m.simbolo === null && !sospesi.has(chiavePersona(n)))
      .sort((a, b) => input.punteggio(chiavePersona(b[0])) - input.punteggio(chiavePersona(a[0])) || a[1].dal.localeCompare(b[1].dal)).map(([n]) => n);
    for (const b of bisogni) {
      const desk = `${pref}${b.simbolo}`;
      if (chi[desk]) continue;
      const scrivania = Object.values(reg.staff).filter((m) => m.reparto === reparto && m.simbolo !== null).length;
      // Lo staff conta anche chi è in formazione: chi va in sala caffè non viene sostituito da un nuovo assunto.
      const staffTotale = Object.values(reg.staff).filter((m) => m.reparto === reparto).length;
      let nome: string | null = null;
      const l = liberi();
      if (b.preferita && l.includes(nomeDi(b.preferita))) nome = nomeDi(b.preferita);
      else if (l.length) nome = l[0]!;
      else if (b.tiene || staffTotale < dimensione) nome = assumi(reparto);
      else if (b.voto) {
        // Nessuno libero: può rientrare chi è in formazione, se il capo lo consente (da chi è lì da più tempo).
        for (const p of input.sospesi.filter((p) => reg.staff[nomeDi(p)]?.reparto === reparto)) {
          const perche = input.rientro(p, desk, reparto, scrivania);
          if (perche) { nome = nomeDi(p); note.push(`${nome} torna dalla sala caffè per ${b.simbolo}: ${perche}`); break; }
        }
      }
      if (!nome) { if (b.voto) senzaPersona.push(desk); continue; }
      reg.staff[nome] = { reparto, simbolo: b.simbolo, dal: now };
      chi[desk] = chiavePersona(nome);
      cambiato = true;
    }
  }
  if (cambiato) scrivi(input.stateDir, reg);
  return { chi, senzaPersona, note, reg };
}

// Le persone per la dashboard: agenti generali (a:nome), staff (p:Nome) con reparto e titolo, e per comodità anche le
// postazioni occupate (c:SYM / i:SYM → la persona che ci lavora).
export function persone(reg: Registro, chi: Record<string, string>): Record<string, Persona> {
  const out: Record<string, Persona> = { ...PERSONE_FISSE };
  for (const [n, m] of Object.entries(reg.staff)) {
    out[chiavePersona(n)] = { nome: n, reparto: m.reparto, simbolo: m.simbolo, ruolo: m.reparto === "trading" ? "Trading agent: prende le occasioni di più giorni che il motore trova" : "Intraday agent: prende le occasioni di poche ore sulle candele brevi" };
  }
  for (const [desk, p] of Object.entries(chi)) out[desk] = { ...out[p]!, ruolo: desk.startsWith("c:") ? `Trading agent su ${desk.slice(2)}` : `Intraday agent su ${desk.slice(2)}` };
  return out;
}
