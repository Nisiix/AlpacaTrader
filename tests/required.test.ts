import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWake } from "../src/wake.ts";
import { readWitness } from "../src/witness.ts";
import { at, brainSaying, makeEnv, openStopsFor, ordersFor } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");

describe("casi richiesti", () => {
  test("stessa sveglia lanciata 2 volte: un solo ordine per titolo", async () => {
    const env = makeEnv(at("15:41"));
    const first = await runWake(env.deps());
    expect(first.status).toBe("done");
    expect(first.runId).toBe("2026-09-24-15-40");
    expect(ordersFor(env, "SPY")[0]!.clientOrderId).toBe("2026-09-24-15-40-SPY-buy");

    const second = await runWake(env.deps());
    expect(second.status).toBe("already-done");

    const forced = await runWake(env.deps(), { force: true });
    expect(forced.status).toBe("done");
    expect(forced.witness!.ordiniInviati).toHaveLength(0);
    expect(forced.witness!.ordiniGiaPresenti.map((o) => o.simbolo).sort()).toEqual(["GLD", "SPY"]);

    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(1);
    // Anche lo stop su Alpaca non si duplica rifacendo la sveglia.
    expect(openStopsFor(env, "SPY")).toHaveLength(1);
    expect(openStopsFor(env, "GLD")).toHaveLength(1);
  });

  test("processo ucciso dopo il primo ordine: la sveglia dopo trova il lock, riconcilia, non ricompra", async () => {
    const env = makeEnv(at("15:41"));
    env.setFake((s) => (s.faults.crashAfterSubmits = 1));
    const args = ["bun", join(ROOT, "src/cli/once.ts"), "--fake", "--now", at("15:41").toISOString(), "--state", env.stateDir, "--logs", env.logsDir];
    const killed = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    expect(killed.signalCode).toBe("SIGKILL");
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(0);
    expect(readWitness(env.stateDir).kind).toBe("missing");

    env.setFake((s) => (s.faults = {}));
    const again = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    expect(again.exitCode).toBe(0);

    const out = env.outbox();
    expect(out).toContain("⚠️ Run 2026-09-24-15-40 · Sveglia precedente interrotta");
    expect(out).toContain("partito: BUY 10 SPY");
    expect(out).toContain("NON partito: BUY 5 GLD");
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(1);
    const w = readWitness(env.stateDir);
    expect(w.kind === "ok" && w.value.ordiniGiaPresenti.map((o) => o.simbolo)).toEqual(["SPY"]);
  });

  test("testimone delle 9 e poi niente fino alle 21:40: segnala 15:40 e 18:30 come saltate", async () => {
    const env = makeEnv(at("09:01"));
    expect((await runWake(env.deps())).runId).toBe("2026-09-24-09-00");
    env.clock.t = at("21:41").getTime();
    const res = await runWake(env.deps());
    expect(res.runId).toBe("2026-09-24-21-40");
    expect(env.outbox()).toContain("Sveglie saltate");
    const alarm = res.witness!.allarmi.find((a) => a.startsWith("Sveglie saltate"))!;
    expect(alarm).toContain("2026-09-24 15:40");
    expect(alarm).toContain("2026-09-24 18:30");
    expect(alarm).not.toContain("09:00");
  });

  test("titolo fuori universo o 40% del conto su un titolo: rifiutati", async () => {
    const env = makeEnv(
      at("15:41"),
      brainSaying({
        orders: [
          { symbol: "TSLA", side: "buy", qty: 1, why: "prova" },
          { symbol: "NVDA", side: "buy", qty: 222, why: "40% del conto" }, // 222 * 180 = 39.960 su 100.000
          { symbol: "AAPL", side: "buy", qty: 4, why: "ok" },
        ],
        reasoning: "Prova.",
        plan_next: "",
      }),
    );
    const res = await runWake(env.deps());
    const rej = res.witness!.ordiniRifiutati;
    expect(rej.find((r) => r.simbolo === "TSLA")!.motivo).toBe("fuori universo");
    expect(rej.find((r) => r.simbolo === "NVDA")!.motivo).toContain("massimo 20.0%");
    expect(res.witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["AAPL"]);
    expect(env.outbox()).toContain("TSLA [modello]: fuori universo");
    expect(ordersFor(env, "TSLA")).toHaveLength(0);
    expect(ordersFor(env, "NVDA")).toHaveLength(0);
  });

  test("posizione a -12%, oltre lo stop di protezione: la gabbia la vende anche se il modello dice di tenere", async () => {
    const env = makeEnv(at("18:31"), brainSaying({ orders: [], reasoning: "Tengo tutto.", plan_next: "" }));
    env.setFake((s) => {
      s.positions.MSFT = { qty: 20, avgEntryPrice: 500 };
      s.prices.MSFT = 440; // -12%, lo stop di MSFT è all'8,5%
      s.cash -= 10_000;
    });
    const res = await runWake(env.deps());
    const sold = res.witness!.ordiniInviati.find((o) => o.simbolo === "MSFT")!;
    expect(sold.lato).toBe("sell");
    expect(sold.quantita).toBe(20);
    expect(sold.origine).toBe("stop-loss");
    expect(env.broker.load().positions.MSFT).toBeUndefined();
  });

  test("testimone corrotto: vale come nessun testimone, la sveglia va avanti col broker", async () => {
    const env = makeEnv(at("15:41"));
    await runWake(env.deps({ now: () => at("09:01") }));
    writeFileSync(join(env.stateDir, "witness.json"), '{"versione":1,"sveglia":"2026-09-24-09-00","fin');
    const res = await runWake(env.deps());
    expect(res.status).toBe("done");
    expect(env.outbox()).toContain("Testimone illeggibile");
    expect(res.witness!.allarmi.some((a) => a.startsWith("Sveglie saltate"))).toBe(false);
    expect(res.witness!.ordiniInviati.map((o) => o.simbolo).sort()).toEqual(["GLD", "SPY"]);
    expect(readWitness(env.stateDir).kind).toBe("ok");
  });
});
