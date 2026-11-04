// Le sveglie cloud contro un GitHub finto (un repo bare locale): prenotazioni rimaste a metà, scadute o vive,
// push che non rispondono, SIGTERM a metà lavoro. Broker e cervello finti.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { judgeClaim, makeClaim, parseClaim } from "../src/claim.ts";

const ROOT = join(import.meta.dir, "..");
const SLOT = "2026-09-24-18-30";
const NOW = "2026-09-24T16:30:20Z"; // 18:30:20 a Roma, giovedì

function sh(args: string[], cwd: string) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const g = (cwd: string, ...a: string[]) => sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], cwd);

// remote.git con un branch `stato` minimo, e un clone che fa da "repo della sessione".
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cloud-wake-"));
  const remote = join(dir, "remote.git");
  sh(["git", "init", "-q", "--bare", remote], dir);
  const seed = join(dir, "seed");
  sh(["git", "init", "-q", "-b", "stato", seed], dir);
  writeFileSync(join(seed, "README.md"), "stato\n");
  writeFileSync(join(seed, ".gitignore"), "*.tmp-*\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-qm", "inizio");
  g(seed, "remote", "add", "origin", remote);
  g(seed, "push", "-q", "origin", "stato");
  const repo = join(dir, "repo");
  sh(["git", "clone", "-q", remote, repo], dir);
  return { dir, remote, seed, repo };
}

// Una prenotazione scritta da un'altra sessione direttamente su GitHub.
function remoteClaim(env: ReturnType<typeof setup>, content: string) {
  g(env.seed, "pull", "-q", "origin", "stato");
  sh(["mkdir", "-p", "claims"], env.seed);
  writeFileSync(join(env.seed, "claims", SLOT), content);
  g(env.seed, "add", "-A");
  g(env.seed, "commit", "-qm", "prenota da un'altra sessione");
  g(env.seed, "push", "-q", "origin", "stato");
}

const remoteFile = (env: ReturnType<typeof setup>, path: string): string | null => {
  const r = Bun.spawnSync(["git", "show", `stato:${path}`], { cwd: env.remote, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
};

const wakeArgs = ["bun", join(ROOT, "src/cli/cloud-wake.ts"), "--fake", "--now", NOW];
const wakeEnv = (env: ReturnType<typeof setup>, timeoutMs = 20_000) => ({ ...process.env, CLOUD_WAKE_REPO: env.repo, CLOUD_WAKE_GIT_TIMEOUT_MS: String(timeoutMs) });

function runWakeSync(env: ReturnType<typeof setup>, timeoutMs?: number) {
  const r = Bun.spawnSync(wakeArgs, { cwd: ROOT, env: wakeEnv(env, timeoutMs), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("prenotazione: chi decide", () => {
  const me = { host: "io", pid: 100 };
  const now = new Date("2026-11-03T17:34:00Z");
  const slot = new Date("2026-11-03T17:30:00Z");
  test("nessun file su GitHub: libera", () => {
    expect(judgeClaim(null, now, me, () => true).kind).toBe("free");
  });
  test("presa da un'altra macchina e ancora valida: presa", () => {
    const v = judgeClaim(makeClaim(now, slot, "altra", 5), new Date(now.getTime() + 5 * 60_000), me, () => true);
    expect(v.kind).toBe("taken");
  });
  test("scade 20 minuti dopo l'orario della sveglia, non dopo la presa", () => {
    const early = new Date("2026-11-03T16:50:00Z"); // presa 40 minuti prima della sveglia
    const c = makeClaim(early, slot, "altra", 5);
    expect(judgeClaim(c, new Date("2026-11-03T17:45:00Z"), me, () => true).kind).toBe("taken");
    expect(judgeClaim(c, new Date("2026-11-03T17:51:00Z"), me, () => true).kind).toBe("stale");
  });
  test("stessa macchina, processo morto: abbandonata; processo vivo: presa", () => {
    const c = makeClaim(now, slot, "io", 7);
    expect(judgeClaim(c, now, me, () => false).kind).toBe("stale");
    expect(judgeClaim(c, now, me, () => true).kind).toBe("taken");
    expect(judgeClaim(makeClaim(now, slot, "io", 100), now, me, () => true).kind).toBe("mine");
  });
  test("formato vecchio (solo la data) e file illeggibile", () => {
    expect(parseClaim("2026-11-03T17:33:00.000Z\n")?.host).toBeNull();
    expect(judgeClaim("2026-11-03T17:33:00.000Z\n", now, me, () => true).kind).toBe("taken");
    expect(judgeClaim("2026-11-03T17:00:00.000Z\n", now, me, () => true).kind).toBe("stale");
    expect(judgeClaim("{rott", now, me, () => true).kind).toBe("stale");
  });
});

describe("sveglia cloud contro un GitHub finto", () => {
  test("3/11 18:30: una prenotazione rimasta solo in locale non ferma più la sveglia", () => {
    const env = setup();
    // Un tentativo precedente sulla stessa macchina ha scritto e committato la prenotazione ma non l'ha mai pubblicata.
    g(env.repo, "worktree", "add", "-q", "-B", "stato", join(env.repo, ".stato"), "origin/stato");
    sh(["mkdir", "-p", "claims"], join(env.repo, ".stato"));
    writeFileSync(join(env.repo, ".stato", "claims", SLOT), `${new Date().toISOString()}\n`);
    g(join(env.repo, ".stato"), "add", "-A");
    g(join(env.repo, ".stato"), "commit", "-qm", `prenota ${SLOT}`);
    const r = runWakeSync(env);
    expect(r.out).not.toContain("già stata presa");
    expect(r.code).toBe(0);
    expect(JSON.parse(remoteFile(env, "state/witness.json")!).sveglia).toBe(SLOT);
    expect(parseClaim(remoteFile(env, `claims/${SLOT}`)!)?.host).toBe(hostname());
    rmSync(env.dir, { recursive: true, force: true });
  }, 60_000);

  test("prenotazione viva di un'altra sessione su GitHub: si ferma e dice chi e quando", () => {
    const env = setup();
    remoteClaim(env, makeClaim(new Date(), new Date(Date.now() + 5 * 60_000), "altra-macchina", 42));
    const r = runWakeSync(env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("già stata presa da un'altra sessione (macchina altra-macchina, pid 42, 0 minuti fa)");
    expect(remoteFile(env, "state/witness.json")).toBeNull();
    rmSync(env.dir, { recursive: true, force: true });
  }, 60_000);

  test("prenotazione scaduta su GitHub: lo dice e la riprende", () => {
    const env = setup();
    const old = new Date(Date.now() - 60 * 60_000);
    remoteClaim(env, makeClaim(old, old, "altra-macchina", 42));
    const r = runWakeSync(env);
    expect(r.out).toContain(`prenotazione di ${SLOT} abbandonata`);
    expect(r.out).toContain("La riprendo io");
    expect(r.code).toBe(0);
    expect(JSON.parse(remoteFile(env, "state/witness.json")!).sveglia).toBe(SLOT);
    rmSync(env.dir, { recursive: true, force: true });
  }, 60_000);

  test("GitHub non risponde ai push: niente blocco, la sveglia lavora lo stesso, e al giro dopo lo stato arriva", () => {
    const env = setup();
    const hook = join(env.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nsleep 30\n");
    chmodSync(hook, 0o755);
    const t = Date.now();
    const r = runWakeSync(env, 1_500);
    expect(Date.now() - t).toBeLessThan(45_000);
    expect(r.out).toContain("non ha risposto entro 2 secondi");
    expect(r.out).toContain("Vado avanti senza");
    expect(r.out).toContain("[done]");
    expect(r.code).toBe(1); // stato non salvato: lo dice
    expect(remoteFile(env, "state/witness.json")).toBeNull();
    // GitHub torna: il tentativo dopo sulla stessa macchina pubblica lo stato rimasto indietro, senza rifare la sveglia.
    rmSync(hook);
    const r2 = runWakeSync(env);
    expect(r2.out).toContain("già stata fatta");
    expect(r2.code).toBe(0);
    expect(JSON.parse(remoteFile(env, "state/witness.json")!).sveglia).toBe(SLOT);
    rmSync(env.dir, { recursive: true, force: true });
  }, 120_000);

  test("SIGTERM mentre la sveglia lavora (3/11 21:40): il testimone arriva lo stesso su GitHub", async () => {
    const env = setup();
    const p = Bun.spawn(wakeArgs, { cwd: ROOT, env: wakeEnv(env), stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let out = "";
    while (!out.includes("lancio la sveglia")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    p.kill("SIGTERM");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(await p.exited).toBe(143);
    expect(out).toContain("ricevuto SIGTERM: salvo lo stato prima di uscire");
    expect(out).toMatch(/uscita per SIGTERM; stato salvato/);
    expect(JSON.parse(remoteFile(env, "state/witness.json")!).sveglia).toBe(SLOT);
    rmSync(env.dir, { recursive: true, force: true });
  }, 60_000);
});
