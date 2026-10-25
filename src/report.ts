import type { Witness } from "./witness.ts";
import { describeRunId } from "./slots.ts";

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

  L.push("", `Motivazioni: ${twoLines(w.ragionamento)}`);
  if (w.conto) {
    const base = w.conto.patrimonio - w.conto.pnlGiorno;
    const pct = base > 0 ? ((w.conto.pnlGiorno / base) * 100).toFixed(2) : "0.00";
    L.push("", `Conto: ${money(w.conto.patrimonio)} · contanti ${money(w.conto.contanti)} · P&L giorno ${signed(w.conto.pnlGiorno)} (${pct}%)${w.conto.aggiornato === false ? " · ATTENZIONE: dato di inizio sveglia, Alpaca non ha risposto alla fine" : ""}`);
  } else {
    L.push("", "Conto: non disponibile (broker non raggiungibile)");
  }
  L.push(`Prossima sveglia: ${describeRunId(w.prossimaSveglia)}`);
  if (w.allarmi.length) L.push(`Allarmi in questa sveglia: ${w.allarmi.length} (vedi messaggi ⚠️)`);
  return L.join("\n");
}
