// Un ordine proposto dall'allocatore, prima della gabbia (src/cage.ts) che lo ammette o lo rifiuta.
export interface ProposedOrder {
  symbol: string;
  side: string;
  qty: number;
  why: string;
  confidence?: "bassa" | "media" | "alta" | null;
  expect?: string;
  // Operazione intraday (agente "intraday"): si apre e si chiude in giornata; la gabbia la ammette a mercato aperto.
  intraday?: boolean;
  // Proiezione di Kronos a sostegno: la gabbia ammette l'acquisto sotto la media a 50 (ma sopra la 200) se è netta.
  kronos?: number;
}
