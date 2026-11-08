import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentCardsWithValues } from "./agent-settings.ts";
import { barsPath, forecastsPath, statusPath } from "./agents/engine.ts";
import { listEventDays, readEvents } from "./agents/bus.ts";
import { AGENTS } from "./config.ts";

// Pubblicazione su GitHub Pages: ogni N minuti il motore scrive un'istantanea in sola lettura (pagina + data/*.json,
// niente chiavi né secrets) nella cartella .pages/ e la spinge sul ramo gh-pages con il git del PC. La pagina, aperta da
// github.io, legge i JSON invece delle API locali. Spenta di serie: i dati del conto diventano visibili a chi ha il link.
export interface PagesResult {
  ok: boolean;
  messaggio: string;
}

const readJsonSafe = (p: string) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

export function buildSnapshot(root: string, stateDir: string, outDir: string) {
  const data = join(outDir, "data");
  mkdirSync(join(outDir, "vendor", "addons", "controls"), { recursive: true });
  mkdirSync(join(outDir, "vendor", "addons", "renderers"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const html = readFileSync(join(root, "src", "dashboard", "index.html"), "utf8").replace("<script>\n// Modalità statica", "<script>window.__STATIC__ = true;</script>\n<script>\n// Modalità statica");
  writeFileSync(join(outDir, "index.html"), html);
  writeFileSync(join(outDir, ".nojekyll"), "");
  const three = join(Bun.resolveSync("three/package.json", join(root, "src")), "..");
  copyFileSync(join(three, "build", "three.module.js"), join(outDir, "vendor", "three.module.js"));
  copyFileSync(join(three, "examples", "jsm", "controls", "OrbitControls.js"), join(outDir, "vendor", "addons", "controls", "OrbitControls.js"));
  copyFileSync(join(three, "examples", "jsm", "renderers", "CSS2DRenderer.js"), join(outDir, "vendor", "addons", "renderers", "CSS2DRenderer.js"));
  writeFileSync(join(data, "status.json"), JSON.stringify(readJsonSafe(statusPath(stateDir)) ?? { versione: 0, nota: "nessuno stato" }));
  const days = listEventDays(stateDir);
  const day = days.at(-1) ?? "";
  writeFileSync(join(data, "events.json"), JSON.stringify({ giorno: day, giorni: days, eventi: day ? readEvents(stateDir, day, 400) : [] }));
  const bars = readJsonSafe(barsPath(stateDir));
  writeFileSync(join(data, "bars.json"), JSON.stringify(bars ? { aggiornato: bars.aggiornato, barre: Object.fromEntries(Object.entries(bars.barre ?? {}).map(([k, v]) => [k, (v as unknown[]).slice(-150)])) } : { aggiornato: null, barre: {} }));
  writeFileSync(join(data, "previsioni.json"), JSON.stringify(readJsonSafe(forecastsPath(stateDir)) ?? { previsioni: {} }));
  writeFileSync(join(data, "journal.json"), JSON.stringify(readJsonSafe(join(stateDir, "journal.json")) ?? { trade: [] }));
  writeFileSync(join(data, "schede.json"), JSON.stringify({ schede: agentCardsWithValues(stateDir) }));
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).trim() };
}

export async function publishPages(root: string, stateDir: string): Promise<PagesResult> {
  const cfg = AGENTS.pages;
  const outDir = join(root, ".pages");
  try {
    buildSnapshot(root, stateDir, outDir);
  } catch (e) {
    return { ok: false, messaggio: `istantanea non scritta: ${(e as Error).message}` };
  }
  const remote = cfg.remote || (await git(root, ["remote", "get-url", "origin"])).out.split("\n")[0]!;
  if (!existsSync(join(outDir, ".git"))) {
    await git(outDir, ["init", "-q"]);
    await git(outDir, ["checkout", "-q", "-b", cfg.branch]);
    await git(outDir, ["remote", "add", "origin", remote]);
  } else await git(outDir, ["remote", "set-url", "origin", remote]);
  await git(outDir, ["add", "-A"]);
  const c = await git(outDir, ["-c", "user.name=Agenti Alpaca", "-c", "user.email=agenti@localhost", "commit", "-q", "-m", `istantanea ${new Date().toISOString()}`]);
  if (c.code !== 0 && !/nothing to commit/i.test(c.out)) return { ok: false, messaggio: `commit fallito: ${c.out.slice(0, 200)}` };
  const p = await git(outDir, ["push", "-q", "-f", "origin", `HEAD:${cfg.branch}`]);
  return p.code === 0 ? { ok: true, messaggio: `pubblicata su ${cfg.branch}` } : { ok: false, messaggio: `push fallito (credenziali GitHub del PC?): ${p.out.slice(0, 200)}` };
}
