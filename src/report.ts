import { byConfidence, groupStats, statsOf, type JournalFile, type Stats } from "./journal.ts";
import type { Witness } from "./witness.ts";
import { addDays, describeRunId } from "./slots.ts";
import type { Comparison } from "./benchmark.ts";

const money = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " $";
const signed = (n: number) => (n >= 0 ? "+" : "") + money(n);

export function alarmText(runId: string, title: string, detail: string): string {
  return `⚠️ Run ${runId} · ${title}\n${detail}`;
}

// Le prime due frasi del ragionamento, per stare in due righe.
export function twoLines(text: string): string {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences.slice(0, 2).map((s) => s.trim()).join(" ") || "(nessuna motivazione)";
}

export function endOfRunText(w: Witness): string {
  const L: string[] = [`Run ${w.sveglia} · ${w.tipo} · ${w.esito}`];
  const line = (o: { lato: string; quantita: number; simbolo: string }) => `${o.lato.toUpperCase()} ${o.quantita} ${o.simbolo}`;

  L.push("", "Ordini inviati:");
  if (w.ordiniInviati.length === 0) L.push("• nessuno");
  for (const o of w.ordiniInviati) L.push(`• ${line(o)} [${o.origine}] ${o.stato}${o.perche ? ` - ${o.perche}` : ""}`);
  for (const o of w.ordiniGiaPresenti) L.push(`• già presente su Alpaca, non rimandato: ${line(o)}`);
  for (const o of w.ordiniIncerti) L.push(`• ESITO INCERTO: ${line(o)} (controllo alla prossima sveglia)`);
  for (const o of w.ordiniFalliti) L.push(`• FALLITO: ${line(o)}: ${o.errore}`);

  L.push("", "Ordini rifiutati:");
  if (w.ordiniRifiutati.length === 0) L.push("• nessuno");
  for (const r of w.ordiniRifiutati) L.push(`• ${r.lato.toUpperCase()} ${r.quantita} ${r.simbolo} [${r.origine}]: ${r.motivo}`);

  if (w.stopSuAlpaca) {
    const st = w.stopSuAlpaca;
    L.push("", `Stop su Alpaca: ${st.attivi.length ? st.attivi.join(", ") : "nessuno"}${st.piazzati.length ? ` (nuovi: ${st.piazzati.join(", ")})` : ""}`);
    for (const e of st.errori) L.push(`• STOP NON A POSTO: ${e}`);
  }
  for (const l of w.lezioniNuove ?? []) L.push(`Lezione nuova: ${l.motivo} (fino al ${l.finoAl})`);
  if (w.acquistiBloccati) L.push(`Acquisti bloccati: ${w.acquistiBloccati}`);

  for (const t of w.tradeChiusi ?? []) L.push(`Trade chiuso: ${t.simbolo} ${pctOf(t.risultato)} in ${t.giorni} giorni (${t.uscita})`);

  L.push("", `Motivazioni: ${twoLines(w.ragionamento)}`);
  if (w.conto) {
    const base = w.conto.patrimonio - w.conto.pnlGiorno;
    const pct = base > 0 ? ((w.conto.pnlGiorno / base) * 100).toFixed(2) : "0.00";
    L.push("", `Conto: ${money(w.conto.patrimonio)} · contanti ${money(w.conto.contanti)} · P&L giorno ${signed(w.conto.pnlGiorno)} (${pct}%)${w.conto.aggiornato === false ? " · ATTENZIONE: dato di inizio sveglia, Alpaca non ha risposto alla fine" : ""}`);
  } else {
    L.push("", "Conto: non disponibile (broker non raggiungibile)");
  }
  if (w.confronto) {
    const p = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
    L.push(`Dal ${w.confronto.dal}: conto ${p(w.confronto.conto)}, SPY ${p(w.confronto.spy)}`);
  }
  if (w.diario && w.diario.statistiche.trade > 0) L.push(`Diario: ${statsLine(w.diario.statistiche)}`);
  L.push(`Prossima sveglia: ${describeRunId(w.prossimaSveglia)}`);
  if (w.allarmi.length) L.push(`Allarmi in questa sveglia: ${w.allarmi.length} (vedi messaggi ⚠️)`);
  return L.join("\n");
}

const pctOf = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

// Percentuale di vinti sempre insieme a vincita media, perdita media e risultato medio: da sola inganna.
export function statsLine(s: Stats): string {
  if (s.trade === 0) return "nessun trade chiuso";
  const opt = (x: number | null) => (x === null ? "-" : pctOf(x));
  return `${s.trade} trade chiusi, ${s.vinti} vinti (${((s.percVinti ?? 0) * 100).toFixed(0)}%), vincita media ${opt(s.mediaVincita)}, perdita media ${opt(s.mediaPerdita)}, risultato medio ${opt(s.attesa)} · campione ${s.campione}`;
}

export function weeklyText(runId: string, j: JournalFile, today: string, learning: string, cmp: Comparison | null): string {
  const from = addDays(today, -6);
  const week = j.trade.filter((t) => t.stato === "chiuso" && (t.chiusoIl ?? "").slice(0, 10) >= from);
  const L = [`📒 Run ${runId} · Riepilogo della settimana`, "", `Questa settimana: ${statsLine(statsOf(week))}`];
  for (const t of week) L.push(`• ${t.simbolo} ${pctOf(t.risultato ?? 0)} in ${t.giorni} giorni (${t.motivoUscita}; fiducia ${t.contesto?.fiducia ?? "non dichiarata"})`);
  L.push("", `Da sempre: ${statsLine(statsOf(j.trade))}`);
  const conf = groupStats(j.trade, byConfidence);
  const confLines = Object.entries(conf).map(([k, s]) => `${k}: ${s.trade} trade, risultato medio ${s.attesa === null ? "-" : pctOf(s.attesa)}`);
  if (confLines.length) L.push(`Fiducia dichiarata contro risultato: ${confLines.join(" · ")}`);
  const open = j.trade.filter((t) => t.stato === "aperto").map((t) => t.simbolo);
  L.push(`Trade aperti: ${open.length ? open.join(", ") : "nessuno"}`);
  if (cmp) L.push(`Dal ${cmp.dal}: conto ${pctOf(cmp.conto)}, SPY ${pctOf(cmp.spy)}`);
  L.push("", `Stato del diario: ${learning}`);
  return L.join("\n");
}
