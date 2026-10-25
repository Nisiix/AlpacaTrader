import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// Scrittura atomica: file temporaneo nella stessa cartella, fsync, poi rename.
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export type ReadResult<T> = { kind: "missing" } | { kind: "corrupt"; error: string } | { kind: "ok"; value: T };

export function readJson<T>(path: string, validate: (v: unknown) => v is T): ReadResult<T> {
  if (!existsSync(path)) return { kind: "missing" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { kind: "corrupt", error: String(e) };
  }
  try {
    const v = JSON.parse(raw);
    if (!validate(v)) return { kind: "corrupt", error: "struttura non valida" };
    return { kind: "ok", value: v };
  } catch (e) {
    return { kind: "corrupt", error: (e as Error).message };
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
