// I nove miglioramenti presi dalla pratica professionale, uno per uno.
import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBacktest } from "../src/backtest.ts";
import { UNIVERSE } from "../src/config.ts";
import { runWake } from "../src/wake.ts";
import { brainSaying, makeEnv, openStopsFor, ordersFor } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const day = (date: string, rome: string) => new Date(`${date}T${rome}:00+02:00`);
const buy = (symbol: string, qty: number) => ({ symbol, side: "buy", qty, why: "prova" });
const sell = (symbol: string, qty: number) => ({ symbol, side: "sell", qty, why: "prova" });
const saying = (...orders: ReturnType<typeof buy>[]) => brainSaying({ orders, reasoning: "Prova.", plan_next: "" });
const reasonFor = (res: Awaited<ReturnType<typeof runWake>>, sym: string) => res.witness!.ordiniRifiutati.find((r) => r.simbolo === sym)?.motivo ?? "";

describe("1. registro degli errori", () => {
  test("dopo uno stop loss del codice niente riacquisto per 5 giorni di borsa, poi sì", async () => {
    const env = makeEnv(day("2026-09-24", "18:31"), saying());
    env.setFake((s) => {
      s.positions.MSFT = { qty: 20, avgEntryPrice: 500 };
      s.prices.MSFT = 480;
      s.cash -= 10_000;
    });
    const first = await runWake(env.deps());
    expect(first.witness!.lezioniNuove![0]!.simbolo).toBe("MSFT");
    expect(env.outbox()).toContain("Lezione nuova");

    env.clock.t = day("2026-09-25", "15:41").getTime();
    const again = await runWake(env.deps({ brain: saying(buy("MSFT", 5)) }));
    expect(reasonFor(again, "MSFT")).toContain("registro degli errori");
    expect(reasonFor(again, "MSFT")).toContain("fino al 2026-10-01");

    env.clock.t = day("2026-10-02", "15:41").getTime();
    const later = await runWake(env.deps({ brain: saying(buy("MSFT", 5)) }));
    expect(later.witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["MSFT"]);
  });

  test("uno stop eseguito da Alpaca tra due sveglie diventa una lezione", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    await runWake(env.deps());
    env.setFake((s) => (s.prices.SPY = 570)); // sotto lo stop a 582
    expect(env.broker.load().positions.SPY).toBeUndefined();
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const res = await runWake(env.deps());
    expect(res.witness!.lezioniNuove!.map((l) => l.simbolo)).toEqual(["SPY"]);
    expect(reasonFor(res, "SPY")).toContain("registro degli errori");
    expect(ordersFor(env, "SPY")).toHaveLength(1);
  });

  test("Alpaca rifiuta due volte lo stesso titolo: la terza volta non ci si prova", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("GLD", 5)));
    env.setFake((s) => (s.faults.rejectSymbols = ["GLD"]));
    expect((await runWake(env.deps())).witness!.ordiniFalliti).toHaveLength(1);
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const second = await runWake(env.deps());
    expect(second.witness!.ordiniFalliti).toHaveLength(1);
    expect(second.witness!.lezioniNuove![0]!.tipo).toBe("rifiuto-alpaca");
    env.clock.t = day("2026-09-24", "21:41").getTime();
    const third = await runWake(env.deps());
    expect(third.witness!.ordiniFalliti).toHaveLength(0);
    expect(reasonFor(third, "GLD")).toContain("Alpaca ha rifiutato 2 volte");
  });
});

describe("2. stop loss piazzato su Alpaca", () => {
  test("dopo l'acquisto c'è uno stop per tutta la quantità al -3% dal carico", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    const res = await runWake(env.deps());
    const stops = openStopsFor(env, "SPY");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.qty).toBe(10);
    expect(stops[0]!.stopPrice).toBe(582);
    expect(res.witness!.stopSuAlpaca!.piazzati).toEqual(["SPY 10 @ 582.00"]);
    expect(env.outbox()).toContain("Stop su Alpaca: SPY 10 @ 582.00");
  });

  test("lo stop vende da solo a sveglie ferme", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    await runWake(env.deps());
    env.setFake((s) => (s.prices.SPY = 575));
    const s = env.broker.load();
    expect(s.positions.SPY).toBeUndefined();
    expect(s.cash).toBeCloseTo(100_000 - 6_000 + 5_750);
  });

  test("vendita parziale del modello: lo stop si toglie prima e si rimette sulla quantità rimasta", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    await runWake(env.deps());
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const res = await runWake(env.deps({ brain: saying(sell("SPY", 4)) }));
    expect(res.witness!.ordiniFalliti).toHaveLength(0);
    expect(res.witness!.ordiniInviati.map((o) => `${o.lato} ${o.quantita}`)).toEqual(["sell 4"]);
    const stops = openStopsFor(env, "SPY");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.qty).toBe(6);
  });

  test("nel briefing gli stop non si toccano", async () => {
    const env = makeEnv(day("2026-09-24", "09:01"));
    env.setFake((s) => {
      s.positions.SPY = { qty: 10, avgEntryPrice: 600 };
      s.cash -= 6_000;
    });
    const res = await runWake(env.deps());
    expect(res.witness!.stopSuAlpaca).toBeNull();
    expect(openStopsFor(env, "SPY")).toHaveLength(0);
  });
});

describe("3. dimensione in base alla volatilità", () => {
  test("NVDA (volatilità ~3%) non può superare ~8% del conto; SPY può arrivare al 20%", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("NVDA", 50), buy("SPY", 30)));
    const res = await runWake(env.deps());
    expect(reasonFor(res, "NVDA")).toMatch(/volatilità giornaliera 3\.\d% .*massimo è 8\.\d% del conto/);
    expect(res.witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["SPY"]);
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const ok = await runWake(env.deps({ brain: saying(buy("NVDA", 40)) }));
    expect(ok.witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["NVDA"]);
  });
});

describe("4. interruttore sulla perdita", () => {
  test("-7% dal massimo: scatta, blocca gli acquisti anche dopo un recupero, lascia le vendite; si riarma solo a mano", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    await runWake(env.deps());
    env.setFake((s) => {
      s.cash -= 7_000;
      s.lastEquity = 93_000;
    });
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const hit = await runWake(env.deps({ brain: saying(buy("GLD", 5), sell("SPY", 2)) }));
    expect(env.outbox()).toContain("Interruttore scattato");
    expect(reasonFor(hit, "GLD")).toContain("interruttore scattato");
    expect(hit.witness!.ordiniInviati.map((o) => `${o.simbolo} ${o.lato}`)).toEqual(["SPY sell"]);

    env.setFake((s) => (s.cash += 7_000));
    env.clock.t = day("2026-09-24", "21:41").getTime();
    expect(reasonFor(await runWake(env.deps({ brain: saying(buy("GLD", 5)) })), "GLD")).toContain("interruttore scattato");

    const reset = Bun.spawnSync(["bun", join(ROOT, "src/cli/breaker-reset.ts"), "--fake", "--state", env.stateDir, "--logs", env.logsDir], { stdout: "pipe" });
    expect(reset.exitCode).toBe(0);
    env.clock.t = day("2026-09-25", "15:41").getTime();
    const after = await runWake(env.deps({ brain: saying(buy("GLD", 5)) }));
    expect(after.witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["GLD"]);
  });

  test("-2,5% in giornata: niente acquisti oggi, domani sì", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("GLD", 5)));
    env.setFake((s) => (s.cash = 97_500));
    expect(reasonFor(await runWake(env.deps()), "GLD")).toContain("perdita di oggi 2.5%");
    env.setFake((s) => (s.lastEquity = 97_500));
    env.clock.t = day("2026-09-25", "15:41").getTime();
    expect((await runWake(env.deps())).witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["GLD"]);
  });

  test("file dell'interruttore rotto: acquisti bloccati e allarme, non si riparte da zero in silenzio", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("GLD", 5)));
    writeFileSync(join(env.stateDir, "breaker.json"), '{"versione":1,"mass');
    const res = await runWake(env.deps());
    expect(env.outbox()).toContain("Interruttore illeggibile");
    expect(reasonFor(res, "GLD")).toContain("breaker-reset");
  });
});

describe("5. tetto sui titoli correlati", () => {
  test("QQQ + MSFT + AAPL oltre il 35% insieme: l'ultimo viene rifiutato", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("MSFT", 30), buy("AAPL", 40)));
    env.setFake((s) => {
      s.positions.QQQ = { qty: 30, avgEntryPrice: 520 };
      s.cash -= 15_600;
    });
    const res = await runWake(env.deps());
    expect(res.witness!.ordiniInviati.map((o) => o.simbolo)).toEqual(["MSFT"]);
    expect(reasonFor(res, "AAPL")).toContain("gruppo tecnologia al 40.0%");
  });
});

describe("6. metodo dichiarato", () => {
  test("sotto la media a 50 giorni non si compra; senza storico nemmeno", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("IWM", 10), buy("TLT", 10)));
    env.setFake((s) => {
      s.closes.IWM = Array.from({ length: 80 }, (_, i) => 300 - i); // in discesa fino a 230
      s.closes.TLT = [90, 90, 90];
    });
    const res = await runWake(env.deps());
    expect(reasonFor(res, "IWM")).toContain("sotto la media a 50 giorni");
    expect(reasonFor(res, "TLT")).toContain("storico insufficiente");
    expect(env.broker.load().orders).toHaveLength(0);
  });
});

describe("7. confronto con SPY", () => {
  test("il resoconto dice quanto ha fatto il conto e quanto SPY dallo stesso giorno", async () => {
    const env = makeEnv(day("2026-09-24", "09:01"));
    await runWake(env.deps());
    expect(env.outbox()).toContain("Dal 2026-09-24: conto +0.00%, SPY +0.00%");
    env.setFake((s) => (s.prices.SPY = 660));
    env.clock.t = day("2026-09-25", "09:01").getTime();
    await runWake(env.deps());
    expect(env.outbox()).toContain("SPY +10.00%");
  });
});

describe("8. backtest della gabbia", () => {
  test("crollo di SPY: lo stop scatta e il registro impedisce di ricomprare subito", () => {
    const closes: Record<string, number[]> = {};
    for (const s of UNIVERSE) closes[s] = Array.from({ length: 120 }, (_, i) => 100 * (1 + 0.004 * i) * (1 + (i % 2 ? 0.003 : -0.003)));
    closes.SPY = closes.SPY!.map((v, i) => (i === 80 ? v * 0.8 : v)); // un giorno a -20%, poi torna in trend
    const r = runBacktest(closes);
    expect(r.days).toBe(70);
    expect(r.stopOuts).toBeGreaterThanOrEqual(1);
    expect(r.blockedByLessons).toBeGreaterThanOrEqual(1);
    expect(r.trades).toBeGreaterThan(0);
  });
});

describe("avvocato del diavolo sui pezzi nuovi", () => {
  test("registro degli errori rotto: messo da parte, allarme, la sveglia va avanti", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    writeFileSync(join(env.stateDir, "lessons.json"), '{"versione":1,"lezi');
    const res = await runWake(env.deps());
    expect(env.outbox()).toContain("Registro degli errori illeggibile");
    expect(res.witness!.ordiniInviati).toHaveLength(1);
    expect(readdirSync(env.stateDir).some((f) => f.startsWith("lessons.json.illeggibile-"))).toBe(true);
  });

  test("storico prezzi non disponibile: niente acquisti, ma stop loss e stop su Alpaca funzionano", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("GLD", 5)));
    env.setFake((s) => {
      s.faults.failMethods = ["getDailyCloses"];
      s.positions.MSFT = { qty: 20, avgEntryPrice: 500 };
      s.prices.MSFT = 480;
      s.positions.SPY = { qty: 10, avgEntryPrice: 600 };
      s.cash -= 16_000;
    });
    const res = await runWake(env.deps());
    expect(reasonFor(res, "GLD")).toContain("storico insufficiente");
    expect(res.witness!.ordiniInviati.map((o) => `${o.simbolo} ${o.origine}`)).toEqual(["MSFT stop-loss"]);
    expect(openStopsFor(env, "SPY")).toHaveLength(1);
  });

  test("il processo muore tra la cancellazione dello stop e la vendita: la sveglia dopo rimette lo stop", async () => {
    const env = makeEnv(day("2026-09-24", "15:41"), saying(buy("SPY", 10)));
    await runWake(env.deps());
    const stop = openStopsFor(env, "SPY")[0]!;
    await env.broker.cancelOrder(stop.id);
    env.setFake((s) => (s.faults = {}));
    expect(openStopsFor(env, "SPY")).toHaveLength(0);
    env.clock.t = day("2026-09-24", "18:31").getTime();
    const res = await runWake(env.deps({ brain: saying() }));
    expect(res.witness!.stopSuAlpaca!.piazzati).toEqual(["SPY 10 @ 582.00"]);
  });
});
