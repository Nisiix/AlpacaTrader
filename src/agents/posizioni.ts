import type { JournalFile } from "../journal.ts";

// Un'operazione intraday è un trade aperto votato solo dall'agente "intraday": si chiude in giornata con le sue regole
// (obiettivo, stop, Kronos sulle candele brevi). Le regole pensate per le posizioni di più giorni (proiezione a 5 sedute,
// presa di profitto, uscita di trend) non la riguardano.
export function soloIntraday(journal: JournalFile, simbolo: string): boolean {
  const a = journal.trade.find((t) => t.simbolo === simbolo && t.stato === "aperto")?.contesto?.agenti;
  return !!a && a.length === 1 && a[0] === "intraday";
}

export function simboliIntraday(journal: JournalFile): Set<string> {
  const out = new Set<string>();
  for (const t of journal.trade) if (t.stato === "aperto" && soloIntraday(journal, t.simbolo)) out.add(t.simbolo);
  return out;
}
