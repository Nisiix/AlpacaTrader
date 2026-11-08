import { AGENTS, sectorOf } from "../config.ts";
import type { JournalFile, Trade } from "../journal.ts";
import { entryKind, kronosOf, regolaSuperata, type CapoReport } from "./capo.ts";
import type { CustodeStato } from "./custode.ts";
import type { IntradayStato } from "./intraday.ts";
import type { AgentReport, Signal } from "./types.ts";

// La sala caffè. Gli agenti che in questo giro non hanno niente da fare (nessuna posizione da seguire, nessun voto,
// nessun trade da aprire) lasciano la scrivania e si siedono qui. Non chiacchierano a caso: si scambiano quello che
// hanno davvero in mano.
// - Pareri: il dossier del custode (probabilità, Kronos, grafico, notizie), la candela e il motivo dell'operatore
//   intraday, le proiezioni più nette di Kronos, la lezione del capo ufficio.
// - Lezioni di squadra: dai trade chiusi di tutti (diario), cosa ha reso e cosa no per tipo d'ingresso, settore e forza
//   della proiezione di Kronos all'ingresso. Servono almeno 3 trade per parlarne.
// - Apprendimento: un voto d'acquisto che somiglia a quello che alla squadra è andato male perde forza (×0,85 per
//   lezione, mai sotto ×0,7); se somiglia a quello che ha reso, ne guadagna un poco (×1,1, mai oltre ×1,15 né oltre 1).
//   È l'esperienza degli altri che corregge il singolo, con limiti stretti: Kronos e le regole restano i padroni.
// Chi deve tornare operativo (un trade da aprire, una posizione da seguire) torna alla scrivania al giro stesso.

export interface Lezione {
  tema: "ingresso" | "settore" | "kronos" | "ingresso e settore";
  chiave: string; // es. "rialzo anticipato da Kronos · crypto"
  trade: number;
  vinti: number;
  media: number; // risultato medio per trade (frazione)
  effetto: "prudenza" | "fiducia" | null;
  testo: string;
  da: string | null; // l'agente che ne ha più esperienza (chi la racconta)
}

export interface Scambio {
  da: string; // chiave della postazione: a:trend, c:SOL/USD, i:DOT/USD, capo
  a: string | null; // a chi lo dice (null: al tavolo)
  tema: "parere" | "lezione" | "kronos" | "capo" | "rientro" | "esplorazione";
  testo: string;
}

export interface Presenza {
  chiave: string;
  nome: string;
  perche: string;
}

export interface CaffeReport {
  aggiornato: string;
  presenti: Presenza[]; // in sala caffè
  operativi: { chiave: string; nome: string; perche: string }[]; // alla scrivania, con il motivo
  scambi: Scambio[];
  lezioni: Lezione[];
  applicati: string[]; // voti cambiati da una lezione di squadra in questo giro
}

const MIN_TRADE = 3;
const pct = (x: number | null, d = 1) => (x === null ? "n.d." : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function kronosBucket(k: number | null): string {
  if (k === null) return "senza proiezione";
  if (k < AGENTS.kronos.anticipaSoglia) return `Kronos sotto ${pct(AGENTS.kronos.anticipaSoglia, 0)}`;
  if (k < 0.03) return `Kronos tra ${pct(AGENTS.kronos.anticipaSoglia, 0)} e +3%`;
  return "Kronos oltre +3%";
}

// Il tipo d'ingresso di un voto, con la stessa regola del capo ufficio sul motivo.
const kindOfSignal = (s: Signal) => entryKind({ contesto: { perche: s.perche } as Trade["contesto"] });

function keysOf(kind: string, symbol: string, k: number | null): { tema: Lezione["tema"]; chiave: string }[] {
  const sec = sectorOf(symbol);
  return [
    { tema: "ingresso", chiave: kind },
    { tema: "settore", chiave: sec },
    { tema: "kronos", chiave: kronosBucket(k) },
    { tema: "ingresso e settore", chiave: `${kind} · ${sec}` },
  ];
}

// Le lezioni di squadra dal diario: per ogni gruppo con almeno 3 trade chiusi, vinti e risultato medio.
export function teamLessons(journal: JournalFile): Lezione[] {
  const closed = journal.trade.filter((t) => t.stato === "chiuso" && t.risultato !== undefined && !regolaSuperata(t));
  const groups = new Map<string, { tema: Lezione["tema"]; chiave: string; ts: Trade[] }>();
  for (const t of closed) {
    for (const k of keysOf(entryKind(t), t.simbolo, kronosOf(t))) {
      const id = `${k.tema}|${k.chiave}`;
      const g = groups.get(id) ?? { ...k, ts: [] };
      g.ts.push(t);
      groups.set(id, g);
    }
  }
  const out: Lezione[] = [];
  for (const g of groups.values()) {
    if (g.ts.length < MIN_TRADE) continue;
    const res = g.ts.map((t) => t.risultato ?? 0);
    const vinti = res.filter((r) => r > 0).length;
    const media = mean(res);
    const win = vinti / g.ts.length;
    const effetto: Lezione["effetto"] = win < 0.4 && media < 0 ? "prudenza" : win >= 0.6 && media > 0 ? "fiducia" : null;
    // Chi la racconta: l'agente che ha più trade nel gruppo.
    const count = new Map<string, number>();
    for (const t of g.ts) for (const a of t.contesto?.agenti ?? []) count.set(a, (count.get(a) ?? 0) + 1);
    const da = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const base = `«${g.chiave}»: ${vinti} vinti su ${g.ts.length}, media ${pct(media, 2)}`;
    const testo =
      effetto === "prudenza"
        ? `${base}. Lì sbagliamo: prima di entrare serve qualcosa in più.`
        : effetto === "fiducia"
          ? `${base}. Lì funzioniamo: quando si ripresenta, si può avere più fiducia.`
          : `${base}. Ancora né bene né male.`;
    out.push({ tema: g.tema, chiave: g.chiave, trade: g.ts.length, vinti, media, effetto, testo, da });
  }
  // Prima le lezioni che cambiano qualcosa, poi le più numerose.
  return out.sort((a, b) => Number(!!b.effetto) - Number(!!a.effetto) || b.trade - a.trade);
}

// Applica le lezioni ai voti d'acquisto (non a vendite né a regole vincolanti). Restituisce le note di cosa è cambiato.
export function applyLessons(reports: Record<string, AgentReport>, lezioni: Lezione[], previsioni: Record<string, number> | undefined): string[] {
  const active = new Map(lezioni.filter((l) => l.effetto).map((l) => [`${l.tema}|${l.chiave}`, l]));
  if (!active.size) return [];
  const note: string[] = [];
  for (const r of Object.values(reports)) {
    r.segnali = r.segnali.map((s) => {
      if (s.lato !== "buy" || s.vincolante) return s;
      const k = s.kronos ?? previsioni?.[s.simbolo] ?? null;
      const hits = keysOf(kindOfSignal(s), s.simbolo, k)
        .map((x) => active.get(`${x.tema}|${x.chiave}`))
        .filter((l): l is Lezione => !!l);
      if (!hits.length) return s;
      let f = 1;
      for (const l of hits) f *= l.effetto === "prudenza" ? 0.85 : 1.1;
      f = Math.min(1.15, Math.max(0.7, f));
      const quali0 = hits.map((l) => `«${l.chiave}» ${l.vinti}/${l.trade}`).join(", ");
      // Voto intraday: l'esperienza della squadra cambia la taglia (solo in meno), non la forza; l'ingresso lo decide Kronos
      // sulle candele brevi, e la prudenza non deve bastare a portarlo sotto la soglia d'acquisto.
      if (s.intraday && s.pesoMassimo !== undefined) {
        if (f >= 1) return s;
        note.push(`sala caffè: ${s.agente} su ${s.simbolo} più prudente (taglia ×${f.toFixed(2)}) per l'esperienza della squadra: ${quali0}`);
        return { ...s, pesoMassimo: s.pesoMassimo * f, perche: `${s.perche} · sala caffè: taglia ridotta dall'esperienza della squadra (${quali0})` };
      }
      const forza = Math.min(1, s.forza * f);
      if (Math.abs(forza - s.forza) < 1e-9) return s;
      const quali = hits.map((l) => `«${l.chiave}» ${l.vinti}/${l.trade}`).join(", ");
      note.push(`sala caffè: ${s.agente} su ${s.simbolo} ${f < 1 ? "più prudente" : "più fiducioso"} (forza ${s.forza.toFixed(2)} → ${forza.toFixed(2)}) per l'esperienza della squadra: ${quali}`);
      return { ...s, forza, perche: `${s.perche} · sala caffè: ${f < 1 ? "prudenza" : "fiducia"} dall'esperienza della squadra (${quali})` };
    });
  }
  return note;
}

// Chi sta alla scrivania e chi va in sala caffè in questo giro, e cosa si dicono.
export function coffeeBreak(input: {
  now: Date;
  reports: Record<string, AgentReport>;
  held: Set<string>;
  previsioni: Record<string, number> | undefined;
  scartate: string[];
  lezioni: Lezione[];
  capo: CapoReport | null;
  applicati: string[];
  giro: number; // per far girare gli argomenti da un giro all'altro
  primaInPausa?: Set<string>; // chi era in sala caffè al giro prima: solo loro "tornano" alla scrivania
  esploratori?: Map<string, string>; // chi sta lavorando su un titolo trovato con l'esplorazione: alla scrivania
}): CaffeReport {
  const { reports, held } = input;
  const presenti: Presenza[] = [];
  const operativi: CaffeReport["operativi"] = [];
  const signals = Object.values(reports).flatMap((r) => r.segnali);
  const voted = (pred: (s: Signal) => boolean) => signals.find(pred);
  const esploratori = input.esploratori ?? new Map<string, string>();
  for (const [k, why] of esploratori) operativi.push({ chiave: k, nome: k, perche: why });
  const taken = (k: string) => esploratori.has(k);

  // Agenti generali: alla scrivania se votano o se stanno frenando il rischio (regime, contesto); altrimenti in pausa.
  for (const [n, r] of Object.entries(reports)) {
    if (n === "custodi" || n === "intraday" || taken(`a:${n}`)) continue;
    const v = r.segnali[0];
    if (v) operativi.push({ chiave: `a:${n}`, nome: n, perche: `vota ${v.lato === "buy" ? "acquisto" : "vendita"} ${v.simbolo}` });
    else if (r.rischio !== undefined && r.rischio < 1) operativi.push({ chiave: `a:${n}`, nome: n, perche: `tiene il rischio a ${Math.round(r.rischio * 100)}%` });
    else presenti.push({ chiave: `a:${n}`, nome: n, perche: "nessun voto in questo giro" });
  }
  // Custodi: alla scrivania con una posizione, un'uscita, un ingresso pronto o un voto; altrimenti in sala caffè.
  const custodi: CustodeStato[] = Object.values(reports).flatMap((r) => r.custodi ?? []);
  for (const c of custodi) {
    const key = `c:${c.simbolo}`;
    if (taken(key)) continue;
    const v = voted((s) => s.agente === c.agente);
    if (held.has(c.simbolo) || c.fase === "in posizione" || c.fase === "in uscita") operativi.push({ chiave: key, nome: c.agente, perche: "segue la posizione" });
    else if (v) operativi.push({ chiave: key, nome: c.agente, perche: `trade da ${v.lato === "buy" ? "aprire" : "chiudere"} su ${c.simbolo}` });
    else if (c.fase === "pronto") operativi.push({ chiave: key, nome: c.agente, perche: "ingresso pronto" });
    else presenti.push({ chiave: key, nome: c.agente, perche: c.fase === "attende" ? "aspetta: niente da aprire" : "osserva da lontano" });
  }
  // Operatori intraday: in posizione o con un ingresso votato alla scrivania; chi cerca soltanto, in pausa.
  const intraday: IntradayStato[] = Object.values(reports).flatMap((r) => r.intraday ?? []);
  for (const x of intraday) {
    const key = `i:${x.simbolo}`;
    if (taken(key)) continue;
    const v = voted((s) => s.agente === "intraday" && s.simbolo === x.simbolo);
    if (x.fase === "in posizione") operativi.push({ chiave: key, nome: `intraday ${x.simbolo}`, perche: "operazione aperta" });
    else if (v) operativi.push({ chiave: key, nome: `intraday ${x.simbolo}`, perche: `ingresso su ${x.simbolo}, candele ${x.candela}` });
    else if (x.fase === "cerca ingresso") presenti.push({ chiave: key, nome: `intraday ${x.simbolo}`, perche: "cerca un ingresso, ancora niente" });
  }

  // Cosa si dicono: solo cose vere, prese dai loro dati.
  const scambi: Scambio[] = [];
  const here = presenti.map((p) => p.chiave);
  const peerOf = (key: string, pref?: (k: string) => boolean) => {
    const others = here.filter((k) => k !== key);
    const best = pref ? others.filter(pref) : [];
    const pool = best.length ? best : others;
    return pool.length ? pool[(input.giro + key.length) % pool.length]! : null;
  };
  const sec = (k: string) => (k.startsWith("c:") || k.startsWith("i:") ? sectorOf(k.slice(2)) : null);
  // 1. I custodi in pausa raccontano il loro dossier a un collega dello stesso settore.
  for (const c of custodi.filter((c) => here.includes(`c:${c.simbolo}`)).slice(0, 6)) {
    const d = c.dossier;
    if (!d) continue;
    const key = `c:${c.simbolo}`;
    const pezzi = [`${c.simbolo}: ${Math.round(d.probabilita * 100)}% favorevole`, `Kronos ${d.kronos.nota}`];
    if (d.tecnica.pattern.length) pezzi.push(`grafico: ${d.tecnica.pattern.slice(0, 2).join(", ")}`);
    if (d.notizie.punteggio !== null) pezzi.push(`notizie ${d.notizie.nota}`);
    if (d.memoria.trade) pezzi.push(`memoria: ${d.memoria.lezione}`);
    scambi.push({ da: key, a: peerOf(key, (k) => sec(k) === sectorOf(c.simbolo)), tema: "parere", testo: pezzi.join(" · ") });
  }
  // 1b. Gli agenti generali in pausa raccontano la loro lettura del giro (le loro note).
  for (const p of presenti.filter((p) => p.chiave.startsWith("a:")).slice(0, 4)) {
    const n = reports[p.nome]?.note?.[0];
    if (n) scambi.push({ da: p.chiave, a: peerOf(p.chiave), tema: "parere", testo: n.length > 220 ? `${n.slice(0, 217)}…` : n });
  }
  // 2. Gli operatori intraday in pausa dicono cosa vedono sulle candele brevi.
  for (const x of intraday.filter((x) => here.includes(`i:${x.simbolo}`)).slice(0, 4)) {
    const key = `i:${x.simbolo}`;
    scambi.push({ da: key, a: peerOf(key, (k) => k.startsWith("i:") || sec(k) === sectorOf(x.simbolo)), tema: "parere", testo: `${x.simbolo} su candele ${x.candela}: ${x.motivo}` });
  }
  // 3. Kronos (alla scrivania o in pausa) dice dove vede i rialzi e i ribassi più netti, e cosa ha scartato.
  const fc = Object.entries(input.previsioni ?? {});
  if (fc.length) {
    const ups = fc.filter(([, v]) => v >= AGENTS.kronos.anticipaSoglia).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const downs = fc.filter(([, v]) => v <= -AGENTS.kronos.anticipaSoglia).sort((a, b) => a[1] - b[1]).slice(0, 3);
    const t = [
      ups.length ? `rialzi più netti ${ups.map(([s, v]) => `${s} ${pct(v)}`).join(", ")}` : "nessun rialzo oltre la soglia",
      downs.length ? `ribassi ${downs.map(([s, v]) => `${s} ${pct(v)}`).join(", ")}` : "",
      input.scartate.length ? `non fidatevi di ${input.scartate.join(", ")}: proiezione fuori misura` : "",
    ].filter(Boolean);
    scambi.push({ da: "a:kronos", a: null, tema: "kronos", testo: `Per le prossime ${AGENTS.kronos.horizon} sedute: ${t.join("; ")}.` });
  }
  // 4. Le lezioni di squadra: le racconta chi ne ha più esperienza.
  for (const l of input.lezioni.filter((l) => l.effetto).slice(0, 4)) {
    const da = l.da?.startsWith("custode ") ? `c:${l.da.slice(8)}` : l.da === "intraday" ? (here.find((k) => k.startsWith("i:")) ?? "capo") : l.da ? `a:${l.da}` : "capo";
    scambi.push({ da: here.includes(da) ? da : (here[0] ?? da), a: null, tema: "lezione", testo: l.testo });
  }
  // 5. Il capo ufficio passa a dare la lezione comune, se ce n'è una.
  if (input.capo) {
    const cp = input.capo;
    const msg = [
      cp.sogliaKronos !== null ? `si vince di più con Kronos ≥ ${pct(cp.sogliaKronos)}` : "",
      cp.ingressoMigliore ? `l'ingresso che rende di più è «${cp.ingressoMigliore}»` : "",
      ...cp.valutazioni.filter((v) => v.giudizio === "richiamato").map((v) => `${v.agente} è richiamato: ${v.consigli[0] ?? v.messaggio}`),
    ].filter(Boolean);
    if (msg.length) scambi.push({ da: "capo", a: null, tema: "capo", testo: `A tutti: ${msg.join("; ")}.` });
  }
  // 6. Chi era in pausa e ora ha da fare lo dice e torna alla scrivania.
  for (const o of operativi.filter((o) => input.primaInPausa?.has(o.chiave)).slice(0, 4)) scambi.push({ da: o.chiave, a: null, tema: "rientro", testo: `Torno alla scrivania: ${o.perche}.` });

  return { aggiornato: input.now.toISOString(), presenti, operativi, scambi: scambi.slice(0, 16), lezioni: input.lezioni.slice(0, 12), applicati: input.applicati };
}
