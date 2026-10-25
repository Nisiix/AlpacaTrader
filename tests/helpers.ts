import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBrain } from "../src/brain/fake.ts";
import type { Brain, Decision } from "../src/brain/types.ts";
import { FakeBroker, type FakeState } from "../src/broker/fake.ts";
import { Redactor } from "../src/log.ts";
import { FileNotifier } from "../src/telegram.ts";
import type { WakeDeps } from "../src/wake.ts";

// Giovedì 24 settembre 2026, ora legale: Roma = UTC+2.
export const at = (rome: string) => new Date(`2026-09-24T${rome}:00+02:00`);

export interface TestEnv {
  dir: string;
  stateDir: string;
  logsDir: string;
  broker: FakeBroker;
  clock: { t: number };
  deps: (overrides?: Partial<WakeDeps>) => WakeDeps;
  outbox: () => string;
  setFake: (patch: (s: FakeState) => void) => void;
}

export function makeEnv(start: Date, brain: Brain = new FakeBrain()): TestEnv {
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
      brain,
      notifier,
      stateDir,
      logsDir,
      redactor: new Redactor([]),
      now,
      // Il tempo passa solo quando la sveglia aspetta: test veloci, attese vere nel conto.
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

export const brainSaying = (d: Decision): Brain => new FakeBrain(d);

export const ordersFor = (env: TestEnv, symbol: string) => env.broker.load().orders.filter((o) => o.symbol === symbol);
