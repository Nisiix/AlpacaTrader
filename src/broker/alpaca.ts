import { limitiSedute } from "../sedute.ts";
import { CRYPTO_STOP_LIMIT_GAP, HTTP_TIMEOUT_MS, MARKET_DATA_URL, PAPER_TRADING_URL, isCrypto } from "../config.ts";
import { assertPaperUrl } from "../guard.ts";
import type { Account, Bar, Broker, IntradayBar, MarketClock, Order, OrderRequest, Position, StopOrderRequest } from "./types.ts";
import { BrokerError, DuplicateOrderError, humanizeBrokerError, prezzoStringa } from "./types.ts";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v));

// Alpaca scrive le posizioni crypto senza barra (BTCUSD) e gli ordini con la barra (BTC/USD): qui vale sempre BTC/USD.
export function canonicalSymbol(symbol: string, assetClass?: string): string {
  if (assetClass === "crypto" && !symbol.includes("/") && symbol.endsWith("USD")) return `${symbol.slice(0, -3)}/USD`;
  return symbol;
}
// Crypto: 6 decimali troncati, mai arrotondati per eccesso (80,874531937 → 80,874531): con toFixed Alpaca rispondeva
// "insufficient balance" perché si chiedeva un milionesimo in più di quanto c'è (la commissione si paga nella moneta).
export const qtyString = (symbol: string, qty: number) => (isCrypto(symbol) ? (Math.floor(qty * 1e6 + 1e-6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : String(qty));

function toOrder(o: any): Order {
  return {
    id: String(o.id),
    clientOrderId: String(o.client_order_id),
    symbol: canonicalSymbol(String(o.symbol), o.asset_class),
    side: o.side,
    qty: num(o.qty),
    filledQty: num(o.filled_qty),
    status: String(o.status),
    submittedAt: String(o.submitted_at ?? o.created_at ?? ""),
    type: String(o.type ?? o.order_type ?? "market"),
    stopPrice: o.stop_price === null || o.stop_price === undefined ? null : Number(o.stop_price),
    filledAvgPrice: o.filled_avg_price === null || o.filled_avg_price === undefined ? null : Number(o.filled_avg_price),
    filledAt: o.filled_at ? String(o.filled_at) : null,
  };
}

export class AlpacaBroker implements Broker {
  readonly name = "alpaca-paper";
  private readonly baseUrl = PAPER_TRADING_URL;

  constructor(
    private keyId: string,
    private secretKey: string,
  ) {
    assertPaperUrl(this.baseUrl);
    if (!keyId || !secretKey) throw new BrokerError("chiavi Alpaca mancanti in secrets.ts");
  }

  private async request(base: string, path: string, init: RequestInit = {}): Promise<any> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        ...init,
        headers: {
          "APCA-API-KEY-ID": this.keyId,
          "APCA-API-SECRET-KEY": this.secretKey,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      // Il messaggio di fetch non contiene header, quindi niente chiavi.
      throw new BrokerError(`rete o timeout su ${init.method ?? "GET"} ${path}: ${(e as Error).message}`, undefined, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const body = text.slice(0, 300);
      if (res.status === 422 && /client_order_id/i.test(body)) throw new DuplicateOrderError(`client_order_id già usato: ${body}`, 422);
      throw new BrokerError(humanizeBrokerError(res.status, text), res.status, res.status >= 500 || res.status === 429);
    }
    return text ? JSON.parse(text) : null;
  }

  async getAccount(): Promise<Account> {
    const a = await this.request(this.baseUrl, "/v2/account");
    return { equity: num(a.equity), lastEquity: num(a.last_equity), cash: num(a.cash), status: String(a.status) };
  }

  async getPositions(): Promise<Position[]> {
    const list = await this.request(this.baseUrl, "/v2/positions");
    return (list as any[]).map((p) => ({
      symbol: canonicalSymbol(String(p.symbol), p.asset_class),
      qty: num(p.qty),
      avgEntryPrice: num(p.avg_entry_price),
      currentPrice: num(p.current_price),
      marketValue: num(p.market_value),
    }));
  }

  async getRecentOrders(hours: number): Promise<Order[]> {
    const after = new Date(Date.now() - hours * 3600_000).toISOString();
    const list = await this.request(this.baseUrl, `/v2/orders?status=all&limit=500&direction=desc&after=${encodeURIComponent(after)}`);
    return (list as any[]).map(toOrder);
  }

  async getOpenOrders(): Promise<Order[]> {
    const list = await this.request(this.baseUrl, "/v2/orders?status=open&limit=500&direction=desc");
    return (list as any[]).map(toOrder);
  }

  async getClock(): Promise<MarketClock> {
    const c = await this.request(this.baseUrl, "/v2/clock");
    return { isOpen: Boolean(c.is_open), timestamp: String(c.timestamp), ...(c.next_close ? { nextClose: new Date(String(c.next_close)).toISOString() } : {}) };
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const stocks = symbols.filter((s) => !isCrypto(s));
    const crypto = symbols.filter(isCrypto);
    if (stocks.length) {
      const data = await this.request(MARKET_DATA_URL, `/v2/stocks/trades/latest?feed=iex&symbols=${stocks.map(encodeURIComponent).join(",")}`);
      for (const [sym, t] of Object.entries<any>(data?.trades ?? {})) if (t?.p) out[sym] = Number(t.p);
    }
    if (crypto.length) {
      const data = await this.request(MARKET_DATA_URL, `/v1beta3/crypto/us/latest/trades?symbols=${crypto.map(encodeURIComponent).join(",")}`);
      for (const [sym, t] of Object.entries<any>(data?.trades ?? {})) if (t?.p) out[sym] = Number(t.p);
    }
    return out;
  }

  async getOrderByClientId(clientOrderId: string): Promise<Order | null> {
    try {
      return toOrder(await this.request(this.baseUrl, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`));
    } catch (e) {
      if (e instanceof BrokerError && e.status === 404) return null;
      throw e;
    }
  }

  async submitOrder(req: OrderRequest): Promise<Order> {
    const body = {
      symbol: req.symbol,
      qty: qtyString(req.symbol, req.qty),
      side: req.side,
      type: "market",
      // Le crypto non accettano "day".
      time_in_force: isCrypto(req.symbol) ? "gtc" : "day",
      client_order_id: req.clientOrderId,
    };
    return toOrder(await this.request(this.baseUrl, "/v2/orders", { method: "POST", body: JSON.stringify(body) }));
  }

  async submitStopOrder(req: StopOrderRequest): Promise<Order> {
    // Le crypto non accettano lo stop a mercato: stop_limit con limite mezzo punto sotto.
    const body = isCrypto(req.symbol)
      ? { symbol: req.symbol, qty: qtyString(req.symbol, req.qty), side: "sell", type: "stop_limit", stop_price: prezzoStringa(req.symbol, req.stopPrice), limit_price: prezzoStringa(req.symbol, req.stopPrice * (1 - CRYPTO_STOP_LIMIT_GAP)), time_in_force: "gtc", client_order_id: req.clientOrderId }
      : { symbol: req.symbol, qty: String(req.qty), side: "sell", type: "stop", stop_price: prezzoStringa(req.symbol, req.stopPrice), time_in_force: "gtc", client_order_id: req.clientOrderId };
    return toOrder(await this.request(this.baseUrl, "/v2/orders", { method: "POST", body: JSON.stringify(body) }));
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.request(this.baseUrl, `/v2/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
    } catch (e) {
      // 404/422: già eseguito o già cancellato. La verità la rilegge chi chiama.
      if (e instanceof BrokerError && (e.status === 404 || e.status === 422)) return;
      throw e;
    }
  }

  async getDailyCloses(symbols: string[], days: number): Promise<Record<string, number[]>> {
    const byDate = await this.getDailyClosesByDate(symbols, days);
    return Object.fromEntries(Object.entries(byDate).map(([sym, bars]) => [sym, bars.map((b) => b.close)]));
  }

  async getDailyClosesByDate(symbols: string[], days: number): Promise<Record<string, { date: string; close: number }[]>> {
    const bars = await this.getDailyBars(symbols, days);
    return Object.fromEntries(Object.entries(bars).map(([sym, bs]) => [sym, bs.map((b) => ({ date: b.date, close: b.close }))]));
  }

  async getCryptoPairs(): Promise<string[]> {
    const data = await this.request(PAPER_TRADING_URL, "/v2/assets?asset_class=crypto&status=active");
    return (Array.isArray(data) ? data : [])
      .filter((a: any) => a.tradable && typeof a.symbol === "string" && a.symbol.endsWith("/USD"))
      .map((a: any) => String(a.symbol))
      .sort();
  }

  async getIntradayBars(symbols: string[], timeframe: string, count: number): Promise<Record<string, IntradayBar[]>> {
    const out: Record<string, IntradayBar[]> = {};
    if (!symbols.length) return out;
    const minutes = timeframe.endsWith("Min") ? Number(timeframe.replace("Min", "")) : timeframe.endsWith("Hour") ? Number(timeframe.replace("Hour", "")) * 60 : 1440;
    // Abbastanza indietro da coprire `count` candele anche con notti e fine settimana (titoli: ~6,5 ore al giorno).
    const spanMin = minutes * count * (minutes >= 240 ? 4 : 3) + 3 * 1440;
    const start = new Date(Date.now() - spanMin * 60_000).toISOString();
    const now = Date.now();
    const closedBefore = (t: string) => Date.parse(t) + minutes * 60_000 <= now; // candela finita
    const fetchAll = async (path: string) => {
      let token = "";
      for (let page = 0; page < 10; page++) {
        const data = await this.request(MARKET_DATA_URL, `${path}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
        for (const [sym, bars] of Object.entries<any[]>(data?.bars ?? {})) (out[sym] ??= []).push(...bars.filter((b) => closedBefore(String(b.t))).map((b) => ({ t: String(b.t), open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v ?? 0) })));
        token = data?.next_page_token ?? "";
        if (!token) break;
      }
    };
    const stocks = symbols.filter((s) => !isCrypto(s));
    const crypto = symbols.filter(isCrypto);
    if (stocks.length) await fetchAll(`/v2/stocks/bars?timeframe=${encodeURIComponent(timeframe)}&adjustment=all&feed=iex&limit=10000&start=${start}&symbols=${stocks.map(encodeURIComponent).join(",")}`);
    if (crypto.length) await fetchAll(`/v1beta3/crypto/us/bars?timeframe=${encodeURIComponent(timeframe)}&limit=10000&start=${start}&symbols=${crypto.map(encodeURIComponent).join(",")}`);
    for (const sym of Object.keys(out)) out[sym] = out[sym]!.sort((a, b) => a.t.localeCompare(b.t)).slice(-count);
    return out;
  }

  async getDailyBars(symbols: string[], days: number): Promise<Record<string, Bar[]>> {
    const out: Record<string, Bar[]> = {};
    if (symbols.length === 0) return out;
    const start = new Date(Date.now() - days * 1.6 * 86_400_000).toISOString().slice(0, 10);
    // Solo giornate concluse (src/sedute.ts): la seduta di oggi entra dopo la chiusura di New York, la candela crypto a mezzanotte UTC.
    const limiti = limitiSedute(new Date());
    const fetchAll = async (path: string, today: string) => {
      let token = "";
      for (let page = 0; page < 20; page++) {
        const data = await this.request(MARKET_DATA_URL, `${path}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
        for (const [sym, bars] of Object.entries<any[]>(data?.bars ?? {})) (out[sym] ??= []).push(...bars.filter((b) => String(b.t).slice(0, 10) < today).map((b) => ({ date: String(b.t).slice(0, 10), open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v ?? 0) })));
        token = data?.next_page_token ?? "";
        if (!token) break;
      }
    };
    const stocks = symbols.filter((s) => !isCrypto(s));
    const crypto = symbols.filter(isCrypto);
    if (stocks.length) await fetchAll(`/v2/stocks/bars?timeframe=1Day&adjustment=all&feed=iex&limit=10000&start=${start}&symbols=${stocks.map(encodeURIComponent).join(",")}`, limiti.azioni);
    if (crypto.length) await fetchAll(`/v1beta3/crypto/us/bars?timeframe=1Day&limit=10000&start=${start}T00:00:00Z&symbols=${crypto.map(encodeURIComponent).join(",")}`, limiti.crypto);
    // Le crypto hanno 7 barre a settimana: per coprire gli stessi giorni di borsa ne servono di più.
    for (const sym of Object.keys(out)) out[sym] = out[sym]!.sort((a, b) => a.date.localeCompare(b.date)).slice(isCrypto(sym) ? -Math.ceil(days * 1.55) : -days);
    return out;
  }
}
