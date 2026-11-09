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
  nextClose?: string; // ISO: con la borsa aperta, la chiusura di oggi (orari veri di Alpaca, ora legale compresa)
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  clientOrderId: string;
  // Ordine limite (crypto in acquisto): resta nel book e paga la commissione maker invece della taker.
  limitPrice?: number;
}

// Stop di protezione che vive su Alpaca: vende da solo anche tra un giro e l'altro e a motore spento.
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
  // Le stesse chiusure con la data (YYYY-MM-DD): servono ai grafici e a Kronos, che lavora sulle candele intere.
  getDailyClosesByDate(symbols: string[], days: number): Promise<Record<string, { date: string; close: number }[]>>;
  // Barre giornaliere complete (apertura, massimo, minimo, chiusura, volume) di sedute finite: per i grafici a candele.
  getDailyBars(symbols: string[], days: number): Promise<Record<string, Bar[]>>;
  // Coppie crypto negoziabili su Alpaca (es. "SOL/USD"); i broker senza crypto rispondono con la lista vuota.
  getCryptoPairs(): Promise<string[]>;
  // Barre intraday (timeframe Alpaca: "5Min", "15Min", "1Hour", "4Hour"), le ultime `count`, candela in corso esclusa.
  getIntradayBars(symbols: string[], timeframe: string, count: number): Promise<Record<string, IntradayBar[]>>;
  // Storico del patrimonio del conto (per il rendimento per periodo in dashboard): un punto per candela di `timeframe`.
  getPortfolioHistory?(start: string, end: string, timeframe: string): Promise<{ t: string; equity: number; pnl: number }[]>;
  // Nome del titolo o della crypto (es. «Apple Inc.», «Bitcoin»), per mostrarlo accanto al codice.
  getAssetName?(symbol: string): Promise<string | null>;
}

export interface IntradayBar {
  t: string; // ISO dell'apertura della candela
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Gli errori di Alpaca arrivano come JSON ({"code":40310000,"message":"insufficient balance ..."}): qui diventano una frase
// leggibile in italiano, per log, Telegram e dashboard. Il codice numerico resta tra parentesi per chi deve indagare.
export function humanizeBrokerError(status: number | undefined, body: string): string {
  let msg = body.trim();
  let code: string | number | undefined;
  try {
    const j = JSON.parse(body) as { message?: string; code?: number | string; available?: string; requested?: string };
    if (j && typeof j === "object") {
      msg = String(j.message ?? body);
      code = j.code;
    }
  } catch {}
  const it: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/qty must be > 0|qty must be \u003e 0/i, () => "quantità troppo piccola (resto frazionario)"],
    [/insufficient balance for (\w+)(?: \(requested: ([\d.]+), available: ([\d.]+)\))?/i, (m) => `saldo insufficiente di ${m[1]}${m[2] ? ` (chiesti ${m[2]}, disponibili ${m[3]})` : ""}`],
    [/insufficient buying power/i, () => "liquidità insufficiente"],
    [/forbidden|unauthorized/i, () => "chiavi rifiutate (controlla key id e secret del conto paper)"],
    [/market is closed|not open/i, () => "mercato chiuso"],
    [/asset .* is not (?:active|tradable)/i, () => "titolo non negoziabile su Alpaca"],
    [/client_order_id must be unique/i, () => "ordine già inviato con lo stesso identificativo"],
    [/potential wash trade/i, () => "ordine opposto ancora aperto sullo stesso titolo (wash trade)"],
    [/rate limit|too many requests/i, () => "troppe richieste, Alpaca chiede di rallentare"],
  ];
  for (const [re, f] of it) {
    const m = msg.match(re);
    if (m) {
      msg = f(m);
      break;
    }
  }
  if (msg.length > 160) msg = `${msg.slice(0, 157)}…`;
  return `Alpaca${status ? ` ${status}` : ""}: ${msg}${code !== undefined ? ` (codice ${code})` : ""}`;
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

// Decimali di prezzo ammessi da Alpaca: azioni 2 (4 sotto il dollaro); crypto 4 cifre significative, da 2 a 9 decimali
// (PEPE a 0,0000048 con 2 decimali diventerebbe 0 e Alpaca rifiuterebbe lo stop).
export function decimaliPrezzo(symbol: string, price: number): number {
  if (!symbol.includes("/")) return price >= 1 ? 2 : 4;
  if (!(price > 0)) return 2;
  return Math.max(2, Math.min(9, 3 - Math.floor(Math.log10(price))));
}
export function arrotondaPrezzo(symbol: string, price: number): number {
  const f = 10 ** decimaliPrezzo(symbol, price);
  return Math.round(price * f) / f;
}
export const prezzoStringa = (symbol: string, price: number) => price.toFixed(decimaliPrezzo(symbol, price));

// Quantità ammessa da Alpaca: azioni intere per i titoli, frazioni (6 decimali) per le crypto.
export function roundQty(symbol: string, qty: number): number {
  if (!symbol.includes("/")) return Math.floor(qty);
  const f = 10 ** 6;
  return Math.floor(qty * f) / f;
}
