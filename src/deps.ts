import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeBrain } from "./brain/claude.ts";
import { FakeBrain } from "./brain/fake.ts";
import { AlpacaBroker } from "./broker/alpaca.ts";
import { FakeBroker } from "./broker/fake.ts";
import type { CliArgs } from "./cli/args.ts";
import { assertPaperOnly } from "./guard.ts";
import { Redactor } from "./log.ts";
import type { Secrets } from "./secrets-types.ts";
import { FileNotifier, TelegramNotifier } from "./telegram.ts";
import type { WakeDeps } from "./wake.ts";

export const ROOT = resolve(import.meta.dir, "..");

export async function loadSecrets(required: boolean): Promise<Secrets | null> {
  const p = join(ROOT, "secrets.ts");
  if (!existsSync(p)) {
    if (required) throw new Error("secrets.ts non esiste: copia secrets.example.ts in secrets.ts e riempi i campi");
    return null;
  }
  return (await import(p)).secrets as Secrets;
}

export function dirs(args: CliArgs) {
  // Il finto vive in cartelle sue: un testimone finto non deve mai confondere la sveglia vera.
  const stateDir = resolve(args.state ?? join(ROOT, args.fake ? "state/fake" : "state"));
  const logsDir = resolve(args.logs ?? join(ROOT, args.fake ? "logs/fake" : "logs"));
  return { stateDir, logsDir };
}

export async function buildDeps(args: CliArgs): Promise<WakeDeps & { warnings: string[] }> {
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
    return { broker: new FakeBroker(join(stateDir, "fake-broker.json"), now), brain: new FakeBrain(), notifier: outbox, stateDir, logsDir, redactor, now, sleep, warnings };
  }
  const s = secrets!;
  let notifier;
  if (s.telegramBotToken && s.telegramChatId) notifier = new TelegramNotifier(s.telegramBotToken, s.telegramChatId);
  else {
    notifier = outbox;
    warnings.push(`Telegram non configurato (manca token o chat id): i messaggi vanno in ${outbox.file}`);
  }
  return { broker: new AlpacaBroker(s.alpacaKeyId, s.alpacaSecretKey), brain: new ClaudeBrain(), notifier, stateDir, logsDir, redactor, now, sleep, warnings };
}
