import { existsSync } from "node:fs";
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
}

export interface KronosForecastPath {
  rendimentoPrevisto: number; // alla fine dell'orizzonte
  percorso: number[]; // rendimento previsto giorno per giorno rispetto all'ultima chiusura
  ultimaChiusura: number | null;
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
  const child = Bun.spawn([py, "server.py", "--model", model, "--port", String(port), "--lookback", String(AGENTS.kronos.lookback), "--samples", String(AGENTS.kronos.samples)], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });
  link.child = child;
  link.stato = `in avvio (Kronos-${model}, pid ${child.pid}): carico i pesi del modello`;
  log(`kronos: ${link.stato}`);
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
  void pipe(child.stdout as ReadableStream<Uint8Array>, "out");
  void pipe(child.stderr as ReadableStream<Uint8Array>, "err");
  let stopped = false;
  link.stop = () => {
    stopped = true;
    try {
      child.kill();
    } catch {}
  };
  void child.exited.then((code) => {
    if (!stopped) {
      link.ready = false;
      link.stato = `fermo: il sidecar è uscito con codice ${code}; riavvia il motore per riprovare`;
      log(`kronos: ${link.stato}`);
    }
  });
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

// Chiede le proiezioni mandando le barre che il motore ha già (così il sidecar non ha bisogno di chiavi Alpaca).
export function pathForecaster(link: KronosLink): (symbols: string[], bars: Record<string, Bar[]>) => Promise<Record<string, KronosForecastPath>> {
  return async (symbols, bars) => {
    if (!link.ready) throw new Error(`Kronos ${link.stato}`);
    const series: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = {};
    for (const s of symbols) {
      const b = bars[s];
      if (b && b.length >= 60) series[s] = b.slice(-AGENTS.kronos.lookback).map((x) => ({ t: x.date, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }));
    }
    if (!Object.keys(series).length) return {};
    const res = await fetch(`${link.url}/forecast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ series, horizon: AGENTS.kronos.horizon }),
      signal: AbortSignal.timeout(AGENTS.kronos.timeoutMs),
    });
    if (!res.ok) throw new Error(`Kronos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { forecasts?: Record<string, { pred_ret: number; path?: number[]; last_close?: number }> };
    const out: Record<string, KronosForecastPath> = {};
    for (const [s, f] of Object.entries(data.forecasts ?? {})) {
      const r = Number(f.pred_ret);
      if (!Number.isFinite(r)) continue;
      out[s] = { rendimentoPrevisto: r, percorso: Array.isArray(f.path) ? f.path.map(Number) : [r], ultimaChiusura: typeof f.last_close === "number" ? f.last_close : null };
    }
    return out;
  };
}

// Kronos sulle candele intraday (5 min, 15 min, 1 ora, 4 ore): le prossime `horizon` candele dello stesso passo.
// Per la decisione intraday conta questa proiezione, non quella a 5 sedute.
export function intradayForecaster(link: KronosLink): (series: Record<string, IntradayBar[]>, stepMinutes: number, horizon: number) => Promise<Record<string, KronosForecastPath>> {
  return async (bars, stepMinutes, horizon) => {
    if (!link.ready) throw new Error(`Kronos ${link.stato}`);
    const series: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> = {};
    for (const [s, b] of Object.entries(bars)) if (b.length >= 60) series[s] = b.slice(-AGENTS.kronos.lookback).map((x) => ({ t: x.t, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }));
    if (!Object.keys(series).length) return {};
    const res = await fetch(`${link.url}/forecast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ series, horizon, step_minutes: stepMinutes }),
      signal: AbortSignal.timeout(AGENTS.kronos.timeoutMs),
    });
    if (!res.ok) throw new Error(`Kronos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { forecasts?: Record<string, { pred_ret: number; path?: number[]; last_close?: number }> };
    const out: Record<string, KronosForecastPath> = {};
    for (const [s, f] of Object.entries(data.forecasts ?? {})) {
      const r = Number(f.pred_ret);
      if (Number.isFinite(r)) out[s] = { rendimentoPrevisto: r, percorso: Array.isArray(f.path) ? f.path.map(Number) : [r], ultimaChiusura: typeof f.last_close === "number" ? f.last_close : null };
    }
    return out;
  };
}
