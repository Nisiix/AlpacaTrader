import { join } from "node:path";
import type { Broker } from "../broker/types.ts";
import { AGENTS, STABLECOINS, isCrypto } from "../config.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";

// L'universo crypto degli agenti: le coppie USD negoziabili su Alpaca che stanno nella top N per capitalizzazione
// (CoinGecko). Si rinnova una volta al giorno e resta in state/crypto-universe.json: se CoinGecko non risponde si
// tiene la lista precedente, e alla prima volta tutte le coppie di Alpaca (senza stablecoin), in ordine alfabetico.
export interface CryptoUniverseFile {
  versione: 1;
  aggiornato: string;
  fonte: string; // "coingecko" | "alpaca" | "coingecko (cache)"
  coppie: string[]; // in ordine di capitalizzazione
  classifica: Record<string, number>; // coppia -> posizione nella top N
  scartate: string[]; // coppie di Alpaca fuori dalla top N o stablecoin
}

const isFile = (v: unknown): v is CryptoUniverseFile => isObject(v) && v.versione === 1 && Array.isArray(v.coppie) && typeof v.aggiornato === "string";
export const cryptoUniversePath = (stateDir: string) => join(stateDir, "crypto-universe.json");
const baseOf = (pair: string) => pair.split("/")[0]!.toUpperCase();

export type TopFetcher = () => Promise<string[]>; // simboli (es. "BTC", "ETH") in ordine di capitalizzazione

export function coingeckoTop(url = AGENTS.cryptoUniverse.coingeckoUrl, timeoutMs = 15_000): TopFetcher {
  return async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = (await res.json()) as { symbol?: string }[];
    if (!Array.isArray(data)) throw new Error("CoinGecko: risposta inattesa");
    return data.map((c) => String(c.symbol ?? "").toUpperCase()).filter(Boolean);
  };
}

export function readCryptoUniverse(stateDir: string): CryptoUniverseFile | null {
  const r = readJson(cryptoUniversePath(stateDir), isFile);
  return r.kind === "ok" ? r.value : null;
}

// Incrocia la top N con le coppie di Alpaca; senza top N, tutte le coppie (ordine alfabetico), stablecoin escluse.
export function selectPairs(pairs: string[], top: string[] | null, maxPairs = AGENTS.cryptoUniverse.maxPairs, topN = AGENTS.cryptoUniverse.topMarketCap): { coppie: string[]; classifica: Record<string, number>; scartate: string[] } {
  const usd = pairs.filter((p) => isCrypto(p) && p.endsWith("/USD"));
  const rank = new Map<string, number>();
  if (top) top.slice(0, topN).forEach((s, i) => rank.has(s) || rank.set(s, i + 1));
  const kept: { p: string; r: number }[] = [];
  const scartate: string[] = [];
  for (const p of usd) {
    const b = baseOf(p);
    if (STABLECOINS.has(b)) {
      scartate.push(p);
      continue;
    }
    const r = top ? rank.get(b) : usd.indexOf(p) + 1;
    if (r === undefined) scartate.push(p);
    else kept.push({ p, r });
  }
  kept.sort((a, b) => a.r - b.r || a.p.localeCompare(b.p));
  const chosen = kept.slice(0, maxPairs);
  for (const k of kept.slice(maxPairs)) scartate.push(k.p);
  return { coppie: chosen.map((k) => k.p), classifica: Object.fromEntries(chosen.map((k) => [k.p, k.r])), scartate };
}

export async function refreshCryptoUniverse(broker: Broker, stateDir: string, now: Date, fetchTop: TopFetcher | null = coingeckoTop()): Promise<{ file: CryptoUniverseFile; refreshed: boolean; problem?: string }> {
  const prev = readCryptoUniverse(stateDir);
  const ageH = prev ? (now.getTime() - Date.parse(prev.aggiornato)) / 3_600_000 : Infinity;
  if (prev && ageH < AGENTS.cryptoUniverse.refreshHours) return { file: prev, refreshed: false };
  const pairs = await broker.getCryptoPairs();
  let top: string[] | null = null;
  let fonte = "alpaca";
  let problem: string | undefined;
  if (fetchTop) {
    try {
      top = await fetchTop();
      fonte = "coingecko";
    } catch (e) {
      problem = `classifica per capitalizzazione non disponibile (${(e as Error).message})`;
      if (prev && prev.fonte.startsWith("coingecko")) {
        // Meglio la classifica di ieri che nessuna classifica.
        top = Object.entries(prev.classifica).sort((a, b) => a[1] - b[1]).map(([p]) => baseOf(p));
        fonte = "coingecko (cache)";
      }
    }
  }
  const sel = selectPairs(pairs, top);
  const file: CryptoUniverseFile = { versione: 1, aggiornato: now.toISOString(), fonte, ...sel };
  writeJsonAtomic(cryptoUniversePath(stateDir), file);
  return { file, refreshed: true, problem };
}
