// Fin dove arrivano le giornate concluse, per lo storico giornaliero e per le proiezioni di Kronos. Azioni: la seduta di
// un giorno di New York è conclusa dalle 16:15 locali (chiusura alle 16:00, più un margine per le ultime stampe); prima
// di quell'ora l'ultima conclusa è quella del giorno prima. Crypto: la candela giornaliera di un giorno UTC è conclusa a
// mezzanotte UTC. `azioni` e `crypto` sono limiti esclusivi: entrano le barre con data minore.
// `chiave` cambia quando arriva una giornata conclusa nuova (azioni o crypto): è il momento di riscaricare lo storico e
// ricalcolare le proiezioni. Prima lo si faceva alla mezzanotte italiana, quando a New York il giorno non era ancora
// cambiato: la seduta appena chiusa restava fuori per tutta la giornata, e così l'ultima candela crypto.
const nyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const giornoDopo = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

export function limitiSedute(now: Date): { azioni: string; crypto: string; chiave: string } {
  const p: Record<string, string> = {};
  for (const part of nyFmt.formatToParts(now)) p[part.type] = part.value;
  const oggiNy = `${p.year}-${p.month}-${p.day}`;
  const minuti = Number(p.hour) * 60 + Number(p.minute);
  const azioni = minuti >= 16 * 60 + 15 ? giornoDopo(oggiNy) : oggiNy;
  const crypto = now.toISOString().slice(0, 10);
  return { azioni, crypto, chiave: `${azioni}|${crypto}` };
}
