import { AGENTS } from "../config.ts";
import { romeTime } from "../slots.ts";
import type { JournalFile, Trade } from "../journal.ts";
import type { AgentReport, Signal } from "./types.ts";
import { personeDelTrade } from "./persone.ts";

// Il capo ufficio: conosce la logica del motore e controlla il lavoro degli altri agenti sui trade chiusi del diario.
// Giudica le persone, non i titoli: ogni trading agent e intraday agent (p:Nome) sui trade che ha preso lui, e gli agenti
// generali (trend, rientro, kronos...) sui trade che hanno votato. Per ognuno: vinti, persi, risultato medio, la
// proiezione di Kronos che aveva all'ingresso e come sono andate le sue sessioni (giorni chiusi in guadagno o in perdita). Chi lavora bene viene lodato; chi lavora male viene richiamato e riceve consigli concreti
// presi da chi ha avuto successo: la soglia di Kronos sotto la quale non entrare, il tipo d'ingresso che ha reso, la
// taglia. I consigli diventano vincolanti per l'agente richiamato (i suoi voti d'acquisto sotto la soglia di Kronos
// consigliata non valgono, la forza degli altri si riduce) finché i risultati non tornano buoni. Mai ordini propri.
export type Giudizio = "ottimo" | "bene" | "da seguire" | "richiamato" | "nuovo";

export interface Valutazione {
  agente: string;
  trade: number;
  vinti: number;
  persi: number;
  percVinti: number | null;
  media: number | null; // risultato medio per trade (frazione)
  risultato: number; // $ totali
  kronosVinti: number | null; // proiezione media all'ingresso dei trade vinti (solo trade di più giorni: Kronos a 5 sedute)
  kronosPersi: number | null;
  // Per i trade intraday il metro è la probabilità con cui si è entrati (Kronos sulle candele), non Kronos a 5 sedute.
  probVinti?: number | null;
  probPersi?: number | null;
  giudizio: Giudizio;
  messaggio: string; // cosa gli dice il capo
  consigli: string[];
  // Regole che il capo impone finché il richiamo resta: soglia minima di Kronos per comprare e forza dei voti.
  kronosMin: number | null;
  forza: number;
  // Le sue sessioni di trading (giorni in cui ha chiuso trade): quante in guadagno e quante in perdita.
  sessioni?: { positive: number; negative: number };
}

export interface CapoReport {
  aggiornato: string;
  sintesi: string;
  migliori: string[];
  valutazioni: Valutazione[];
  // Lezione comune dai trade vincenti di tutti: da quale proiezione di Kronos in su si è vinto più spesso.
  sogliaKronos: number | null;
  // La stessa lezione per l'intraday: da quale probabilità d'ingresso in su si è vinto di più (almeno LEZIONE_MIN trade).
  sogliaProbabilita?: number | null;
  ingressoMigliore: string | null;
  // Trade chiusi da una regola che non esiste più (venduti il giorno stesso dall'uscita di trend): non giudicano nessuno.
  esclusi?: number;
}

// Nome della squadra dei custodi nei giudizi: un custode segue un titolo solo e raramente arriva a 3 trade, la squadra sì.
export const SQUADRA_CUSTODI = "custodi (squadra)";

const nome = (k: string) => (k.startsWith("p:") ? k.slice(2) : k);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (x: number | null, d = 1) => (x === null ? "n.d." : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const pnlOf = (t: Trade) => (t.incassato ?? 0) - (t.costo ?? 0);
// La proiezione all'ingresso: dal campo kronos del diario o, per i trade registrati prima che esistesse, dal motivo
// dell'ingresso ("Kronos anticipa 12.9%", "rialzo anticipato da Kronos (+4.0% …)").
export function kronosOf(t: Pick<Trade, "contesto">): number | null {
  if (typeof t.contesto?.kronos === "number") return t.contesto.kronos;
  const m = (t.contesto?.perche ?? "").match(/Kronos[^%\d+-]{0,40}([+-]?\d+(?:[.,]\d+)?)%/i);
  return m ? Number(m[1]!.replace(",", ".")) / 100 : null;
}
// Venduto lo stesso giorno dall'uscita di trend: oggi la regola non lo permette più (il giorno d'acquisto si tiene).
export const regolaSuperata = (t: Trade) =>
  !!t.chiusoIl && romeTime(new Date(t.apertoIl)).date === romeTime(new Date(t.chiusoIl)).date && /uscita di trend/i.test(t.motivoUscita ?? "");
export const entryKind = (t: Pick<Trade, "contesto">) => (/rientro|vicino alla media/i.test(t.contesto?.perche ?? "") ? "rientro sulla media a 20" : /rottura/i.test(t.contesto?.perche ?? "") ? "rottura dei massimi" : /Kronos anticipa/i.test(t.contesto?.perche ?? "") ? "rialzo anticipato da Kronos" : "trend");

// Una «lezione per tutti» si trae solo da abbastanza trade: con meno è rumore (il primo giorno, da 6 trade, «con Kronos
// ≥ +0,0% si è vinto di più»).
export const LEZIONE_MIN = 20;
export const intradayTrade = (t: Pick<Trade, "contesto">) => t.contesto?.tipo === "intraday" || (!t.contesto?.tipo && !!t.contesto?.livelli);
const probOf = (t: Pick<Trade, "contesto">) => (typeof t.contesto?.misure?.probabilita === "number" ? t.contesto.misure.probabilita : null);

// La soglia di Kronos (a 5 sedute) che separa meglio vinti e persi tra i trade di più giorni chiusi: per gli intraday
// conta un'altra cosa (bestProbThreshold).
export function bestKronosThreshold(trades: Trade[]): number | null {
  const withK = trades.filter((t) => !intradayTrade(t) && kronosOf(t) !== null);
  if (withK.length < LEZIONE_MIN) return null;
  let best: { s: number; score: number } | null = null;
  for (const s of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05]) {
    const kept = withK.filter((t) => kronosOf(t)! >= s);
    if (kept.length < 3) continue;
    const win = kept.filter((t) => (t.risultato ?? 0) > 0).length / kept.length;
    const avg = mean(kept.map((t) => t.risultato ?? 0))!;
    const score = avg * Math.sqrt(kept.length) + win * 0.001;
    if (!best || score > best.score) best = { s, score };
  }
  return best ? best.s : null;
}

// La probabilità d'ingresso (Kronos sulle candele) che separa meglio vinti e persi tra i trade intraday chiusi.
export function bestProbThreshold(trades: Trade[]): number | null {
  const withP = trades.filter((t) => intradayTrade(t) && probOf(t) !== null);
  if (withP.length < LEZIONE_MIN) return null;
  let best: { s: number; score: number } | null = null;
  for (const s of [0.55, 0.57, 0.6, 0.62, 0.65, 0.7, 0.75]) {
    const kept = withP.filter((t) => probOf(t)! >= s);
    if (kept.length < 5) continue;
    const win = kept.filter((t) => (t.risultato ?? 0) > 0).length / kept.length;
    const avg = mean(kept.map((t) => t.risultato ?? 0))!;
    const score = avg * Math.sqrt(kept.length) + win * 0.001;
    if (!best || score > best.score) best = { s, score };
  }
  return best ? best.s : null;
}

// La chiave del giudizio: la persona (p:Nome) o il nome dell'agente generale (trend, kronos...).
export const chiaviGiudizio = (t: Trade, vecchi: Record<string, string> = {}) => personeDelTrade(t, vecchi).map((k) => (k.startsWith("a:") ? k.slice(2) : k));

export function review(journal: JournalFile, now: Date, vecchi: Record<string, string> = {}): CapoReport {
  const all = journal.trade.filter((t) => t.stato === "chiuso" && t.risultato !== undefined);
  const closed = all.filter((t) => !regolaSuperata(t));
  const esclusi = all.length - closed.length;
  const byAgent = new Map<string, Trade[]>();
  for (const t of closed) for (const a of chiaviGiudizio(t, vecchi)) byAgent.set(a, [...(byAgent.get(a) ?? []), t]);
  const winners = closed.filter((t) => (t.risultato ?? 0) > 0);
  const sogliaKronos = bestKronosThreshold(closed);
  const sogliaProbabilita = bestProbThreshold(closed);
  const kinds = new Map<string, number[]>();
  for (const t of closed) kinds.set(entryKind(t), [...(kinds.get(entryKind(t)) ?? []), t.risultato ?? 0]);
  const bestKind = [...kinds].filter(([, r]) => r.length >= 2).sort((a, b) => mean(b[1])! - mean(a[1])!)[0];
  const ingressoMigliore = bestKind && mean(bestKind[1])! > 0 ? bestKind[0] : null;
  const valutazioni: Valutazione[] = [];
  for (const [agente, ts] of byAgent) {
    const res = ts.map((t) => t.risultato ?? 0);
    const vinti = res.filter((r) => r > 0).length;
    const n = ts.length;
    const media = mean(res);
    const percVinti = n ? vinti / n : null;
    // Kronos a 5 sedute solo per i trade di più giorni; per gli intraday la probabilità d'ingresso.
    const kv = mean(ts.filter((t) => !intradayTrade(t) && (t.risultato ?? 0) > 0 && kronosOf(t) !== null).map((t) => kronosOf(t)!));
    const kp = mean(ts.filter((t) => !intradayTrade(t) && (t.risultato ?? 0) <= 0 && kronosOf(t) !== null).map((t) => kronosOf(t)!));
    const pv = mean(ts.filter((t) => intradayTrade(t) && (t.risultato ?? 0) > 0 && probOf(t) !== null).map((t) => probOf(t)!));
    const pp = mean(ts.filter((t) => intradayTrade(t) && (t.risultato ?? 0) <= 0 && probOf(t) !== null).map((t) => probOf(t)!));
    const soloIntraday = ts.every(intradayTrade);
    // Le sue sessioni: per giorno di chiusura (ora di Roma), risultato in dollari.
    const perGiorno = new Map<string, number>();
    for (const t of ts) { const g = romeTime(new Date(t.chiusoIl ?? t.apertoIl)).date; perGiorno.set(g, (perGiorno.get(g) ?? 0) + pnlOf(t)); }
    const sessioni = { positive: [...perGiorno.values()].filter((x) => x > 0).length, negative: [...perGiorno.values()].filter((x) => x <= 0).length };
    const consigli: string[] = [];
    let giudizio: Giudizio;
    let messaggio: string;
    let kronosMin: number | null = null;
    let forza = 1;
    // Si giudica prima l'aspettativa (guadagno medio a trade, profit factor), poi il vincolo del 51% di vittorie. Sotto i
    // 10 trade non si giudica: con meno il risultato è quasi tutto caso.
    const guad = ts.filter((t) => pnlOf(t) > 0).reduce((a, t) => a + pnlOf(t), 0);
    const perd = -ts.filter((t) => pnlOf(t) <= 0).reduce((a, t) => a + pnlOf(t), 0);
    const pf = perd > 0 ? guad / perd : null;
    const pfTxt = pf !== null ? `, profit factor ${pf.toFixed(2)}` : "";
    if (n < AGENTS.apprendimento.minTradeSquadra) {
      giudizio = "nuovo";
      messaggio = `${n} trade chiusi: troppo pochi per giudicare (servono ${AGENTS.apprendimento.minTradeSquadra}). Continua seguendo Kronos e le regole del motore.`;
    } else if ((media ?? 0) > 0 && (percVinti ?? 0) >= 0.51) {
      giudizio = (pf ?? 99) >= 1.5 && (percVinti ?? 0) >= 0.55 ? "ottimo" : "bene";
      messaggio = `Ottimo lavoro: ${vinti} vinti su ${n}, guadagno medio ${pct(media, 2)} a trade${pfTxt}. Continua così.`;
    } else if ((media ?? 0) > 0) {
      giudizio = "da seguire";
      messaggio = `In attivo (${pct(media, 2)} a trade${pfTxt}) ma vinci solo ${Math.round((percVinti ?? 0) * 100)}% delle volte: seleziona meglio gli ingressi.`;
      if (soloIntraday && sogliaProbabilita !== null) consigli.push(`Entra solo con probabilità ≥ ${Math.round(sogliaProbabilita * 100)}%: è la soglia da cui i trade intraday di tutti hanno reso di più.`);
      else if (!soloIntraday && sogliaKronos !== null) consigli.push(`Entra solo con Kronos ≥ ${pct(sogliaKronos)}: è la soglia da cui i trade di tutti hanno reso di più.`);
    } else if ((percVinti ?? 0) >= 0.51) {
      giudizio = "da seguire";
      messaggio = `Vinci spesso (${Math.round((percVinti ?? 0) * 100)}%) ma il guadagno medio è ${pct(media, 2)} a trade${pfTxt}: gli incassi sono troppo piccoli rispetto alle perdite. Lascia correre di più i trade buoni o taglia prima quelli cattivi.`;
    } else {
      giudizio = "richiamato";
      messaggio = `Richiamo: ${vinti} vinti su ${n}, risultato medio ${pct(media, 2)}. Così non va: da ora entri solo quando Kronos è netto e con forza ridotta, finché i risultati non migliorano.`;
      kronosMin = Math.max(AGENTS.kronos.anticipaSoglia, sogliaKronos ?? 0, kv !== null ? Math.min(kv, 0.05) : 0);
      forza = 0.6;
      if (soloIntraday) consigli.push(`Taglia ridotta finché i risultati non migliorano${pv !== null || pp !== null ? ` (i tuoi trade vinti partivano in media da una probabilità del ${pv !== null ? Math.round(pv * 100) : "n.d."}%, i persi del ${pp !== null ? Math.round(pp * 100) : "n.d."}%)` : ""}${sogliaProbabilita !== null ? `; entra solo con probabilità ≥ ${Math.round(sogliaProbabilita * 100)}%` : ""}.`);
      else consigli.push(`Soglia minima di Kronos per comprare: ${pct(kronosMin)} (i tuoi trade vinti partivano in media da ${pct(kv)}, i persi da ${pct(kp)}).`);
      if (ingressoMigliore) consigli.push(`Preferisci l'ingresso «${ingressoMigliore}»: è quello che ha reso di più nell'ufficio.`);
      const lessThanHalfStop = ts.filter((t) => /stop/i.test(t.motivoUscita ?? "")).length;
      if (lessThanHalfStop >= 2) consigli.push(`${lessThanHalfStop} uscite dallo stop: evita gli ingressi troppo lontani dalla media a 20, aspetta il rientro.`);
    }
    if (giudizio !== "richiamato" && giudizio !== "nuovo" && kv !== null) consigli.push(`I tuoi trade vinti partivano da Kronos ${pct(kv)} in media: tieni quella soglia.`);
    if (giudizio !== "richiamato" && giudizio !== "nuovo" && pv !== null) consigli.push(`I tuoi trade intraday vinti partivano da una probabilità del ${Math.round(pv * 100)}% in media.`);
    if (perGiorno.size >= 2) messaggio += ` Sessioni: ${sessioni.positive} in guadagno, ${sessioni.negative} in perdita.`;
    if (giudizio === "da seguire" && sessioni.negative > sessioni.positive) consigli.push(`Più sessioni in perdita che in guadagno: meno ingressi, solo i più netti.`);
    valutazioni.push({ agente, trade: n, vinti, persi: n - vinti, percVinti, media, risultato: ts.reduce((a, t) => a + pnlOf(t), 0), kronosVinti: kv, kronosPersi: kp, probVinti: pv, probPersi: pp, giudizio, messaggio, consigli, kronosMin, forza, sessioni });
  }
  valutazioni.sort((a, b) => b.risultato - a.risultato);
  const migliori = valutazioni.filter((v) => v.giudizio === "ottimo" || v.giudizio === "bene").slice(0, 3).map((v) => v.agente);
  const richiamati = valutazioni.filter((v) => v.giudizio === "richiamato");
  const totWin = winners.length;
  const nota = esclusi ? ` (${esclusi} ${esclusi === 1 ? "trade chiuso" : "trade chiusi"} dalla vecchia uscita in giornata non ${esclusi === 1 ? "conta" : "contano"})` : "";
  const sintesi = !closed.length
    ? `Nessun trade chiuso da giudicare${nota}: osservo, i giudizi arrivano con i primi risultati.`
    : `${closed.length} trade chiusi${nota}, ${totWin} vinti (${Math.round((totWin / closed.length) * 100)}%).${migliori.length ? ` Migliori: ${migliori.map(nome).join(", ")}.` : ""}${richiamati.length ? ` Richiamati: ${richiamati.map((v) => nome(v.agente)).join(", ")}.` : " Nessun richiamo."}${sogliaKronos !== null ? ` Lezione per tutti: con Kronos ≥ ${pct(sogliaKronos)} si è vinto di più.` : ""}${sogliaProbabilita !== null ? ` Lezione intraday: con probabilità d'ingresso ≥ ${Math.round(sogliaProbabilita * 100)}% si è vinto di più.` : ""}`;
  return { aggiornato: now.toISOString(), sintesi, migliori, valutazioni, sogliaKronos, sogliaProbabilita, ingressoMigliore, esclusi };
}

// Applica i richiami ai voti: per gli agenti richiamati i voti d'acquisto sotto la soglia di Kronos non valgono e gli altri
// pesano meno. Le vendite non si toccano. Restituisce le note da mostrare.
// `chiDelVoto`: la persona che prende il voto (p:Nome) o il nome dell'agente generale.
export function applyGuidance(reports: Record<string, AgentReport>, capo: CapoReport, previsioni: Record<string, number> | undefined, chiDelVoto: (s: Signal) => string | undefined = (s) => s.agente): string[] {
  const rules = new Map(capo.valutazioni.filter((v) => v.giudizio === "richiamato").map((v) => [v.agente, v]));
  if (!rules.size) return [];
  const note: string[] = [];
  for (const r of Object.values(reports)) {
    const kept: Signal[] = [];
    for (const s of r.segnali) {
      const chi = chiDelVoto(s);
      // Coordinatore dell'apprendimento: per le persone dello staff agiscono la calibrazione e la formazione; il richiamo del
      // capo vale per gli agenti generali (niente doppia stretta sugli stessi trade).
      const rule = chi && !chi.startsWith("p:") ? rules.get(chi) : undefined;
      if (!rule || s.lato !== "buy" || s.vincolante) {
        kept.push(s);
        continue;
      }
      // Un voto intraday si regge su Kronos sulle candele brevi (già filtrato da costi e probabilità nell'agente): la soglia
      // del richiamo è sul Kronos a 5 sedute, un altro orizzonte, quindi qui vale solo la forza ridotta.
      const fc = s.kronos ?? previsioni?.[s.simbolo];
      if (!s.intraday && rule.kronosMin !== null && (fc === undefined || fc < rule.kronosMin)) {
        note.push(`capo ufficio: voto di ${s.agente} su ${s.simbolo} scartato (Kronos ${pct(fc ?? null)} sotto la soglia del richiamo ${pct(rule.kronosMin)})`);
        continue;
      }
      // Per un voto intraday il richiamo riduce la taglia, non la forza: la decisione d'entrare resta a Kronos sulle candele
      // brevi (con i suoi filtri di probabilità e costi), così il richiamo non lo porta sotto la soglia d'acquisto.
      if (s.intraday && s.pesoMassimo !== undefined) kept.push({ ...s, pesoMassimo: s.pesoMassimo * rule.forza, perche: `${s.perche} · sotto richiamo del capo ufficio: taglia ridotta` });
      else kept.push({ ...s, forza: s.forza * rule.forza, perche: `${s.perche} · sotto richiamo del capo ufficio: forza ridotta` });
    }
    r.segnali = kept;
  }
  return note;
}
