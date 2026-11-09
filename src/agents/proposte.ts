import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPath, paramOf, readAgentSettings, saveAgentSettings } from "../agent-settings.ts";
import { AGENTS, isCrypto } from "../config.ts";
import type { JournalFile, Trade } from "../journal.ts";
import { writeJsonAtomic } from "../fsutil.ts";
import { romeTime } from "../slots.ts";

// Proposte del capo ufficio sulle impostazioni generali. Il capo guarda i risultati delle operazioni chiuse (intraday,
// le ultime `finestra`) e, solo con dati sufficienti (almeno `minTrade` operazioni e `minGruppo` nel gruppo che giustifica
// la proposta), propone all'utente di cambiare un'impostazione generale: quale, da che valore a quale e perché, con i
// numeri. Non cambia niente da solo: la proposta resta aperta finché l'utente la accetta (si salva come le altre
// impostazioni) o la rifiuta (la stessa impostazione non si ripropone per `giorniRifiuto` giorni). Dopo un'accettazione
// la stessa impostazione si riguarda solo con `minGruppo` operazioni nuove, chiuse con il valore nuovo.

export interface Proposta {
  id: string;
  chiave: string;
  etichetta: string;
  attuale: number;
  proposto: number;
  motivo: string;
  dati: { trade: number; vinti: number; media: number; pf: number | null };
  creata: string;
  stato: "aperta" | "accettata" | "rifiutata" | "superata";
  decisaIl?: string;
  tradeAllaDecisione?: number;
}
export interface FileProposte { versione: 1; aggiornato: string; analizzati: number; proposte: Proposta[]; osservazioni: string[] }

export const propostePath = (stateDir: string) => join(stateDir, "proposte-capo.json");
export function leggiProposte(stateDir: string): FileProposte {
  try {
    if (existsSync(propostePath(stateDir))) {
      const v = JSON.parse(readFileSync(propostePath(stateDir), "utf8"));
      if (v?.versione === 1 && Array.isArray(v.proposte)) return v as FileProposte;
    }
  } catch {}
  return { versione: 1, aggiornato: "", analizzati: 0, proposte: [], osservazioni: [] };
}

const resa = (t: Trade) => (t.costo > 0 ? (t.incassato - t.costo) / t.costo : 0);
interface Gruppo { trade: number; vinti: number; media: number; pf: number | null; quota: number }
function gruppo(ts: Trade[]): Gruppo {
  const r = ts.map(resa);
  const v = r.filter((x) => x > 0), p = r.filter((x) => x <= 0);
  const sp = -p.reduce((a, x) => a + x, 0);
  return { trade: r.length, vinti: v.length, media: r.length ? r.reduce((a, x) => a + x, 0) / r.length : 0, pf: sp > 0 ? v.reduce((a, x) => a + x, 0) / sp : v.length ? null : 0, quota: r.length ? v.length / r.length : 0 };
}
const pc = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2).replace(".", ",")}%`;
const descr = (g: Gruppo) => `${g.trade} operazioni, ${g.vinti} vinte (${Math.round(g.quota * 100)}%), resa media ${pc(g.media)}${g.pf !== null ? `, rapporto guadagni/perdite ${g.pf.toFixed(2).replace(".", ",")}` : ""}`;
const arrot = (x: number, passo: number) => Math.round(x / passo) * passo;
const LIVELLI = ["sopra", "sotto50", "sotto200", "sottoEntrambe"] as const;
const NOMI_LIVELLI: Record<string, string> = { sopra: "sopra le medie a 50 e 200", sotto50: "sotto la media a 50", sotto200: "sotto la media a 200", sottoEntrambe: "sotto le medie a 50 e 200" };

// Le operazioni intraday chiuse, dalla più vecchia.
const intradayChiuse = (j: JournalFile) => j.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl && (t.contesto?.tipo === "intraday" || t.contesto?.agenti?.includes("intraday") || t.contesto?.livelli)).sort((a, b) => a.chiusoIl!.localeCompare(b.chiusoIl!));

export function aggiornaProposte(stateDir: string, journal: JournalFile, now: Date): { file: FileProposte; nuove: Proposta[] } {
  const cfg = AGENTS.capo.proposte;
  const file = leggiProposte(stateDir);
  const tutte = intradayChiuse(journal);
  const ts = tutte.slice(-cfg.finestra);
  const nuove: Proposta[] = [];
  file.osservazioni = [];
  if (tutte.length < cfg.minTrade) {
    file.osservazioni.push(`Dati ancora insufficienti per proporre cambi: ${tutte.length} operazioni chiuse su ${cfg.minTrade} necessarie.`);
  } else if (tutte.length !== file.analizzati) {
    const proponi = (chiave: string, proposto: number, motivo: string, g: Gruppo) => {
      const p = paramOf(chiave);
      if (!p) return;
      const attuale = Number(getPath(chiave));
      if (p.min !== undefined) proposto = Math.max(p.min, proposto);
      if (p.max !== undefined) proposto = Math.min(p.max, proposto);
      if (p.tipo === "intero") proposto = Math.round(proposto);
      if (!Number.isFinite(attuale) || Math.abs(proposto - attuale) < 1e-9) return;
      // Una proposta aperta per impostazione; dopo un rifiuto si aspetta; dopo un'accettazione servono operazioni nuove.
      if (file.proposte.some((x) => x.chiave === chiave && x.stato === "aperta")) return;
      const rif = file.proposte.filter((x) => x.chiave === chiave && x.stato === "rifiutata" && x.decisaIl).at(-1);
      if (rif && now.getTime() - Date.parse(rif.decisaIl!) < cfg.giorniRifiuto * 86_400_000) return;
      const acc = file.proposte.filter((x) => x.chiave === chiave && x.stato === "accettata").at(-1);
      if (acc && tutte.length - (acc.tradeAllaDecisione ?? 0) < cfg.minGruppo) return;
      const x: Proposta = { id: `${now.getTime().toString(36)}-${nuove.length}`, chiave, etichetta: p.etichetta, attuale, proposto, motivo, dati: { trade: g.trade, vinti: g.vinti, media: g.media, pf: g.pf }, creata: now.toISOString(), stato: "aperta" };
      file.proposte.push(x);
      nuove.push(x);
    };
    const tot = gruppo(ts);
    const giorni = Math.max(1, (Date.parse(ts.at(-1)!.chiusoIl!) - Date.parse(ts[0]!.apertoIl)) / 86_400_000);
    file.osservazioni.push(`Ultime ${ts.length} operazioni intraday: ${descr(tot)}; circa ${(ts.length / giorni).toFixed(1).replace(".", ",")} al giorno.`);
    // 1. Probabilità minima: le operazioni entrate appena sopra la soglia (entro 5 punti) rendono meno di zero, quelle più
    //    sicure no → alzare la soglia. Tutto molto positivo ma poche operazioni → abbassarla di poco.
    const soglia = Number(getPath("AGENTS.intraday.kronos.minProb"));
    const conP = ts.filter((t) => typeof t.contesto?.misure?.probabilita === "number");
    const alLimite = conP.filter((t) => t.contesto!.misure!.probabilita! < soglia + 0.05), sicure = conP.filter((t) => t.contesto!.misure!.probabilita! >= soglia + 0.05);
    const gl = gruppo(alLimite), gs = gruppo(sicure);
    if (gl.trade >= cfg.minGruppo && gl.media < 0 && (gs.trade < cfg.minGruppo || gs.media > 0)) proponi("AGENTS.intraday.kronos.minProb", arrot(soglia + 0.02, 0.005), `Le operazioni entrate con una probabilità vicina alla soglia (sotto ${Math.round((soglia + 0.05) * 100)}%) perdono: ${descr(gl)}${gs.trade ? `; quelle più sicure: ${descr(gs)}` : ""}. Alzando la soglia si scartano i casi al limite.`, gl);
    else if (tot.trade >= cfg.minTrade * 2 && tot.quota >= 0.6 && (tot.pf ?? 0) >= 1.5 && ts.length / giorni < 1) proponi("AGENTS.intraday.kronos.minProbSenzaGrafico", arrot(Number(getPath("AGENTS.intraday.kronos.minProbSenzaGrafico")) - 0.01, 0.005), `I risultati sono buoni (${descr(tot)}) ma le operazioni sono poche (${(ts.length / giorni).toFixed(1).replace(".", ",")} al giorno): abbassando di un punto la soglia senza medie brevi in ordine si prendono più occasioni, con un margine di sicurezza ancora ampio.`, tot);
    // 2. Taglia: aspettativa negativa → più piccola; molto positiva e stabile → un po' più grande.
    //    La taglia la decide il rischio allo stop di ogni operazione (budget.rischioTrade): è lui che si propone di cambiare.
    const rischio = Number(getPath("AGENTS.intraday.budget.rischioTrade"));
    if (tot.trade >= cfg.minTrade && tot.media < 0 && (tot.pf ?? 0) < 0.9) proponi("AGENTS.intraday.budget.rischioTrade", arrot(rischio * 0.8, 0.0001), `Nel complesso le operazioni perdono (${descr(tot)}): finché i risultati non tornano positivi conviene rischiare meno su ciascuna (perdita massima allo stop dal ${(rischio * 100).toFixed(2).replace(".", ",")}% al ${(rischio * 80).toFixed(2).replace(".", ",")}% del conto).`, tot);
    else if (tot.trade >= cfg.minTrade && tot.media > 0 && (tot.pf ?? 0) >= 1.4 && tot.quota >= 0.55 && rischio < 0.005) proponi("AGENTS.intraday.budget.rischioTrade", arrot(Math.min(0.005, rischio * 1.1), 0.0001), `Le operazioni rendono con costanza (${descr(tot)}): si può rischiare un po' di più su ciascuna, restando entro il budget e i limiti del motore.`, tot);
    // 2b. Budget dell'intraday (investito insieme): dal 25% al 50% solo con almeno minTrade operazioni chiuse, resa media
    //     positiva dopo i costi e almeno il 51% vinte; se poi le operazioni perdono, si torna al 25%.
    const quota = Number(getPath("AGENTS.intraday.budget.quota")), piena = AGENTS.intraday.budget.quotaPiena;
    if (quota < piena && tot.trade >= cfg.minTrade && tot.media > 0 && tot.quota >= 0.51) proponi("AGENTS.intraday.budget.quota", piena, `Le operazioni intraday rendono dopo i costi (${descr(tot)}): si può investire insieme fino al ${Math.round(piena * 100)}% del conto invece del ${Math.round(quota * 100)}%. Ogni operazione resta limitata dal rischio allo stop (${(AGENTS.intraday.budget.rischioTrade * 100).toFixed(2).replace(".", ",")}% del conto) e le crypto al ${Math.round(AGENTS.intraday.budget.maxCrypto * 100)}%.`, tot);
    else if (quota > 0.25 && tot.trade >= cfg.minTrade && tot.media < 0) proponi("AGENTS.intraday.budget.quota", 0.25, `Con il budget al ${Math.round(quota * 100)}% le operazioni intraday perdono (${descr(tot)}): meglio tornare al 25% finché i risultati non migliorano.`, tot);
    // 3. Scaletta delle medie: un livello che perde → più prudenza; uno che rende molto → un po' meno.
    for (const [i, liv] of LIVELLI.entries()) {
      const g = gruppo(ts.filter((t) => t.contesto?.misure?.medie === i));
      if (g.trade < cfg.minGruppo) continue;
      const chiave = `AGENTS.prudenzaMedie.intraday.${liv}`;
      const f = Number(getPath(chiave));
      if (g.media < 0 && (g.pf ?? 0) < 0.8) proponi(chiave, arrot(Math.max(0.3, f * 0.8), 0.05), `Con il prezzo ${NOMI_LIVELLI[liv]} le operazioni perdono (${descr(g)}): più prudenza in quella situazione.`, g);
      else if (f < 1 && g.media > 0 && (g.pf ?? 0) >= 1.5 && g.quota >= 0.6) proponi(chiave, arrot(Math.min(1, f * 1.1), 0.05), `Con il prezzo ${NOMI_LIVELLI[liv]} le operazioni rendono bene (${descr(g)}): la prudenza su quel livello si può allentare un poco.`, g);
    }
    // 4. Margine sui costi: le operazioni con un obiettivo vicino ai costi perdono → margine più alto.
    const margine = Number(getPath("AGENTS.costi.margineCosti"));
    const vicine = ts.filter((t) => { const lv = t.contesto?.livelli; const ing = t.comprate > 0 ? t.costo / t.comprate : 0; if (!lv?.obiettivo || !ing) return false; const costi = isCrypto(t.simbolo) ? AGENTS.costi.cryptoAndataRitorno : AGENTS.costi.azioniAndataRitorno; return lv.obiettivo / ing - 1 < costi * (margine + 0.5); });
    const gv = gruppo(vicine);
    if (gv.trade >= cfg.minGruppo && gv.media < 0) proponi("AGENTS.costi.margineCosti", margine + 0.5, `Le operazioni con un obiettivo vicino ai costi (meno di ${margine + 0.5} volte i costi) perdono: ${descr(gv)}. Chiedere un rialzo previsto più ampio scarta quelle che i costi si mangiano.`, gv);
    // 5. Scadenza dell'orizzonte: le chiusure per tempo scaduto perdono → si chiude prima.
    const scad = ts.filter((t) => /scadut|orizzonte|scadenza/i.test(t.motivoUscita ?? ""));
    const gsc = gruppo(scad);
    if (gsc.trade >= cfg.minGruppo && gsc.media < 0) proponi("AGENTS.intraday.scadenzaOrizzonte", arrot(Number(getPath("AGENTS.intraday.scadenzaOrizzonte")) - 0.25, 0.05), `Le operazioni chiuse perché è passato il tempo previsto perdono (${descr(gsc)}): conviene chiuderle prima, quando la previsione non si è avverata.`, gsc);
    // 6. Rientri nello stesso giorno: se perdono, un ingresso al giorno per titolo.
    const rientri = ts.filter((t) => ts.some((u) => u !== t && u.simbolo === t.simbolo && u.apertoIl < t.apertoIl && romeTime(new Date(u.apertoIl)).date === romeTime(new Date(t.apertoIl)).date));
    const gr = gruppo(rientri);
    const maxIng = Number(getPath("AGENTS.intraday.ingressiGiorno.max"));
    if (gr.trade >= cfg.minGruppo && gr.media < 0 && maxIng > 1) proponi("AGENTS.intraday.ingressiGiorno.max", maxIng - 1, `I rientri sullo stesso titolo nello stesso giorno perdono (${descr(gr)}): meno rientri.`, gr);
    // 7. Riporto al giorno dopo: se le operazioni riportate perdono → riporto più selettivo.
    const rip = ts.filter((t) => (t.contesto?.livelli?.riporti ?? 0) > 0);
    const grp = gruppo(rip);
    if (grp.trade >= cfg.minGruppo && grp.media < 0) proponi("AGENTS.intraday.riporto.minProb", arrot(Number(getPath("AGENTS.intraday.riporto.minProb")) + 0.05, 0.01), `Le operazioni riportate al giorno dopo perdono (${descr(grp)}): si riporta solo quando Kronos è più sicuro.`, grp);
    // Osservazioni per candela (senza proposta: la scelta delle candele la fa già l'affidabilità misurata).
    for (const tf of ["5Min", "15Min", "1Hour", "4Hour"]) { const g = gruppo(ts.filter((t) => t.contesto?.livelli?.candela === tf)); if (g.trade >= cfg.minGruppo) file.osservazioni.push(`Candele ${tf}: ${descr(g)}.`); }
    file.analizzati = tutte.length;
  }
  // Le proposte aperte superate (il valore attuale è già quello proposto, cambiato a mano) si chiudono.
  for (const x of file.proposte) if (x.stato === "aperta" && Math.abs(Number(getPath(x.chiave)) - x.proposto) < 1e-9) Object.assign(x, { stato: "superata", decisaIl: now.toISOString() });
  file.proposte = file.proposte.slice(-50);
  file.aggiornato = now.toISOString();
  writeJsonAtomic(propostePath(stateDir), file);
  return { file, nuove };
}

// Accetta o rifiuta una proposta. Accettare salva il valore come le altre impostazioni (tenendo quelle già cambiate).
export function decidiProposta(stateDir: string, id: string, azione: "accetta" | "rifiuta", journal: JournalFile | null, now: Date): { ok: true; nota: string } | { ok: false; errore: string } {
  const file = leggiProposte(stateDir);
  const x = file.proposte.find((p) => p.id === id);
  if (!x) return { ok: false, errore: "proposta non trovata" };
  if (x.stato !== "aperta") return { ok: false, errore: `proposta già ${x.stato}` };
  if (azione === "accetta") {
    const r = saveAgentSettings(stateDir, { ...readAgentSettings(stateDir), [x.chiave]: x.proposto });
    if (!r.ok) return { ok: false, errore: r.errori.join("; ") };
  }
  Object.assign(x, { stato: azione === "accetta" ? "accettata" : "rifiutata", decisaIl: now.toISOString(), tradeAllaDecisione: journal ? intradayChiuse(journal).length : file.analizzati });
  writeJsonAtomic(propostePath(stateDir), file);
  return { ok: true, nota: azione === "accetta" ? `${x.etichetta}: ${x.attuale} → ${x.proposto}, applicato dal prossimo giro.` : `Proposta rifiutata: ${x.etichetta} resta ${x.attuale}; non verrà riproposta per ${AGENTS.capo.proposte.giorniRifiuto} giorni.` };
}
