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
  host?: string; // il PID vale solo sulla stessa macchina
  startedAt: string;
  intended: IntendedOrder[];
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

// Guarda il lock esistente. Se è di un processo morto lo "reclama" con un rename atomico:
// se due processi lo trovano insieme, solo uno riesce.
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
  // Un lock appena creato da un altro processo può essere ancora vuoto: non è morto, è giovane.
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



// Creazione esclusiva: se il file esiste già, un altro processo è partito nello stesso istante.
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


export function releaseLock(stateDir: string) {
  try {
    unlinkSync(lockPath(stateDir));
  } catch {}
}

