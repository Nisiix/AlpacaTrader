import type { Account, Position, Side } from "../broker/types.ts";
import type { Indicator } from "../indicators.ts";
import type { JournalFile } from "../journal.ts";
import type { CustodeStato } from "./custode.ts";

// Un segnale è un'opinione: un agente, un titolo, un lato, una forza tra 0 e 1 e il perché in italiano.
// Nessun agente ordina niente: l'allocatore somma i segnali pesati e la gabbia decide cosa passa.
export interface Signal {
  agente: string;
  simbolo: string;
  lato: Side;
  forza: number; // 0..1
  orizzonteSedute: number;
  perche: string;
  // Regola di rischio, non opinione: l'allocatore la esegue senza sommarla agli altri voti.
  vincolante?: boolean;
  // Comparto a taglia ridotta (es. il rientro): peso massimo del titolo se lo votano solo segnali con questo limite.
  pesoMassimo?: number;
  // Vendita vincolante parziale: quota della posizione da vendere (1 = tutta).
  frazione?: number;
}

export interface AgentView {
  today: string; // YYYY-MM-DD ora di Roma
  now: Date;
  prices: Record<string, number>;
  closes: Record<string, number[]>; // sedute finite, dalla più vecchia
  indicators: Record<string, Indicator>;
  positions: Position[];
  account: Account;
  journal: JournalFile;
  // Rendimento previsto per simbolo (Kronos) quando il sidecar c'è; altrimenti assente.
  previsioni?: Record<string, number>;
  // Contesto economico deciso prima degli altri agenti: settori in cui si aspetta, proiezioni di cui fidarsi.
  contesto?: MarketContext;
}

export type Outlook = "favorevole" | "neutro" | "sfavorevole";

export interface MarketContext {
  aggiornato: string;
  fonte: string; // "regole" | "claude" | "claude (cache)"
  generale: Outlook;
  settori: Record<string, Outlook>;
  motivo: string;
  // Titoli per cui oggi non si apre niente: si aspetta la candela successiva, con il perché.
  attendi: Record<string, string>;
  // Titoli per cui la proiezione (Kronos) può guidare uscite e ingressi.
  fidatiDellaProiezione: Record<string, boolean>;
}

export interface AgentReport {
  segnali: Signal[];
  // Solo l'agente del contesto: cosa ha deciso, per la vista degli altri agenti e per la dashboard.
  contesto?: MarketContext;
  // Solo gli agenti di rischio: moltiplicatore 0..1 dell'esposizione ammessa.
  rischio?: number;
  note?: string[];
  // Solo l'agente dei custodi: lo stato di ogni custode (tesi, piano, rischio, livelli), per la dashboard.
  custodi?: CustodeStato[];
}

export interface Agent {
  readonly name: string;
  observe(view: AgentView): AgentReport | Promise<AgentReport>;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
