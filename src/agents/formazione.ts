import { join } from "node:path";
import { AGENTS } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { JournalFile, Trade } from "../journal.ts";
import { entryKind, kronosOf, regolaSuperata } from "./capo.ts";
import type { AgentReport, Signal } from "./types.ts";
import { nomeDi, personeDelTrade } from "./persone.ts";

// La formazione in sala caffè. Quando il capo ufficio giudica che una persona lavora male (sui trade chiusi dal suo
// ultimo rientro, almeno `minTrade`: vince meno del 51% e chiude in perdita), la manda in sala caffè per `ore` ore: non
// apre nuovi trade (le sue posizioni restano protette da stop e regole d'uscita) e intanto ascolta le persone che
// lavorano bene (almeno il 51% di trade vinti e risultato positivo), da cui raccoglie un bagaglio concreto:
// - la proiezione minima di Kronos da cui partivano i loro trade vinti;
// - il tipo d'ingresso che ha reso di più;
// - le candele su cui vincono (per gli operatori intraday).
// Finito il periodo torna disponibile con quel bagaglio, che da lì vale per i suoi acquisti. Prima della fine torna
// solo prendendo un'occasione: se il capo la giudica valida col bagaglio, o se alla scrivania servono persone (almeno
// `minOperativi` trading agents, almeno `minIntraday` intraday agents): rientra per primo chi è lì da più tempo.
// Le chiavi sono quelle delle persone: p:Nome per lo staff, a:nome per gli agenti generali.

export interface Bagaglio {
  mentori: string[]; // chiavi delle persone ascoltate (p:Nome, a:nome)
  kronosMin: number | null;
  ingresso: string | null;
  candele: string[];
  testo: string[];
}
export interface Voce {
  stato: "in formazione" | "operativo";
  dal: string; // inizio della formazione o del rientro (da qui si contano i trade per il prossimo giudizio)
  fino?: string; // fine prevista della formazione
  motivo: string;
  bagaglio?: Bagaglio;
  formazioni: number;
}
interface File {
  versione: 1;
  voci: Record<string, Voce>;
}
export interface FormazioneReport {
  inFormazione: { chiave: string; dal: string; fino: string; motivo: string; mentori: string[]; imparato: string[] }[];
  conBagaglio: { chiave: string; bagaglio: Bagaglio; rientrato: string; formazioni: number }[];
  rientri: Record<string, "approvato" | "necessità">; // rientri anticipati di questo giro
  note: string[];
}

const percorso = (stateDir: string) => join(stateDir, "formazione.json");
function leggi(stateDir: string): File {
  const r = readJson(percorso(stateDir), (v): v is File => isObject(v) && v.versione === 1 && isObject(v.voci));
  return r.kind === "ok" ? r.value : { versione: 1, voci: {} };
}
const pnl = (t: Trade) => (t.incassato ?? 0) - (t.costo ?? 0);
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

// La postazione di un voto: c:SYM per i trading agents, i:SYM per gli intraday agents, a:nome per gli agenti generali.
export function postazioneDelVoto(s: Signal): string {
  return s.agente.startsWith("custode ") ? `c:${s.agente.slice(8)}` : s.agente === "intraday" ? `i:${s.simbolo}` : `a:${s.agente}`;
}

function bagaglioDa(mentori: string[], per: Map<string, Trade[]>, tutti: Trade[]): Bagaglio {
  const vinti = (mentori.length ? mentori.flatMap((m) => per.get(m) ?? []) : tutti).filter((t) => pnl(t) > 0);
  const unici = [...new Map(vinti.map((t) => [t.id ?? `${t.simbolo}|${t.apertoIl}`, t])).values()];
  const kv = unici.map(kronosOf).filter((k): k is number => k !== null);
  const kronosMin = kv.length ? Math.min(0.05, Math.max(AGENTS.kronos.anticipaSoglia, kv.reduce((a, b) => a + b, 0) / kv.length)) : null;
  const tipi = new Map<string, number>();
  for (const t of unici) tipi.set(entryKind(t), (tipi.get(entryKind(t)) ?? 0) + 1);
  const ingresso = [...tipi].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const candele = [...new Set(unici.map((t) => t.contesto?.livelli?.candela).filter((c): c is string => !!c))];
  const testo = [
    kronosMin !== null ? `entrare solo con Kronos ≥ ${pct(kronosMin)}, da dove partivano i trade vinti di chi lavora bene` : "",
    ingresso ? `preferire l'ingresso «${ingresso}»` : "",
    candele.length ? `in intraday, le candele su cui si vince: ${candele.join(", ")}` : "",
  ].filter(Boolean);
  return { mentori, kronosMin, ingresso, candele, testo };
}

// Aggiorna chi va in formazione e chi torna (una volta per giro). `presenti`: le persone di questo giro.
export function aggiornaFormazione(stateDir: string, journal: JournalFile, presenti: string[], now: Date, vecchi: Record<string, string> = {}): FormazioneReport {
  const c = AGENTS.formazione;
  const f = leggi(stateDir);
  const note: string[] = [];
  let cambiato = false;
  if (!c.enabled) return { inFormazione: [], conBagaglio: [], rientri: {}, note };
  const chiusi = journal.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl && !regolaSuperata(t));
  const per = new Map<string, Trade[]>();
  for (const t of chiusi) for (const k of personeDelTrade(t, vecchi)) per.set(k, [...(per.get(k) ?? []), t]);
  // Chi lavora bene: almeno il 51% di trade vinti e risultato positivo (almeno 3 trade).
  const bravi = [...per].filter(([k, ts]) => f.voci[k]?.stato !== "in formazione" && ts.length >= 3 && ts.filter((t) => pnl(t) > 0).length / ts.length >= c.obiettivo && ts.reduce((a, t) => a + pnl(t), 0) > 0)
    .sort((a, b) => b[1].reduce((x, t) => x + pnl(t), 0) - a[1].reduce((x, t) => x + pnl(t), 0)).map(([k]) => k);

  // 1. Fine della formazione: si torna alla scrivania col bagaglio.
  const rientra = (k: string, v: Voce, perche: string) => {
    const bag = bagaglioDa(bravi.length ? bravi.slice(0, 5) : v.bagaglio?.mentori ?? [], per, chiusi);
    f.voci[k] = { stato: "operativo", dal: now.toISOString(), motivo: perche, bagaglio: bag, formazioni: v.formazioni };
    note.push(`capo ufficio: ${nomeDi(k)} torna disponibile (${perche})${bag.testo.length ? ` con il bagaglio: ${bag.testo.join("; ")}` : ""}`);
    cambiato = true;
  };
  for (const [k, v] of Object.entries(f.voci)) if (v.stato === "in formazione" && v.fino && v.fino <= now.toISOString()) rientra(k, v, "formazione finita");

  // 2. Nuove formazioni: chi lavora male dal suo ultimo rientro.
  for (const [k, ts] of per) {
    const v = f.voci[k];
    if (v?.stato === "in formazione" || !presenti.includes(k)) continue;
    const nuovi = ts.filter((t) => !v?.dal || t.chiusoIl! > v.dal);
    if (nuovi.length < c.minTrade) continue;
    const vinti = nuovi.filter((t) => pnl(t) > 0).length;
    const ris = nuovi.reduce((a, t) => a + pnl(t), 0);
    if (vinti / nuovi.length >= c.obiettivo || ris >= 0) continue;
    const mentori = bravi.filter((b) => b !== k).slice(0, 5);
    const fino = new Date(now.getTime() + c.ore * 3600_000).toISOString();
    f.voci[k] = { stato: "in formazione", dal: now.toISOString(), fino, motivo: `${vinti} vinti su ${nuovi.length} (${Math.round((vinti / nuovi.length) * 100)}%), ${ris.toFixed(2)} $: lavora male, in sala caffè a imparare${mentori.length ? ` da ${mentori.map(nomeDi).join(", ")}` : " dai trade vinti della squadra"}`, bagaglio: bagaglioDa(mentori, per, chiusi), formazioni: (v?.formazioni ?? 0) + 1 };
    note.push(`capo ufficio: ${nomeDi(k)} in sala caffè fino alle ${fino.slice(11, 16)} UTC, ${f.voci[k]!.motivo}`);
    cambiato = true;
  }

  // 3. Chi è in sala caffè continua ad ascoltare: il bagaglio si aggiorna con i risultati di chi lavora bene.
  for (const [k, v] of Object.entries(f.voci)) {
    if (v.stato !== "in formazione") continue;
    const mentori = bravi.filter((b) => b !== k).slice(0, 5);
    const bag = bagaglioDa(mentori, per, chiusi);
    if (JSON.stringify(bag) !== JSON.stringify(v.bagaglio)) { v.bagaglio = bag; cambiato = true; }
  }
  if (cambiato) writeJsonAtomic(percorso(stateDir), f);
  return {
    inFormazione: Object.entries(f.voci).filter(([, v]) => v.stato === "in formazione").map(([k, v]) => ({ chiave: k, dal: v.dal, fino: v.fino ?? "", motivo: v.motivo, mentori: v.bagaglio?.mentori ?? [], imparato: v.bagaglio?.testo ?? [] })),
    conBagaglio: Object.entries(f.voci).filter(([, v]) => v.stato === "operativo" && v.bagaglio?.testo.length).map(([k, v]) => ({ chiave: k, bagaglio: v.bagaglio!, rientrato: v.dal, formazioni: v.formazioni })),
    rientri: {},
    note,
  };
}

// Un'occasione passa il bagaglio? Kronos almeno alla soglia imparata dai colleghi bravi; per l'intraday una candela su cui
// loro vincono. È il giudizio del capo ufficio sull'esito atteso.
export function passaBagaglio(s: Signal, b: Bagaglio | undefined, previsioni: Record<string, number> | undefined): { ok: boolean; perche: string } {
  if (!b) return { ok: false, perche: "nessun bagaglio" };
  if (s.intraday) {
    const tf = /su candele (\w+)/.exec(s.perche)?.[1];
    return b.candele.length && tf && b.candele.includes(tf) ? { ok: true, perche: `candele ${tf}, quelle su cui vincono i colleghi bravi` } : { ok: false, perche: b.candele.length ? `candele ${tf ?? "n.d."} fuori da quelle dei colleghi bravi (${b.candele.join(", ")})` : "nessuna candela vincente dei colleghi da confrontare" };
  }
  const fc = s.kronos ?? previsioni?.[s.simbolo];
  return b.kronosMin !== null && fc !== undefined && fc >= b.kronosMin ? { ok: true, perche: `Kronos ${pct(fc)} ≥ ${pct(b.kronosMin)} imparato dai colleghi bravi` } : { ok: false, perche: `Kronos ${fc === undefined ? "n.d." : pct(fc)} sotto ${b.kronosMin === null ? "una soglia ancora da imparare" : pct(b.kronosMin)}` };
}

// Il capo fa rientrare prima del tempo una persona in formazione per questa occasione (i voti d'acquisto della
// postazione)? Sì se l'occasione passa il suo bagaglio, oppure se alla scrivania del suo reparto servono persone. Se sì,
// la persona torna operativa (salvato) e il motivo si restituisce; altrimenti null.
export function provaRientro(stateDir: string, r: FormazioneReport, k: string, voti: Signal[], previsioni: Record<string, number> | undefined, scrivania: number, minimo: number, now: Date): string | null {
  const f = leggi(stateDir);
  const v = f.voci[k];
  if (!v || v.stato !== "in formazione") return null;
  const valida = voti.map((s) => ({ s, esito: passaBagaglio(s, v.bagaglio, previsioni) })).find((x) => x.esito.ok);
  const perche = valida ? `il capo ufficio approva l'occasione su ${valida.s.simbolo}: ${valida.esito.perche}` : voti.length && scrivania < minimo ? `alla scrivania servono almeno ${minimo} ${minimo === 1 ? "persona" : "persone"} (ora ${scrivania}): rientra per primo chi è in sala caffè da più tempo` : null;
  if (!perche) return null;
  f.voci[k] = { stato: "operativo", dal: now.toISOString(), motivo: perche, ...(v.bagaglio ? { bagaglio: v.bagaglio } : {}), formazioni: v.formazioni };
  writeJsonAtomic(percorso(stateDir), f);
  r.inFormazione = r.inFormazione.filter((x) => x.chiave !== k);
  if (v.bagaglio) r.conBagaglio.push({ chiave: k, bagaglio: v.bagaglio, rientrato: now.toISOString(), formazioni: v.formazioni });
  r.rientri[k] = valida ? "approvato" : "necessità";
  r.note.push(`capo ufficio: ${nomeDi(k)} torna dalla sala caffè (${perche})${v.bagaglio?.testo.length ? `, col bagaglio: ${v.bagaglio.testo.join("; ")}` : ""}`);
  return perche;
}

// Applica formazione e assegnazioni ai voti d'acquisto. `chi`: postazione (c:SYM / i:SYM) → persona; `senzaPersona`:
// postazioni con un voto ma nessuna persona disponibile (il voto non vale). Gli agenti generali in formazione rientrano
// solo con un'occasione approvata dal capo. Chi è tornato col bagaglio lo usa; chi è rientrato per necessità con
// un'occasione che non passa il bagaglio entra con forza ×0,8 o taglia ×0,7. Vendite e regole vincolanti non si toccano.
export function applicaFormazione(stateDir: string, reports: Record<string, AgentReport>, r: FormazioneReport, previsioni: Record<string, number> | undefined, chi: Record<string, string>, senzaPersona: Set<string>, now: Date): string[] {
  const note: string[] = [];
  const sospesi = new Set(r.inFormazione.map((x) => x.chiave));
  // Agenti generali in formazione con un'occasione: il capo la giudica col bagaglio.
  for (const k of [...sospesi].filter((k) => k.startsWith("a:"))) {
    const voti = Object.values(reports).flatMap((x) => x.segnali).filter((s) => s.lato === "buy" && !s.vincolante && postazioneDelVoto(s) === k);
    if (voti.length && provaRientro(stateDir, r, k, voti, previsioni, Infinity, 0, now)) sospesi.delete(k);
  }
  const bag = new Map(r.conBagaglio.map((x) => [x.chiave, x.bagaglio]));
  for (const rep of Object.values(reports)) {
    const kept: Signal[] = [];
    for (const s of rep.segnali) {
      if (s.lato !== "buy" || s.vincolante) { kept.push(s); continue; }
      const desk = postazioneDelVoto(s);
      if (senzaPersona.has(desk)) { note.push(`ufficio: voto d'acquisto su ${s.simbolo} senza una persona libera (tutte occupate o in formazione)`); continue; }
      const k = desk.startsWith("a:") ? desk : chi[desk];
      if (!k) { kept.push(s); continue; }
      if (sospesi.has(k)) { note.push(`formazione: ${nomeDi(k)} è in sala caffè a imparare, il suo voto su ${s.simbolo} non vale`); continue; }
      const b = bag.get(k);
      const passa = passaBagaglio(s, b, previsioni);
      if (r.rientri[k] === "necessità" && !passa.ok) {
        kept.push(s.intraday && s.pesoMassimo !== undefined ? { ...s, pesoMassimo: s.pesoMassimo * 0.7, perche: `${s.perche} · ${nomeDi(k)} rientrato dalla sala caffè per necessità: taglia ridotta` } : { ...s, forza: s.forza * 0.8, perche: `${s.perche} · ${nomeDi(k)} rientrato dalla sala caffè per necessità: forza ridotta` });
        continue;
      }
      if (!b) { kept.push(s); continue; }
      if (s.intraday) {
        // Intraday agent: fuori dalle candele su cui vince chi lavora bene, taglia ridotta.
        kept.push(!passa.ok && b.candele.length && s.pesoMassimo !== undefined ? { ...s, pesoMassimo: s.pesoMassimo * 0.7, perche: `${s.perche} · bagaglio di ${nomeDi(k)}: ${passa.perche}, taglia ridotta` } : s);
        continue;
      }
      if (!passa.ok && b.kronosMin !== null) { note.push(`formazione: voto di ${nomeDi(k)} su ${s.simbolo} scartato dal suo bagaglio (${passa.perche})`); continue; }
      kept.push({ ...s, perche: `${s.perche} · ${nomeDi(k)} col bagaglio della sala caffè (${b.testo[0] ?? "lezioni dei colleghi"})` });
    }
    rep.segnali = kept;
  }
  return note;
}
