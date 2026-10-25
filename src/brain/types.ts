import type { Account, MarketClock, Order, Position } from "../broker/types.ts";
import type { SlotKind } from "../config.ts";
import type { Witness } from "../witness.ts";

export interface ProposedOrder {
  symbol: string;
  side: string;
  qty: number;
  why: string;
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
}

export interface Brain {
  readonly name: string;
  decide(input: BrainInput): Promise<Decision>;
}

export class BrainError extends Error {}
