import type { ProposedOrder } from "./brain/types.ts";
import type { Account, Order, Position, Side } from "./broker/types.ts";
import { isOpenOrder, isProtectiveStop } from "./broker/types.ts";
import { AGENTS, CRYPTO, CRYPTO_MIN_NOTIONAL, LIMITS, MAX_LATENESS_MIN, UNIVERSE, isCrypto, sectorOf, type SlotKind } from "./config.ts";
import { EVENTS, eventBlockFor, type MarketEvent } from "./events.ts";
import { dailyVol, indicatorsFor, sma, trendOf } from "./indicators.ts";
import { setupOf } from "./journal.ts";
import type { Lesson } from "./lessons.ts";
import { stopPctFor } from "./stops.ts";
import { controTendenza, pesoControTendenza } from "./agents/fiducia.ts";

function setupOfSymbol(i: CageInput, symbol: string): string {
  const c = i.closes[symbol];
  return c ? setupOf(indicatorsFor({ [symbol]: c }, i.prices, LIMITS.trendSmaDays, LIMITS.volLookbackDays)[symbol]) : "dati insufficienti";
}

export interface PlannedOrder {
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  source: OrderSource;
}

// stop-loss = protezione contro i crolli; uscita-trend = l'uscita normale del metodo, decisa dal codice.
export type OrderSource = "modello" | "stop-loss" | "uscita-trend";

export interface Rejection {
  symbol: string;
  side: string;
  qty: number;
  reason: string;
  source: OrderSource;
}

export interface CageInput {
  today: string; // YYYY-MM-DD, per il calendario degli eventi
  events?: MarketEvent[]; // di serie il calendario di events.ts
  slotKind: SlotKind;
  marketOpen: boolean;
  latenessMin: number;
  account: Account;
  positions: Position[];
  prices: Record<string, number>;
  closes: Record<string, number[]>;
  recentOrders: Order[];
  lessons: Lesson[]; // solo quelle attive
  buyBlock: string | null; // interruttore sulla perdita
  proposals: ProposedOrder[];
  // Proiezioni di Kronos (rendimento a `horizon` sedute): con un rialzo anticipato l'uscita di trend aspetta (lo stop resta).
  previsioni?: Record<string, number>;
  // Titoli comprati oggi: l'uscita di trend (che guarda la chiusura di ieri, già nota all'acquisto) non li vende finché
  // non si è formata una candela giornaliera nuova. Restano gli stop e le uscite vincolanti.
  apertiOggi?: Set<string>;
  // Operazioni intraday aperte: hanno le loro uscite, l'uscita di trend giornaliera non le riguarda.
  intradayAperti?: Set<string>;
}

export interface CageResult {
  orders: PlannedOrder[];
  rejected: Rejection[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function lossPct(p: Position): number {
  return p.avgEntryPrice > 0 ? (p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice : 0;
}

export function tradingBlockReason(i: Pick<CageInput, "slotKind" | "marketOpen" | "latenessMin" | "account">, symbol?: string): string | null {
  if (i.slotKind === "briefing") return "briefing: nessun ordine";
  if (i.account.equity <= 0) return "conto senza patrimonio";
  // Le crypto trattano 24 ore su 24: l'orario di borsa non conta.
  if (symbol && isCrypto(symbol)) return null;
  if (!i.marketOpen) return "mercato chiuso";
  if (i.latenessMin > MAX_LATENESS_MIN) return `sveglia in ritardo di ${i.latenessMin} minuti: l'ordine non ha più senso`;
  return null;
}

// Peso massimo di un titolo: 20% del conto, meno se è nervoso (valore × volatilità ≤ rischio giornaliero ammesso).
export function maxWeightFor(closes: number[] | undefined): { max: number; vol: number; estimated: boolean } {
  const v = closes ? dailyVol(closes, LIMITS.volLookbackDays) : null;
  const vol = v ?? LIMITS.fallbackDailyVol;
  return { max: Math.min(LIMITS.maxPositionPct, LIMITS.dailyRiskPerPositionPct / vol), vol, estimated: v === null };
}

// Il modello propone, la gabbia dispone. Tutte le regole stanno qui, non nel prompt.
export function applyCage(i: CageInput): CageResult {
  const orders: PlannedOrder[] = [];
  const rejected: Rejection[] = [];
  // L'universo del giorno: titoli fissi, crypto di base e le coppie scelte oggi (top per capitalizzazione).
  const universe = new Set<string>([...UNIVERSE, ...CRYPTO, ...AGENTS.universe]);
  const held = new Map(i.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const stopLoss = i.positions.filter((p) => p.qty > 0 && lossPct(p) <= -stopPctFor(i.closes[p.symbol]));

  // Il blocco di orario vale per i titoli; le crypto passano sempre (salvo conto vuoto o briefing).
  const blockFor = (symbol: string) => tradingBlockReason(i, symbol);
  // Gli stop di protezione su Alpaca sono ordini aperti per scelta nostra: non contano come doppioni.
  const openOrders = i.recentOrders.filter((o) => isOpenOrder(o) && !isProtectiveStop(o));
  // Una vendita già in corso (non ancora eseguita) non si rimanda a ogni giro: Alpaca la rifiuterebbe per quantità impegnata.
  const sellInCorso = (symbol: string) => openOrders.some((o) => o.symbol === symbol && o.side === "sell");
  const seen = new Set<string>();
  const stopped = new Set<string>();
  for (const p of stopLoss) {
    const block = blockFor(p.symbol);
    if (block) {
      rejected.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "stop-loss", reason: `stop loss scattato (${pct(lossPct(p))}) ma ${block}: vendo alla prossima sveglia utile` });
      continue;
    }
    if (sellInCorso(p.symbol)) {
      rejected.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "stop-loss", reason: `stop loss scattato (${pct(lossPct(p))}): una vendita è già in corso` });
      seen.add(`${p.symbol}-sell`);
      stopped.add(p.symbol);
      continue;
    }
    orders.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "stop-loss", why: `stop loss: ${pct(lossPct(p))} dal prezzo di carico` });
    seen.add(`${p.symbol}-sell`);
    stopped.add(p.symbol);
  }
  if (tradingBlockReason(i) && !i.proposals.some((p) => isCrypto(p.symbol)) && !i.positions.some((p) => isCrypto(p.symbol))) {
    const block = tradingBlockReason(i)!;
    for (const p of i.proposals) rejected.push({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello", reason: block });
    return { orders, rejected };
  }

  // Uscita di trend: alla sveglia di apertura (per le crypto a ogni passata), chi ha chiuso ieri sotto la media a 50 giorni esce tutto.
  // È il codice a farla, come lo stop: il metodo non dipende dal modello che se ne ricordi.
  {
    for (const p of i.positions) {
      if (p.qty <= 0 || stopped.has(p.symbol) || blockFor(p.symbol) || sellInCorso(p.symbol) || i.intradayAperti?.has(p.symbol)) continue;
      const c = i.closes[p.symbol];
      const m = c ? sma(c, LIMITS.trendSmaDays) : null;
      const last = c?.[c.length - 1];
      if (m === null || last === undefined || last >= m) continue;
      if (i.apertiOggi?.has(p.symbol)) continue;
      // Posizione aperta (o tenuta) perché Kronos anticipa un rialzo: la regola del trend aspetta finché la proiezione resta netta.
      const fc = i.previsioni?.[p.symbol];
      if (fc !== undefined && fc >= AGENTS.kronos.anticipaSoglia) continue;
      orders.push({ symbol: p.symbol, side: "sell", qty: p.qty, source: "uscita-trend", why: `uscita di trend: chiusura ${last.toFixed(2)} sotto la media a ${LIMITS.trendSmaDays} giorni (${m.toFixed(2)})` });
      seen.add(`${p.symbol}-sell`);
      stopped.add(p.symbol);
    }
  }

  let cash = i.account.cash;
  for (const o of openOrders) if (o.side === "buy") cash -= (o.qty - o.filledQty) * (i.prices[o.symbol] ?? 0);
  const symbols = new Set([...held.keys(), ...openOrders.filter((o) => o.side === "buy").map((o) => o.symbol)]);
  const valueOf = (s: string) => (held.get(s)?.qty ?? 0) * (i.prices[s] ?? held.get(s)?.currentPrice ?? 0) + (added.get(s) ?? 0);
  const added = new Map<string, number>();

  const sorted = [...i.proposals].sort((a, b) => (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1));
  for (const p of sorted) {
    const reject = (reason: string) => rejected.push({ symbol: p.symbol, side: p.side, qty: p.qty, source: "modello", reason });
    if (p.side !== "buy" && p.side !== "sell") { reject(`lato non valido "${p.side}"`); continue; }
    if (!universe.has(p.symbol)) { reject("fuori universo"); continue; }
    const block = blockFor(p.symbol);
    if (block) { reject(block); continue; }
    if (isCrypto(p.symbol)) {
      if (!(p.qty > 0)) { reject("quantità positiva"); continue; }
      if (p.side === "buy" && p.qty * (i.prices[p.symbol] ?? 0) < CRYPTO_MIN_NOTIONAL) { reject(`ordine crypto sotto il minimo di ${CRYPTO_MIN_NOTIONAL} $`); continue; }
    } else if (!Number.isInteger(p.qty) || p.qty < 1) { reject("solo azioni intere e quantità positiva"); continue; }
    const key = `${p.symbol}-${p.side}`;
    if (seen.has(key)) { reject(stopped.has(p.symbol) && p.side === "sell" ? "già venduto dal codice (stop o uscita di trend)" : "doppione nella stessa sveglia"); continue; }
    if (p.side === "buy" && stopped.has(p.symbol)) { reject("in uscita in questa sveglia (stop o trend)"); continue; }
    const lesson = i.lessons.find((l) => l.lato === p.side && (l.simbolo === p.symbol || (l.simbolo === "*" && l.setup !== undefined && l.setup === setupOfSymbol(i, p.symbol))));
    if (lesson) { reject(`lezione dal registro degli errori: ${lesson.motivo} (fino al ${lesson.finoAl})`); continue; }
    if (openOrders.some((o) => o.symbol === p.symbol && o.side === p.side)) { reject("c'è già un ordine aperto uguale"); continue; }

    if (p.side === "sell") {
      const q = held.get(p.symbol)?.qty ?? 0;
      if (p.qty > q) { reject(`niente short: in portafoglio ce ne sono ${q}`); continue; }
    } else {
      if (i.buyBlock) { reject(i.buyBlock); continue; }
      // L'intraday si chiude in giornata con obiettivo e stop propri: non segue il filtro macro né il trend giornaliero.
      const ev = p.intraday ? null : eventBlockFor(p.symbol, i.today, i.events ?? EVENTS);
      if (ev) { reject(ev); continue; }
      const price = i.prices[p.symbol];
      if (!price || price <= 0) { reject("prezzo non disponibile"); continue; }
      const cost = p.qty * price;
      const share = (valueOf(p.symbol) + cost) / i.account.equity;
      if (share > LIMITS.maxPositionPct) { reject(`porterebbe il titolo al ${pct(share)} del conto (massimo ${pct(LIMITS.maxPositionPct)})`); continue; }
      if (!symbols.has(p.symbol) && symbols.size >= LIMITS.maxPositions) { reject(`massimo ${LIMITS.maxPositions} titoli in portafoglio`); continue; }
      const settore = sectorOf(p.symbol);
      if (settore !== "altro") {
        const tetto = LIMITS.groupMaxBySector[settore] ?? LIMITS.groupMaxPct;
        const membri = new Set([...held.keys(), ...added.keys(), p.symbol].filter((s) => sectorOf(s) === settore));
        const g = ([...membri].reduce((a, s) => a + valueOf(s), 0) + cost) / i.account.equity;
        if (g > tetto) { reject(`porterebbe il settore ${settore} al ${pct(g)} del conto (massimo ${pct(tetto)}): sono titoli che si muovono insieme`); continue; }
      }
      const closes = i.closes[p.symbol];
      const t = trendOf(closes, LIMITS.trendSmaDays, LIMITS.longSmaDays);
      if (!p.intraday) {
        if (t === null) { reject(`storico insufficiente per il metodo (servono ${LIMITS.longSmaDays} giorni di chiusure)`); continue; }
        // Kronos può anticipare: con una proiezione netta si entra anche sotto la media a 50; sotto la 200 solo contro
        // tendenza (Kronos ≥ 2% con probabilità di successo ≥ 60%), a metà del peso massimo.
        const kronosForte = p.kronos !== undefined && p.kronos >= AGENTS.kronos.anticipaSoglia;
        // Sotto la 200 solo contro tendenza: Kronos netto, probabilità di successo sufficiente, taglia ridotta.
        if (t.close <= t.long) {
          const ct = controTendenza(closes, p.kronos);
          if (!ct.ok) { reject(`chiusura ${t.close.toFixed(2)} sotto la media a ${LIMITS.longSmaDays} giorni (${t.long.toFixed(2)}): trend di lungo periodo negativo e niente ingresso contro tendenza (${ct.motivo})`); continue; }
          if (share > pesoControTendenza() + 1e-9) { reject(`contro tendenza il massimo è ${pct(pesoControTendenza())} del conto, qui si arriverebbe al ${pct(share)}`); continue; }
        }
        if (!kronosForte) {
          if (t.close <= t.sma) { reject(`chiusura ${t.close.toFixed(2)} sotto la media a ${LIMITS.trendSmaDays} giorni (${t.sma.toFixed(2)}): il metodo compra solo in trend, salvo un rialzo netto anticipato da Kronos`); continue; }
          if (price <= t.sma) { reject(`prezzo ${price.toFixed(2)} sceso sotto la media a ${LIMITS.trendSmaDays} giorni (${t.sma.toFixed(2)}) in giornata`); continue; }
        }
      }
      const w = maxWeightFor(closes);
      if (share > w.max) { reject(`con volatilità giornaliera ${pct(w.vol)}${w.estimated ? " (stimata)" : ""} il massimo è ${pct(w.max)} del conto, qui si arriverebbe al ${pct(share)}`); continue; }
      if (cost > cash) { reject("niente leva: contanti insufficienti"); continue; }
      cash -= cost;
      symbols.add(p.symbol);
      added.set(p.symbol, (added.get(p.symbol) ?? 0) + cost);
    }
    seen.add(key);
    orders.push({ symbol: p.symbol, side: p.side, qty: p.qty, why: p.why, source: "modello" });
  }
  return { orders, rejected };
}
