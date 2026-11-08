import { LIMITS, UNIVERSE, isCrypto } from "./config.ts";
import { addDays, addTradingDays } from "./slots.ts";

// Calendario degli eventi che muovono i prezzi a salti. La Fed è scritta qui (calendario ufficiale); le trimestrali di
// tutti i titoli seguiti arrivano ogni giorno dal calendario pubblico di Nasdaq (earnings.ts) e si aggiungono a quelle
// scritte qui, che restano come riserva se la fonte non risponde.
// Date americane. Fed = giorno della decisione (le 14:00 di New York). Trimestrali: tutte dopo la chiusura.
export interface MarketEvent {
  date: string; // YYYY-MM-DD
  kind: "fed" | "trimestrale";
  symbol?: string;
  confirmed: boolean; // false = data stimata, da verificare
}

export const EVENTS: MarketEvent[] = [
  // Fed: calendario ufficiale 2026 e calendario provvisorio 2027 (comunicato del 5 settembre 2025).
  ...["2026-10-28", "2026-12-09", "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08"].map((date) => ({ date, kind: "fed" as const, confirmed: true })),
  { date: "2026-10-28", kind: "trimestrale", symbol: "MSFT", confirmed: true },
  { date: "2026-11-02", kind: "trimestrale", symbol: "AAPL", confirmed: true },
  { date: "2026-11-18", kind: "trimestrale", symbol: "NVDA", confirmed: false },
];

// I singoli titoli dell'universo: per gli ETF non ci sono trimestrali.
export const SINGLE_STOCKS = ["AAPL", "MSFT", "NVDA"] as const satisfies readonly (typeof UNIVERSE)[number][];

const describe = (e: MarketEvent) => (e.kind === "fed" ? "decisione della Fed" : `trimestrale ${e.symbol}`) + ` il ${e.date}${e.confirmed ? "" : " (data stimata)"}`;

// Perché oggi non si può comprare questo titolo, o null. Fed: niente acquisti nel giorno della decisione.
// Trimestrale: niente acquisti del titolo negli ultimi giorni di borsa prima, giorno compreso (i conti escono dopo la chiusura).
export function eventBlockFor(symbol: string, today: string, events: MarketEvent[] = EVENTS): string | null {
  // La Fed decide sui tassi americani: ferma gli acquisti di azioni ed ETF, non quelli delle crypto.
  const fed = isCrypto(symbol) ? undefined : events.find((e) => e.kind === "fed" && e.date === today);
  if (fed) return `${describe(fed)}: oggi niente acquisti nuovi`;
  const horizon = addTradingDays(today, LIMITS.earningsBlackoutDays);
  const er = events.find((e) => e.kind === "trimestrale" && e.symbol === symbol && e.date >= today && e.date <= horizon);
  if (er) return `${describe(er)}: niente acquisti nei ${LIMITS.earningsBlackoutDays} giorni di borsa prima`;
  return null;
}

// Gli eventi delle prossime settimane, da far vedere al modello.
export function upcomingEvents(today: string, days = 21, events: MarketEvent[] = EVENTS): string[] {
  const until = addDays(today, days);
  return events.filter((e) => e.date >= today && e.date <= until).sort((a, b) => a.date.localeCompare(b.date)).map(describe);
}

// Cosa manca nel calendario: senza una data futura il blocco non può scattare.
export function staleCalendar(today: string, events: MarketEvent[] = EVENTS): string[] {
  const out: string[] = [];
  if (!events.some((e) => e.kind === "fed" && e.date >= today)) out.push("nessuna decisione della Fed futura");
  for (const s of SINGLE_STOCKS) if (!events.some((e) => e.kind === "trimestrale" && e.symbol === s && e.date >= today)) out.push(`nessuna trimestrale futura per ${s}`);
  return out;
}

// Aggiunge (senza doppioni) le trimestrali arrivate dalla fonte automatica.
export function addEarnings(list: { date: string; symbol: string }[]) {
  for (const x of list) {
    if (EVENTS.some((e) => e.kind === "trimestrale" && e.symbol === x.symbol && e.date === x.date)) continue;
    EVENTS.push({ date: x.date, kind: "trimestrale", symbol: x.symbol, confirmed: true });
  }
}
