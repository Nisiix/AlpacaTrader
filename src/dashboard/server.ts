import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listEventDays, readEvents, type BusEvent, type EventBus } from "../agents/bus.ts";
import { barsPath, forecastsPath, statusPath, type Valutazione } from "../agents/engine.ts";
import { readJson, isObject } from "../fsutil.ts";
import { readWitness } from "../witness.ts";
import { ROOT } from "../deps.ts";
import { maskedSettings, testSettings, writeSecretsFile } from "../settings.ts";
import { agentCardsWithValues, saveAgentSettings } from "../agent-settings.ts";

// Dashboard locale: una pagina (3D + pannelli) servita da Bun, stato da agents-status.json, eventi dal registro
// JSONL e in diretta via WebSocket. Solo lettura: da qui non parte nessun ordine.
export interface DashboardOptions {
  port: number;
  stateDir: string;
  bus?: EventBus;
  hostname?: string;
  // Valutazione a secco di un titolo con gli agenti del motore (solo quando la dashboard gira dentro bun run agents).
  valuta?: (symbol: string) => Promise<Valutazione>;
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
      if (url.pathname.startsWith("/vendor/addons/") && !url.pathname.includes("..")) return js(join(threeDir, "examples", "jsm", url.pathname.slice("/vendor/addons/".length)));
      if (url.pathname === "/api/status") {
        const r = readJson(statusPath(o.stateDir), isObject);
        if (r.kind === "ok") return Response.json(r.value);
        // Senza motore degli agenti, la dashboard mostra almeno l'ultimo testimone delle sveglie.
        const w = readWitness(o.stateDir);
        return Response.json({ versione: 0, testimone: w.kind === "ok" ? w.value : null, nota: "nessuno stato degli agenti: avvia bun run agents" });
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
        return Response.json(sym ? { aggiornato: r.value.aggiornato, simbolo: sym, barre: all[sym] ?? [] } : { aggiornato: r.value.aggiornato, simboli: Object.keys(all) });
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
