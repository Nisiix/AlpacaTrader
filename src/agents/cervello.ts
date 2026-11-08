import { join } from "node:path";
import { AGENTS } from "../config.ts";
import type { IntradayBar } from "../broker/types.ts";
import { isObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { KronosForecastPath } from "../kronos-sidecar.ts";

// Il cervello delle previsioni: più modelli (Kronos, Chronos-2, TimesFM...) prevedono lo stesso titolo; qui si registra la
// previsione di ognuno, la si confronta con il prezzo vero quando scade e si tiene il conto di quanto spesso ogni modello
// ha preso la direzione giusta, separatamente per le previsioni giornaliere e per ogni candela intraday.
// La previsione usata dal motore è la media dei percorsi pesata: peso = affidabilità a priori (dati finanziari con cui il
// modello è stato addestrato e prove pubblicate sui rendimenti) × risultato misurato qui. Finché un modello non ha
// `minCampione` previsioni valutate conta solo l'affidabilità; poi la sua bravura la conferma, la alza o la azzera.
// Kronos è il modello principale: finché non risulta peggiore del caso tiene almeno `kronosMinimo` del peso.

export interface PrevisioneAperta {
  m: string; // modello
  s: string; // simbolo
  tipo: string; // "giorno" | "intraday-15m" ...
  fatta: string; // ISO
  scade: string; // ISO
  base: number; // prezzo di riferimento (ultima chiusura nota)
  prev: number; // rendimento previsto alla scadenza
}

export interface StatModello {
  n: number; // previsioni valutate
  giusti: number; // direzione giusta
  segno: number; // somma di segno(previsto) × rendimento vero: quanto avrebbe reso seguirlo
}

export interface CervelloFile {
  versione: 1;
  aperte: PrevisioneAperta[];
  stat: Record<string, StatModello>; // chiave `${tipo}|${modello}`
}

export interface RigaCervello {
  tipo: string;
  modello: string;
  campione: number;
  inDirezione: number | null; // quota di direzioni giuste
  resaMedia: number | null; // rendimento medio seguendo il segno della previsione
  affidabilita: number; // scala a priori
  peso: number;
}

export const affidabilitaDi = (m: string) => AGENTS.kronos.cervello.affidabilita[m] ?? AGENTS.kronos.cervello.affidabilitaIgnota;
export const cervelloPath = (stateDir: string) => join(stateDir, "cervello.json");
const vuoto = (): CervelloFile => ({ versione: 1, aperte: [], stat: {} });
// Movimenti più piccoli di così non dicono niente sulla direzione: non si contano.
const PIATTO = 0.0005;

export class Cervello {
  private f: CervelloFile;
  private sporco = false;
  constructor(private stateDir: string) {
    const valido = (v: unknown): v is CervelloFile => isObject(v) && v.versione === 1 && Array.isArray(v.aperte) && isObject(v.stat);
    const r = readJson(cervelloPath(stateDir), valido);
    this.f = r.kind === "ok" ? r.value : vuoto();
  }

  // Una previsione per modello: rendimento atteso a `scade`, rispetto al prezzo `base`.
  registra(tipo: string, simbolo: string, base: number, fatta: Date, scade: Date, modelli: Record<string, number>) {
    if (!(base > 0)) return;
    const scadeIso = scade.toISOString();
    for (const [m, prev] of Object.entries(modelli)) {
      if (!Number.isFinite(prev)) continue;
      if (this.f.aperte.some((x) => x.m === m && x.s === simbolo && x.tipo === tipo && x.scade === scadeIso)) continue;
      this.f.aperte.push({ m, s: simbolo, tipo, fatta: fatta.toISOString(), scade: scadeIso, base, prev });
    }
    const max = AGENTS.kronos.cervello.maxAperte;
    if (this.f.aperte.length > max) this.f.aperte.splice(0, this.f.aperte.length - max);
    this.sporco = true;
  }

  // Le previsioni scadute si confrontano con il prezzo di adesso. Troppo in ritardo (oltre un quarto dell'orizzonte, almeno
  // 15 minuti) il prezzo non è più quello della scadenza: si scartano senza contarle.
  valuta(now: Date, prezzi: Record<string, number>): number {
    let contate = 0;
    const restano: PrevisioneAperta[] = [];
    for (const x of this.f.aperte) {
      const scade = Date.parse(x.scade);
      if (scade > now.getTime()) {
        restano.push(x);
        continue;
      }
      const tolleranza = Math.max(15 * 60_000, (scade - Date.parse(x.fatta)) / 4);
      const p = prezzi[x.s];
      if (now.getTime() - scade > tolleranza || !(p > 0)) {
        if (now.getTime() - scade <= tolleranza) restano.push(x); // prezzo non ancora disponibile: si riprova
        continue;
      }
      const vero = p / x.base - 1;
      if (Math.abs(vero) >= PIATTO && x.prev !== 0) {
        const k = `${x.tipo}|${x.m}`;
        const st = (this.f.stat[k] ??= { n: 0, giusti: 0, segno: 0 });
        st.n++;
        if (Math.sign(vero) === Math.sign(x.prev)) st.giusti++;
        st.segno += Math.sign(x.prev) * vero;
        contate++;
      }
    }
    if (restano.length !== this.f.aperte.length) this.sporco = true;
    this.f.aperte = restano;
    this.salva();
    return contate;
  }

  salva() {
    if (!this.sporco) return;
    writeJsonAtomic(cervelloPath(this.stateDir), this.f);
    this.sporco = false;
  }

  // Pesi per un tipo di previsione, tra i modelli dati: affidabilità × fattore misurato. Bravura = (giusti - n/2) / (n +
  // prudenza): oltre il caso e ridotta quando il campione è piccolo. Sotto minCampione il fattore è 1; poi bravura /
  // bravuraAttesa tra 0 e 3. Se nessuno ha peso, decide Kronos.
  pesi(tipo: string, modelli: string[]): Record<string, number> {
    const c = AGENTS.kronos.cervello;
    const brav: Record<string, number> = {};
    const w: Record<string, number> = {};
    for (const m of modelli) {
      const st = this.f.stat[`${tipo}|${m}`];
      brav[m] = st && st.n >= c.minCampione ? (st.giusti - st.n / 2) / (st.n + c.prudenza) : Number.NaN;
      const fattore = Number.isFinite(brav[m]!) ? Math.max(0, Math.min(3, brav[m]! / c.bravuraAttesa)) : 1;
      w[m] = affidabilitaDi(m) * fattore;
    }
    const tot = Object.values(w).reduce((a, x) => a + x, 0);
    const hasK = modelli.includes("kronos");
    if (tot <= 0) return Object.fromEntries(modelli.map((m) => [m, hasK ? (m === "kronos" ? 1 : 0) : 1 / modelli.length]));
    for (const m of modelli) w[m] = w[m]! / tot;
    // Kronos non dimostrato peggiore del caso (bravura non negativa o campione ancora piccolo) tiene la sua quota minima.
    if (hasK && !(brav.kronos! < 0) && w.kronos! < c.kronosMinimo) {
      const resto = 1 - w.kronos!;
      for (const m of modelli) if (m !== "kronos") w[m] = resto > 0 ? (w[m]! / resto) * (1 - c.kronosMinimo) : 0;
      w.kronos = c.kronosMinimo;
    }
    return w;
  }

  // Il percorso combinato: media dei percorsi pesata (lunghezza di quello principale; i più corti tengono l'ultimo valore).
  combina(tipo: string, modelli: Record<string, number[]> | undefined, principale: number[]): number[] {
    if (!modelli || Object.keys(modelli).length < 2) return principale;
    const nomi = Object.keys(modelli).filter((m) => modelli[m]!.length > 0);
    const w = this.pesi(tipo, nomi);
    const len = principale.length || Math.max(...nomi.map((m) => modelli[m]!.length));
    const out: number[] = [];
    for (let i = 0; i < len; i++) {
      let sum = 0, tw = 0;
      for (const m of nomi) {
        const p = modelli[m]!;
        const v = p[Math.min(i, p.length - 1)]!;
        if (!Number.isFinite(v) || !(w[m]! > 0)) continue;
        sum += w[m]! * v;
        tw += w[m]!;
      }
      out.push(tw > 0 ? sum / tw : (principale[i] ?? 0));
    }
    return out;
  }

  // Per la dashboard: una riga per tipo e modello con campione, direzione giusta, resa e peso di adesso.
  stato(): { righe: RigaCervello[]; inAttesa: number } {
    const perTipo = new Map<string, Set<string>>();
    for (const k of Object.keys(this.f.stat)) {
      const [tipo, m] = k.split("|") as [string, string];
      (perTipo.get(tipo) ?? perTipo.set(tipo, new Set()).get(tipo)!).add(m);
    }
    for (const x of this.f.aperte) (perTipo.get(x.tipo) ?? perTipo.set(x.tipo, new Set()).get(x.tipo)!).add(x.m);
    const righe: RigaCervello[] = [];
    for (const [tipo, ms] of [...perTipo].sort((a, b) => a[0].localeCompare(b[0]))) {
      const w = this.pesi(tipo, [...ms]);
      for (const m of [...ms].sort()) {
        const st = this.f.stat[`${tipo}|${m}`];
        righe.push({ tipo, modello: m, campione: st?.n ?? 0, inDirezione: st?.n ? st.giusti / st.n : null, resaMedia: st?.n ? st.segno / st.n : null, affidabilita: affidabilitaDi(m), peso: w[m] ?? 0 });
      }
    }
    return { righe, inAttesa: this.f.aperte.length };
  }
}

// Le scadenze: le proiezioni giornaliere guardano `horizon` sedute (circa 7 giorni di calendario ogni 5); quelle intraday
// finiscono `n` candele dopo la chiusura dell'ultima candela nota.
export const scadenzaGiorno = (now: Date) => new Date(now.getTime() + Math.ceil((AGENTS.kronos.horizon * 7) / 5) * 86_400_000);
export const scadenzaIntraday = (ultimaCandela: string, stepMinutes: number, n: number) => new Date(Date.parse(ultimaCandela) + (n + 1) * stepMinutes * 60_000);
export const tipoIntraday = (stepMinutes: number) => `intraday-${stepMinutes}m`;

// Le previsioni giornaliere passano dal cervello: si registra la previsione di ogni modello e si restituisce il percorso
// combinato (il motore non vede differenze: un percorso, un rendimento previsto).
export function previsioniCombinate<B extends { close: number }, T extends string = "giorno" | "esplorazione">(
  f: (symbols: string[], bars: Record<string, B[]>, tipo?: T) => Promise<Record<string, KronosForecastPath>>,
  c: Cervello,
  now: () => Date = () => new Date(),
): (symbols: string[], bars: Record<string, B[]>, tipo?: T) => Promise<Record<string, KronosForecastPath>> {
  return async (symbols, bars, tipo) => {
    const raw = await f(symbols, bars, tipo);
    const t = now();
    for (const [s, p] of Object.entries(raw)) {
      if (!p.modelli) continue;
      const base = p.ultimaChiusura ?? bars[s]?.at(-1)?.close;
      if (base) c.registra("giorno", s, base, t, scadenzaGiorno(t), finali(p.modelli));
      const percorso = c.combina("giorno", p.modelli, p.percorso);
      raw[s] = { ...p, percorso, rendimentoPrevisto: percorso.at(-1) ?? p.rendimentoPrevisto };
    }
    return raw;
  };
}

// Lo stesso per le candele intraday: un conto separato per ogni candela (5, 15, 60, 240 minuti).
export function previsioniIntradayCombinate(
  f: (series: Record<string, IntradayBar[]>, stepMinutes: number, horizon: number) => Promise<Record<string, KronosForecastPath>>,
  c: Cervello,
  now: () => Date = () => new Date(),
): (series: Record<string, IntradayBar[]>, stepMinutes: number, horizon: number) => Promise<Record<string, KronosForecastPath>> {
  return async (series, step, horizon) => {
    const raw = await f(series, step, horizon);
    const t = now();
    const tipo = tipoIntraday(step);
    for (const [s, p] of Object.entries(raw)) {
      if (!p.modelli) continue;
      const ultima = series[s]?.at(-1);
      const base = p.ultimaChiusura ?? ultima?.close;
      if (base && ultima) c.registra(tipo, s, base, t, scadenzaIntraday(ultima.t, step, p.percorso.length), finali(p.modelli));
      const percorso = c.combina(tipo, p.modelli, p.percorso);
      raw[s] = { ...p, percorso, rendimentoPrevisto: percorso.at(-1) ?? p.rendimentoPrevisto };
    }
    return raw;
  };
}

const finali = (modelli: Record<string, number[]>) => Object.fromEntries(Object.entries(modelli).map(([m, p]) => [m, p[p.length - 1]!]));
