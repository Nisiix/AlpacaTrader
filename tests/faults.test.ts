// Avvocato del diavolo: sei guasti, uno alla volta, con broker e cervello finti.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeBrain } from "../src/brain/claude.ts";
import { FAKE_DECISION } from "../src/brain/fake.ts";
import { dueSlot } from "../src/slots.ts";
import { runWake } from "../src/wake.ts";
import { readWitness } from "../src/witness.ts";
import { at, brainSaying, makeEnv, ordersFor, type TestEnv } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const onceArgs = (env: TestEnv, when: Date, extra: string[] = []) => ["bun", join(ROOT, "src/cli/once.ts"), "--fake", "--now", when.toISOString(), "--state", env.stateDir, "--logs", env.logsDir, ...extra];
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("guasto 1: morte a metà", () => {
  test("kill subito dopo il primo ordine, poi la sveglia dopo (18:30) non rimanda il vecchio ordine", async () => {
    const env = makeEnv(at("15:31"));
    env.setFake((s) => (s.faults.crashAfterSubmits = 1));
    expect(Bun.spawnSync(onceArgs(env, at("15:31"))).signalCode).toBe("SIGKILL");
    env.setFake((s) => (s.faults = {}));
    expect(Bun.spawnSync(onceArgs(env, at("18:31"))).exitCode).toBe(0);
    const out = env.outbox();
    expect(out).toContain("Sveglia precedente interrotta (2026-09-24-15-30)");
    expect(out).toContain("NON partito: BUY 5 GLD (id 2026-09-24-15-30-GLD-buy), non lo rimando");
    expect(env.broker.load().orders.some((o) => o.clientOrderId === "2026-09-24-15-30-GLD-buy")).toBe(false);
  });

  test("kill anche durante la riconciliazione: la terza sveglia sa ancora cosa è successo alla prima", async () => {
    const env = makeEnv(at("15:31"));
    env.setFake((s) => (s.faults.crashAfterSubmits = 1));
    expect(Bun.spawnSync(onceArgs(env, at("15:31"))).signalCode).toBe("SIGKILL");
    env.setFake((s) => (s.faults = { crashOnMethod: "getOrderByClientId" }));
    expect(Bun.spawnSync(onceArgs(env, at("15:32"))).signalCode).toBe("SIGKILL");
    env.setFake((s) => (s.faults = {}));
    expect(Bun.spawnSync(onceArgs(env, at("15:33"))).exitCode).toBe(0);
    const out = env.outbox();
    expect(out).toContain("partito: BUY 10 SPY");
    expect(out).toContain("NON partito: BUY 5 GLD");
    expect(ordersFor(env, "SPY")).toHaveLength(1);
  });
});

describe("guasto 2: doppio lancio", () => {
  test("quattro sveglie uguali lanciate insieme: una lavora, le altre si fermano, un ordine per titolo", async () => {
    const env = makeEnv(at("15:31"));
    const procs = Array.from({ length: 4 }, () => Bun.spawn(onceArgs(env, at("15:31")), { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    expect(outs.filter((o) => o.includes("[done]"))).toHaveLength(1);
    expect(codes.every((c) => c === 0 || c === 3)).toBe(true);
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(1);
  });

  test("due sveglie insieme dopo una morta: una sola riconcilia", async () => {
    const env = makeEnv(at("15:31"));
    env.setFake((s) => (s.faults.crashAfterSubmits = 1));
    Bun.spawnSync(onceArgs(env, at("15:31")));
    env.setFake((s) => (s.faults = {}));
    const procs = Array.from({ length: 3 }, () => Bun.spawn(onceArgs(env, at("15:32")), { stdout: "pipe", stderr: "pipe" }));
    await Promise.all(procs.map((p) => p.exited));
    expect(count(env.outbox(), "Sveglia precedente interrotta")).toBe(1);
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(1);
  });
});

describe("guasto 3: Alpaca in timeout durante l'invio", () => {
  test("30 secondi di panne: l'ordine arrivato non viene duplicato e il resoconto dice la verità", async () => {
    const env = makeEnv(at("15:31"));
    env.setFake((s) => (s.faults.outageOnSubmitMs = 30_000));
    const res = await runWake(env.deps());
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    expect(ordersFor(env, "GLD")).toHaveLength(1);
    expect(res.witness!.ordiniInviati.find((o) => o.simbolo === "SPY")!.stato).toContain("confermato dopo un timeout");
    expect(res.witness!.ordiniIncerti).toHaveLength(0);
  });

  test("panne più lunga dei tentativi: esito incerto dichiarato, e la sveglia dopo verifica e lo dice", async () => {
    const env = makeEnv(at("15:31"));
    env.setFake((s) => (s.faults.outageOnSubmitMs = 10 * 60_000));
    const res = await runWake(env.deps());
    expect(res.witness!.ordiniIncerti.map((o) => o.id)).toContain("2026-09-24-15-30-SPY-buy");
    expect(env.outbox()).toContain("ESITO INCERTO");
    expect(ordersFor(env, "SPY")).toHaveLength(1);
    env.setFake((s) => (s.faults = {}));
    env.clock.t = at("18:31").getTime();
    await runWake(env.deps());
    expect(env.outbox()).toContain("2026-09-24-15-30-SPY-buy risulta partito");
  });
});

describe("guasto 4: il modello risponde male", () => {
  const truncations: [string, string][] = [
    ["busta JSON troncata", '{"type":"result","is_error":false,"structured_output":{"orders":[{"symbol":"SPY","side":"buy","qty":10'],
    ["risultato testuale troncato", JSON.stringify({ type: "result", is_error: false, result: '{"orders":[{"symbol":"SPY","side":"buy","qty":10,"why":"x"},{"symbol":"NVDA"' })],
    ["campi mancanti", JSON.stringify({ type: "result", is_error: false, structured_output: { orders: [{ symbol: "SPY", side: "buy", qty: 10, why: "x" }] } })],
    ["output vuoto", ""],
  ];
  for (const [name, stdout] of truncations) {
    test(`${name}: nessun ordine del modello, allarme, stop loss comunque attivo`, async () => {
      const brain = new ClaudeBrain(async () => ({ code: 0, stdout, stderr: "" }));
      const env = makeEnv(at("15:31"), brain);
      env.setFake((s) => {
        s.positions.AAPL = { qty: 10, avgEntryPrice: 270 };
        s.cash -= 2_700;
      }); // 250 vs 270 = -7.4%
      const res = await runWake(env.deps());
      expect(res.status).toBe("done");
      expect(env.outbox()).toContain("Errore del cervello");
      expect(ordersFor(env, "SPY")).toHaveLength(0);
      expect(res.witness!.ordiniInviati.map((o) => `${o.simbolo}-${o.lato}-${o.origine}`)).toEqual(["AAPL-sell-stop-loss"]);
    });
  }

  test("JSON valido ma ordini strani: quantità testo, frazionaria, lato inventato, tutti rifiutati con motivo", async () => {
    const env = makeEnv(at("15:31"), brainSaying({ orders: [{ symbol: "SPY", side: "buy", qty: "10" as any, why: "" }, { symbol: "QQQ", side: "buy", qty: 1.5, why: "" }, { symbol: "IWM", side: "short", qty: 1, why: "" }], reasoning: "x", plan_next: "" }));
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
    env.clock.t = at("15:31").getTime();
    const res = await runWake(env.deps());
    expect(res.status).toBe("done");
    expect(env.outbox()).not.toContain("Testimone illeggibile");
    expect(readdirSync(env.stateDir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("witness.json troncato dopo la sveglia: rilanciarla non produce una seconda decisione", async () => {
    const env = makeEnv(at("15:31"));
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
