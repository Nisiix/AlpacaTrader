import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../fsutil.ts";
import { isCrypto } from "../config.ts";
import { addDays, romeTime } from "../slots.ts";
import type { Account, Bar, Broker, IntradayBar, MarketClock, Order, OrderRequest, Position, StopOrderRequest } from "./types.ts";
import { BrokerError, DuplicateOrderError, isOpenOrder, isProtectiveStop } from "./types.ts";

export interface FakeFaults {
  // Dopo N ordini registrati il processo si uccide da solo (SIGKILL), come una macchina che muore.
  crashAfterSubmits?: number;
  // Al primo invio Alpaca accetta l'ordine ma la risposta si perde; poi tutto va in timeout per N ms.
  outageOnSubmitMs?: number;
  outageStartedAt?: number;
  // Il processo muore (SIGKILL) appena viene chiamato questo metodo, es. "getOrderByClientId".
  crashOnMethod?: string;
  // L'orologio di Alpaca è avanti di N ms rispetto a quello della macchina.
  clockSkewMs?: number;
  // Alpaca rifiuta sempre gli ordini a mercato su questi simboli (errore definitivo, non temporaneo).
  rejectSymbols?: string[];
  // Questi metodi falliscono sempre con un errore temporaneo.
  failMethods?: string[];
}

export interface FakeState {
  cash: number;
  lastEquity: number;
  positions: Record<string, { qty: number; avgEntryPrice: number }>;
  prices: Record<string, number>;
  orders: Order[];
  // Chiusure giornaliere per simbolo (la più recente è sostituita dal prezzo attuale).
  closes: Record<string, number[]>;
  // auto = aperto 15:30-22:00 ora di Roma nei giorni feriali
  clock: "auto" | "open" | "closed";
  // Barre intraday per simbolo e timeframe, per provare l'agente intraday a tavolino.
  intraday?: Record<string, Record<string, IntradayBar[]>>;
  faults: FakeFaults;
  submits: number;
}

export function defaultFakeState(): FakeState {
  return {
    cash: 100_000,
    lastEquity: 100_000,
    positions: {},
    prices: { SPY: 600, QQQ: 520, IWM: 230, AAPL: 250, MSFT: 480, NVDA: 180, GLD: 380, TLT: 90, TSLA: 400, "BTC/USD": 76_000, "ETH/USD": 2_200 },
    orders: [],
    closes: {},
    clock: "auto",
    faults: {},
    submits: 0,
  };
}

export const FAKE_VOL: Record<string, number> = { SPY: 0.01, QQQ: 0.013, IWM: 0.015, AAPL: 0.017, MSFT: 0.015, NVDA: 0.03, GLD: 0.01, TLT: 0.009, TSLA: 0.035, "BTC/USD": 0.025, "ETH/USD": 0.035 };

// Storico finto deterministico: trend in salita del 10% e oscillazioni ± pari alla volatilità del titolo.
export function syntheticCloses(price: number, vol: number, days: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < days; i++) {
    const trend = price * (0.9 + (0.1 * i) / (days - 1));
    out.push(trend * (1 + (i % 2 === 0 ? -vol / 2 : vol / 2)));
  }
  out[days - 1] = price;
  return out;
}

// Broker finto con la stessa interfaccia di quello vero, persistito su file così sopravvive tra processi.
export class FakeBroker implements Broker {
  readonly name = "finto";

  constructor(
    private file: string,
    private now: () => Date = () => new Date(),
  ) {
    if (!existsSync(file)) writeJsonAtomic(file, defaultFakeState());
  }

  load(): FakeState {
    const s: FakeState = { ...defaultFakeState(), ...JSON.parse(readFileSync(this.file, "utf8")) };
    if (this.triggerStops(s)) this.save(s);
    return s;
  }

  // Come sul broker vero: uno stop aperto scatta da solo quando il prezzo scende sotto la soglia.
  private triggerStops(s: FakeState): boolean {
    let changed = false;
    for (const o of s.orders) {
      if (!isOpenOrder(o) || !isProtectiveStop(o) || o.stopPrice === null) continue;
      const price = s.prices[o.symbol];
      const pos = s.positions[o.symbol];
      if (price === undefined || !pos || price > o.stopPrice) continue;
      const qty = Math.min(o.qty, pos.qty);
      pos.qty -= qty;
      s.cash += qty * price;
      if (pos.qty <= 0) delete s.positions[o.symbol];
      o.status = "filled";
      o.filledQty = qty;
      o.filledAvgPrice = price;
      o.filledAt = this.now().toISOString();
      changed = true;
    }
    return changed;
  }

  private heldForStops(s: FakeState, symbol: string): number {
    return s.orders.filter((o) => o.symbol === symbol && isOpenOrder(o) && isProtectiveStop(o)).reduce((a, o) => a + o.qty, 0);
  }

  save(s: FakeState) {
    writeJsonAtomic(this.file, s);
  }

  private checkOutage(s: FakeState, method?: string) {
    const f = s.faults;
    if (method && f.crashOnMethod === method) process.kill(process.pid, "SIGKILL");
    if (method && f.failMethods?.includes(method)) throw new BrokerError(`timeout su ${method} (broker finto)`, undefined, true);
    if (f.outageStartedAt !== undefined && f.outageOnSubmitMs !== undefined) {
      if (this.now().getTime() < f.outageStartedAt + f.outageOnSubmitMs) throw new BrokerError("timeout (broker finto in panne)", undefined, true);
    }
  }

  private price(s: FakeState, sym: string): number {
    const p = s.prices[sym];
    if (!p) throw new BrokerError(`simbolo sconosciuto ${sym}`, 422);
    return p;
  }

  async getAccount(): Promise<Account> {
    const s = this.load();
    this.checkOutage(s, "getAccount");
    let equity = s.cash;
    for (const [sym, p] of Object.entries(s.positions)) equity += p.qty * this.price(s, sym);
    return { equity, lastEquity: s.lastEquity, cash: s.cash, status: "ACTIVE" };
  }

  async getPositions(): Promise<Position[]> {
    const s = this.load();
    this.checkOutage(s, "getPositions");
    return Object.entries(s.positions).map(([symbol, p]) => {
      const currentPrice = this.price(s, symbol);
      return { symbol, qty: p.qty, avgEntryPrice: p.avgEntryPrice, currentPrice, marketValue: p.qty * currentPrice };
    });
  }

  async getRecentOrders(hours: number): Promise<Order[]> {
    const s = this.load();
    this.checkOutage(s, "getRecentOrders");
    const since = this.now().getTime() - hours * 3600_000;
    return s.orders.filter((o) => Date.parse(o.submittedAt) >= since).reverse();
  }

  async getOpenOrders(): Promise<Order[]> {
    const s = this.load();
    this.checkOutage(s, "getOpenOrders");
    return s.orders.filter(isOpenOrder).reverse();
  }

  async getClock(): Promise<MarketClock> {
    const s = this.load();
    this.checkOutage(s, "getClock");
    const now = new Date(this.now().getTime() + (s.faults.clockSkewMs ?? 0));
    let isOpen = s.clock === "open";
    if (s.clock === "auto") {
      const rt = romeTime(now);
      isOpen = rt.weekday >= 1 && rt.weekday <= 5 && rt.minutes >= 15 * 60 + 30 && rt.minutes < 22 * 60;
    }
    const nextClose = isOpen && s.clock === "auto" ? new Date(now.getTime() + (22 * 60 - romeTime(now).minutes) * 60_000).toISOString() : undefined;
    return { isOpen, timestamp: now.toISOString(), ...(nextClose ? { nextClose } : {}) };
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    const s = this.load();
    this.checkOutage(s, "getLatestPrices");
    const out: Record<string, number> = {};
    for (const sym of symbols) if (s.prices[sym]) out[sym] = s.prices[sym]!;
    return out;
  }

  async getOrderByClientId(clientOrderId: string): Promise<Order | null> {
    const s = this.load();
    this.checkOutage(s, "getOrderByClientId");
    return s.orders.find((o) => o.clientOrderId === clientOrderId) ?? null;
  }

  async submitOrder(req: OrderRequest): Promise<Order> {
    const s = this.load();
    this.checkOutage(s, "submitOrder");
    if (s.orders.some((o) => o.clientOrderId === req.clientOrderId)) throw new DuplicateOrderError(`client_order_id già usato: ${req.clientOrderId}`, 422);
    if (s.faults.rejectSymbols?.includes(req.symbol)) throw new BrokerError(`asset ${req.symbol} is not tradable (broker finto)`, 422);
    const price = this.price(s, req.symbol);
    const pos = s.positions[req.symbol] ?? { qty: 0, avgEntryPrice: 0 };
    if (req.side === "buy") {
      if (req.qty * price > s.cash) throw new BrokerError("fondi insufficienti", 403);
      pos.avgEntryPrice = (pos.avgEntryPrice * pos.qty + price * req.qty) / (pos.qty + req.qty);
      pos.qty += req.qty;
      s.cash -= req.qty * price;
    } else {
      if (req.qty > pos.qty) throw new BrokerError("quantità superiore alla posizione", 403);
      if (req.qty > pos.qty - this.heldForStops(s, req.symbol)) throw new BrokerError("insufficient qty available for order (azioni impegnate da uno stop)", 403);
      pos.qty -= req.qty;
      s.cash += req.qty * price;
    }
    if (pos.qty > 0) s.positions[req.symbol] = pos;
    else delete s.positions[req.symbol];
    const order: Order = {
      id: `fake-${s.orders.length + 1}`,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      filledQty: req.qty,
      status: "filled",
      submittedAt: this.now().toISOString(),
      type: "market",
      stopPrice: null,
      filledAvgPrice: price,
      filledAt: this.now().toISOString(),
    };
    s.orders.push(order);
    s.submits += 1;
    const outageNow = s.faults.outageOnSubmitMs !== undefined && s.faults.outageStartedAt === undefined;
    if (outageNow) s.faults.outageStartedAt = this.now().getTime();
    this.save(s);
    if (s.faults.crashAfterSubmits !== undefined && s.submits >= s.faults.crashAfterSubmits) process.kill(process.pid, "SIGKILL");
    if (outageNow) throw new BrokerError("timeout: nessuna risposta da Alpaca (l'ordine però è arrivato)", undefined, true);
    return order;
  }

  // Barre intraday finte: quelle messe nello stato (s.intraday[sym][timeframe]) se ci sono, altrimenti una passeggiata
  // deterministica intorno al prezzo, così la scelta della candela e gli ingressi si possono provare a tavolino.
  async getIntradayBars(symbols: string[], timeframe: string, count: number): Promise<Record<string, IntradayBar[]>> {
    const s = this.load();
    this.checkOutage(s, "getIntradayBars");
    const minutes = timeframe.endsWith("Min") ? Number(timeframe.replace("Min", "")) : timeframe.endsWith("Hour") ? Number(timeframe.replace("Hour", "")) * 60 : 1440;
    const out: Record<string, IntradayBar[]> = {};
    for (const sym of symbols) {
      const stored = s.intraday?.[sym]?.[timeframe];
      if (stored) {
        out[sym] = stored.slice(-count);
        continue;
      }
      const price = s.prices[sym];
      if (!price) continue;
      let seed = [...sym].reduce((a, c) => a + c.charCodeAt(0), 0);
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5);
      const vol = (FAKE_VOL[sym] ?? 0.02) * Math.sqrt(minutes / 390);
      const end = Math.floor(this.now().getTime() / (minutes * 60_000)) * minutes * 60_000;
      const bars: IntradayBar[] = [];
      let c = price * (1 - vol * 3);
      for (let i = count; i >= 1; i--) {
        const o = c;
        c = o * (1 + rnd() * vol * 2 + (price - o) / price / count);
        bars.push({ t: new Date(end - i * minutes * 60_000).toISOString(), open: o, high: Math.max(o, c) * (1 + vol * 0.3), low: Math.min(o, c) * (1 - vol * 0.3), close: c, volume: 1000 });
      }
      out[sym] = bars;
    }
    return out;
  }

  // Barre finte dalle chiusure: apertura = chiusura precedente, massimo e minimo un po' oltre, volume costante.
  async getDailyBars(symbols: string[], days: number): Promise<Record<string, Bar[]>> {
    const byDate = await this.getDailyClosesByDate(symbols, days);
    const out: Record<string, Bar[]> = {};
    for (const [sym, cs] of Object.entries(byDate)) {
      out[sym] = cs.map((c, i) => {
        const open = i ? cs[i - 1]!.close : c.close;
        const span = Math.abs(c.close - open) + c.close * 0.004;
        return { date: c.date, open, high: Math.max(open, c.close) + span * 0.5, low: Math.min(open, c.close) - span * 0.5, close: c.close, volume: 1_000_000 };
      });
    }
    return out;
  }

  // Il finto tratta le coppie di cui ha un prezzo, più qualche altcoin per provare la selezione.
  async getCryptoPairs(): Promise<string[]> {
    const s = this.load();
    return [...new Set([...Object.keys(s.prices).filter(isCrypto), "BTC/USD", "ETH/USD", "SOL/USD", "DOGE/USD", "LINK/USD", "AVAX/USD", "LTC/USD", "UNI/USD", "AAVE/USD", "DOT/USD", "XRP/USD", "SHIB/USD"])].sort();
  }

  async getDailyClosesByDate(symbols: string[], days: number): Promise<Record<string, { date: string; close: number }[]>> {
    const closes = await this.getDailyCloses(symbols, days);
    const today = romeTime(this.now()).date;
    const out: Record<string, { date: string; close: number }[]> = {};
    for (const [sym, c] of Object.entries(closes)) {
      // Tutti sulla stessa griglia di giorni feriali, le crypto comprese: nel finto basta così.
      const dates: string[] = [];
      for (let d = today; dates.length < c.length; d = addDays(d, -1)) if (new Date(`${d}T12:00:00Z`).getUTCDay() % 6 !== 0) dates.unshift(d);
      out[sym] = c.map((close, i) => ({ date: dates[i]!, close }));
    }
    return out;
  }

  async submitStopOrder(req: StopOrderRequest): Promise<Order> {
    const s = this.load();
    this.checkOutage(s, "submitStopOrder");
    if (s.orders.some((o) => o.clientOrderId === req.clientOrderId)) throw new DuplicateOrderError(`client_order_id già usato: ${req.clientOrderId}`, 422);
    const pos = s.positions[req.symbol];
    if (!pos || req.qty > pos.qty - this.heldForStops(s, req.symbol)) throw new BrokerError("insufficient qty available for order", 403);
    const order: Order = {
      id: `fake-${s.orders.length + 1}`,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: "sell",
      qty: req.qty,
      filledQty: 0,
      status: "new",
      submittedAt: this.now().toISOString(),
      type: isCrypto(req.symbol) ? "stop_limit" : "stop",
      stopPrice: req.stopPrice,
    };
    s.orders.push(order);
    this.save(s);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const s = this.load();
    this.checkOutage(s, "cancelOrder");
    const o = s.orders.find((x) => x.id === orderId);
    if (o && isOpenOrder(o)) o.status = "canceled";
    this.save(s);
  }

  async getDailyCloses(symbols: string[], days: number): Promise<Record<string, number[]>> {
    const s = this.load();
    this.checkOutage(s, "getDailyCloses");
    const out: Record<string, number[]> = {};
    for (const sym of symbols) {
      const price = s.prices[sym];
      if (!price) continue;
      const stored = s.closes[sym];
      const series = stored ? [...stored] : syntheticCloses(price, FAKE_VOL[sym] ?? 0.02, days);
      series[series.length - 1] = price;
      out[sym] = series.slice(-days);
    }
    return out;
  }
}
