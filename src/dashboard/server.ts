import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listEventDays, readEvents, type BusEvent, type EventBus } from "../agents/bus.ts";
import { barsPath, forecastsPath, statusPath, type Valutazione } from "../agents/engine.ts";
import { readJson, isObject } from "../fsutil.ts";
import { ROOT } from "../deps.ts";
import { maskedSettings, testSettings, writeSecretsFile } from "../settings.ts";
import { impostazioniDi, salvaImpostazioni } from "../agents/profili.ts";
import { agentCardsWithValues, saveAgentSettings } from "../agent-settings.ts";
import { decidiProposta, leggiProposte } from "../agents/proposte.ts";
import { journalPath } from "../journal.ts";

// Dashboard locale: una pagina (3D + pannelli) servita da Bun, stato da agents-status.json, eventi dal registro
// JSONL e in diretta via WebSocket. Solo lettura: da qui non parte nessun ordine.
export interface DashboardOptions {
  port: number;
  stateDir: string;
  bus?: EventBus;
  hostname?: string;
  // Valutazione a secco di un titolo con gli agenti del motore (solo quando la dashboard gira dentro bun run agents).
  valuta?: (symbol: string) => Promise<Valutazione>;
  // Candele intraday (5Min, 15Min, 1Hour, 4Hour) dal broker e proiezione di Kronos sulle prossime candele.
  // Storico del patrimonio dal broker (rendimento per periodo).
  storico?: (start: string, end: string, timeframe: string) => Promise<{ t: string; equity: number; pnl: number }[]>;
  candele?: (symbol: string, timeframe: string) => Promise<{ barre: { date: string; open: number; high: number; low: number; close: number; volume: number }[]; previsione: { rendimentoPrevisto: number; percorso: number[] } | null; nota?: string }>;
}

const html = () => readFileSync(join(import.meta.dir, "index.html"), "utf8");
// Three.js arriva dal pacchetto npm installato, non da un CDN: la dashboard funziona anche senza internet.
const threeDir = join(Bun.resolveSync("three/package.json", import.meta.dir), "..");
const js = (path: string) => (existsSync(path) ? new Response(Bun.file(path), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" } }) : new Response("non trovato", { status: 404 }));

export function startDashboard(o: DashboardOptions) {
  const clients = new Set<{ send: (s: string) => void }>();
  const unsubscribe = o.bus?.subscribe((e: BusEvent) => {
    const msg = JSON.stringify(e);
    for (const c of clients) {
      try {
        c.send(msg);
      } catch {}
    }
  });
  const server = Bun.serve({
    port: o.port,
    hostname: o.hostname ?? "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return server.upgrade(req) ? undefined : new Response("websocket richiesto", { status: 426 });
      if (url.pathname === "/" || url.pathname === "/index.html") return new Response(html(), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/vendor/three.module.js") return js(join(threeDir, "build", "three.module.js"));
      // Grafici come sulle piattaforme di trading: TradingView Lightweight Charts (Apache 2.0), copiato nel repository.
      if (url.pathname === "/vendor/lightweight-charts.js") return js(join(import.meta.dir, "vendor", "lightweight-charts.js"));
      if (url.pathname.startsWith("/vendor/addons/") && !url.pathname.includes("..")) return js(join(threeDir, "examples", "jsm", url.pathname.slice("/vendor/addons/".length)));
      if (url.pathname === "/api/status") {
        const r = readJson(statusPath(o.stateDir), isObject);
        if (r.kind === "ok") return Response.json(r.value);
        return Response.json({ versione: 0, nota: "nessuno stato degli agenti: avvia bun run agents" });
      }
      if (url.pathname === "/api/events") {
        const days = listEventDays(o.stateDir);
        const day = url.searchParams.get("giorno") ?? days.at(-1) ?? "";
        const n = Number(url.searchParams.get("n") ?? 500);
        const kinds = url.searchParams.get("tipi");
        return Response.json({ giorno: day, giorni: days, eventi: day ? readEvents(o.stateDir, day, n, kinds ? new Set(kinds.split(",")) : undefined) : [] });
      }
      if (url.pathname === "/api/bars") {
        const sym = url.searchParams.get("simbolo");
        const r = readJson(barsPath(o.stateDir), isObject) as { kind: string; value?: any };
        if (r.kind !== "ok") return Response.json({ aggiornato: null, barre: sym ? [] : {} , nota: "barre non ancora scaricate: arrivano col primo giro" });
        const all = (r.value.barre ?? {}) as Record<string, unknown[]>;
        const ultime = Number(url.searchParams.get("ultime") ?? 0);
        if (!sym && ultime > 0) return Response.json({ aggiornato: r.value.aggiornato, barre: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.slice(-Math.min(ultime, 120))])) });
        return Response.json(sym ? { aggiornato: r.value.aggiornato, simbolo: sym, barre: all[sym] ?? [] } : { aggiornato: r.value.aggiornato, simboli: Object.keys(all) });
      }
      if (url.pathname === "/api/candele") {
        const sym = url.searchParams.get("simbolo");
        const tf = url.searchParams.get("tf") ?? "";
        if (!sym || !["1Min", "5Min", "15Min", "1Hour", "4Hour"].includes(tf)) return Response.json({ errore: "servono simbolo e tf (1Min, 5Min, 15Min, 1Hour, 4Hour)" }, { status: 400 });
        if (!o.candele) return Response.json({ errore: "le candele intraday arrivano solo con il motore acceso (bun run agents)" }, { status: 503 });
        try {
          return Response.json({ simbolo: sym, tf, ...(await o.candele(sym, tf)) });
        } catch (e) {
          return Response.json({ errore: (e as Error).message }, { status: 502 });
        }
      }
      if (url.pathname === "/api/storico") {
        const start = url.searchParams.get("dal") ?? "";
        const end = url.searchParams.get("al") ?? new Date().toISOString();
        const tf = url.searchParams.get("tf") ?? "1D";
        if (!/^\d{4}-\d{2}-\d{2}/.test(start) || !["15Min", "1H", "1D"].includes(tf)) return Response.json({ errore: "servono dal (data) e tf (15Min, 1H, 1D)" }, { status: 400 });
        if (!o.storico) return Response.json({ errore: "lo storico del patrimonio arriva solo con il motore acceso (bun run agents)", punti: [] }, { status: 503 });
        try {
          return Response.json({ dal: start, al: end, tf, punti: await o.storico(start, end, tf) });
        } catch (e) {
          return Response.json({ errore: (e as Error).message, punti: [] }, { status: 502 });
        }
      }
      if (url.pathname === "/api/previsioni") {
        const r = readJson(forecastsPath(o.stateDir), isObject) as { kind: string; value?: any };
        return Response.json(r.kind === "ok" ? r.value : { aggiornato: null, giorno: null, previsioni: {}, nota: "nessuna proiezione: Kronos non ancora attivo" });
      }
      if (url.pathname === "/api/valuta") {
        const sym = url.searchParams.get("simbolo");
        if (!sym) return Response.json({ errore: "manca il simbolo" }, { status: 400 });
        if (!o.valuta) return Response.json({ errore: "la valutazione in diretta funziona solo con il motore acceso (bun run agents)" }, { status: 503 });
        try {
          return Response.json(await o.valuta(sym));
        } catch (e) {
          return Response.json({ errore: (e as Error).message }, { status: 502 });
        }
      }
      // Impostazioni: chiavi (mascherate in lettura), prova, salvataggio in secrets.ts; schede degli agenti.
      if (url.pathname === "/api/impostazioni" && req.method === "GET") return Response.json(maskedSettings(ROOT));
      if (url.pathname === "/api/impostazioni" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, string>;
        const r = writeSecretsFile(ROOT, body);
        return Response.json(r.ok ? { ok: true, cambiati: r.cambiati, nota: "Salvato in secrets.ts. Il motore legge le chiavi all'avvio: riavvia il bot (Ctrl-C e avvia-bot.cmd) per usare quelle nuove." } : { ok: false, errore: r.errore }, { status: r.ok ? 200 : 400 });
      }
      if (url.pathname === "/api/impostazioni/prova" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, string>;
        return Response.json(await testSettings(ROOT, body));
      }
      // Proposte del capo ufficio sulle impostazioni generali: elenco, accetta o rifiuta.
      if (url.pathname === "/api/proposte" && req.method === "GET") return Response.json(leggiProposte(o.stateDir));
      const mProp = url.pathname.match(/^\/api\/proposte\/([\w-]+)$/);
      if (mProp && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { azione?: string };
        if (body.azione !== "accetta" && body.azione !== "rifiuta") return Response.json({ ok: false, errore: "azione: accetta o rifiuta" }, { status: 400 });
        const j = readJson(journalPath(o.stateDir), isObject) as { kind: string; value?: any };
        const r = decidiProposta(o.stateDir, mProp[1]!, body.azione, j.kind === "ok" ? j.value : null, new Date());
        return Response.json(r, { status: r.ok ? 200 : 400 });
      }
      if (url.pathname === "/api/riavvia" && req.method === "POST") {
        writeFileSync(join(o.stateDir, "riavvio.richiesta"), new Date().toISOString());
        return Response.json({ ok: true, nota: "Riavvio richiesto: il motore finisce il giro in corso ed esce; avvia-bot.cmd lo rilancia da solo entro un minuto (se è stato avviato con avvia-bot.cmd)." });
      }
      if (url.pathname === "/api/agenti/schede" && req.method === "GET") return Response.json({ schede: agentCardsWithValues(o.stateDir) });
      if (url.pathname === "/api/agenti/schede" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const r = saveAgentSettings(o.stateDir, body);
        return Response.json(r.ok ? { ok: true, salvati: r.salvati, nota: "Impostazioni salvate: valgono dal prossimo giro del motore." } : { ok: false, errori: r.errori }, { status: r.ok ? 200 : 400 });
      }
      // Le impostazioni personali di una persona dello staff (p:Nome): lettura e salvataggio.
      const mPers = /^\/api\/persone\/([^/]+)$/.exec(url.pathname);
      if (mPers && req.method === "GET") return Response.json(impostazioniDi(o.stateDir, `p:${decodeURIComponent(mPers[1]!)}`));
      if (mPers && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { valori?: Record<string, unknown>; obiettivo?: unknown };
        const r = salvaImpostazioni(o.stateDir, `p:${decodeURIComponent(mPers[1]!)}`, body.valori ?? {}, body.obiettivo);
        return Response.json(r.ok ? { ok: true, nota: "Impostazioni personali salvate: valgono dal prossimo giro del motore." } : r, { status: r.ok ? 200 : 400 });
      }
      if (url.pathname === "/api/journal") {
        const p = join(o.stateDir, "journal.json");
        return existsSync(p) ? new Response(readFileSync(p), { headers: { "content-type": "application/json" } }) : Response.json({ trade: [] });
      }
      return new Response("non trovato", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      close(ws) {
        clients.delete(ws);
      },
      message() {},
    },
  });
  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    stop() {
      unsubscribe?.();
      server.stop(true);
    },
  };
}
