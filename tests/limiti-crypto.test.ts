import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../src/agents/bus.ts";
import { emptyCache, runTick, type EngineDeps } from "../src/agents/engine.ts";
import type { AgentView, Signal } from "../src/agents/types.ts";
import { prezzoDaQuote } from "../src/broker/types.ts";
import { AGENTS, setCryptoUniverse } from "../src/config.ts";
import { makeEnv, ordersFor } from "./helpers.ts";

AGENTS.intraday.riporto.enabled = false;

describe("prezzo delle crypto dalle migliori offerte", () => {
  test("a metà tra acquisto e vendita se il libro è sensato; se no l'ultimo scambio", () => {
    expect(prezzoDaQuote({ bid: 0.0880, ask: 0.0882 }, 0.087696)).toBeCloseTo(0.0881, 9); // POL: ultimo scambio vecchio
    expect(prezzoDaQuote({ bid: 90, ask: 110 }, 100.5)).toBe(100.5); // spread del 20%: libro non affidabile
    expect(prezzoDaQuote(undefined, 100.5)).toBe(100.5);
    expect(prezzoDaQuote({ bid: 0, ask: 1 }, undefined)).toBeUndefined();
  });
});

describe("ordini limite crypto nel motore vero", () => {
  const preparaAgente = () => ({
    name: "intraday",
    async observe(v: AgentView) {
      if (v.positions.some((p) => p.symbol === "BTC/USD" && p.qty > 0)) return { segnali: [] };
      return { segnali: [{ agente: "intraday", simbolo: "BTC/USD", lato: "buy", forza: 1, orizzonteSedute: 1, intraday: true, pesoMassimo: 0.05, perche: "prova" } as Signal] };
    },
  });
  const deps = (env: ReturnType<typeof makeEnv>) => { const d = env.deps(); return { broker: d.broker, notifier: d.notifier, stateDir: d.stateDir, logsDir: d.logsDir, redactor: d.redactor, now: d.now, sleep: d.sleep, agents: [preparaAgente()], bus: new EventBus(d.stateDir, d.now), echo: false } as EngineDeps; };
  const log = (env: ReturnType<typeof makeEnv>) => readdirSync(env.logsDir).filter((f) => f.startsWith("agenti-")).map((f) => readFileSync(join(env.logsDir, f), "utf8")).join("\n");

  test("il limite va dentro le migliori offerte (metà meno 0,05%), non sotto un ultimo scambio vecchio", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const env = makeEnv(new Date("2026-09-27T19:00:00Z")); // domenica: solo crypto
    env.setFake((s) => { s.prices["BTC/USD"] = 100_000; s.quotes = { "BTC/USD": { bid: 99_900, ask: 100_100 } }; s.clock = "closed"; });
    await runTick(deps(env), emptyCache());
    const o = ordersFor(env, "BTC/USD").find((x) => x.side === "buy")!;
    expect(o.type).toBe("limit");
    expect(o.filledAvgPrice).toBeCloseTo(100_000 * (1 - AGENTS.costi.ordiniLimite.sotto), 6);
  });

  test("un limite non eseguito in 10 minuti si cancella; al voto dopo si compra al prezzo di vendita", async () => {
    setCryptoUniverse(["BTC/USD"]);
    const env = makeEnv(new Date("2026-09-27T19:00:00Z"));
    env.setFake((s) => {
      s.prices["BTC/USD"] = 100_000; s.quotes = { "BTC/USD": { bid: 99_900, ask: 100_100 } }; s.clock = "closed";
      // Un ordine limite di 15 minuti fa ancora aperto (il prezzo non l'ha toccato).
      s.orders.push({ id: "vecchio", clientOrderId: "agenti-vecchio-BTCUSD-buy", symbol: "BTC/USD", side: "buy", qty: 0.01, filledQty: 0, status: "new", submittedAt: new Date(Date.parse("2026-09-27T19:00:00Z") - 15 * 60_000).toISOString(), type: "limit", stopPrice: null, filledAvgPrice: null, filledAt: null } as any);
    });
    const cache = emptyCache();
    await runTick(deps(env), cache);
    expect(env.broker.load().orders.find((x) => x.id === "vecchio")!.status).toBe("canceled");
    expect(cache.limitiMancati?.["BTC/USD"]).toBeDefined();
    expect(log(env)).toContain("si compra al prezzo di vendita");
    // Più di un'ora dopo si torna al limite dentro le offerte.
    cache.limitiMancati!["BTC/USD"] = new Date(Date.parse("2026-09-27T19:00:00Z") - 2 * 3_600_000).toISOString();
    env.setFake((s) => { delete s.positions["BTC/USD"]; });
    env.clock.t += 5 * 60_000;
    await runTick(deps(env), cache);
    const ultimo = ordersFor(env, "BTC/USD").filter((x) => x.side === "buy" && x.id !== "vecchio").at(-1)!;
    expect(ultimo.filledAvgPrice).toBeCloseTo(100_000 * (1 - AGENTS.costi.ordiniLimite.sotto), 6);
  });
});
