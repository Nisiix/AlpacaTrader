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
  // Prezzo medio e ora di esecuzione: servono al diario dei trade.
  filledAvgPrice?: number | null;
  filledAt?: string | null;
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
  // Chiusure giornaliere di sedute finite, dalla più vecchia alla più recente.
  getDailyCloses(symbols: string[], days: number): Promise<Record<string, number[]>>;
  // Le stesse chiusure con la data (YYYY-MM-DD): serve al backtest per allineare titoli e crypto, che non hanno gli stessi giorni.
  getDailyClosesByDate(symbols: string[], days: number): Promise<Record<string, { date: string; close: number }[]>>;
  // Barre giornaliere complete (apertura, massimo, minimo, chiusura, volume) di sedute finite: per i grafici a candele.
  getDailyBars(symbols: string[], days: number): Promise<Record<string, Bar[]>>;
  // Coppie crypto negoziabili su Alpaca (es. "SOL/USD"); i broker senza crypto rispondono con la lista vuota.
  getCryptoPairs(): Promise<string[]>;
}

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  return (o.type === "stop" || o.type === "stop_limit") && o.side === "sell";
}

// Quantità ammessa da Alpaca: azioni intere per i titoli, frazioni (6 decimali) per le crypto.
export function roundQty(symbol: string, qty: number): number {
  if (!symbol.includes("/")) return Math.floor(qty);
  const f = 10 ** 6;
  return Math.floor(qty * f) / f;
}
