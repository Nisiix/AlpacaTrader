import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cervello, previsioniCombinate, previsioniIntradayCombinate, scadenzaIntraday } from "../src/agents/cervello.ts";
import { AGENTS } from "../src/config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cervello-"));
const t0 = new Date("2026-11-02T15:00:00Z");
const dopo = (min: number) => new Date(t0.getTime() + min * 60_000);

// n previsioni valutate per modello: `giusti` con la direzione giusta.
function allena(c: Cervello, tipo: string, esiti: Record<string, number>, n: number) {
  for (let i = 0; i < n; i++) {
    const base = 100;
    const vero = i % 2 === 0 ? 0.01 : -0.01;
    const modelli: Record<string, number> = {};
    for (const [m, quota] of Object.entries(esiti)) modelli[m] = (i / n < quota ? Math.sign(vero) : -Math.sign(vero)) * 0.005;
    const fatta = dopo(i * 10);
    c.registra(tipo, `T${i}`, base, fatta, dopo(i * 10 + 5), modelli);
    c.valuta(dopo(i * 10 + 6), { [`T${i}`]: base * (1 + vero) });
  }
}

describe("cervello delle previsioni", () => {
  test("le previsioni scadute si confrontano col prezzo vero; quelle troppo in ritardo non si contano", () => {
    const c = new Cervello(dir());
    c.registra("giorno", "SPY", 100, t0, dopo(60), { kronos: 0.02, chronos2: -0.01 });
    expect(c.valuta(dopo(30), { SPY: 103 })).toBe(0); // non ancora scaduta
    expect(c.valuta(dopo(65), { SPY: 103 })).toBe(2);
    const r = c.stato().righe;
    expect(r.find((x) => x.modello === "kronos")!.inDirezione).toBe(1);
    expect(r.find((x) => x.modello === "chronos2")!.inDirezione).toBe(0);
    c.registra("giorno", "QQQ", 100, t0, dopo(60), { kronos: 0.02 });
    expect(c.valuta(dopo(60 * 24), { QQQ: 103 })).toBe(0); // troppo tardi
    expect(c.stato().inAttesa).toBe(0);
  });

  test("prima di un campione sufficiente pesa la scala di affidabilità: il modello più allenato sui mercati conta di più", () => {
    const c = new Cervello(dir());
    allena(c, "giorno", { kronos: 0.9, chronos2: 0.9, timesfm: 0.9 }, AGENTS.kronos.cervello.minCampione - 1);
    const w = c.pesi("giorno", ["kronos", "chronos2", "timesfm"]);
    const a = AGENTS.kronos.cervello.affidabilita;
    const tot = a.kronos! + a.chronos2! + a.timesfm!;
    expect(w.kronos).toBeCloseTo(a.kronos! / tot, 9);
    expect(w.chronos2).toBeCloseTo(a.chronos2! / tot, 9);
    expect(w.kronos!).toBeGreaterThan(w.chronos2!);
    expect(w.chronos2!).toBeGreaterThan(w.timesfm!);
    const p = c.combina("giorno", { kronos: [0.02], chronos2: [-0.02] }, [0.02]);
    expect(p[0]).toBeCloseTo((0.02 * a.kronos! - 0.02 * a.chronos2!) / (a.kronos! + a.chronos2!), 9);
  });

  test("con campioni sufficienti: affidabilità × risultati; chi non supera il caso pesa zero", () => {
    const c = new Cervello(dir());
    allena(c, "giorno", { kronos: 0.55, chronos2: 0.75, timesfm: 0.45 }, 400);
    const w = c.pesi("giorno", ["kronos", "chronos2", "timesfm"]);
    expect(w.timesfm).toBe(0); // peggio del caso: fuori
    // Chronos-2 indovina di più (fattore al massimo, 3) ma parte da un'affidabilità molto più bassa: Kronos resta davanti.
    const cfg = AGENTS.kronos.cervello;
    const fk = ((220 - 200) / (400 + cfg.prudenza)) / cfg.bravuraAttesa;
    const wk = cfg.affidabilita.kronos! * fk, wc = cfg.affidabilita.chronos2! * 3;
    expect(w.kronos).toBeCloseTo(wk / (wk + wc), 9);
    expect(w.chronos2).toBeCloseTo(wc / (wk + wc), 9);
    expect(w.kronos!).toBeGreaterThan(w.chronos2!);
  });

  test("un modello meno allenato che indovina molto più spesso guadagna peso, ma Kronos tiene la sua quota minima", () => {
    const c = new Cervello(dir());
    allena(c, "giorno", { kronos: 0.51, chronos2: 0.85 }, 400);
    const w = c.pesi("giorno", ["kronos", "chronos2"]);
    expect(w.kronos).toBeCloseTo(AGENTS.kronos.cervello.kronosMinimo, 9);
    expect(w.chronos2).toBeCloseTo(1 - AGENTS.kronos.cervello.kronosMinimo, 9);
  });

  test("Kronos peggiore del caso perde la quota minima; nessuno sopra il caso → resta Kronos", () => {
    const c = new Cervello(dir());
    allena(c, "giorno", { kronos: 0.3, chronos2: 0.8 }, 400);
    expect(c.pesi("giorno", ["kronos", "chronos2"])).toEqual({ kronos: 0, chronos2: 1 });
    const d = new Cervello(dir());
    allena(d, "giorno", { kronos: 0.3, chronos2: 0.3 }, 400);
    expect(d.pesi("giorno", ["kronos", "chronos2"])).toEqual({ kronos: 1, chronos2: 0 });
  });

  test("i conti sono separati per tipo di previsione e restano su disco", () => {
    const d = dir();
    const c = new Cervello(d);
    allena(c, "intraday-5m", { kronos: 0.3, chronos2: 0.8 }, 400);
    expect(c.pesi("giorno", ["kronos", "chronos2"]).kronos!).toBeGreaterThan(0.8); // nessun risultato: solo affidabilità
    const riletto = new Cervello(d);
    expect(riletto.pesi("intraday-5m", ["kronos", "chronos2"]).chronos2).toBe(1);
  });

  test("gli involucri registrano ogni modello e restituiscono il percorso combinato", async () => {
    const c = new Cervello(dir());
    allena(c, "giorno", { kronos: 0.55, chronos2: 0.75 }, 400);
    allena(c, "intraday-15m", { kronos: 0.55, chronos2: 0.75 }, 400);
    const giorno = previsioniCombinate(async () => ({ SPY: { rendimentoPrevisto: 0.02, percorso: [0.01, 0.02], ultimaChiusura: 600, modelli: { kronos: [0.01, 0.02], chronos2: [0.03, 0.04] } } }), c, () => t0);
    const g = await giorno(["SPY"], { SPY: [{ close: 600 }] });
    const w = c.pesi("giorno", ["kronos", "chronos2"]);
    expect(g.SPY!.percorso[0]).toBeCloseTo(0.01 * w.kronos! + 0.03 * w.chronos2!, 9);
    expect(g.SPY!.rendimentoPrevisto).toBeCloseTo(0.02 * w.kronos! + 0.04 * w.chronos2!, 9);
    const intra = previsioniIntradayCombinate(async () => ({ "BTC/USD": { rendimentoPrevisto: 0.01, percorso: [0.01], ultimaChiusura: 76_000, modelli: { kronos: [0.01], chronos2: [0.03] } } }), c, () => t0);
    const ultima = { t: "2026-11-02T14:30:00Z", open: 1, high: 1, low: 1, close: 76_000, volume: 1 };
    const r = await intra({ "BTC/USD": [ultima] }, 15, 1);
    const wi = c.pesi("intraday-15m", ["kronos", "chronos2"]);
    expect(r["BTC/USD"]!.rendimentoPrevisto).toBeCloseTo(0.01 * wi.kronos! + 0.03 * wi.chronos2!, 9);
    const aperte = c.stato().inAttesa;
    expect(aperte).toBe(4); // 2 modelli × (giorno + intraday)
    expect(scadenzaIntraday(ultima.t, 15, 1).toISOString()).toBe("2026-11-02T15:00:00.000Z");
  });
});

describe("campioni di Kronos", () => {
  test("si sale con i campioni finché il tempo per titolo resta in quello concesso; oltre si scende; mai fuori da minimo e massimo", async () => {
    const { Campionatore } = await import("../src/kronos-sidecar.ts");
    const cfg = AGENTS.kronos.campioni;
    const c = new Campionatore("intraday");
    expect(c.quanti()).toBe(cfg.intraday.iniziali);
    // Il PC risponde in 1,3 s per titolo con 16 campioni (budget 3 s): si sale (al più il doppio).
    c.misura(1_300, 1, 16);
    const su = c.quanti();
    expect(su).toBeGreaterThan(16);
    expect(su).toBeLessThanOrEqual(32);
    // Ora troppo lento (6 s per titolo): si scende in proporzione.
    c.misura(6_000, 1, su);
    expect(c.quanti()).toBe(Math.max(cfg.min, Math.floor((su * cfg.intraday.msPerSerie) / 6_000)));
    // Lentissimo: mai sotto il minimo. Velocissimo e ripetuto: mai sopra il massimo.
    c.misura(100_000, 1, 4);
    expect(c.quanti()).toBe(cfg.min);
    for (let i = 0; i < 20; i++) c.misura(10, 1, c.quanti());
    expect(c.quanti()).toBe(cfg.max);
  });
});
