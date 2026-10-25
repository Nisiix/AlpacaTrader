import { HTTP_TIMEOUT_MS, MARKET_DATA_URL, PAPER_TRADING_URL } from "../config.ts";
import { assertPaperUrl } from "../guard.ts";
import type { Account, Broker, MarketClock, Order, OrderRequest, Position, StopOrderRequest } from "./types.ts";
import { BrokerError, DuplicateOrderError } from "./types.ts";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v));

function toOrder(o: any): Order {
  return {
    id: String(o.id),
    clientOrderId: String(o.client_order_id),
    symbol: String(o.symbol),
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
      throw new BrokerError(`Alpaca ${res.status} su ${path}: ${body}`, res.status, res.status >= 500 || res.status === 429);
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
      symbol: String(p.symbol),
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
    return { isOpen: Boolean(c.is_open), timestamp: String(c.timestamp) };
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};
    const data = await this.request(MARKET_DATA_URL, `/v2/stocks/trades/latest?feed=iex&symbols=${symbols.map(encodeURIComponent).join(",")}`);
    const out: Record<string, number> = {};
    for (const [sym, t] of Object.entries<any>(data?.trades ?? {})) if (t?.p) out[sym] = Number(t.p);
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
      qty: String(req.qty),
      side: req.side,
      type: "market",
      time_in_force: "day",
      client_order_id: req.clientOrderId,
    };
    return toOrder(await this.request(this.baseUrl, "/v2/orders", { method: "POST", body: JSON.stringify(body) }));
  }

  async submitStopOrder(req: StopOrderRequest): Promise<Order> {
    const body = {
      symbol: req.symbol,
      qty: String(req.qty),
      side: "sell",
      type: "stop",
      stop_price: req.stopPrice.toFixed(2),
      time_in_force: "gtc",
      client_order_id: req.clientOrderId,
    };
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
    const out: Record<string, number[]> = {};
    if (symbols.length === 0) return out;
    const start = new Date(Date.now() - days * 1.6 * 86_400_000).toISOString().slice(0, 10);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    let token = "";
    for (let page = 0; page < 20; page++) {
      const q = `/v2/stocks/bars?timeframe=1Day&adjustment=all&feed=iex&limit=10000&start=${start}&symbols=${symbols.map(encodeURIComponent).join(",")}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
      const data = await this.request(MARKET_DATA_URL, q);
      // Solo giornate chiuse: la barra di oggi, a seduta aperta, è un prezzo provvisorio.
      for (const [sym, bars] of Object.entries<any[]>(data?.bars ?? {})) (out[sym] ??= []).push(...bars.filter((b) => String(b.t).slice(0, 10) < today).map((b) => Number(b.c)));
      token = data?.next_page_token ?? "";
      if (!token) break;
    }
    for (const sym of Object.keys(out)) out[sym] = out[sym]!.slice(-days);
    return out;
  }
}
