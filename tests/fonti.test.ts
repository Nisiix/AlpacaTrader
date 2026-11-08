import { describe, expect, test } from "bun:test";
import { FontiEsterne, crowdAdjustment } from "../src/agents/fonti.ts";

const fakeFetch = (fng: number, funding: Record<string, string>, fail = false) =>
  (async (url: string) => {
    if (fail) throw new Error("rete giù");
    if (String(url).includes("alternative.me")) return new Response(JSON.stringify({ data: [{ value: String(fng), value_classification: fng >= 75 ? "Extreme Greed" : fng <= 25 ? "Extreme Fear" : "Neutral", timestamp: "1762560000" }] }));
    return new Response(JSON.stringify(Object.entries(funding).map(([symbol, lastFundingRate]) => ({ symbol, lastFundingRate }))));
  }) as unknown as typeof fetch;

describe("fonti esterne", () => {
  test("Fear & Greed e funding si leggono, si tengono in memoria e si traducono per le crypto dell'universo", async () => {
    let t = 10_000_000_000;
    let calls = 0;
    const base = fakeFetch(85, { BTCUSDT: "0.0007", ETHUSDT: "-0.0002", AAPLUSDT: "0.0001" });
    const f = new FontiEsterne(((u: string) => { calls++; return base(u as any); }) as typeof fetch, () => t);
    const d = await f.read();
    expect(d.paura).toMatchObject({ valore: 85, classe: "avidità estrema" });
    expect(d.funding["BTC/USD"]).toBeCloseTo(0.0007, 9);
    expect(calls).toBe(2);
    t += 5 * 60_000;
    await f.read();
    expect(calls).toBe(2); // in memoria
    const btc = crowdAdjustment(d, "BTC/USD", 0.02);
    expect(btc.delta).toBeCloseTo(-0.25, 9); // funding affollato e avidità estrema
    expect(btc.nota.join(" ")).toContain("affollate");
    const eth = crowdAdjustment(d, "ETH/USD", 0.02);
    expect(eth.nota.join(" ")).toContain("chiusura degli short");
    expect(crowdAdjustment(d, "AAPL", 0.02)).toEqual({ delta: 0, nota: [] }); // solo crypto
  });

  test("se una fonte non risponde si va avanti senza, con il motivo", async () => {
    const f = new FontiEsterne(fakeFetch(50, {}, true));
    const d = await f.read();
    expect(d.paura).toBeNull();
    expect(d.errori.join(" ")).toContain("non raggiungibile");
  });
});
