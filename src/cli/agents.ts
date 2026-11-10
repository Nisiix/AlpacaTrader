// bun run agents [--fake] [--once] [--tick 5] [--port 8787] [--no-dashboard] [--no-crypto] [--no-kronos] [--kronos http://host:porta]
// Il motore degli agenti: processo sempre acceso sul tuo PC. Ogni `tick` minuti legge il conto, interroga gli agenti
// (trend, rientro, regime, orizzonte, uscite, contesto, presa di profitto, i custodi delle crypto, Kronos), passa dalla
// gabbia, invia, e aggiorna la dashboard locale. Kronos: il sidecar Python lo accende il motore da solo, se installato.
import { HorizonAgent } from "../agents/horizon.ts";
import { ClaudeMacro, ContextAgent } from "../agents/context.ts";
import { CustodiAgent, alpacaNews, combinedNews, googleNews, xNews } from "../agents/custode.ts";
import { FontiEsterne } from "../agents/fonti.ts";
import { loadSecrets } from "../deps.ts";
import { IntradayAgent } from "../agents/intraday.ts";
import { ExitAgent } from "../agents/exits.ts";
import { spawnRunner } from "../claude-runner.ts";
import { KronosAgent } from "../agents/kronos.ts";
import { PullbackAgent } from "../agents/pullback.ts";
import { RegimeAgent } from "../agents/regime.ts";
import { TakeProfitAgent } from "../agents/takeprofit.ts";
import { TrendAgent } from "../agents/trend.ts";
import { EventBus } from "../agents/bus.ts";
import { emptyCache, exploreNow, runEngine, runTick, valutaTitolo, type EngineDeps } from "../agents/engine.ts";
import { coingeckoTop } from "../agents/universe.ts";
import type { Agent } from "../agents/types.ts";
import { AGENTS, enableCrypto } from "../config.ts";
import { startDashboard } from "../dashboard/server.ts";
import { ROOT, buildDeps } from "../deps.ts";
import { CAMPIONI, ensureKronos, intradayForecaster, pathForecaster, type KronosLink } from "../kronos-sidecar.ts";
import { Cervello, previsioniCombinate, previsioniIntradayCombinate, tipoIntraday } from "../agents/cervello.ts";
import { nasdaqEarnings } from "../earnings.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.ts";
import { publishPages } from "../pages.ts";

// Codice di uscita che chiede ad avvia-bot.cmd di rilanciare il motore.
const RESTART_CODE = 75;

try {
  const args = parseArgs(process.argv.slice(2));
  // Le crypto (BTC/USD, ETH/USD di base; poi l'universo del giorno: top per capitalizzazione ∩ coppie Alpaca) lavorano
  // con la stessa logica dei titoli, 24 ore su 24, anche a borsa chiusa.
  if (!args.noCrypto) enableCrypto();
  const deps = await buildDeps(args);
  const registro = (testo: string) => {
    try {
      mkdirSync(deps.logsDir, { recursive: true });
      appendFileSync(join(deps.logsDir, `agenti-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} [ERROR] ${testo}\n`);
    } catch {}
    console.error(testo);
  };
  // Windows: un clic nella finestra del motore (QuickEdit) la mette in selezione e blocca ogni scrittura sulla console,
  // cioè tutto il motore e Kronos, finché non si preme Esc: il 10/11 il motore si è fermato così per mezz'ora. Si spegne
  // la Modifica rapida per questa finestra a ogni avvio.
  if (process.platform === "win32" && process.stdin.isTTY) {
    try { Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "tools", "senza-quickedit.ps1")], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); } catch {}
  }
  // Un errore non gestito si scrive nel registro (prima finiva solo nella finestra) e il motore riparte da solo
  // (codice 75: avvia-bot.cmd lo rilancia) invece di restare fermo.
  process.on("uncaughtException", (e) => { registro(`errore non gestito: ${e?.stack ?? e}: riavvio del motore`); process.exit(RESTART_CODE); });
  process.on("unhandledRejection", (e) => { registro(`promessa rifiutata non gestita: ${(e as Error)?.stack ?? e}`); });
  for (const w of deps.warnings) console.warn(w);
  const bus = new EventBus(deps.stateDir, deps.now);
  const agents: Agent[] = [new TrendAgent(), new PullbackAgent(), new RegimeAgent(), new HorizonAgent()];
  if (AGENTS.exit.enabled) agents.push(new ExitAgent());
  // Il contesto economico: regole sui dati sempre; la lettura con claude e ricerca web solo nel vero, se abilitata.
  if (AGENTS.context.enabled) agents.push(new ContextAgent(AGENTS.context.useClaude && !args.fake ? new ClaudeMacro(deps.stateDir, spawnRunner, deps.now) : null));
  if (args.profitto || AGENTS.takeProfit.enabled) agents.push(new TakeProfitAgent());
  // I custodi studiano il loro titolo tra un giro e l'altro: nel vero leggono anche le notizie (Google News), nel finto no.
  if (AGENTS.custodi.enabled) {
    const sec = args.fake ? null : await loadSecrets(false);
    const xToken = sec?.xBearerToken ?? "";
    const alp = sec?.alpacaKeyId && sec?.alpacaSecretKey ? alpacaNews(sec.alpacaKeyId, sec.alpacaSecretKey) : null;
    agents.push(new CustodiAgent(args.fake ? null : combinedNews([googleNews(), ...(alp ? [alp] : []), ...(xToken ? [xNews(xToken)] : [])])));
    if (!args.fake) console.log(`notizie: Google News${alp ? " + Alpaca/Benzinga" : ""}${xToken ? " + X" : " (X: nessun token in secrets.ts)"}`);
  }

  // Kronos: un sidecar già acceso (--kronos url o KRONOS_URL), altrimenti lo avvia il motore dal venv di tools/kronos.
  let kronos: KronosLink | null = null;
  // Il cervello delle previsioni (Kronos + gli altri modelli del sidecar), con i risultati salvati in state/cervello.json.
  const cervello = new Cervello(deps.stateDir);
  if (!args.noKronos && !args.fake) {
    const url = args.kronos ?? process.env.KRONOS_URL;
    // Le righe del sidecar finiscono anche in logs/kronos-AAAA-MM-GG.log, per capire cosa fa a finestra chiusa.
    const kronosLog = (l: string) => {
      const line = `${new Date().toISOString()} ${l}`;
      console.log(line);
      try {
        mkdirSync(deps.logsDir, { recursive: true });
        appendFileSync(join(deps.logsDir, `kronos-${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
      } catch {}
    };
    kronos = url ? { url, ready: true, stato: `attivo su ${url} (indicato a mano)`, stop: () => {} } : await ensureKronos({ root: ROOT, log: kronosLog });
    agents.push(new KronosAgent());
  }
  // Intraday: operazioni che si chiudono in giornata, su candele scelte dall'agente (5 min / 15 min / 4 ore). Decide Kronos
  // sulle candele brevi (se il sidecar c'è) con le medie brevi; il grafico più lungo pesa solo sulla taglia.
  if (AGENTS.intraday.enabled) {
    const kf = kronos ? previsioniIntradayCombinate(intradayForecaster(kronos), cervello, deps.now) : null;
    agents.push(new IntradayAgent((s, tf, n) => deps.broker.getIntradayBars(s, tf, n), kf ? async (b, step, h) => Object.fromEntries(Object.entries(await kf(b, step, h)).map(([k, v]) => [k, { path: v.percorso.length ? v.percorso : [v.rendimentoPrevisto], ...(v.campioni ? { campioni: v.campioni } : {}) }])) : null, kf ? (step, s) => cervello.affidabilitaPer(tipoIntraday(step), s) : null, join(deps.stateDir, "kronos-intraday.json")));
  }
  const cache = emptyCache();
  const engine: EngineDeps = {
    ...deps,
    agents,
    bus,
    echo: true,
    forecaster: kronos ? previsioniCombinate(pathForecaster(kronos), cervello, deps.now) : undefined,
    cervello: kronos ? cervello : undefined,
    trimestrali: args.fake ? undefined : nasdaqEarnings,
    kronosStato: kronos ? () => `${kronos!.stato} · campioni per previsione: giornaliere ${CAMPIONI.giorno.stato()}, intraday ${CAMPIONI.intraday.stato()}` : undefined,
    // Nel finto niente rete: solo le coppie del broker finto.
    cryptoUniverse: args.noCrypto ? undefined : { fetchTop: args.fake ? null : coingeckoTop() },
    // Fear & Greed e funding: fonti gratuite senza chiavi, solo nel vero.
    fonti: args.fake ? undefined : new FontiEsterne(),
  };
  console.log(`motore degli agenti${args.fake ? " (finto)" : ""}: ${agents.map((a) => a.name).join(", ")} · stato in ${deps.stateDir}${kronos ? ` · kronos ${kronos.stato}` : ""}`);

  // Candele intraday per il grafico, con la proiezione di Kronos sulle prossime candele (in memoria finché non chiude
  // una candela nuova: il sidecar non si interroga a ogni richiesta della pagina).
  // I grafici (dashboard e pagina pubblica) hanno un canale di campioni proprio, leggero: non tolgono tempo agli agenti.
  const kfChart = kronos ? previsioniIntradayCombinate(intradayForecaster(kronos, "grafico"), cervello, deps.now) : null;
  const memo = new Map<string, { at: number; barre: any[]; previsione: any; ultima: string }>();
  const candele = async (sym: string, tf: string) => {
    const key = `${sym}|${tf}`;
    const m = memo.get(key);
    // Candele da 1 e 5 minuti quasi in diretta (15 secondi), le altre ogni minuto.
    if (m && Date.now() - m.at < (tf === "1Min" || tf === "5Min" ? 15_000 : 60_000)) return { barre: m.barre, previsione: m.previsione };
    const b = (await deps.broker.getIntradayBars([sym], tf, 160))[sym] ?? [];
    const barre = b.map((x) => ({ date: x.t, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
    const ultima = b.at(-1)?.t ?? "";
    let previsione = m && m.ultima === ultima ? m.previsione : null;
    let nota: string | undefined;
    if (!previsione && kfChart && b.length >= 60) {
      try {
        const f = (await kfChart({ [sym]: b }, Number(tf.endsWith("Min") ? tf.replace("Min", "") : Number(tf.replace("Hour", "")) * 60), 12))[sym];
        previsione = f ? { rendimentoPrevisto: f.rendimentoPrevisto, percorso: f.percorso } : null;
      } catch (e) {
        nota = `Kronos: ${(e as Error).message}`;
      }
    }
    memo.set(key, { at: Date.now(), barre, previsione, ultima });
    return { barre, previsione, ...(nota ? { nota } : {}) };
  };
  let dash: ReturnType<typeof startDashboard> | null = null;
  if (!args.noDashboard && !args.once) {
    dash = startDashboard({ port: args.port ?? AGENTS.dashboardPort, stateDir: deps.stateDir, bus, valuta: (s) => valutaTitolo(engine, cache, s), candele, ...(deps.broker.getPortfolioHistory ? { storico: (a: string, b: string, tf: string) => deps.broker.getPortfolioHistory!(a, b, tf) } : {}) });
    console.log(`dashboard su ${dash.url}`);
  }
  if (args.once) {
    const r = await runTick(engine, cache);
    console.log(r.message);
    kronos?.stop();
    process.exit(r.status === "fatto" ? 0 : 1);
  }
  let stop = false;
  let exitCode = 0;
  const quit = (code = 0) => {
    if (stop) return;
    stop = true;
    exitCode = code;
    console.log(code === RESTART_CODE ? "riavvio richiesto: finisco il giro in corso e riparto (avvia-bot.cmd rilancia il motore)" : "chiusura richiesta: finisco il giro in corso e mi fermo");
    dash?.stop();
    kronos?.stop();
    setTimeout(() => process.exit(code), 20_000).unref();
  };
  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  // Riavvio dall'applicazione (Impostazioni → «Riavvia il motore», o il file state/riavvio.richiesta): il processo esce con
  // codice 75 e avvia-bot.cmd lo rilancia, così il codice e le chiavi nuove entrano in uso senza toccare il PC.
  const restartFile = join(deps.stateDir, "riavvio.richiesta");
  const watcher = setInterval(() => {
    if (!existsSync(restartFile)) return;
    try {
      unlinkSync(restartFile);
    } catch {}
    quit(RESTART_CODE);
  }, 5_000);
  watcher.unref();
  // Sorveglianza: un giro che dura più di watchdogMinuti (di solito 1-3 minuti, al massimo 6) è bloccato su una chiamata
  // che non risponde: si scrive nel registro e il motore riparte (codice 75) invece di restare fermo per ore.
  const lockFile = join(deps.stateDir, "run.lock");
  const sorveglianza = setInterval(() => {
    try {
      if (stop || !existsSync(lockFile)) return;
      const l = JSON.parse(readFileSync(lockFile, "utf8")) as { runId?: string; pid?: number; startedAt?: string };
      if (l.pid !== process.pid || !l.startedAt) return;
      const minuti = (Date.now() - Date.parse(l.startedAt)) / 60_000;
      if (minuti < AGENTS.watchdogMinuti) return;
      registro(`giro ${l.runId} bloccato da ${Math.round(minuti)} minuti: riavvio del motore`);
      try { unlinkSync(lockFile); } catch {}
      kronos?.stop();
      process.exit(RESTART_CODE);
    } catch {}
  }, 60_000);
  sorveglianza.unref();
  // Prova sullo storico (src/cli/backtest-intraday.ts raccolta): il file state/backtest.richiesta (con le opzioni nel
  // testo, es. «--giorni 3 --campioni 8») la avvia in un processo a parte, con un sidecar Kronos suo; il motore continua.
  const backtestFile = join(deps.stateDir, "backtest.richiesta");
  const btWatcher = setInterval(() => {
    if (!existsSync(backtestFile)) return;
    let opzioni: string[] = [];
    try { opzioni = readFileSync(backtestFile, "utf8").split(/\s+/).filter(Boolean); unlinkSync(backtestFile); } catch {}
    const log = join(deps.logsDir, `backtest-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      mkdirSync(deps.logsDir, { recursive: true });
      const child = Bun.spawn([process.execPath, join(ROOT, "src", "cli", "backtest-intraday.ts"), "raccolta", ...opzioni], { cwd: ROOT, stdout: Bun.file(log), stderr: Bun.file(log.replace(".log", "-errori.log")) });
      child.unref();
      console.log(`prova sullo storico avviata (pid ${child.pid}): ${log}`);
    } catch (e) {
      console.warn(`prova sullo storico non avviata: ${(e as Error).message}`);
    }
  }, 5_000);
  btWatcher.unref();
  // state/backtest.stop ferma la prova sullo storico e il suo sidecar (porta 8766), anche se l'ha avviata un motore precedente.
  const btStop = join(deps.stateDir, "backtest.stop");
  const btStopWatcher = setInterval(() => {
    if (!existsSync(btStop)) return;
    try { unlinkSync(btStop); } catch {}
    const cmd = process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*backtest-intraday*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"]
      : ["sh", "-c", "pkill -f backtest-intraday; pkill -f 'server.py.*--port 8766'"];
    try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref(); console.log("prova sullo storico fermata"); } catch (e) { console.warn(`prova sullo storico: ${(e as Error).message}`); }
  }, 5_000);
  btStopWatcher.unref();
  // Sala caffè: ogni minuto gli agenti in pausa passano un pezzo del radar, anche tra un giro e l'altro.
  const exploreTimer = setInterval(() => {
    if (!stop) exploreNow(engine, cache).catch((e) => console.warn(`esplorazione: ${(e as Error).message}`));
  }, 60_000);
  exploreTimer.unref();
  // GitHub Pages (se acceso nelle schede): istantanea in sola lettura pubblicata ogni N minuti con il git del PC.
  if (!args.fake) {
    let lastPages = 0;
    const pagesTimer = setInterval(async () => {
      if (!AGENTS.pages.enabled || Date.now() - lastPages < AGENTS.pages.everyMinutes * 60_000) return;
      lastPages = Date.now();
      // Candele brevi per la pagina pubblica: posizioni, custodi, esplorazione e titoli votati, ognuno su 4 candele.
      const titoli = new Map<string, Record<string, unknown>>();
      try {
        const st = JSON.parse(await Bun.file(join(deps.stateDir, "agents-status.json")).text());
        const syms = [...new Set<string>([...(st.posizioni ?? []).map((p: any) => p.simbolo), ...(st.custodi ?? []).map((c: any) => c.simbolo), ...(st.esplorazione?.attive ?? []).map((x: any) => x.simbolo), ...(st.punteggi ?? []).filter((p: any) => p.punteggio > 0).map((p: any) => p.simbolo)])].slice(0, 16);
        for (const sym of syms) {
          const per: Record<string, unknown> = {};
          for (const tf of ["5Min", "15Min", "1Hour", "4Hour"]) {
            try {
              const c = await candele(sym, tf);
              per[tf] = { barre: c.barre.slice(-120), previsione: c.previsione };
            } catch {}
          }
          titoli.set(sym, per);
        }
      } catch (e) {
        console.warn(`candele per la pagina pubblica: ${(e as Error).message}`);
      }
      const r = await publishPages(ROOT, deps.stateDir, Object.fromEntries(titoli));
      console.log(`${new Date().toISOString()} pagina pubblica: ${r.messaggio}`);
      bus.emit("nota", { testo: `pagina pubblica: ${r.messaggio}` });
    }, 30_000);
    pagesTimer.unref();
  }
  await runEngine(engine, (args.tick ?? AGENTS.tickMinutes) * 60_000, () => stop, cache);
  kronos?.stop();
  process.exit(exitCode);
} catch (e) {
  console.error(`ERRORE: ${(e as Error).message}`);
  process.exit(2);
}
