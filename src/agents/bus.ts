import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "../config.ts";
import { addDays } from "../slots.ts";

// Registro degli eventi: un file JSONL al giorno, una riga per ogni cosa che succede (prezzi, segnali, ordini,
// rifiuti, allarmi). È l'unica sorgente della dashboard e il modo di rivedere una giornata dopo.
export type EventKind = "tick" | "conto" | "prezzi" | "agente" | "contesto" | "segnale" | "rischio" | "allocazione" | "ordine" | "rifiuto" | "stop" | "trade" | "allarme" | "nota" | "simulazione" | "capo" | "attesa" | "caffe";

export interface BusEvent {
  t: string; // ISO
  tipo: EventKind;
  [k: string]: unknown;
}

export type Listener = (e: BusEvent) => void;

export const eventsDir = (stateDir: string) => join(stateDir, "events");

export class EventBus {
  private listeners = new Set<Listener>();
  constructor(
    private stateDir: string,
    private now: () => Date = () => new Date(),
  ) {}

  emit(tipo: EventKind, data: Record<string, unknown> = {}): BusEvent {
    const e: BusEvent = { t: this.now().toISOString(), tipo, ...data };
    try {
      mkdirSync(eventsDir(this.stateDir), { recursive: true });
      appendFileSync(join(eventsDir(this.stateDir), `${e.t.slice(0, 10)}.jsonl`), JSON.stringify(e) + "\n");
    } catch {
      // Il registro non deve mai fermare il motore: se il disco non scrive l'evento vive solo in memoria.
    }
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {}
    }
    return e;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // Elimina i file più vecchi di eventsKeepDays.
  prune(today: string) {
    const cut = addDays(today, -AGENTS.eventsKeepDays);
    try {
      for (const f of readdirSync(eventsDir(this.stateDir))) if (f.endsWith(".jsonl") && f.slice(0, 10) < cut) unlinkSync(join(eventsDir(this.stateDir), f));
    } catch {}
  }
}

export function readEvents(stateDir: string, day: string, limit = 500, kinds?: Set<string>): BusEvent[] {
  const p = join(eventsDir(stateDir), `${day}.jsonl`);
  if (!existsSync(p)) return [];
  const out: BusEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as BusEvent;
      if (!kinds || kinds.has(e.tipo)) out.push(e);
    } catch {}
  }
  return out.slice(-limit);
}

export function listEventDays(stateDir: string): string[] {
  try {
    return readdirSync(eventsDir(stateDir)).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, 10)).sort();
  } catch {
    return [];
  }
}
