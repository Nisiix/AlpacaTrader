export type Side = "buy" | "sell";

export interface Account {
  equity: number;
  lastEquity: number; // equity alla chiusura di ieri, serve per il P&L del giorno
  cash: number;
  status: string;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  filledQty: number;
  status: string;
  submittedAt: string;
}

export interface MarketClock {
  isOpen: boolean;
  timestamp: string;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  clientOrderId: string;
}

// Stessa interfaccia per il broker vero e per quello finto.
export interface Broker {
  readonly name: string;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getRecentOrders(hours: number): Promise<Order[]>;
  getClock(): Promise<MarketClock>;
  getLatestPrices(symbols: string[]): Promise<Record<string, number>>;
  getOrderByClientId(clientOrderId: string): Promise<Order | null>;
  submitOrder(req: OrderRequest): Promise<Order>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transient = false,
  ) {
    super(message);
  }
}

// Alpaca ha già un ordine con quel client_order_id.
export class DuplicateOrderError extends BrokerError {}

const OPEN_STATUSES = new Set(["new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding", "calculated", "held", "pending_replace"]);
export function isOpenOrder(o: Order): boolean {
  return OPEN_STATUSES.has(o.status);
}
