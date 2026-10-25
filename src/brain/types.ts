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
