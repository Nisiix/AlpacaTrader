import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { LOCK_MAX_AGE_MS } from "./config.ts";
import { isObject, writeJsonAtomic } from "./fsutil.ts";

export interface IntendedOrder {
  clientOrderId: string;
  symbol: string;
  side: string;
  qty: number;
}

export interface LockData {
  runId: string;
  pid: number;
  host?: string; // nel cloud il lock viaggia tra macchine diverse: il PID vale solo sulla stessa
  startedAt: string;
  intended: IntendedOrder[];
  // Lock di sveglie morte che questa sveglia sta ancora riconciliando: se muore anche lei, la prossima li ritrova qui.
  inherited?: LockData[];
}

export const lockPath = (stateDir: string) => join(stateDir, "run.lock");

export type ExistingLock =
  | { kind: "none" }
  | { kind: "alive"; data: LockData }
  | { kind: "stale"; data: LockData | null; raw: string; claimedPath: string };

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLock(raw: string): LockData | null {
  try {
    const v = JSON.parse(raw);
    if (isObject(v) && typeof v.runId === "string" && typeof v.pid === "number" && Array.isArray(v.intended)) return v as unknown as LockData;
  } catch {}
  return null;
}

// Guarda il lock esistente. Se è di una sveglia morta lo "reclama" con un rename atomico:
// se due sveglie lo trovano insieme, solo una riesce e solo quella riconcilia.
export function inspectLock(stateDir: string, now: Date, selfPid = process.pid): ExistingLock {
  const p = lockPath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { kind: "none" };
  }
  const data = parseLock(raw);
  const young = data !== null && now.getTime() - Date.parse(data.startedAt) < LOCK_MAX_AGE_MS;
  const sameHost = !data?.host || data.host === hostname();
  // Su un'altra macchina non posso controllare il PID: se è giovane lo considero vivo, per prudenza.
  if (data && young && (sameHost ? data.pid !== selfPid && pidAlive(data.pid) : true)) {
    return { kind: "alive", data };
  }
  // Un lock appena creato da un'altra sveglia può essere ancora vuoto: non è morto, è giovane.
  if (!data && raw.trim() === "") return { kind: "alive", data: { runId: "?", pid: -1, startedAt: now.toISOString(), intended: [] } };
  const claimedPath = `${p}.stale-${selfPid}-${now.getTime()}`;
  try {
    renameSync(p, claimedPath);
  } catch {
    // Qualcun altro l'ha già reclamato.
    return { kind: "alive", data: data ?? { runId: "?", pid: -1, startedAt: now.toISOString(), intended: [] } };
  }
  return { kind: "stale", data, raw, claimedPath };
}

// Lock reclamati da una sveglia morta prima di riuscire a creare il proprio lock.
export function findOrphanClaims(stateDir: string, selfPid = process.pid): { path: string; data: LockData | null }[] {
  let files: string[];
  try {
    files = readdirSync(stateDir);
  } catch {
    return [];
  }
  const out: { path: string; data: LockData | null }[] = [];
  for (const f of files) {
    const m = f.match(/^run\.lock\.stale-(\d+)-\d+$/);
    if (!m || Number(m[1]) === selfPid || pidAlive(Number(m[1]))) continue;
    const path = join(stateDir, f);
    try {
      out.push({ path, data: parseLock(readFileSync(path, "utf8")) });
    } catch {}
  }
  return out;
}

// Una sveglia morta e tutte quelle che lei stessa stava ancora riconciliando.
export function flattenLock(l: LockData): LockData[] {
  const { inherited, ...own } = l;
  return [own, ...(inherited ?? []).flatMap(flattenLock)];
}

// Creazione esclusiva: se il file esiste già, un'altra sveglia è partita nello stesso istante.
export function acquireLock(stateDir: string, data: LockData): boolean {
  mkdirSync(stateDir, { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath(stateDir), "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Le intenzioni vanno nel lock PRIMA di inviare: se moriamo a metà, la sveglia dopo sa cosa cercare.
export function updateLock(stateDir: string, data: LockData) {
  writeJsonAtomic(lockPath(stateDir), data);
}

export function releaseLock(stateDir: string) {
  try {
    unlinkSync(lockPath(stateDir));
  } catch {}
}

export function readLockForStatus(stateDir: string): { raw: string; data: LockData | null } | null {
  const p = lockPath(stateDir);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return { raw, data: parseLock(raw) };
}
