import { TIMEZONE } from "./config.ts";

// Ora di Roma e giorni di calendario/borsa: il motore ragiona in ora italiana (diario, riepilogo, limiti del giorno).
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

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function isTradingWeekday(date: string): boolean {
  const w = weekdayOf(date);
  return w >= 1 && w <= 5;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// N giorni feriali dopo `date`. Le festività contano come giorni di borsa, quindi in quelle settimane il blocco dura un giorno di borsa in meno.
export function addTradingDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; ) {
    d = addDays(d, 1);
    if (isTradingWeekday(d)) i++;
  }
  return d;
}
