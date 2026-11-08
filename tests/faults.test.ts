// Avvocato del diavolo: sei guasti, uno alla volta, con broker e cervello finti.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_DECISION } from "../src/brain/fake.ts";
import { dueSlot } from "../src/slots.ts";
import { runWake } from "../src/wake.ts";
import { readWitness } from "../src/witness.ts";
import { at, brainSaying, makeEnv, ordersFor, type TestEnv } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const onceArgs = (env: TestEnv, when: Date, extra: string[] = []) => ["bun", join(ROOT, "src/cli/once.ts"), "--fake", "--now", when.toISOString(), "--state", env.stateDir, "--logs", env.logsDir, ...extra];
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("guasto 3: Alpaca in timeout durante l'invio", () => {
  test("30 secondi di panne: l'ordine arrivato non viene duplicato e il resoconto dice la verità", async () => {
    const env = makeEnv(at("15:41"));
    env.setFake((s) => (s.faults.outageOnSubmitMs = 30_000));
    const res = await runWake(env.deps());
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(1);
    expect(res.witness!.ordiniInviati.find((o) => o.simbolo === "SPY")!.stato).toContain("confermato dopo un timeout");
    expect(res.witness!.ordiniIncerti).toHaveLength(0);
  });

  test("panne più lunga dei tentativi: esito incerto dichiarato, e la sveglia dopo verifica e lo dice", async () => {
    const env = makeEnv(at("15:41"));
    env.setFake((s) => (s.faults.outageOnSubmitMs = 10 * 60_000));
    const res = await runWake(env.deps());
    expect(res.witness!.ordiniIncerti.map((o) => o.id)).toContain("2026-09-24-15-40-SPY-buy");
    expect(env.outbox()).toContain("ESITO INCERTO");
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    env.setFake((s) => (s.faults = {}));
    env.clock.t = at("18:31").getTime();
    await runWake(env.deps());
    expect(env.outbox()).toContain("2026-09-24-15-40-SPY-buy risulta partito");
  });
});

describe("guasto 4: il modello risponde male", () => {
  test("JSON valido ma ordini strani: quantità testo, frazionaria, lato inventato, tutti rifiutati con motivo", async () => {
    const env = makeEnv(at("15:41"), brainSaying({ orders: [{ symbol: "SPY", side: "buy", qty: "10" as any, why: "" }, { symbol: "QQQ", side: "buy", qty: 1.5, why: "" }, { symbol: "IWM", side: "short", qty: 1, why: "" }], reasoning: "x", plan_next: "" }));
    const res = await runWake(env.deps());
    expect(res.witness!.ordiniRifiutati).toHaveLength(3);
    expect(env.broker.load().orders).toHaveLength(0);
  });
});

describe("guasto 5: testimone scritto a metà", () => {
  test("file temporaneo lasciato a metà da una scrittura interrotta: il testimone buono resta quello letto", async () => {
    const env = makeEnv(at("09:01"));
    await runWake(env.deps());
    writeFileSync(join(env.stateDir, "witness.json.tmp-999-abc"), '{"versione":1,"sveglia":"2026-09-24-15');
    env.clock.t = at("15:41").getTime();
    const res = await runWake(env.deps());
    expect(res.status).toBe("done");
    expect(env.outbox()).not.toContain("Testimone illeggibile");
    expect(readdirSync(env.stateDir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("witness.json troncato dopo la sveglia: rilanciarla non produce una seconda decisione", async () => {
    const env = makeEnv(at("15:41"));
    await runWake(env.deps());
    const p = join(env.stateDir, "witness.json");
    writeFileSync(p, readFileSync(p, "utf8").slice(0, 120));
    const other = brainSaying({ orders: [{ symbol: "NVDA", side: "buy", qty: 10, why: "idea nuova" }], reasoning: "x", plan_next: "" });
    const res = await runWake(env.deps({ brain: other }));
    expect(env.outbox()).toContain("Testimone illeggibile");
    expect(res.status).toBe("already-done");
    expect(ordersFor(env, "NVDA")).toHaveLength(0);
  });
});

describe("guasto 6: orologio", () => {
  test("la sveglia delle 21:40 parte alle 22:05: nessun ordine, allarme di ritardo, testimone scritto", async () => {
    const env = makeEnv(at("22:05"));
    env.setFake((s) => {
      s.positions.NVDA = { qty: 10, avgEntryPrice: 200 };
      s.cash -= 2_000;
    }); // -10%
    const res = await runWake(env.deps());
    expect(res.runId).toBe("2026-09-24-21-40");
    expect(env.broker.load().orders).toHaveLength(0);
    expect(env.outbox()).toContain("Sveglia in ritardo");
    expect(res.witness!.ordiniRifiutati.find((r) => r.simbolo === "NVDA")!.motivo).toContain("stop loss scattato");
    expect(res.witness!.prossimaSveglia).toBe("2026-09-25-09-00");
  });

  test("lo scheduler alle 22:05 non lancia la 21:40: la sveglia dopo la segnala come saltata", async () => {
    expect(dueSlot(at("22:05"), 20)).toBeNull();
    expect(dueSlot(at("21:59"), 20)!.runId).toBe("2026-09-24-21-40");
  });

  test("macchina indietro di 24 minuti: crede siano le 21:41, Alpaca dice 22:05; nessun ordine e me lo dice", async () => {
    const env = makeEnv(at("21:41"));
    env.setFake((s) => {
      s.clock = "open";
      s.faults.clockSkewMs = 24 * 60_000;
    });
    const res = await runWake(env.deps());
    expect(env.broker.load().orders).toHaveLength(0);
    expect(env.outbox()).toContain("Orologio sbagliato");
    expect(res.witness!.ordiniRifiutati.length).toBeGreaterThan(0);
  });
});
