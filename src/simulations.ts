import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Le simulazioni: dopo il tetto del giorno gli agenti non comprano più, ma quello che avrebbero comprato si annota qui
// (state/simulazioni/AAAA-MM-GG.jsonl) e si rivaluta ai prezzi correnti a ogni giro: così si vede come sarebbe andata e
// il diario di domani parte con un'informazione in più. Nessun ordine, nessun effetto sul conto.
export interface SimulazioneIn {
  id: string;
  simbolo: string;
  quantita: number;
  prezzo: number;
  quando: string;
  agenti: string[];
  perche: string;
}

export interface Simulazione extends SimulazioneIn {
  prezzoOra: number | null;
  risultato: number | null; // frazione
  virtuale: number | null; // dollari
}

const dir = (stateDir: string) => join(stateDir, "simulazioni");
const file = (stateDir: string, day: string) => join(dir(stateDir), `${day}.jsonl`);

export function read(stateDir: string, day: string): SimulazioneIn[] {
  const p = file(stateDir, day);
  if (!existsSync(p)) return [];
  const out: SimulazioneIn[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SimulazioneIn);
    } catch {}
  }
  return out;
}

export function add(stateDir: string, day: string, s: SimulazioneIn) {
  if (read(stateDir, day).some((x) => x.simbolo === s.simbolo)) return; // una simulazione per titolo al giorno
  mkdirSync(dir(stateDir), { recursive: true });
  appendFileSync(file(stateDir, day), JSON.stringify(s) + "\n");
}

export function evaluate(stateDir: string, day: string, prices: Record<string, number>): Simulazione[] {
  return read(stateDir, day).map((s) => {
    const now = prices[s.simbolo] ?? null;
    return { ...s, prezzoOra: now, risultato: now ? now / s.prezzo - 1 : null, virtuale: now ? (now - s.prezzo) * s.quantita : null };
  });
}
