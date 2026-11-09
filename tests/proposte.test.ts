import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAgentSettings, readAgentSettings } from "../src/agent-settings.ts";
import { aggiornaProposte, decidiProposta, leggiProposte } from "../src/agents/proposte.ts";
import { AGENTS } from "../src/config.ts";
import { emptyJournal, type JournalFile } from "../src/journal.ts";

// Un diario di operazioni intraday chiuse: `n` con probabilità `p` e resa `r` ciascuna.
function diario(gruppi: { n: number; p: number; r: number }[]): JournalFile {
  const j = emptyJournal();
  let i = 0;
  const t0 = Date.parse("2026-10-01T10:00:00Z");
  for (const g of gruppi) for (let k = 0; k < g.n; k++, i++) {
    const ap = new Date(t0 + i * 3_600_000).toISOString(), ch = new Date(t0 + i * 3_600_000 + 1_800_000).toISOString();
    j.trade.push({ id: `t${i}`, simbolo: i % 2 ? "BTC/USD" : "ETH/USD", stato: "chiuso", apertoIl: ap, chiusoIl: ch, comprate: 1, costo: 1000, vendute: 1, incassato: 1000 * (1 + g.r), quantita: 0, contesto: { setup: "", momentum20: null, volGiornaliera: null, distanzaMedia: null, fiducia: null, attesa: "", perche: "", agenti: ["intraday"], tipo: "intraday", misure: { probabilita: g.p }, livelli: { candela: "1Hour", obiettivo: 1030, stop: 990, orizzonteMin: 120 } } } as any);
  }
  return j;
}

describe("proposte del capo ufficio", () => {
  test("con pochi dati non propone niente", () => {
    const dir = mkdtempSync(join(tmpdir(), "prop-"));
    const r = aggiornaProposte(dir, diario([{ n: 10, p: 0.56, r: -0.01 }]), new Date("2026-11-01T10:00:00Z"));
    expect(r.nuove).toEqual([]);
    expect(r.file.osservazioni[0]).toContain("insufficienti");
  });
  test("le operazioni al limite della soglia perdono: propone di alzarla; accettata si salva, rifiutata non torna subito", () => {
    const dir = mkdtempSync(join(tmpdir(), "prop-"));
    applyAgentSettings(dir);
    const soglia = AGENTS.intraday.kronos.minProb;
    const j = diario([{ n: 20, p: soglia + 0.01, r: -0.008 }, { n: 20, p: soglia + 0.1, r: 0.012 }]);
    const now = new Date("2026-11-01T10:00:00Z");
    const r = aggiornaProposte(dir, j, now);
    const p = r.nuove.find((x) => x.chiave === "AGENTS.intraday.kronos.minProb")!;
    expect(p.proposto).toBeGreaterThan(soglia);
    expect(p.motivo).toContain("perdono");
    // Rifiutata: non si ripropone al giro dopo, anche con un'operazione in più.
    expect(decidiProposta(dir, p.id, "rifiuta", j, now).ok).toBe(true);
    const j2 = diario([{ n: 21, p: soglia + 0.01, r: -0.008 }, { n: 20, p: soglia + 0.1, r: 0.012 }]);
    expect(aggiornaProposte(dir, j2, new Date(now.getTime() + 3_600_000)).nuove.find((x) => x.chiave === p.chiave)).toBeUndefined();
    // Dopo i giorni di attesa torna; accettata, il valore si salva tra le impostazioni.
    const dopo = new Date(now.getTime() + (AGENTS.capo.proposte.giorniRifiuto + 1) * 86_400_000);
    const j3 = diario([{ n: 22, p: soglia + 0.01, r: -0.008 }, { n: 20, p: soglia + 0.1, r: 0.012 }]);
    const p2 = aggiornaProposte(dir, j3, dopo).nuove.find((x) => x.chiave === p.chiave)!;
    expect(decidiProposta(dir, p2.id, "accetta", j3, dopo).ok).toBe(true);
    expect(readAgentSettings(dir)["AGENTS.intraday.kronos.minProb"]).toBe(p2.proposto);
    expect(leggiProposte(dir).proposte.find((x) => x.id === p2.id)!.stato).toBe("accettata");
    applyAgentSettings(mkdtempSync(join(tmpdir(), "prop-"))); // torna ai valori di serie per gli altri test
  });
  test("operazioni in perdita nel complesso: propone una taglia più piccola", () => {
    const dir = mkdtempSync(join(tmpdir(), "prop-"));
    const r = aggiornaProposte(dir, diario([{ n: 40, p: 0.9, r: -0.006 }]), new Date("2026-11-01T10:00:00Z"));
    const p = r.nuove.find((x) => x.chiave === "AGENTS.intraday.maxWeight")!;
    expect(p.proposto).toBeLessThan(p.attuale);
  });
});
