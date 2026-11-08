import type { Account, MarketClock, Order, Position } from "../broker/types.ts";
import type { SlotKind } from "../config.ts";
import type { Indicator } from "../indicators.ts";
import type { journalForBrain } from "../journal.ts";
import type { Lesson } from "../lessons.ts";
import type { Witness } from "../witness.ts";

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

export interface Decision {
  orders: ProposedOrder[];
  reasoning: string;
  plan_next: string;
}

export interface BrainInput {
  runId: string;
  slotKind: SlotKind;
  slotLabel: string;
  previousWitness: Witness | null;
  account: Account;
  positions: Position[];
  recentOrders: Order[];
  clock: MarketClock;
  prices: Record<string, number>;
  closes: Record<string, number[]>;
  indicators: Record<string, Indicator>;
  events: string[]; // Fed e trimestrali delle prossime settimane
  lessons: Lesson[];
  buyBlock: string | null;
  // Solo quando la raccolta dati è finita; prima resta null e il modello decide senza.
  journal: ReturnType<typeof journalForBrain> | null;
}

export interface Brain {
  readonly name: string;
  decide(input: BrainInput): Promise<Decision>;
}

export class BrainError extends Error {}
