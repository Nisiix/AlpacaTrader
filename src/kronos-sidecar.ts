import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "./config.ts";
import type { Bar, IntradayBar } from "./broker/types.ts";

// Il sidecar Kronos (tools/kronos/server.py) lo accende il motore: se risponde già sulla porta lo usa, altrimenti lo
// avvia dal venv creato da installa-kronos (python + torch per CPU) e aspetta che i pesi siano caricati. Il motore non
// aspetta: parte subito, e le proiezioni arrivano appena il sidecar è pronto. Senza venv il motore lavora senza Kronos
// e dice chiaramente come installarlo.
export interface KronosLink {
  url: string;
  ready: boolean;
  stato: string; // una riga per dashboard e log
  stop(): void;
  // Richieste degli agenti in corso: intanto i grafici della dashboard non chiedono proiezioni (le avranno al prossimo
  // aggiornamento), così non rubano la CPU al giro degli agenti.
  occupato?: number;
}

export interface KronosForecastPath {
  rendimentoPrevisto: number; // alla fine dell'orizzonte
  percorso: number[]; // rendimento previsto giorno per giorno rispetto all'ultima chiusura
  ultimaChiusura: number | null;
  // Il percorso di ogni modello che il sidecar ha fatto girare (kronos, chronos2, timesfm...), prima della combinazione.
  modelli?: Record<string, number[]>;
  // Fin dove arrivavano le giornate concluse quando è stata calcolata (limite di src/sedute.ts per la sua classe).
  del?: string;
  // I singoli percorsi di Kronos (rendimenti candela per candela), se il sidecar li ha mandati: da quanti chiudono sopra i
  // costi la probabilità, dai minimi dei peggiori lo stop.
  campioni?: number[][];
}

// Quanti campioni chiedere: si parte dal numero iniziale e, a ogni richiesta, si guarda il tempo per serie misurato sul
// PC (attese per altre richieste comprese): oltre quello concesso si scende in proporzione; ben sotto si sale (fino al
// doppio alla volta). Il costo dei campioni non è proporzionale (Kronos li genera insieme), quindi salendo così si arriva
// al massimo che il PC regge senza doverlo stimare.
export type TipoCampioni = "giorno" | "intraday" | "esplorazione" | "grafico";
export class Campionatore {
  private n: number;
  private ultimoMsPerSerie: number | null = null;
  constructor(private tipo: TipoCampioni) {
    this.n = AGENTS.kronos.campioni[tipo].iniziali;
  }
  quanti(): number {
    const c = AGENTS.kronos.campioni;
    return (this.n = Math.max(c.min, Math.min(this.massimo(), this.n)));
  }
  misura(ms: number, serie: number, campioni: number) {
    if (serie <= 0 || campioni <= 0 || !(ms > 0)) return;
    const c = AGENTS.kronos.campioni;
    const budget = c[this.tipo].msPerSerie;
    const perSerie = ms / serie;
    this.ultimoMsPerSerie = perSerie;
    if (perSerie > budget) this.n = Math.floor((campioni * budget) / perSerie);
    else if (perSerie < 0.75 * budget) this.n = Math.max(campioni + 1, Math.floor(campioni * Math.min(2, (0.9 * budget) / perSerie)));
    this.n = Math.max(c.min, Math.min(this.massimo(), this.n));
  }
  private massimo(): number {
    const c = AGENTS.kronos.campioni;
    const t = c[this.tipo] as { max?: number };
    return Math.min(c.max, t.max ?? c.max);
  }
  stato(): string {
    return `${this.n}${this.ultimoMsPerSerie !== null ? ` (${(this.ultimoMsPerSerie / 1000).toFixed(1)} s per titolo)` : ""}`;
  }
}
export const CAMPIONI = { giorno: new Campionatore("giorno"), intraday: new Campionatore("intraday"), esplorazione: new Campionatore("esplorazione"), grafico: new Campionatore("grafico") };

const modelliDi = (f: { modelli?: Record<string, unknown> }): Record<string, number[]> | undefined => {
  if (!f.modelli || typeof f.modelli !== "object") return undefined;
  const out: Record<string, number[]> = {};
  for (const [m, p] of Object.entries(f.modelli)) if (Array.isArray(p) && p.length && p.every((x) => Number.isFinite(Number(x)))) out[m] = p.map(Number);
  return Object.keys(out).length ? out : undefined;
};

// La cache di Hugging Face (come la cerca huggingface_hub): HF_HUB_CACHE, poi HF_HOME/hub, poi ~/.cache/huggingface/hub.
const cacheHF = () => process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
const REPO_MODELLI: Record<string, string> = { chronos2: "amazon/chronos-2", timesfm: "google/timesfm-2.5-200m-pytorch" };
export const reposPer = (model: string, modelli: string[]) => [model === "mini" ? "NeoQuasar/Kronos-Tokenizer-2k" : "NeoQuasar/Kronos-Tokenizer-base", `NeoQuasar/Kronos-${model}`, ...modelli.map((m) => REPO_MODELLI[m]).filter((x): x is string => !!x)];
export function pesiInCache(repos: string[], dir = cacheHF()): boolean {
  return repos.every((r) => {
    const snap = join(dir, `models--${r.replace("/", "--")}`, "snapshots");
    try {
      return existsSync(snap) && readdirSync(snap).length > 0;
    } catch {
      return false;
    }
  });
}

const pythonFor = (dir: string) => {
  const win = join(dir, "venv", "Scripts", "python.exe");
  const nix = join(dir, "venv", "bin", "python");
  return existsSync(win) ? win : existsSync(nix) ? nix : null;
};

export async function pingKronos(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface SidecarOptions {
  root: string; // cartella del progetto
  port?: number;
  model?: "mini" | "small" | "base";
  log?: (line: string) => void;
  readyTimeoutMs?: number;
}

export async function ensureKronos(o: SidecarOptions): Promise<KronosLink> {
  const port = o.port ?? AGENTS.kronos.port;
  const url = `http://127.0.0.1:${port}`;
  const log = o.log ?? (() => {});
  const link: KronosLink & { child?: ReturnType<typeof Bun.spawn> } = { url, ready: false, stato: "in avvio", stop: () => {} };
  if (await pingKronos(url)) {
    link.ready = true;
    link.stato = `attivo su ${url} (già acceso)`;
    log(`kronos: ${link.stato}`);
    return link;
  }
  const dir = join(o.root, "tools", "kronos");
  const py = pythonFor(dir);
  const src = existsSync(join(dir, "kronos-src", "model"));
  if (!py || !src) {
    link.stato = `non installato: lancia installa-kronos${process.platform === "win32" ? ".cmd" : ".sh"} nella cartella del progetto (serve Python 3.10+); il motore intanto lavora senza proiezioni`;
    log(`kronos: ${link.stato}`);
    return link;
  }
  const model = o.model ?? AGENTS.kronos.model;
  // Pesi già scaricati: il sidecar parte senza rete (HF_HUB_OFFLINE), più in fretta e senza l'avviso di Hugging Face
  // sulle richieste non autenticate. Se manca qualcosa o l'avvio offline fallisce, si riparte normalmente (scarica).
  const offline = pesiInCache(reposPer(model, AGENTS.kronos.modelli));
  let stopped = false;
  let child: ReturnType<typeof Bun.spawn>;
  const pipe = async (stream: ReadableStream<Uint8Array> | null, tag: string) => {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (line && !/^\s*\d+%\|/.test(line)) log(`kronos ${tag}: ${line}`);
      }
    }
  };
  const avvia = (senzaRete: boolean) => {
    child = Bun.spawn([py, "server.py", "--model", model, "--port", String(port), "--lookback", String(AGENTS.kronos.lookback), "--samples", String(AGENTS.kronos.samples), "--modelli", AGENTS.kronos.modelli.join(",")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1", ...(senzaRete ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {}) },
    });
    link.child = child;
    link.stato = `in avvio (Kronos-${model}, pid ${child.pid}${senzaRete ? ", pesi già scaricati, senza rete" : ""}): carico i pesi del modello`;
    log(`kronos: ${link.stato}`);
    void pipe(child.stdout as ReadableStream<Uint8Array>, "out");
    void pipe(child.stderr as ReadableStream<Uint8Array>, "err");
    void child.exited.then((code) => {
      if (stopped) return;
      const eraPronto = link.ready;
      link.ready = false;
      if (senzaRete && !eraPronto) {
        log(`kronos: avvio senza rete non riuscito (codice ${code}): riprovo scaricando da Hugging Face`);
        avvia(false);
        return;
      }
      link.stato = `fermo: il sidecar è uscito con codice ${code}; riavvia il motore per riprovare`;
      log(`kronos: ${link.stato}`);
    });
  };
  avvia(offline);
  link.stop = () => {
    stopped = true;
    try {
      child.kill();
    } catch {}
  };
  // Pronto quando risponde: alla prima installazione i pesi si scaricano da Hugging Face (minuti).
  const deadline = Date.now() + (o.readyTimeoutMs ?? 20 * 60_000);
  void (async () => {
    while (!stopped && Date.now() < deadline) {
      if (await pingKronos(url)) {
        link.ready = true;
        link.stato = `attivo su ${url} (Kronos-${model})`;
        log(`kronos: ${link.stato}`);
        return;
      }
      await Bun.sleep(5_000);
    }
    if (!stopped && !link.ready) {
      link.stato = "non risponde dopo l'avvio: guarda le righe 'kronos err' nel log";
      log(`kronos: ${link.stato}`);
    }
  })();
  return link;
}

// Prezzi minuscoli (PEPE a 0,000005 $): Kronos normalizza ogni serie con (x − media) / (dev. std + 1e-5), e con una
// deviazione standard di 1e-7 il denominatore è tutto 1e-5: la serie diventa piatta e la proiezione esce fuori misura.
// Le serie sotto 1 $ si mandano scalate (ultima chiusura = 100): i rendimenti non cambiano, l'ultima chiusura si riporta
// alla scala vera.
export function scalaSerie(b: { o: number; h: number; l: number; c: number; v: number; t: string }[]): { serie: typeof b; k: number } {
  const last = b.at(-1)?.c ?? 0;
  if (!(last > 0) || last >= 1) return { serie: b, k: 1 };
  const k = 100 / last;
  return { serie: b.map((x) => ({ ...x, o: x.o * k, h: x.h * k, l: x.l * k, c: x.c * k })), k };
}

// I singoli percorsi mandati dal sidecar: righe di numeri finiti, tutte lunghe uguali (almeno 4, se no non servono).
export function campioniDi(x: unknown): number[][] | null {
  if (!Array.isArray(x) || x.length < 4) return null;
  const righe = x.filter((r): r is unknown[] => Array.isArray(r)).map((r) => r.map(Number));
  const n = righe[0]?.length ?? 0;
  const ok = righe.filter((r) => r.length === n && n > 0 && r.every(Number.isFinite));
  return ok.length >= 4 ? ok : null;
}

// Chiede le proiezioni mandando le barre che il motore ha già (così il sidecar non ha bisogno di chiavi Alpaca).
export function pathForecaster(link: KronosLink): (symbols: string[], bars: Record<string, Bar[]>, tipo?: "giorno" | "esplorazione") => Promise<Record<string, KronosForecastPath>> {
  return async (symbols, bars, tipo = "giorno") => {
    if (!link.ready) throw new Error(`Kronos ${link.stato}`);
    const series: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = {};
    const scala: Record<string, number> = {};
    for (const s of symbols) {
      const b = bars[s];
      if (b && b.length >= 60) { const sc = scalaSerie(b.slice(-AGENTS.kronos.lookback).map((x) => ({ t: x.date, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }))); series[s] = sc.serie; scala[s] = sc.k; }
    }
    if (!Object.keys(series).length) return {};
    const n = Object.keys(series).length;
    const camp = CAMPIONI[tipo];
    const samples = camp.quanti();
    const t0 = Date.now();
    link.occupato = (link.occupato ?? 0) + 1;
    let res: Response;
    try {
      res = await fetch(`${link.url}/forecast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ series, horizon: AGENTS.kronos.horizon, samples }),
        signal: AbortSignal.timeout(AGENTS.kronos.timeoutMs),
      });
    } finally {
      link.occupato = Math.max(0, (link.occupato ?? 1) - 1);
    }
    if (!res.ok) throw new Error(`Kronos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { forecasts?: Record<string, { pred_ret: number; path?: number[]; last_close?: number; modelli?: Record<string, unknown> }> };
    camp.misura(Date.now() - t0, n, samples);
    const out: Record<string, KronosForecastPath> = {};
    for (const [s, f] of Object.entries(data.forecasts ?? {})) {
      const r = Number(f.pred_ret);
      if (!Number.isFinite(r)) continue;
      const modelli = modelliDi(f);
      out[s] = { rendimentoPrevisto: r, percorso: Array.isArray(f.path) ? f.path.map(Number) : [r], ultimaChiusura: typeof f.last_close === "number" ? f.last_close / (scala[s] ?? 1) : null, ...(modelli ? { modelli } : {}) };
    }
    return out;
  };
}

// Kronos sulle candele intraday (5 min, 15 min, 1 ora, 4 ore): le prossime `horizon` candele dello stesso passo.
// Per la decisione intraday conta questa proiezione, non quella a 5 sedute.
export function intradayForecaster(link: KronosLink, tipo: "intraday" | "grafico" = "intraday"): (series: Record<string, IntradayBar[]>, stepMinutes: number, horizon: number) => Promise<Record<string, KronosForecastPath>> {
  return async (bars, stepMinutes, horizon) => {
    if (!link.ready) throw new Error(`Kronos ${link.stato}`);
    if (tipo === "grafico" && (link.occupato ?? 0) > 0) throw new Error("occupato dal giro degli agenti: la proiezione arriva al prossimo aggiornamento");
    const series: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = {};
    const scala: Record<string, number> = {};
    for (const [s, b] of Object.entries(bars)) if (b.length >= 60) { const sc = scalaSerie(b.slice(-AGENTS.kronos.lookback).map((x) => ({ t: x.t, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }))); series[s] = sc.serie; scala[s] = sc.k; }
    if (!Object.keys(series).length) return {};
    const n = Object.keys(series).length;
    const camp = CAMPIONI[tipo];
    const samples = camp.quanti();
    const t0 = Date.now();
    const agenti = tipo !== "grafico";
    if (agenti) link.occupato = (link.occupato ?? 0) + 1;
    let res: Response;
    try {
      res = await fetch(`${link.url}/forecast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ series, horizon, step_minutes: stepMinutes, samples, ...(agenti ? { percorsi: true } : {}) }),
        signal: AbortSignal.timeout(AGENTS.kronos.timeoutMs),
      });
    } finally {
      if (agenti) link.occupato = Math.max(0, (link.occupato ?? 1) - 1);
    }
    if (!res.ok) throw new Error(`Kronos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { forecasts?: Record<string, { pred_ret: number; path?: number[]; last_close?: number; modelli?: Record<string, unknown>; campioni?: unknown }> };
    camp.misura(Date.now() - t0, n, samples);
    const out: Record<string, KronosForecastPath> = {};
    for (const [s, f] of Object.entries(data.forecasts ?? {})) {
      const r = Number(f.pred_ret);
      const modelli = modelliDi(f);
      const campioni = campioniDi(f.campioni);
      if (Number.isFinite(r)) out[s] = { rendimentoPrevisto: r, percorso: Array.isArray(f.path) ? f.path.map(Number) : [r], ultimaChiusura: typeof f.last_close === "number" ? f.last_close / (scala[s] ?? 1) : null, ...(modelli ? { modelli } : {}), ...(campioni ? { campioni } : {}) };
    }
    return out;
  };
}
