// La prenotazione di una sveglia cloud (claims/<runId> sul branch `stato`): chi l'ha presa, quando, e se vale ancora.
// Conta solo quella che è arrivata davvero su GitHub: un file rimasto in locale da un tentativo morto non ferma nessuno.
import { CLAIM_TTL_MIN } from "./config.ts";

export interface Claim {
  presaAlle: string;
  scadeAlle: string;
  host: string | null; // null: prenotazione del formato vecchio (solo la data)
  pid: number | null;
}

export type ClaimVerdict =
  | { kind: "free" }
  | { kind: "mine" }
  | { kind: "taken"; claim: Claim; ageMin: number }
  | { kind: "stale"; claim: Claim; ageMin: number; why: string };

// Scade CLAIM_TTL_MIN minuti dopo l'orario della sveglia (non dopo la presa): una sessione partita presto e in attesa resta valida.
export function makeClaim(now: Date, slotAt: Date, host: string, pid: number): string {
  const scadeAlle = new Date(Math.max(now.getTime(), slotAt.getTime()) + CLAIM_TTL_MIN * 60_000);
  return JSON.stringify({ presaAlle: now.toISOString(), scadeAlle: scadeAlle.toISOString(), host, pid }) + "\n";
}

const plusTtl = (iso: string) => new Date(Date.parse(iso) + CLAIM_TTL_MIN * 60_000).toISOString();

export function parseClaim(raw: string): Claim | null {
  const text = raw.trim();
  try {
    const v = JSON.parse(text);
    if (v && typeof v.presaAlle === "string" && !Number.isNaN(Date.parse(v.presaAlle))) {
      const scadeAlle = typeof v.scadeAlle === "string" && !Number.isNaN(Date.parse(v.scadeAlle)) ? v.scadeAlle : plusTtl(v.presaAlle);
      return { presaAlle: v.presaAlle, scadeAlle, host: typeof v.host === "string" ? v.host : null, pid: typeof v.pid === "number" ? v.pid : null };
    }
  } catch {}
  // Formato vecchio: solo la data.
  if (!Number.isNaN(Date.parse(text))) return { presaAlle: text, scadeAlle: plusTtl(text), host: null, pid: null };
  return null;
}

// `remote` è il contenuto del file su GitHub (null se non c'è).
export function judgeClaim(remote: string | null, now: Date, me: { host: string; pid: number }, pidAlive: (pid: number) => boolean): ClaimVerdict {
  if (remote === null) return { kind: "free" };
  const claim = parseClaim(remote);
  // Illeggibile (scritta a metà): non dice né chi né quando, quindi non può fermare la sveglia. I doppi ordini
  // li impediscono comunque gli id degli ordini, uguali per la stessa sveglia.
  if (!claim) return { kind: "stale", claim: { presaAlle: "?", scadeAlle: "?", host: null, pid: null }, ageMin: Infinity, why: "il file di prenotazione è illeggibile" };
  const ageMin = (now.getTime() - Date.parse(claim.presaAlle)) / 60_000;
  if (claim.host === me.host && claim.pid === me.pid) return { kind: "mine" };
  if (now.getTime() >= Date.parse(claim.scadeAlle)) return { kind: "stale", claim, ageMin, why: `scaduta alle ${claim.scadeAlle} (${CLAIM_TTL_MIN} minuti dopo l'orario della sveglia)` };
  if (claim.host === me.host && claim.pid !== null && !pidAlive(claim.pid)) return { kind: "stale", claim, ageMin, why: `il processo ${claim.pid} che l'aveva presa su questa macchina non c'è più` };
  return { kind: "taken", claim, ageMin };
}

export function describeClaim(c: Claim, ageMin: number): string {
  const who = c.host ? `macchina ${c.host}, pid ${c.pid ?? "?"}` : "sessione sconosciuta";
  const age = Number.isFinite(ageMin) ? `${Math.max(0, Math.round(ageMin))} minuti fa` : "ora sconosciuta";
  return `${who}, ${age}`;
}
