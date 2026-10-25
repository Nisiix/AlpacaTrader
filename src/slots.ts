import { SLOTS, TIMEZONE, type SlotDef } from "./config.ts";

export interface RomeTime {
  date: string; // YYYY-MM-DD
  minutes: number; // minuti dalla mezzanotte, ora di Roma
  weekday: number; // 0 domenica ... 6 sabato
}

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function romeTime(d: Date): RomeTime {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday!),
  };
}

export function slotMinutes(s: SlotDef): number {
  const [h, m] = s.time.split(":").map(Number);
  return h! * 60 + m!;
}

export function runIdFor(date: string, slot: SlotDef): string {
  return `${date}-${slot.time.replace(":", "-")}`;
}

export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/;

export function parseRunId(runId: string): { date: string; slot: SlotDef } | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const date = runId.slice(0, 10);
  const time = runId.slice(11).replace("-", ":");
  const slot = SLOTS.find((s) => s.time === time);
  return slot ? { date, slot } : null;
}

export function findSlot(time: string): SlotDef | null {
  return SLOTS.find((s) => s.time === time) ?? null;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function isTradingWeekday(date: string): boolean {
  const w = weekdayOf(date);
  return w >= 1 && w <= 5;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// La sveglia più recente di oggi già arrivata (per `once`).
export function latestSlotToday(now: Date): { runId: string; slot: SlotDef } | null {
  const rt = romeTime(now);
  if (!isTradingWeekday(rt.date)) return null;
  const past = SLOTS.filter((s) => slotMinutes(s) <= rt.minutes);
  const slot = past[past.length - 1];
  return slot ? { runId: runIdFor(rt.date, slot), slot } : null;
}

// La sveglia dovuta adesso per lo scheduler: arrivata da non più di `graceMin` minuti.
export function dueSlot(now: Date, graceMin: number): { runId: string; slot: SlotDef } | null {
  const latest = latestSlotToday(now);
  if (!latest) return null;
  const late = romeTime(now).minutes - slotMinutes(latest.slot);
  return late <= graceMin ? latest : null;
}

// Minuti trascorsi tra l'orario della sveglia e adesso (negativo se la sveglia è nel futuro).
export function latenessMinutes(runId: string, now: Date): number {
  const p = parseRunId(runId)!;
  const rt = romeTime(now);
  const dayDiff = Math.round((Date.parse(`${rt.date}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86_400_000);
  return dayDiff * 1440 + rt.minutes - slotMinutes(p.slot);
}

// Tutte le sveglie (giorni feriali) strettamente tra `prev` e `current`.
export function missedSlots(prev: string, current: string, maxDays = 31): string[] {
  const a = parseRunId(prev);
  const b = parseRunId(current);
  if (!a || !b || prev >= current) return [];
  const out: string[] = [];
  let date = a.date;
  for (let i = 0; i <= maxDays && date <= b.date; i++, date = addDays(date, 1)) {
    if (!isTradingWeekday(date)) continue;
    for (const s of SLOTS) {
      const id = runIdFor(date, s);
      if (id > prev && id < current) out.push(id);
    }
  }
  return out;
}

export function nextSlotAfter(runId: string): string {
  const p = parseRunId(runId)!;
  const idx = SLOTS.indexOf(p.slot);
  if (idx < SLOTS.length - 1) return runIdFor(p.date, SLOTS[idx + 1]!);
  let date = addDays(p.date, 1);
  while (!isTradingWeekday(date)) date = addDays(date, 1);
  return runIdFor(date, SLOTS[0]!);
}

export function describeRunId(runId: string): string {
  const p = parseRunId(runId);
  if (!p) return runId;
  return `${p.date} ${p.slot.time} (${p.slot.label})`;
}
