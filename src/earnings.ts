import { join } from "node:path";
import { HTTP_TIMEOUT_MS } from "./config.ts";
import { isObject, readJson, writeJsonAtomic } from "./fsutil.ts";
import { addDays } from "./slots.ts";

// Le date delle trimestrali dal calendario pubblico di Nasdaq: una volta al giorno, per i prossimi giorni, solo per i titoli
// che il motore segue (universo, radar, posizioni). Salvate in state/trimestrali.json: se la fonte non risponde restano
// quelle già scaricate e il calendario scritto a mano.
// quando: "prima" = prima dell'apertura, "dopo" = dopo la chiusura, "ignoto" = orario non comunicato.
export type QuandoConti = "prima" | "dopo" | "ignoto";
export interface Trimestrale {
  date: string;
  symbol: string;
  quando?: QuandoConti;
}
export interface EarningsFile {
  versione: 1;
  giorno: string;
  date: Trimestrale[];
}

export const earningsPath = (stateDir: string) => join(stateDir, "trimestrali.json");
const valido = (v: unknown): v is EarningsFile => isObject(v) && v.versione === 1 && typeof v.giorno === "string" && Array.isArray(v.date);

export type EarningsFetcher = (date: string) => Promise<{ symbol: string; quando: QuandoConti }[]>;

// Una giornata del calendario: i simboli con i conti in quella data.
export const nasdaqEarnings: EarningsFetcher = async (date) => {
  const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Nasdaq ${r.status}`);
  const j = (await r.json()) as { data?: { rows?: { symbol?: string; time?: string }[] | null } | null };
  return (j.data?.rows ?? [])
    .map((x) => ({ symbol: String(x.symbol ?? "").trim().toUpperCase(), quando: (x.time === "time-pre-market" ? "prima" : x.time === "time-after-hours" ? "dopo" : "ignoto") as QuandoConti }))
    .filter((x) => x.symbol);
};

// Scarica (al massimo una volta al giorno) i prossimi `giorni` giorni di calendario per i simboli dati.
export async function refreshEarnings(stateDir: string, today: string, simboli: string[], fetcher: EarningsFetcher, giorni = 7): Promise<{ file: EarningsFile | null; nuove: number; problema: string | null }> {
  const r = readJson(earningsPath(stateDir), valido);
  const prima = r.kind === "ok" ? r.value : null;
  if (prima?.giorno === today) return { file: prima, nuove: 0, problema: null };
  const voluti = new Set(simboli.filter((s) => !s.includes("/")));
  const trovate: Trimestrale[] = [];
  const errori: string[] = [];
  for (let i = 0; i <= giorni; i++) {
    const d = addDays(today, i);
    try {
      for (const x of await fetcher(d)) if (voluti.has(x.symbol)) trovate.push({ date: d, symbol: x.symbol, quando: x.quando });
    } catch (e) {
      errori.push(`${d}: ${(e as Error).message}`);
    }
  }
  if (errori.length > giorni) return { file: prima, nuove: 0, problema: `calendario trimestrali non disponibile (${errori[0]})` };
  // Si tengono anche le date già note ancora future, nel caso un giorno non abbia risposto.
  const vecchie = (prima?.date ?? []).filter((x) => x.date >= today && !trovate.some((t) => t.symbol === x.symbol && t.date === x.date));
  const file: EarningsFile = { versione: 1, giorno: today, date: [...trovate, ...vecchie].sort((a, b) => a.date.localeCompare(b.date)) };
  writeJsonAtomic(earningsPath(stateDir), file);
  return { file, nuove: trovate.length, problema: errori.length ? `${errori.length} giorni del calendario non letti` : null };
}
