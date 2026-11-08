import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listEventDays, readEvents, type BusEvent, type EventBus } from "../agents/bus.ts";
import { statusPath } from "../agents/engine.ts";
import { readJson, isObject } from "../fsutil.ts";
import { readWitness } from "../witness.ts";

// Dashboard locale: una pagina (3D + pannelli) servita da Bun, stato da agents-status.json, eventi dal registro
// JSONL e in diretta via WebSocket. Solo lettura: da qui non parte nessun ordine.
export interface DashboardOptions {
  port: number;
  stateDir: string;
  bus?: EventBus;
  hostname?: string;
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
    fetch(req, server) {
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
