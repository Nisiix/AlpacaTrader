// bun run cloud-wake: il comando unico delle sessioni cloud programmate.
// 1. prende lo stato dal branch `stato` del repo, 2. "prenota" la sveglia con un push (se due sessioni
// partono insieme, git ne fa vincere una sola), 3. aspetta l'orario, 4. lancia la sveglia in un processo
// nuovo, 5. salva lo stato sul branch ogni 15 secondi e alla fine, anche se la sveglia muore.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_GRACE_MIN, SLOTS } from "../config.ts";
import { ROOT, loadSecrets } from "../deps.ts";
import { assertPaperOnly } from "../guard.ts";
import { Redactor } from "../log.ts";
import { alarmText } from "../report.ts";
import { TelegramNotifier } from "../telegram.ts";
import { nearbySlot, romeTime, runIdFor } from "../slots.ts";

const BRANCH = "stato";
const WT = join(ROOT, ".stato");
const EARLY_MIN = 45;
const SYNC_MS = 15_000;
const argv = process.argv.slice(2);
// PROVA (temporaneo): se nel repo c'è il file PROVA e non c'è una sveglia dovuta, fa un briefing adesso.
// Il briefing non manda mai ordini: legge il conto, salva lo stato sul branch e scrive su Telegram.
const prova = existsSync(join(ROOT, "PROVA"));
let force = argv.includes("--force");
// Solo per provarlo: --fake usa broker e cervello finti, --now (con --fake) finge l'ora e non aspetta.
const fake = argv.includes("--fake");
const nowArg = argv.includes("--now") ? argv[argv.indexOf("--now") + 1] : undefined;
if (nowArg && !fake) throw new Error("--now si usa solo con --fake");

function git(args: string[], cwd = ROOT): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-c", "user.name=Agente Alpaca", "-c", "user.email=agente-alpaca@users.noreply.github.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

// Gli errori di git possono contenere l'URL del remote con il token dentro.
function clean(out: string): string {
  const token = process.env.GITHUB_TOKEN;
  const masked = token ? out.split(token).join("***") : out;
  return masked.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@").slice(-400);
}

function log(msg: string) {
  console.log(`${new Date().toISOString()} [cloud] ${msg}`);
}

function openStateBranch() {
  if (existsSync(join(WT, ".git"))) {
    git(["pull", "--rebase", "origin", BRANCH], WT);
    return;
  }
  const remote = git(["fetch", "origin", BRANCH]).ok;
  if (remote) {
    const r = git(["worktree", "add", "-B", BRANCH, WT, `origin/${BRANCH}`]);
    if (!r.ok) throw new Error(`non riesco ad aprire il branch ${BRANCH}: ${r.out}`);
    return;
  }
  // Primo giro in assoluto: branch orfano, solo stato e log.
  const r = git(["worktree", "add", "--detach", WT, "HEAD"]);
  if (!r.ok) throw new Error(`non riesco a creare il branch ${BRANCH}: ${r.out}`);
  git(["checkout", "--orphan", BRANCH], WT);
  git(["rm", "-rfq", "."], WT);
  writeFileSync(join(WT, "README.md"), "Stato dell'agente: testimone, lock, registro degli errori, interruttore, log. Lo scrive solo il programma.\n");
}

function ensureIgnore() {
  // I file temporanei delle scritture atomiche non vanno mai salvati a metà.
  const p = join(WT, ".gitignore");
  if (!existsSync(p)) writeFileSync(p, "*.tmp-*\n");
}

// Salva lo stato. Se il push è rifiutato perché il branch è avanti, si rimette in coda e riprova.
function sync(message: string): boolean {
  git(["add", "-A"], WT);
  if (git(["diff", "--cached", "--quiet"], WT).ok) return true;
  git(["commit", "-qm", message], WT);
  for (let i = 0; i < 4; i++) {
    if (git(["push", "-q", "origin", `HEAD:${BRANCH}`], WT).ok) return true;
    git(["pull", "--rebase", "-q", "origin", BRANCH], WT);
  }
  log("ATTENZIONE: push dello stato non riuscito, riprovo al prossimo salvataggio");
  return false;
}

// Prenotazione: un file per sveglia, pubblicato con un push. Chi arriva secondo trova il file e si ferma.
let lastPushError = "";
function claim(runId: string): boolean {
  const dir = join(WT, "claims");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, runId);
  for (let i = 0; i < 4; i++) {
    git(["pull", "--rebase", "-q", "origin", BRANCH], WT);
    if (existsSync(p) && !force) return false;
    writeFileSync(p, `${new Date().toISOString()}\n`);
    git(["add", "-A"], WT);
    git(["commit", "-qm", `prenota ${runId}`], WT);
    const push = git(["push", "-q", "origin", `HEAD:${BRANCH}`], WT);
    if (push.ok) return true;
    lastPushError = push.out;
    git(["reset", "-q", "--hard", `origin/${BRANCH}`], WT);
  }
  throw new Error(`non riesco a prenotare la sveglia: push sul branch ${BRANCH} rifiutato più volte. Git dice: ${clean(lastPushError)}`);
}

let runId = "cloud";
// PROVA (temporaneo): controlla se le API di GitHub sono raggiungibili con il token.
if (prova && process.env.GITHUB_TOKEN) {
  const h = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "user-agent": "agente-alpaca" };
  for (const url of ["https://api.github.com/repos/Nisiix/AlpacaTrader", "https://api.github.com/repos/Nisiix/AlpacaTrader/git/ref/heads/main", "https://codeload.github.com/Nisiix/AlpacaTrader/tar.gz/main"]) {
    try {
      const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(15_000) });
      const body = await r.text();
      const push = body.match(/"push":\s*(true|false)/)?.[1];
      log(`sonda ${url.replace(/^https:\/\//, "")}: ${r.status}${push ? ` push=${push}` : ""}`);
    } catch (e) {
      log(`sonda ${url}: errore ${(e as Error).name}`);
    }
  }
}
try {
  assertPaperOnly(process.env, (await loadSecrets(!fake)) ?? undefined);
  const now = nowArg ? new Date(nowArg) : new Date();
  let target = nearbySlot(now, EARLY_MIN, SCHEDULE_GRACE_MIN);
  if (!target && prova) {
    const slot = SLOTS[0]!;
    target = { runId: runIdFor(romeTime(now).date, slot), slot, waitMin: 0 };
    force = true;
    log(`file PROVA presente: sveglia di prova ${target.runId} (briefing, nessun ordine)`);
  }
  if (!target) {
    log("nessuna sveglia dovuta in questa finestra: esco senza fare niente");
    process.exit(0);
  }
  runId = target.runId;
  openStateBranch();
  ensureIgnore();
  if (!claim(target.runId)) {
    log(`la sveglia ${target.runId} è già stata presa da un'altra sessione: mi fermo`);
    process.exit(0);
  }
  if (target.waitMin > 0 && !nowArg) {
    log(`sveglia ${target.runId}: aspetto ${target.waitMin} minuti`);
    const at = Date.now() + target.waitMin * 60_000;
    // Aspetta il minuto esatto della sveglia, non oltre.
    while (Date.now() < at) await Bun.sleep(Math.min(30_000, at - Date.now()));
  }
  const args = ["bun", join(ROOT, "src/cli/once.ts"), "--slot", target.slot.time, "--state", join(WT, "state"), "--logs", join(WT, "logs")];
  if (force) args.push("--force");
  if (fake) args.push("--fake");
  if (nowArg) args.push("--now", new Date(new Date(nowArg).getTime() + Math.max(0, target.waitMin) * 60_000).toISOString());
  log(`lancio la sveglia ${target.runId}`);
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit", cwd: ROOT });
  const timer = setInterval(() => sync(`sveglia ${target.runId} in corso`), SYNC_MS);
  const code = await child.exited;
  clearInterval(timer);
  const saved = sync(`sveglia ${target.runId} finita (codice ${code})`);
  log(`sveglia ${target.runId} finita con codice ${code}; stato ${saved ? "salvato" : "NON salvato"} sul branch ${BRANCH}`);
  process.exit(code === 0 && saved ? 0 : 1);
} catch (e) {
  const msg = clean((e as Error).message);
  console.error(`ERRORE: ${msg}`);
  // Se la sveglia non parte nemmeno, la sessione cloud non lo dice a nessuno: lo dice Telegram.
  const secrets = fake ? null : await loadSecrets(false).catch(() => null);
  if (secrets?.telegramBotToken && secrets.telegramChatId) {
    const redactor = new Redactor([secrets.alpacaKeyId, secrets.alpacaSecretKey, secrets.telegramBotToken]);
    const res = await new TelegramNotifier(secrets.telegramBotToken, secrets.telegramChatId).send(redactor.apply(alarmText(runId, "Sveglia non partita", msg)));
    if (!res.ok) console.error(`Telegram non ha ricevuto l'allarme: ${redactor.apply(res.error ?? "")}`);
  }
  process.exit(2);
}
