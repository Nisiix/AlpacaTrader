// bun run schedule [--fake]: ogni 30 secondi guarda l'ora e lancia la sveglia dovuta, in un processo nuovo.
import { join } from "node:path";
import { SCHEDULE_GRACE_MIN, SCHEDULE_TICK_MS } from "../config.ts";
import { assertPaperOnly } from "../guard.ts";
import { ROOT, dirs, loadSecrets } from "../deps.ts";
import { dueSlot } from "../slots.ts";
import { readWitness } from "../witness.ts";
import { parseArgs } from "./args.ts";

const MAX_ATTEMPTS = 2;

const args = parseArgs(process.argv.slice(2));
if (args.now) throw new Error("--now non è supportato dallo scheduler");
assertPaperOnly(process.env, (await loadSecrets(!args.fake)) ?? undefined);
const { stateDir } = dirs(args);
const attempts = new Map<string, number>();

console.log(`scheduler avviato${args.fake ? " (finto)" : ""}: controllo ogni ${SCHEDULE_TICK_MS / 1000}s, stato in ${stateDir}`);

async function tick() {
  const due = dueSlot(new Date(), SCHEDULE_GRACE_MIN);
  if (!due) return;
  const w = readWitness(stateDir);
  const last = w.kind === "ok" ? w.value.sveglia : null;
  if (last && last >= due.runId) return;
  const n = attempts.get(due.runId) ?? 0;
  // Se la sveglia muore senza testimone la si rilancia una volta (riconcilia col lock), non all'infinito.
  if (n >= MAX_ATTEMPTS) return;
  attempts.set(due.runId, n + 1);
  console.log(`${new Date().toISOString()} lancio la sveglia ${due.runId} (tentativo ${n + 1})`);
  const cmd = ["bun", join(ROOT, "src/cli/once.ts"), "--slot", due.slot.time];
  if (args.fake) cmd.push("--fake");
  if (args.state) cmd.push("--state", args.state);
  if (args.logs) cmd.push("--logs", args.logs);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  console.log(`${new Date().toISOString()} sveglia ${due.runId} terminata con codice ${code}`);
}

while (true) {
  try {
    await tick();
  } catch (e) {
    console.error(`scheduler: ${(e as Error).message}`);
  }
  await Bun.sleep(SCHEDULE_TICK_MS);
}
