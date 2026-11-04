// bun run cloud-wake: il comando unico delle sessioni cloud programmate.
// 1. prende lo stato dal branch `stato` del repo, 2. "prenota" la sveglia con un push (se due sessioni
// partono insieme, git ne fa vincere una sola), 3. aspetta l'orario, 4. lancia la sveglia in un processo
// nuovo, 5. salva lo stato sul branch appena il testimone è scritto, ogni 15 secondi e alla fine,
// anche se la sveglia muore o se questo processo riceve SIGTERM.
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describeClaim, judgeClaim, makeClaim } from "../claim.ts";
import { SCHEDULE_GRACE_MIN } from "../config.ts";
import { ROOT, loadSecrets } from "../deps.ts";
import { assertPaperOnly } from "../guard.ts";
import { pidAlive } from "../lock.ts";
import { Redactor } from "../log.ts";
import { alarmText } from "../report.ts";
import { TelegramNotifier } from "../telegram.ts";
import { nearbySlot } from "../slots.ts";

const BRANCH = "stato";
// CLOUD_WAKE_REPO e CLOUD_WAKE_GIT_TIMEOUT_MS servono solo ai test (un repo finto, timeout corti).
const REPO = process.env.CLOUD_WAKE_REPO ?? ROOT;
const WT = join(REPO, ".stato");
const EARLY_MIN = 45;
const SYNC_MS = 15_000;
// Un git che non risponde non deve mai bloccare tutto (il 3/11 un push appeso ha tenuto fermo il salvataggio fino al SIGTERM).
const GIT_TIMEOUT_MS = Number(process.env.CLOUD_WAKE_GIT_TIMEOUT_MS ?? 60_000);
// Dopo un SIGTERM chi ci ferma aspetta poco: tentativi brevi.
const QUICK_TIMEOUT_MS = Math.min(GIT_TIMEOUT_MS, 20_000);
const CHILD_GRACE_MS = 30_000;
const argv = process.argv.slice(2);
const force = argv.includes("--force");
// Solo per provarlo: --fake usa broker e cervello finti, --now (con --fake) finge l'ora e non aspetta.
const fake = argv.includes("--fake");
const nowArg = argv.includes("--now") ? argv[argv.indexOf("--now") + 1] : undefined;
if (nowArg && !fake) throw new Error("--now si usa solo con --fake");

interface GitResult {
  ok: boolean;
  out: string;
  timedOut: boolean;
}

async function git(args: string[], cwd = REPO, timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  const p = Bun.spawn(["git", "-c", "user.name=Agente Alpaca", "-c", "user.email=agente-alpaca@users.noreply.github.com", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const text = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  // Un figlio di git rimasto appeso (git-remote-https) può tenere aperte le pipe: non lo aspetto.
  const [o, e] = await Promise.race([text, Bun.sleep(2_000).then(() => ["", ""])]);
  const timedOut = p.exitCode === null;
  const out = (o + e).trim() + (timedOut ? ` (git ${args[0]} non ha risposto entro ${Math.round(timeout / 1000)} secondi: interrotto)` : "");
  return { ok: p.exitCode === 0, out, timedOut };
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

async function openStateBranch() {
  if (existsSync(join(WT, ".git"))) {
    // Stessa macchina di un tentativo precedente: tengo i suoi commit non ancora pubblicati e li metto sopra GitHub.
    const r = await git(["pull", "--rebase", "-q", "origin", BRANCH], WT);
    if (!r.ok) {
      await git(["rebase", "--abort"], WT);
      log(`ATTENZIONE: non riesco ad aggiornare il branch ${BRANCH} locale: ${clean(r.out)}`);
    }
    return;
  }
  const remote = (await git(["fetch", "-q", "origin", BRANCH])).ok;
  if (remote) {
    const r = await git(["worktree", "add", "-B", BRANCH, WT, `origin/${BRANCH}`]);
    if (!r.ok) throw new Error(`non riesco ad aprire il branch ${BRANCH}: ${r.out}`);
    return;
  }
  // Primo giro in assoluto: branch orfano, solo stato e log.
  const r = await git(["worktree", "add", "--detach", WT, "HEAD"]);
  if (!r.ok) throw new Error(`non riesco a creare il branch ${BRANCH}: ${r.out}`);
  await git(["checkout", "--orphan", BRANCH], WT);
  await git(["rm", "-rfq", "."], WT);
  writeFileSync(join(WT, "README.md"), "Stato dell'agente: testimone, lock, registro degli errori, interruttore, log. Lo scrive solo il programma.\n");
}

function ensureIgnore() {
  // I file temporanei delle scritture atomiche non vanno mai salvati a metà.
  const p = join(WT, ".gitignore");
  if (!existsSync(p)) writeFileSync(p, "*.tmp-*\n");
}

async function aheadOfRemote(): Promise<boolean> {
  const r = await git(["rev-list", "--count", `origin/${BRANCH}..HEAD`], WT);
  return !r.ok || Number(r.out) > 0;
}

// Salva lo stato. Se il push è rifiutato perché il branch è avanti, si rimette in coda e riprova.
// Ripubblica anche i commit rimasti indietro da un push fallito prima, anche se non c'è niente di nuovo.
let lastSyncError = "";
async function doSync(message: string, attempts: number, timeout: number): Promise<boolean> {
  await git(["add", "-A"], WT, timeout);
  if (!(await git(["diff", "--cached", "--quiet"], WT, timeout)).ok) await git(["commit", "-qm", message], WT, timeout);
  if (!(await aheadOfRemote())) return true;
  for (let i = 0; i < attempts; i++) {
    const push = await git(["push", "-q", "origin", `HEAD:${BRANCH}`], WT, timeout);
    if (push.ok) return true;
    lastSyncError = push.out;
    const pull = await git(["pull", "--rebase", "-q", "origin", BRANCH], WT, timeout);
    if (!pull.ok) await git(["rebase", "--abort"], WT, timeout);
  }
  log(`ATTENZIONE: push dello stato non riuscito, riprovo al prossimo salvataggio. Git dice: ${clean(lastSyncError)}`);
  return false;
}

// Un salvataggio alla volta: quelli chiesti nel frattempo aspettano in fila.
let queue: Promise<boolean> = Promise.resolve(true);
let syncBusy = false;
function sync(message: string, attempts = 4, timeout = GIT_TIMEOUT_MS): Promise<boolean> {
  const next = queue.then(async () => {
    syncBusy = true;
    try {
      return await doSync(message, attempts, timeout);
    } catch (e) {
      log(`ATTENZIONE: salvataggio dello stato fallito: ${clean((e as Error).message)}`);
      return false;
    } finally {
      syncBusy = false;
    }
  });
  queue = next;
  return next;
}

const me = { host: hostname(), pid: process.pid };
const claimFile = (runId: string) => join(WT, "claims", runId);

// Prenotazione: un file per sveglia, pubblicato con un push. Decide solo quello che c'è su GitHub:
// un file rimasto in locale da un tentativo morto non conta (era la causa della 18:30 del 3/11 saltata).
type ClaimResult = { kind: "claimed" } | { kind: "taken"; detail: string } | { kind: "unclaimed"; error: string };
async function claim(runId: string, slotAt: Date): Promise<ClaimResult> {
  const p = claimFile(runId);
  mkdirSync(join(WT, "claims"), { recursive: true });
  let error = "";
  for (let i = 0; i < 4; i++) {
    const fetch = await git(["fetch", "-q", "origin", BRANCH], WT);
    if (!fetch.ok) error = fetch.out;
    const remote = await git(["show", `origin/${BRANCH}:claims/${runId}`], WT);
    const verdict = judgeClaim(remote.ok ? remote.out : null, new Date(), me, pidAlive);
    if (verdict.kind === "taken" && !force) return { kind: "taken", detail: describeClaim(verdict.claim, verdict.ageMin) };
    if (verdict.kind === "mine") return { kind: "claimed" };
    if (verdict.kind === "stale") log(`prenotazione di ${runId} abbandonata (${describeClaim(verdict.claim, verdict.ageMin)}): ${verdict.why}. La riprendo io.`);
    if (verdict.kind === "taken" && force) log(`prenotazione di ${runId} già presa (${describeClaim(verdict.claim, verdict.ageMin)}), ma c'è --force: la riprendo io.`);
    // Tengo i commit locali non pubblicati (stato di un tentativo precedente), sopra quello che c'è su GitHub.
    const pull = await git(["pull", "--rebase", "-q", "origin", BRANCH], WT);
    if (!pull.ok) {
      await git(["rebase", "--abort"], WT);
      // Conflitto sul file di prenotazione: qualcuno l'ha appena presa. Mi allineo a GitHub e ricontrollo.
      if (fetch.ok) await git(["reset", "-q", "--hard", `origin/${BRANCH}`], WT);
    }
    writeFileSync(p, makeClaim(new Date(), slotAt, me.host, me.pid));
    await git(["add", "-A"], WT);
    await git(["commit", "-qm", `prenota ${runId}`], WT);
    const push = await git(["push", "-q", "origin", `HEAD:${BRANCH}`], WT);
    if (push.ok) return { kind: "claimed" };
    error = push.out;
  }
  return { kind: "unclaimed", error };
}

// Toglie la prenotazione: solo se la sveglia non è ancora partita, così un nuovo tentativo può prenderla.
async function release(runId: string): Promise<void> {
  rmSync(claimFile(runId), { force: true });
  await sync(`rilascia ${runId} (interrotta prima di partire)`, 1, QUICK_TIMEOUT_MS);
}

async function telegramAlarm(title: string, msg: string): Promise<void> {
  const secrets = fake ? null : await loadSecrets(false).catch(() => null);
  if (!secrets?.telegramBotToken || !secrets.telegramChatId) return;
  const redactor = new Redactor([secrets.alpacaKeyId, secrets.alpacaSecretKey, secrets.telegramBotToken]);
  const res = await new TelegramNotifier(secrets.telegramBotToken, secrets.telegramChatId).send(redactor.apply(alarmText(runId, title, msg)));
  if (!res.ok) console.error(`Telegram non ha ricevuto l'allarme: ${redactor.apply(res.error ?? "")}`);
}

let runId = "cloud";
let claimed = false;
let child: ReturnType<typeof Bun.spawn> | null = null;
let childDone = false;
let timer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

// SIGTERM (per esempio il timeout del comando nella sessione cloud): salvo subito quello che c'è,
// poi aspetto un po' la sveglia se sta ancora lavorando, e salvo di nuovo.
async function onSignal(sig: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  log(`ricevuto ${sig}: salvo lo stato prima di uscire`);
  if (claimed && !child) {
    await release(runId);
    log(`sveglia ${runId} interrotta prima di partire: prenotazione tolta, nessun ordine possibile`);
    process.exit(143);
  }
  let saved = await sync(`sveglia ${runId} interrotta (${sig})`, 1, QUICK_TIMEOUT_MS);
  if (child && !childDone) {
    log(`la sveglia ${runId} sta ancora lavorando: la aspetto al massimo ${CHILD_GRACE_MS / 1000} secondi`);
    await Promise.race([child.exited, Bun.sleep(CHILD_GRACE_MS)]);
    saved = await sync(`sveglia ${runId} interrotta (${sig})`, 1, QUICK_TIMEOUT_MS);
  }
  log(`uscita per ${sig}; stato ${saved ? "salvato" : "NON salvato"} sul branch ${BRANCH}`);
  process.exit(143);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void onSignal(sig));

try {
  assertPaperOnly(process.env, (await loadSecrets(!fake)) ?? undefined);
  const now = nowArg ? new Date(nowArg) : new Date();
  const target = nearbySlot(now, EARLY_MIN, SCHEDULE_GRACE_MIN);
  if (!target) {
    log("nessuna sveglia dovuta in questa finestra: esco senza fare niente");
    process.exit(0);
  }
  runId = target.runId;
  await openStateBranch();
  ensureIgnore();
  // L'orario della sveglia sull'orologio vero (con --now l'ora è finta, la prenotazione no).
  const c = await claim(target.runId, new Date(Date.now() + target.waitMin * 60_000));
  if (c.kind === "taken") {
    log(`la sveglia ${target.runId} è già stata presa da un'altra sessione (${c.detail}): mi fermo`);
    process.exit(0);
  }
  if (c.kind === "unclaimed") {
    // GitHub non risponde: vado avanti lo stesso. Due ordini uguali restano impossibili, perché l'id dell'ordine
    // è lo stesso per la stessa sveglia e Alpaca rifiuta il secondo; il lock della sveglia fa il resto.
    log(`ATTENZIONE: prenotazione di ${target.runId} non pubblicata (${clean(c.error)}). Vado avanti senza: gli ordini doppi li blocca l'id dell'ordine.`);
  }
  claimed = c.kind === "claimed";
  if (target.waitMin > 0 && !nowArg) {
    log(`sveglia ${target.runId}: aspetto ${target.waitMin} minuti`);
    const at = Date.now() + target.waitMin * 60_000;
    // Aspetta il minuto esatto della sveglia, non oltre.
    while (Date.now() < at) await Bun.sleep(Math.min(30_000, at - Date.now()));
  }
  if (stopping) await new Promise(() => {});
  const stateDir = join(WT, "state");
  mkdirSync(stateDir, { recursive: true });
  const args = ["bun", join(ROOT, "src/cli/once.ts"), "--slot", target.slot.time, "--state", stateDir, "--logs", join(WT, "logs")];
  if (force) args.push("--force");
  if (fake) args.push("--fake");
  if (nowArg) args.push("--now", new Date(new Date(nowArg).getTime() + Math.max(0, target.waitMin) * 60_000).toISOString());
  log(`lancio la sveglia ${target.runId}`);
  child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit", cwd: ROOT });
  // Il testimone appena scritto va su GitHub subito, prima del resoconto su Telegram e di tutto il resto.
  let witnessTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(stateDir, (_ev, file) => {
    if (file !== "witness.json" || witnessTimer) return;
    witnessTimer = setTimeout(() => {
      witnessTimer = null;
      void sync(`sveglia ${target.runId}: testimone scritto`);
    }, 300);
  });
  timer = setInterval(() => {
    if (!syncBusy) void sync(`sveglia ${target.runId} in corso`);
  }, SYNC_MS);
  const code = await child.exited;
  childDone = true;
  watcher.close();
  if (stopping) await new Promise(() => {}); // il gestore del segnale finisce il lavoro ed esce
  clearInterval(timer);
  const saved = await sync(`sveglia ${target.runId} finita (codice ${code})`);
  log(`sveglia ${target.runId} finita con codice ${code}; stato ${saved ? "salvato" : "NON salvato"} sul branch ${BRANCH}`);
  if (!saved) {
    await telegramAlarm(
      "Stato non salvato",
      `La sveglia è finita (codice ${code}) ma il push sul branch ${BRANCH} non è riuscito: la prossima sveglia la vedrà come saltata. Git dice: ${clean(lastSyncError)}`,
    );
  }
  process.exit(code === 0 && saved ? 0 : 1);
} catch (e) {
  const msg = clean((e as Error).message);
  console.error(`ERRORE: ${msg}`);
  // Se la sveglia non parte nemmeno, la sessione cloud non lo dice a nessuno: lo dice Telegram.
  await telegramAlarm("Sveglia non partita", msg);
  process.exit(2);
}
