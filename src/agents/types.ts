import type { Account, Position, Side } from "../broker/types.ts";
import type { Indicator } from "../indicators.ts";
import type { JournalFile } from "../journal.ts";

// Un segnale è un'opinione: un agente, un titolo, un lato, una forza tra 0 e 1 e il perché in italiano.
// Nessun agente ordina niente: l'allocatore somma i segnali pesati e la gabbia decide cosa passa.
export interface Signal {
  agente: string;
  simbolo: string;
  lato: Side;
  forza: number; // 0..1
  orizzonteSedute: number;
  perche: string;
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
}

export interface AgentReport {
  segnali: Signal[];
  // Solo gli agenti di rischio: moltiplicatore 0..1 dell'esposizione ammessa.
  rischio?: number;
  note?: string[];
}

export interface Agent {
  readonly name: string;
  observe(view: AgentView): AgentReport | Promise<AgentReport>;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
