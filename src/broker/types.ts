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
  type: string; // market | stop | ...
  stopPrice: number | null;
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

// Stop di protezione che vive su Alpaca: vende da solo anche tra una sveglia e l'altra.
export interface StopOrderRequest {
  symbol: string;
  qty: number;
  stopPrice: number;
  clientOrderId: string;
}

// Stessa interfaccia per il broker vero e per quello finto.
export interface Broker {
  readonly name: string;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getRecentOrders(hours: number): Promise<Order[]>;
  // Tutti gli ordini ancora aperti, anche vecchi (gli stop GTC possono avere settimane).
  getOpenOrders(): Promise<Order[]>;
  getClock(): Promise<MarketClock>;
  getLatestPrices(symbols: string[]): Promise<Record<string, number>>;
  getOrderByClientId(clientOrderId: string): Promise<Order | null>;
  submitOrder(req: OrderRequest): Promise<Order>;
  submitStopOrder(req: StopOrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  // Chiusure giornaliere, dalla più vecchia alla più recente.
  getDailyCloses(symbols: string[], days: number): Promise<Record<string, number[]>>;
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

export function isProtectiveStop(o: Order): boolean {
  return o.type === "stop" && o.side === "sell";
}
