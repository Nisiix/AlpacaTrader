import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AlpacaBroker } from "./broker/alpaca.ts";
import { FakeBroker } from "./broker/fake.ts";
import type { CliArgs } from "./cli/args.ts";
import { assertPaperOnly } from "./guard.ts";
import { Redactor } from "./log.ts";
import type { Secrets } from "./secrets-types.ts";
import { FileNotifier, TelegramNotifier } from "./telegram.ts";
import type { Broker } from "./broker/types.ts";
import type { Notifier } from "./telegram.ts";

export const ROOT = resolve(import.meta.dir, "..");

// Nell'ambiente cloud le chiavi arrivano come variabili d'ambiente: valgono per i campi vuoti di secrets.ts.
const ENV_NAMES: Record<keyof Secrets, string> = {
  alpacaKeyId: "ALPACA_KEY_ID",
  alpacaSecretKey: "ALPACA_SECRET_KEY",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  telegramChatId: "TELEGRAM_CHAT_ID",
  xBearerToken: "X_BEARER_TOKEN",
};

export async function loadSecrets(required: boolean): Promise<Secrets | null> {
  const p = join(ROOT, "secrets.ts");
  const fromFile: Partial<Secrets> = existsSync(p) ? ((await import(p)).secrets as Secrets) : {};
  const merged = {} as Secrets;
  for (const [k, env] of Object.entries(ENV_NAMES) as [keyof Secrets, string][]) (merged as unknown as Record<string, string>)[k] = fromFile[k] || process.env[env] || "";
  if (!existsSync(p) && !merged.alpacaKeyId) {
    if (required) throw new Error("secrets.ts non esiste e mancano ALPACA_KEY_ID/ALPACA_SECRET_KEY: copia secrets.example.ts in secrets.ts e riempi i campi");
    return null;
  }
  return merged;
}

export function dirs(args: CliArgs) {
  // Il finto vive in cartelle sue: uno stato finto non deve mai confondersi con quello vero.
  const stateDir = resolve(args.state ?? join(ROOT, args.fake ? "state/fake" : "state"));
  const logsDir = resolve(args.logs ?? join(ROOT, args.fake ? "logs/fake" : "logs"));
  return { stateDir, logsDir };
}

// Le dipendenze di base del motore degli agenti e degli strumenti accanto (chiusura posizioni, riarmo dell'interruttore, chat id di Telegram).
export interface BaseDeps {
  broker: Broker;
  notifier: Notifier;
  stateDir: string;
  logsDir: string;
  redactor: Redactor;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  echo?: boolean;
}
export async function buildDeps(args: CliArgs): Promise<BaseDeps & { warnings: string[] }> {
  const secrets = await loadSecrets(!args.fake);
  assertPaperOnly(process.env, secrets ?? undefined);
  const { stateDir, logsDir } = dirs(args);
  const fixedNow = args.now ? new Date(args.now) : null;
  if (fixedNow && Number.isNaN(fixedNow.getTime())) throw new Error(`--now non valido: ${args.now}`);
  const offset = fixedNow ? fixedNow.getTime() - Date.now() : 0;
  const now = () => new Date(Date.now() + offset);
  const redactor = new Redactor(secrets ? [secrets.alpacaKeyId, secrets.alpacaSecretKey, secrets.telegramBotToken] : []);
  const sleep = (ms: number) => Bun.sleep(ms);
  const warnings: string[] = [];
  const outbox = new FileNotifier(join(stateDir, "telegram-outbox.log"));

  if (args.fake) {
    return { broker: new FakeBroker(join(stateDir, "fake-broker.json"), now), notifier: outbox, stateDir, logsDir, redactor, now, sleep, warnings };
  }
  const s = secrets!;
  let notifier;
  if (s.telegramBotToken && s.telegramChatId) notifier = new TelegramNotifier(s.telegramBotToken, s.telegramChatId);
  else {
    notifier = outbox;
    warnings.push(`Telegram non configurato (manca token o chat id): i messaggi vanno in ${outbox.file}`);
  }
  return { broker: new AlpacaBroker(s.alpacaKeyId, s.alpacaSecretKey), notifier, stateDir, logsDir, redactor, now, sleep, warnings };
}
