import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticCloses } from "../src/broker/fake.ts";
import { applyCage, type CageInput } from "../src/cage.ts";
import { assertPaperOnly, LiveEndpointError } from "../src/guard.ts";
import { Logger, Redactor } from "../src/log.ts";
import { at } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const secrets = { alpacaKeyId: "PKTESTKEY123456", alpacaSecretKey: "supersecretvalue987", telegramBotToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", telegramChatId: "42" };

describe("endpoint solo paper", () => {
  test("variabile d'ambiente verso il conto vero: rifiuta", () => {
    expect(() => assertPaperOnly({ APCA_API_BASE_URL: "https://api.alpaca.markets" })).toThrow(LiveEndpointError);
    expect(() => assertPaperOnly({ APCA_API_BASE_URL: "https://paper-api.alpaca.markets/v2" })).not.toThrow();
  });
  test("endpoint vero dentro secrets.ts o chiave live: rifiuta", () => {
    expect(() => assertPaperOnly({}, { ...secrets, telegramChatId: "https://api.alpaca.markets" })).toThrow(LiveEndpointError);
    expect(() => assertPaperOnly({}, { ...secrets, alpacaKeyId: "AKLIVE" })).toThrow(LiveEndpointError);
  });
  test("il programma non parte con l'endpoint vero configurato", () => {
    const r = Bun.spawnSync(["bun", join(ROOT, "src/cli/agents.ts"), "--fake", "--no-kronos"], { env: { ...process.env, APCA_API_BASE_URL: "https://api.alpaca.markets" }, stderr: "pipe", timeout: 30_000 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("mi rifiuto di partire");
  });
});

describe("chiavi mai nei log", () => {
  test("il logger oscura chiavi e token anche dentro un messaggio d'errore", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-"));
    const file = join(dir, "x.log");
    const log = new Logger(file, new Redactor([secrets.alpacaKeyId, secrets.alpacaSecretKey, secrets.telegramBotToken]), false);
    log.error(`errore con ${secrets.alpacaSecretKey} e https://api.telegram.org/bot${secrets.telegramBotToken}/send e ${secrets.alpacaKeyId}`);
    const text = readFileSync(file, "utf8");
    for (const v of [secrets.alpacaKeyId, secrets.alpacaSecretKey, secrets.telegramBotToken]) expect(text).not.toContain(v);
  });
  test("nessun file di log, testimone o messaggio contiene le chiavi di secrets.ts", async () => {
    const real = (await import(join(ROOT, "secrets.ts"))).secrets;
    const values = [real.alpacaKeyId, real.alpacaSecretKey, real.telegramBotToken].filter((v: string) => v);
    const walk = (d: string): string[] => {
      try {
        return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      } catch {
        return [];
      }
    };
    for (const f of [...walk(join(ROOT, "logs")), ...walk(join(ROOT, "state"))]) {
      const text = readFileSync(f, "utf8");
      for (const v of values) expect(text.includes(v)).toBe(false);
    }
  });
});


const PRICES: Record<string, number> = { SPY: 600, QQQ: 520, IWM: 230, AAPL: 250, MSFT: 480, NVDA: 180, GLD: 380, TLT: 90 };

describe("gabbia", () => {
  const base = (over: Partial<CageInput> = {}): CageInput => ({
    today: "2026-09-24",
    events: [],
    marketOpen: true,
    account: { equity: 100_000, lastEquity: 100_000, cash: 100_000, status: "ACTIVE" },
    positions: [],
    prices: PRICES,
    closes: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, syntheticCloses(v, 0.01, 260)])),
    recentOrders: [],
    lessons: [],
    buyBlock: null,
    proposals: [],
    ...over,
  });
  test("niente short, niente leva, massimo 5 titoli", () => {
    expect(applyCage(base({ proposals: [{ symbol: "SPY", side: "sell", qty: 1, why: "" }] })).rejected[0]!.reason).toContain("niente short");
    const poor = base({ account: { equity: 100_000, lastEquity: 100_000, cash: 1_000, status: "ACTIVE" }, proposals: [{ symbol: "SPY", side: "buy", qty: 2, why: "" }] });
    expect(applyCage(poor).rejected[0]!.reason).toContain("niente leva");
    const five = ["SPY", "QQQ", "IWM", "AAPL", "MSFT"].map((s) => ({ symbol: s, qty: 1, avgEntryPrice: 100, currentPrice: 100, marketValue: 100 }));
    expect(applyCage(base({ positions: five, proposals: [{ symbol: "TLT", side: "buy", qty: 1, why: "" }] })).rejected[0]!.reason).toContain("massimo 5 titoli");
  });
  test("20% conta anche quello che hai già", () => {
    const pos = [{ symbol: "SPY", qty: 30, avgEntryPrice: 600, currentPrice: 600, marketValue: 18_000 }];
    expect(applyCage(base({ positions: pos, proposals: [{ symbol: "SPY", side: "buy", qty: 5, why: "" }] })).rejected[0]!.reason).toContain("20.0%");
  });
});


describe("impostazioni degli agenti e chiavi", () => {
  test("i parametri si validano, si salvano solo se diversi da quelli di serie, si applicano al motore e si tolgono", async () => {
    const { AGENTS, LIMITS } = await import("../src/config.ts");
    const { saveAgentSettings, applyAgentSettings, agentCardsWithValues, validate } = await import("../src/agent-settings.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/imp-`);
    expect(validate("LIMITS.maxPositions", 5000).ok).toBe(false);
    expect(validate("AGENTS.exit.mode", "boh").ok).toBe(false);
    expect(validate("AGENTS.intraday.closeBy.stocks", "25:00").ok).toBe(false);
    const before = LIMITS.maxPositions;
    const cryptoDiSerie = AGENTS.intraday.target.crypto;
    const r = saveAgentSettings(dir, { "LIMITS.maxPositions": 7, "AGENTS.intraday.target.crypto": 0.03, "AGENTS.buyScore": 0.5 });
    expect(r.ok && Object.keys(r.salvati).sort()).toEqual(["AGENTS.intraday.target.crypto", "LIMITS.maxPositions"]); // buyScore è di serie: non salvato
    expect(LIMITS.maxPositions).toBe(7);
    expect(AGENTS.intraday.target.crypto).toBe(0.03);
    const cards = agentCardsWithValues(dir);
    expect(cards.find((c) => c.agente === "motore")!.parametri.find((p) => p.chiave === "LIMITS.maxPositions")!.cambiato).toBe(true);
    saveAgentSettings(dir, {});
    applyAgentSettings(dir);
    expect(LIMITS.maxPositions).toBe(before);
    expect(AGENTS.intraday.target.crypto).toBe(cryptoDiSerie);
  });

  test("secrets.ts: scrittura con campi vuoti che non toccano il resto, lettura mascherata, chiavi non paper rifiutate", async () => {
    const { writeSecretsFile, maskedSettings, readSecretsFile } = await import("../src/settings.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/sec-`);
    expect(writeSecretsFile(dir, { alpacaKeyId: "AKLIVE123", alpacaSecretKey: "x" })).toEqual({ ok: false, errore: expect.stringContaining("PAPER") });
    const w = writeSecretsFile(dir, { alpacaKeyId: "PKTEST12345678", alpacaSecretKey: "segretissimo123", telegramBotToken: "123456:ABC-def", telegramChatId: "42" });
    expect(w.ok).toBe(true);
    const w2 = writeSecretsFile(dir, { telegramChatId: "43" });
    expect(w2.ok && w2.cambiati).toEqual(["telegramChatId"]);
    expect(readSecretsFile(dir).alpacaKeyId).toBe("PKTEST12345678");
    const m = maskedSettings(dir);
    expect(m.alpacaKeyId).toBe("PKTE…678");
    expect(m.alpacaSecretKey).not.toContain("segretissimo");
    expect(m.telegramChatId).toBe("43");
  });
});

describe("briciole e arrotondamenti", () => {
  test("le posizioni crypto microscopiche si ignorano, le quantità si troncano a 6 decimali, i titoli restano interi", async () => {
    const { cleanPositions } = await import("../src/agents/engine.ts");
    const out = cleanPositions([
      { symbol: "AAVE/USD", qty: 2.27e-7, avgEntryPrice: 130, currentPrice: 130, marketValue: 0.00003 },
      { symbol: "LTC/USD", qty: 80.874531937, avgEntryPrice: 100, currentPrice: 100, marketValue: 8087.45 },
      { symbol: "AAPL", qty: 40, avgEntryPrice: 350, currentPrice: 342, marketValue: 13680 },
      { symbol: "ETH/USD", qty: 0.002, avgEntryPrice: 2100, currentPrice: 2100, marketValue: 4.2 }, // 4,2 $: sotto il minimo di 10 $
    ]);
    expect(out.map((p) => p.symbol)).toEqual(["LTC/USD", "AAPL"]);
    expect(out[0]!.qty).toBe(80.874531);
  });

  test("un rifiuto di Alpaca per quantità non diventa una lezione", async () => {
    const { emptyLessons, learnFromBrokerReject } = await import("../src/lessons.ts");
    const f = emptyLessons();
    expect(learnFromBrokerReject(f, "LTC/USD", "sell", "2026-11-08", 'Alpaca 403: {"message":"insufficient balance for LTC"}', new Date("2026-11-08T12:00:00Z"))).toBeNull();
    expect(learnFromBrokerReject(f, "LTC/USD", "sell", "2026-11-08", 'Alpaca 422: {"message":"qty must be > 0"}', new Date("2026-11-08T12:00:00Z"))).toBeNull();
    expect(f.rifiuti).toHaveLength(0);
  });
});

describe("errori di Alpaca leggibili", () => {
  test("il JSON di Alpaca diventa una frase in italiano con il codice tra parentesi", async () => {
    const { humanizeBrokerError } = await import("../src/broker/types.ts");
    expect(humanizeBrokerError(422, '{"code":40010001,"message":"qty must be \\u003e 0"}')).toBe("Alpaca 422: quantità troppo piccola (resto frazionario) (codice 40010001)");
    expect(humanizeBrokerError(403, '{"available":"0.000000937","balance":"0.000000937","code":40310000,"message":"insufficient balance for LTC (requested: 0.000001, available: 0.000000937)","symbol":"USD"}')).toBe("Alpaca 403: saldo insufficiente di LTC (chiesti 0.000001, disponibili 0.000000937) (codice 40310000)");
    expect(humanizeBrokerError(401, '{"message": "unauthorized."}')).toContain("chiavi rifiutate");
    expect(humanizeBrokerError(500, "errore interno")).toBe("Alpaca 500: errore interno");
  });
});

describe("ora di Roma", () => {
  test("dopo il cambio d'ora Roma resta Roma; i giorni di borsa saltano il fine settimana", async () => {
    const { romeTime, addTradingDays } = await import("../src/slots.ts");
    expect(romeTime(new Date("2026-10-26T14:41:00Z"))).toMatchObject({ date: "2026-10-26", minutes: 15 * 60 + 41 }); // CET = UTC+1
    expect(romeTime(new Date("2026-09-24T13:41:00Z"))).toMatchObject({ date: "2026-09-24", minutes: 15 * 60 + 41 }); // CEST = UTC+2
    expect(addTradingDays("2026-11-06", 1)).toBe("2026-11-09");
  });
});
