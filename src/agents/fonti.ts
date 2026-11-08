import { isCrypto } from "../config.ts";

// Fonti esterne gratuite, senza chiavi, che arricchiscono contesto e dossier (mai ordini da sole):
// - Crypto Fear & Greed Index (alternative.me): 0 = paura estrema, 100 = avidità estrema. Avidità estrema → prudenza sulle
//   crypto; paura estrema → solo una nota (storicamente zona di accumulo, ma decide Kronos).
// - Funding dei perpetui Binance (premiumIndex, tutti i simboli in una chiamata): funding alto = posizioni lunghe
//   affollate (rischio di scarico); funding negativo con Kronos al rialzo = possibile chiusura forzata degli short.
// I dati si tengono in memoria: indice ogni ora, funding ogni 15 minuti. Se una fonte non risponde si va avanti senza.

export interface FontiDati {
  paura: { valore: number; classe: string; aggiornato: string } | null;
  funding: Record<string, number>; // "BTC/USD" -> funding dell'ultimo periodo (frazione, 0.0001 = 0,01% ogni 8 ore)
  errori: string[];
}

type Fetch = typeof fetch;

export class FontiEsterne {
  private paura: FontiDati["paura"] = null;
  private pauraAt = 0;
  private funding: Record<string, number> = {};
  private fundingAt = 0;
  private errori = new Map<string, string>();
  constructor(
    private f: Fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {}

  async read(): Promise<FontiDati> {
    const t = this.now();
    const jobs: Promise<void>[] = [];
    if (t - this.pauraAt > 60 * 60_000) jobs.push(this.loadPaura(t));
    if (t - this.fundingAt > 15 * 60_000) jobs.push(this.loadFunding(t));
    await Promise.all(jobs);
    return { paura: this.paura, funding: this.funding, errori: [...this.errori.values()] };
  }

  private async loadPaura(t: number) {
    try {
      const res = await this.f("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const d = (await res.json()) as { data?: { value: string; value_classification: string; timestamp: string }[] };
      const x = d.data?.[0];
      if (!x) throw new Error("risposta vuota");
      this.paura = { valore: Number(x.value), classe: CLASSI[x.value_classification] ?? x.value_classification, aggiornato: new Date(Number(x.timestamp) * 1000).toISOString() };
      this.pauraAt = t;
      this.errori.delete("paura");
    } catch (e) {
      this.pauraAt = t - 50 * 60_000; // si riprova tra 10 minuti
      this.errori.set("paura", `Fear & Greed non raggiungibile (${(e as Error).message})`);
    }
  }

  private async loadFunding(t: number) {
    try {
      const res = await this.f("https://fapi.binance.com/fapi/v1/premiumIndex", { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const d = (await res.json()) as { symbol: string; lastFundingRate: string }[];
      if (!Array.isArray(d)) throw new Error("risposta inattesa");
      const out: Record<string, number> = {};
      for (const x of d) if (x.symbol.endsWith("USDT")) out[`${x.symbol.slice(0, -4)}/USD`] = Number(x.lastFundingRate);
      this.funding = out;
      this.fundingAt = t;
      this.errori.delete("funding");
    } catch (e) {
      this.fundingAt = t - 10 * 60_000; // si riprova tra 5 minuti
      this.errori.set("funding", `funding Binance non raggiungibile (${(e as Error).message})`);
    }
  }
}

const CLASSI: Record<string, string> = { "Extreme Fear": "paura estrema", Fear: "paura", Neutral: "neutrale", Greed: "avidità", "Extreme Greed": "avidità estrema" };

// Quanto le fonti esterne spostano la lettura del contesto di una crypto nel dossier del custode (in punti 0..1), e perché.
export function crowdAdjustment(fonti: FontiDati | undefined, symbol: string, kronos: number | undefined): { delta: number; nota: string[] } {
  if (!fonti || !isCrypto(symbol)) return { delta: 0, nota: [] };
  let delta = 0;
  const nota: string[] = [];
  const fr = fonti.funding[symbol];
  if (fr !== undefined && Number.isFinite(fr)) {
    const p = `${(fr * 100).toFixed(3)}%`;
    if (fr >= 0.0005) { delta -= 0.15; nota.push(`funding ${p}: posizioni lunghe affollate, rischio di scarico`); }
    else if (fr < 0 && kronos !== undefined && kronos > 0) { delta += 0.1; nota.push(`funding ${p} negativo con Kronos al rialzo: possibile chiusura degli short`); }
    else nota.push(`funding ${p}`);
  }
  const fg = fonti.paura;
  if (fg) {
    if (fg.valore >= 80) { delta -= 0.1; nota.push(`Fear & Greed ${fg.valore} (${fg.classe}): mercato euforico, prudenza`); }
    else if (fg.valore <= 20) { delta += 0.05; nota.push(`Fear & Greed ${fg.valore} (${fg.classe}): paura estrema, storicamente zona di accumulo`); }
    else nota.push(`Fear & Greed ${fg.valore} (${fg.classe})`);
  }
  return { delta, nota };
}
