import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBroker, type FakeState } from "../src/broker/fake.ts";
import { Redactor } from "../src/log.ts";
import { FileNotifier } from "../src/telegram.ts";
import type { BaseDeps } from "../src/deps.ts";

// Giovedì 24 settembre 2026, ora legale: Roma = UTC+2.
export const at = (rome: string) => new Date(`2026-09-24T${rome}:00+02:00`);

export interface TestEnv {
  dir: string;
  stateDir: string;
  logsDir: string;
  broker: FakeBroker;
  clock: { t: number };
  deps: (overrides?: Partial<BaseDeps>) => BaseDeps;
  outbox: () => string;
  setFake: (patch: (s: FakeState) => void) => void;
}

export function makeEnv(start: Date): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
  const stateDir = join(dir, "state");
  const logsDir = join(dir, "logs");
  const clock = { t: start.getTime() };
  const now = () => new Date(clock.t);
  const broker = new FakeBroker(join(stateDir, "fake-broker.json"), now);
  const notifier = new FileNotifier(join(stateDir, "telegram-outbox.log"));
  return {
    dir,
    stateDir,
    logsDir,
    broker,
    clock,
    deps: (o = {}) => ({
      broker,
      notifier,
      stateDir,
      logsDir,
      redactor: new Redactor([]),
      now,
      // Il tempo passa solo quando il motore aspetta: test veloci, attese vere nel conto.
      sleep: async (ms: number) => {
        clock.t += ms;
      },
      echo: false,
      ...o,
    }),
    outbox: () => {
      try {
        return readFileSync(join(stateDir, "telegram-outbox.log"), "utf8");
      } catch {
        return "";
      }
    },
    setFake: (patch) => {
      const s = broker.load();
      patch(s);
      broker.save(s);
    },
  };
}

// Ordini di trading (a mercato). Gli stop di protezione su Alpaca si contano a parte.
export const ordersFor = (env: TestEnv, symbol: string) => env.broker.load().orders.filter((o) => o.symbol === symbol && o.type !== "stop");
export const openStopsFor = (env: TestEnv, symbol: string) => env.broker.load().orders.filter((o) => o.symbol === symbol && (o.type === "stop" || o.type === "stop_limit") && o.status === "new");
