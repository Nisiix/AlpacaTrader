import { join } from "node:path";
import { AGENTS } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { JournalFile, Trade } from "../journal.ts";
import { entryKind, kronosOf, regolaSuperata } from "./capo.ts";
import type { AgentReport, Signal } from "./types.ts";

// La formazione in sala caffè. Quando il capo ufficio giudica che una persona lavora male (sui trade chiusi dal suo
// ultimo rientro, almeno `minTrade`: vince meno del 51% e chiude in perdita), la manda in sala caffè per `ore` ore: non
// apre nuovi trade (le sue posizioni restano protette da stop e regole d'uscita) e intanto ascolta le persone che
// lavorano bene (almeno il 51% di trade vinti e risultato positivo), da cui raccoglie un bagaglio concreto:
// - la proiezione minima di Kronos da cui partivano i loro trade vinti;
// - il tipo d'ingresso che ha reso di più;
// - le candele su cui vincono (per gli operatori intraday).
// Finito il periodo torna alla scrivania con quel bagaglio, che da lì vale per i suoi voti d'acquisto. Alla scrivania
// devono restare sempre almeno `minOperativi` persone: se mancano, torna prima chi è in sala caffè da più tempo (sempre
// col bagaglio raccolto fin lì).

export interface Bagaglio {
  mentori: string[]; // chiavi delle persone ascoltate (c:SYM, i:SYM, a:nome)
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
  note: string[];
}

const percorso = (stateDir: string) => join(stateDir, "formazione.json");
function leggi(stateDir: string): File {
  const r = readJson(percorso(stateDir), (v): v is File => isObject(v) && v.versione === 1 && isObject(v.voci));
  return r.kind === "ok" ? r.value : { versione: 1, voci: {} };
}
const pnl = (t: Trade) => (t.incassato ?? 0) - (t.costo ?? 0);
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

// Le persone di un trade: i trading agents (c:SYM), l'operatore intraday del titolo (i:SYM), gli agenti generali (a:nome).
export function personeDelTrade(t: Trade): string[] {
  return (t.contesto?.agenti ?? []).map((a) => (a.startsWith("custode ") ? `c:${a.slice(8)}` : a === "intraday" ? `i:${t.simbolo}` : `a:${a}`));
}
export function personaDelVoto(s: Signal): string {
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
export function aggiornaFormazione(stateDir: string, journal: JournalFile, presenti: string[], now: Date): FormazioneReport {
  const c = AGENTS.formazione;
  const f = leggi(stateDir);
  const note: string[] = [];
  let cambiato = false;
  if (!c.enabled) return { inFormazione: [], conBagaglio: [], note };
  const chiusi = journal.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl && !regolaSuperata(t));
  const per = new Map<string, Trade[]>();
  for (const t of chiusi) for (const k of personeDelTrade(t)) per.set(k, [...(per.get(k) ?? []), t]);
  // Chi lavora bene: almeno il 51% di trade vinti e risultato positivo (almeno 3 trade).
  const bravi = [...per].filter(([k, ts]) => f.voci[k]?.stato !== "in formazione" && ts.length >= 3 && ts.filter((t) => pnl(t) > 0).length / ts.length >= c.obiettivo && ts.reduce((a, t) => a + pnl(t), 0) > 0)
    .sort((a, b) => b[1].reduce((x, t) => x + pnl(t), 0) - a[1].reduce((x, t) => x + pnl(t), 0)).map(([k]) => k);

  // 1. Fine della formazione: si torna alla scrivania col bagaglio.
  const rientra = (k: string, v: Voce, perche: string) => {
    const bag = bagaglioDa(bravi.length ? bravi.slice(0, 5) : v.bagaglio?.mentori ?? [], per, chiusi);
    f.voci[k] = { stato: "operativo", dal: now.toISOString(), motivo: perche, bagaglio: bag, formazioni: v.formazioni };
    note.push(`capo ufficio: ${k} torna alla scrivania (${perche})${bag.testo.length ? ` con il bagaglio: ${bag.testo.join("; ")}` : ""}`);
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
    f.voci[k] = { stato: "in formazione", dal: now.toISOString(), fino, motivo: `${vinti} vinti su ${nuovi.length} (${Math.round((vinti / nuovi.length) * 100)}%), ${ris.toFixed(2)} $: lavora male, in sala caffè a imparare${mentori.length ? ` da ${mentori.join(", ")}` : " dai trade vinti della squadra"}`, bagaglio: bagaglioDa(mentori, per, chiusi), formazioni: (v?.formazioni ?? 0) + 1 };
    note.push(`capo ufficio: ${k} in sala caffè fino alle ${fino.slice(11, 16)} UTC, ${f.voci[k]!.motivo}`);
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
    note,
  };
}

// Quante persone lavorano alla scrivania in questo giro (stessa regola della sala caffè): trading agents con una
// posizione, un ingresso pronto o un voto; operatori intraday in posizione o con un voto; agenti generali che votano.
export interface Scrivanie { trading: number; intraday: number }
export function allaScrivania(reports: Record<string, AgentReport>, held: Set<string>, esclusi: Set<string>): Scrivanie {
  const k = new Set<string>();
  for (const [n, r] of Object.entries(reports)) {
    for (const s of r.segnali) k.add(personaDelVoto(s));
    for (const c of r.custodi ?? []) if (held.has(c.simbolo) || c.fase === "in posizione" || c.fase === "in uscita" || c.fase === "pronto") k.add(`c:${c.simbolo}`);
    for (const x of r.intraday ?? []) if (x.fase === "in posizione") k.add(`i:${x.simbolo}`);
    if (n !== "custodi" && n !== "intraday" && r.rischio !== undefined && r.rischio < 1) k.add(`a:${n}`);
  }
  for (const e of esclusi) k.delete(e);
  const intraday = [...k].filter((x) => x.startsWith("i:")).length;
  return { trading: k.size - intraday, intraday };
}

// Un'occasione passa il bagaglio? Kronos almeno alla soglia imparata dai colleghi bravi; per l'intraday una candela su cui
// loro vincono. È il giudizio del capo ufficio sull'esito atteso.
function passaBagaglio(s: Signal, b: Bagaglio | undefined, previsioni: Record<string, number> | undefined): { ok: boolean; perche: string } {
  if (!b) return { ok: false, perche: "nessun bagaglio" };
  if (s.intraday) {
    const tf = /su candele (\w+)/.exec(s.perche)?.[1];
    return b.candele.length && tf && b.candele.includes(tf) ? { ok: true, perche: `candele ${tf}, quelle su cui vincono i colleghi bravi` } : { ok: false, perche: b.candele.length ? `candele ${tf ?? "n.d."} fuori da quelle dei colleghi bravi (${b.candele.join(", ")})` : "nessuna candela vincente dei colleghi da confrontare" };
  }
  const fc = s.kronos ?? previsioni?.[s.simbolo];
  return b.kronosMin !== null && fc !== undefined && fc >= b.kronosMin ? { ok: true, perche: `Kronos ${pct(fc)} ≥ ${pct(b.kronosMin)} imparato dai colleghi bravi` } : { ok: false, perche: `Kronos ${fc === undefined ? "n.d." : pct(fc)} sotto ${b.kronosMin === null ? "una soglia ancora da imparare" : pct(b.kronosMin)}` };
}

// Applica la formazione ai voti. Chi è in sala caffè e trova un'occasione torna alla scrivania prima della fine della
// formazione solo se (a) il capo ufficio giudica valida l'occasione col bagaglio imparato, oppure (b) alla scrivania del
// suo reparto servono persone (meno di minOperativi trading agents, nessun operatore nella sala intraday): torna per
// primo chi è in sala caffè da più tempo. Altrimenti il suo voto
// d'acquisto non vale. Chi è tornato col bagaglio lo usa. Le vendite e le regole vincolanti non si toccano.
export function applicaFormazione(stateDir: string, reports: Record<string, AgentReport>, r: FormazioneReport, previsioni: Record<string, number> | undefined, scrivania: Scrivanie, now: Date): string[] {
  const c = AGENTS.formazione;
  const sospesi = new Map(r.inFormazione.map((x) => [x.chiave, x]));
  const bag = new Map(r.conBagaglio.map((x) => [x.chiave, x.bagaglio]));
  if (!sospesi.size && !bag.size) return [];
  const note: string[] = [];
  const f = leggi(stateDir);
  // Le occasioni di chi è in sala caffè, da chi ci è da più tempo.
  const occasioni = new Map<string, Signal[]>();
  for (const rep of Object.values(reports)) for (const s of rep.segnali) { const k = personaDelVoto(s); if (sospesi.has(k) && s.lato === "buy" && !s.vincolante) occasioni.set(k, [...(occasioni.get(k) ?? []), s]); }
  const tornati = new Map<string, string>();
  for (const [k] of [...occasioni].sort((a, b) => sospesi.get(a[0])!.dal.localeCompare(sospesi.get(b[0])!.dal))) {
    const v = f.voci[k];
    if (!v) continue;
    const valida = occasioni.get(k)!.map((s) => ({ s, esito: passaBagaglio(s, v.bagaglio, previsioni) })).find((x) => x.esito.ok);
    // Le due sale hanno minimi diversi: 10 trading agents (con gli agenti generali), 1 operatore intraday (zero se nessuno
    // ha un'occasione: senza trade intraday da aprire la sala può restare vuota).
    const sala: keyof Scrivanie = k.startsWith("i:") ? "intraday" : "trading";
    const minimo = sala === "intraday" ? c.minIntraday : c.minOperativi;
    const perche = valida ? `il capo ufficio approva l'occasione su ${valida.s.simbolo}: ${valida.esito.perche}` : scrivania[sala] < minimo ? `${sala === "intraday" ? "nella sala intraday" : "alla scrivania"} servono almeno ${minimo} persone (ora ${scrivania[sala]}): rientra per primo chi è in sala caffè da più tempo` : null;
    if (!perche) continue;
    f.voci[k] = { stato: "operativo", dal: now.toISOString(), motivo: perche, ...(v.bagaglio ? { bagaglio: v.bagaglio } : {}), formazioni: v.formazioni };
    tornati.set(k, perche); scrivania[sala]++; sospesi.delete(k);
    if (v.bagaglio) bag.set(k, v.bagaglio);
    note.push(`capo ufficio: ${k} torna alla scrivania per un'occasione (${perche})${v.bagaglio?.testo.length ? `, col bagaglio: ${v.bagaglio.testo.join("; ")}` : ""}`);
  }
  if (tornati.size) {
    writeJsonAtomic(percorso(stateDir), f);
    r.inFormazione = r.inFormazione.filter((x) => !tornati.has(x.chiave));
    for (const [k] of tornati) { const b = f.voci[k]!.bagaglio; if (b) r.conBagaglio.push({ chiave: k, bagaglio: b, rientrato: now.toISOString(), formazioni: f.voci[k]!.formazioni }); }
  }
  for (const rep of Object.values(reports)) {
    const kept: Signal[] = [];
    for (const s of rep.segnali) {
      const k = personaDelVoto(s);
      if (s.lato !== "buy" || s.vincolante) { kept.push(s); continue; }
      if (sospesi.has(k)) { note.push(`formazione: voto d'acquisto di ${k} su ${s.simbolo} non vale, è in sala caffè a imparare (occasione non approvata dal capo e scrivanie già coperte)`); continue; }
      // Rientrato per necessità con un'occasione che non passa il bagaglio: entra, ma con forza o taglia ridotte.
      if (tornati.has(k) && !passaBagaglio(s, bag.get(k), previsioni).ok) {
        kept.push(s.intraday && s.pesoMassimo !== undefined ? { ...s, pesoMassimo: s.pesoMassimo * 0.7, perche: `${s.perche} · rientrato dalla sala caffè per necessità: taglia ridotta` } : { ...s, forza: s.forza * 0.8, perche: `${s.perche} · rientrato dalla sala caffè per necessità: forza ridotta` });
        continue;
      }
      const b = bag.get(k);
      if (!b) { kept.push(s); continue; }
      if (s.intraday) {
        // Operatore intraday: fuori dalle candele su cui vince chi lavora bene, taglia ridotta.
        const tf = /su candele (\w+)/.exec(s.perche)?.[1];
        if (b.candele.length && s.pesoMassimo !== undefined && tf && !b.candele.includes(tf)) {
          kept.push({ ...s, pesoMassimo: s.pesoMassimo * 0.7, perche: `${s.perche} · bagaglio della sala caffè: candela diversa da quelle dei colleghi bravi (${b.candele.join(", ")}), taglia ridotta` });
          continue;
        }
        kept.push(s);
        continue;
      }
      const fc = s.kronos ?? previsioni?.[s.simbolo];
      if (b.kronosMin !== null && (fc === undefined || fc < b.kronosMin)) {
        note.push(`formazione: voto di ${k} su ${s.simbolo} scartato dal suo bagaglio (Kronos ${fc === undefined ? "n.d." : pct(fc)} sotto ${pct(b.kronosMin)})`);
        continue;
      }
      kept.push({ ...s, perche: `${s.perche} · col bagaglio della sala caffè (${b.testo[0] ?? "lezioni dei colleghi"})` });
    }
    rep.segnali = kept;
  }
  return note;
}
