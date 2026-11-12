import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, LIMITS } from "./config.ts";
import { writeJsonAtomic } from "./fsutil.ts";

// Le schede degli agenti: ogni agente ha una descrizione e i parametri che si possono cambiare dalla dashboard.
// I valori cambiati stanno in state/impostazioni-agenti.json e il motore li applica all'inizio di ogni giro (senza
// riavvio); il resto resta quello di src/config.ts. Solo i parametri elencati qui si possono toccare, nei limiti dati.
export interface Param {
  chiave: string; // percorso: "AGENTS.exit.stopPct" o "LIMITS.maxPositions"
  etichetta: string;
  descrizione: string;
  tipo: "numero" | "percento" | "intero" | "scelta" | "bool" | "ora";
  min?: number;
  max?: number;
  passo?: number;
  opzioni?: string[];
}

export interface AgentCard {
  agente: string; // nome interno (trend, custodi, ...) o "motore" per le regole comuni
  titolo: string;
  ruolo: string; // una frase: cosa fa
  come: string; // come decide
  parametri: Param[];
}

export const AGENT_CARDS: AgentCard[] = [
  {
    agente: "motore",
    titolo: "Generali",
    ruolo: "Le regole comuni del profilo di investimento su Alpaca e della piattaforma: quanto si può avere in portafoglio, soglie dei voti, ritmo dei giri, obiettivo del giorno, stop, pagina pubblica su GitHub.",
    come: "L'allocatore somma i voti pesati; sopra la soglia di acquisto compra, sotto quella di vendita vende. La gabbia impone peso massimo per titolo, orari dei titoli (le crypto sempre) e il limite di guadagno del giorno; nessun tetto di perdita né interruttore: decidono gli agenti con Kronos.",
    parametri: [
      { chiave: "AGENTS.tickMinutes", etichetta: "Minuti tra un giro e l'altro", descrizione: "Ogni quanto il motore rilegge conto, prezzi e posizioni: uscite, stop, protezione del profitto.", tipo: "intero", min: 1, max: 60 },
      { chiave: "AGENTS.analisiMinuti", etichetta: "Minuti tra un'analisi d'ingresso e l'altra", descrizione: "Ogni quanto gli agenti decidono se investire e su cosa (scansione intraday con Kronos, nuovi acquisti): più tempo, più campioni per Kronos.", tipo: "intero", min: 5, max: 120 },
      { chiave: "AGENTS.buyScore", etichetta: "Soglia di acquisto", descrizione: "Punteggio netto dei voti oltre il quale si compra.", tipo: "numero", min: 0.1, max: 3, passo: 0.05 },
      { chiave: "AGENTS.sellScore", etichetta: "Soglia di vendita", descrizione: "Punteggio netto sotto il quale si vende (negativo).", tipo: "numero", min: -3, max: -0.1, passo: 0.05 },
      { chiave: "LIMITS.maxPositions", etichetta: "Posizioni massime (sicurezza)", descrizione: "Nessun numero fisso: di serie 1000, solo una sicurezza tecnica. Il limite vero è il capitale, distribuito per qualità delle occasioni.", tipo: "intero", min: 1, max: 1000 },
      { chiave: "LIMITS.maxPositionPct", etichetta: "Peso massimo per titolo", descrizione: "Quota del conto che un solo titolo può occupare.", tipo: "percento", min: 0.02, max: 0.5 },
      { chiave: "AGENTS.pages.enabled", etichetta: "Pagina pubblica su GitHub Pages", descrizione: "Pubblica ogni N minuti un'istantanea in sola lettura sul ramo gh-pages (usa il git del PC). Visibile a chiunque abbia il link.", tipo: "bool" },
      { chiave: "AGENTS.pages.everyMinutes", etichetta: "Pagina pubblica: ogni (minuti)", descrizione: "Ogni quanto si aggiorna l'istantanea.", tipo: "intero", min: 2, max: 120 },
      { chiave: "AGENTS.daily.enabled", etichetta: "Obiettivi personali del giorno con difesa del guadagno", descrizione: "Acceso di serie: ogni persona ha il suo obiettivo del giorno (nella sua scheda, di serie 10%, sale dopo i successi e scende dopo i fallimenti); toccato, si continua a investire, ma se il guadagno dei suoi trade torna a metà si vendono i suoi trade non favorevoli.", tipo: "bool" },
      { chiave: "AGENTS.evidenza.min", etichetta: "Evidenza minima per entrare", descrizione: "Dossier del custode (Kronos, grafico, notizie, contesto) sotto il quale non si apre una posizione nuova sopra la media a 200.", tipo: "percento", min: 0.3, max: 0.9 },
      { chiave: "AGENTS.evidenza.minContro", etichetta: "Evidenza minima sotto la media a 200", descrizione: "Più alta: contro tendenza serve più conferma.", tipo: "percento", min: 0.4, max: 0.95 },
      { chiave: "AGENTS.sizing.byKronos", etichetta: "Taglia proporzionale alla fiducia in Kronos", descrizione: "Più è probabile che la proiezione si avveri, più si investe (fino al peso massimo).", tipo: "bool" },
      { chiave: "AGENTS.sizing.minFactor", etichetta: "Taglia minima (fiducia 50%)", descrizione: "Quota del peso massimo quando la proiezione è incerta.", tipo: "percento", min: 0.05, max: 1 },
      { chiave: "AGENTS.sizing.fullAt", etichetta: "Taglia piena da fiducia", descrizione: "Probabilità oltre la quale si usa tutto il peso massimo.", tipo: "percento", min: 0.55, max: 0.99 },
      { chiave: "AGENTS.sizing.noForecast", etichetta: "Taglia senza proiezione", descrizione: "Quota del peso massimo quando Kronos non ha una proiezione per il titolo.", tipo: "percento", min: 0.05, max: 1 },
      { chiave: "LIMITS.stop.volMultiple", etichetta: "Stop: multiplo della volatilità", descrizione: "Distanza dello stop su Alpaca = multiplo × volatilità giornaliera × √5.", tipo: "numero", min: 1, max: 5, passo: 0.1 },
      { chiave: "LIMITS.stop.minPct", etichetta: "Stop minimo", descrizione: "Distanza minima dello stop dal carico.", tipo: "percento", min: 0.01, max: 0.2 },
      { chiave: "LIMITS.stop.maxPct", etichetta: "Stop massimo", descrizione: "Distanza massima dello stop dal carico.", tipo: "percento", min: 0.02, max: 0.3 },
      { chiave: "AGENTS.entryWindow.from", etichetta: "Acquisti titoli: da (riserva)", descrizione: "Di norma vale l'orario vero della borsa dato da Alpaca (tutta la seduta, fino a 5 minuti dalla chiusura); questo orario di Roma serve solo se Alpaca non lo dà.", tipo: "ora" },
      { chiave: "AGENTS.entryWindow.to", etichetta: "Acquisti titoli: fino a (riserva)", descrizione: "Come sopra: solo senza l'orario di Alpaca. Le crypto non hanno orario.", tipo: "ora" },
      { chiave: "AGENTS.summaryAfter", etichetta: "Riepilogo Telegram dopo le", descrizione: "Ora del riepilogo serale con il conto di profitto e perdita.", tipo: "ora" },
      { chiave: "AGENTS.cryptoUniverse.topMarketCap", etichetta: "Crypto: top N per capitalizzazione", descrizione: "Quante crypto della classifica CoinGecko si considerano (incrociate con Alpaca).", tipo: "intero", min: 5, max: 250 },
      { chiave: "AGENTS.cryptoUniverse.maxPairs", etichetta: "Crypto: coppie massime", descrizione: "Tetto alle coppie seguite ogni giorno.", tipo: "intero", min: 1, max: 60 },
    ],
  },
  {
    agente: "trend",
    titolo: "Trend",
    ruolo: "Il metodo di fondo: compra chi è in trend e vende chi lo perde.",
    come: "Compra i titoli che chiudono sopra le medie a 50 e 200 giorni con rendimento a 12 mesi positivo (crypto: anche a 3 mesi), i migliori per momentum a 6 mesi; vende chi chiude sotto la media a 50.",
    parametri: [
      { chiave: "LIMITS.trendSmaDays", etichetta: "Media breve (giorni)", descrizione: "Sopra questa media si compra, sotto si vende.", tipo: "intero", min: 10, max: 150 },
      { chiave: "LIMITS.longSmaDays", etichetta: "Media lunga (giorni)", descrizione: "Il trend di lungo periodo deve essere positivo.", tipo: "intero", min: 50, max: 300 },
      { chiave: "LIMITS.rankMomentumDays", etichetta: "Classifica: momentum su (giorni)", descrizione: "Finestra del rendimento con cui si ordinano i candidati.", tipo: "intero", min: 20, max: 252 },
      { chiave: "AGENTS.absMomentum.days", etichetta: "Momentum assoluto: finestra (giorni)", descrizione: "Rendimento che deve essere positivo per entrare.", tipo: "intero", min: 60, max: 400 },
      { chiave: "AGENTS.cryptoMomentumDays", etichetta: "Crypto: momentum breve (giorni)", descrizione: "Per le crypto anche questo rendimento deve essere positivo.", tipo: "intero", min: 10, max: 200 },
    ],
  },
  {
    agente: "rientro",
    titolo: "Rientro",
    ruolo: "Compra i ritracciamenti brevi dentro un trend lungo, a taglia ridotta.",
    come: "RSI a 2 giorni sotto la soglia con prezzo sopra la media a 200; esce quando l'RSI supera la soglia alta o dopo N sedute.",
    parametri: [
      { chiave: "AGENTS.pullback.rsiEntry", etichetta: "RSI(2) di ingresso", descrizione: "Sotto questo valore il titolo è ipervenduto di breve.", tipo: "intero", min: 2, max: 40 },
      { chiave: "AGENTS.pullback.rsiExit", etichetta: "RSI(2) di uscita", descrizione: "Sopra questo valore si esce.", tipo: "intero", min: 50, max: 95 },
      { chiave: "AGENTS.pullback.maxHoldSessions", etichetta: "Sedute massime", descrizione: "Dopo tante sedute si esce comunque.", tipo: "intero", min: 1, max: 20 },
      { chiave: "AGENTS.pullback.maxWeight", etichetta: "Peso massimo", descrizione: "Quota del conto per un'operazione di rientro.", tipo: "percento", min: 0.01, max: 0.2 },
    ],
  },
  {
    agente: "regime",
    titolo: "Regime",
    ruolo: "Misura il clima del mercato e riduce le taglie quando è brutto.",
    come: "SPY sotto la media a 200 o volatilità alta: il rischio ammesso scende e tutte le taglie si riducono.",
    parametri: [
      { chiave: "AGENTS.regime.bearScale", etichetta: "Scala con SPY sotto la 200", descrizione: "Moltiplicatore delle taglie in mercato in discesa.", tipo: "numero", min: 0, max: 1, passo: 0.05 },
      { chiave: "AGENTS.regime.highVolDaily", etichetta: "Soglia di volatilità alta (giornaliera)", descrizione: "Oltre questa volatilità di SPY il clima è nervoso.", tipo: "percento", min: 0.005, max: 0.05 },
      { chiave: "AGENTS.regime.highVolScale", etichetta: "Scala con volatilità alta", descrizione: "Moltiplicatore delle taglie con volatilità alta.", tipo: "numero", min: 0, max: 1, passo: 0.05 },
    ],
  },
  {
    agente: "uscite",
    titolo: "Uscite",
    ruolo: "Le regole vincolanti di uscita: proteggono ogni posizione.",
    come: "Stop scalato sulla volatilità (o fisso), uscita normale sul trend; in alternativa la politica a obiettivo; trailing opzionale; proiezione di Kronos negativa: esce.",
    parametri: [
      { chiave: "AGENTS.trimestrali.uscita", etichetta: "Uscita prima delle trimestrali", descrizione: "Nell'ultima seduta prima dei conti decide da guadagno/perdita, salto atteso e Kronos: tutto, metà o niente.", tipo: "bool" },
      { chiave: "AGENTS.trimestrali.minutiPrimaChiusura", etichetta: "Trimestrali: minuti prima della chiusura", descrizione: "Quando decidere nell'ultima seduta prima dei conti.", tipo: "intero", min: 10, max: 390 },
      { chiave: "AGENTS.trimestrali.movimentoVol", etichetta: "Trimestrali: salto atteso (× volatilità)", descrizione: "Il salto atteso ai conti in multipli della volatilità giornaliera.", tipo: "numero", min: 1, max: 8, passo: 0.5 },
      { chiave: "AGENTS.trimestrali.movimentoMin", etichetta: "Trimestrali: salto atteso minimo", descrizione: "Il salto atteso non è mai sotto questa percentuale.", tipo: "percento", min: 0.01, max: 0.2 },
      { chiave: "AGENTS.trimestrali.fiduciaTenere", etichetta: "Trimestrali: probabilità di Kronos per tenere metà", descrizione: "Con un guadagno piccolo o una perdita piccola si tiene metà solo se Kronos vede rialzo almeno con questa probabilità.", tipo: "percento", min: 0.5, max: 0.95 },
      { chiave: "AGENTS.exit.mode", etichetta: "Politica", descrizione: "trend: nessun obiettivo, esce il trend; obiettivo: prende profitto a una percentuale.", tipo: "scelta", opzioni: ["trend", "obiettivo"] },
      { chiave: "AGENTS.exit.stopMode", etichetta: "Stop", descrizione: "volatilita: 2,5 × vol × √5 (5-10%); fisso: la percentuale sotto.", tipo: "scelta", opzioni: ["volatilita", "fisso"] },
      { chiave: "AGENTS.exit.stopPct", etichetta: "Stop fisso", descrizione: "Usato solo con stop fisso.", tipo: "percento", min: 0.005, max: 0.2 },
      { chiave: "AGENTS.exit.targetPct", etichetta: "Obiettivo", descrizione: "Usato solo con la politica a obiettivo.", tipo: "percento", min: 0.005, max: 0.3 },
      { chiave: "AGENTS.exit.trailAtr", etichetta: "Trailing (ATR dal massimo)", descrizione: "0 = spento; N = esce a N ATR sotto il massimo visto.", tipo: "numero", min: 0, max: 6, passo: 0.5 },
    ],
  },
  {
    agente: "profitto",
    titolo: "Presa di profitto",
    ruolo: "Mette al sicuro una parte del guadagno e lascia correre il resto.",
    come: "Quando una posizione supera la percentuale, vende la frazione indicata; il resto segue il trend.",
    parametri: [
      { chiave: "AGENTS.takeProfit.enabled", etichetta: "Attiva", descrizione: "Spenta, nessuna presa di profitto parziale.", tipo: "bool" },
      { chiave: "AGENTS.takeProfit.pct", etichetta: "Soglia di guadagno", descrizione: "Dal carico.", tipo: "percento", min: 0.005, max: 0.3 },
      { chiave: "AGENTS.takeProfit.fraction", etichetta: "Frazione venduta", descrizione: "Quota della posizione che si vende alla soglia.", tipo: "percento", min: 0.1, max: 1 },
    ],
  },
  {
    agente: "contesto",
    titolo: "Contesto economico",
    ruolo: "Legge il clima generale e per settore prima di ogni trade.",
    come: "Regole sui dati (SPY, settori, oro e obbligazioni, Fed) e lettura con claude se disponibile. Con Kronos che anticipa un rialzo il settore debole non ferma l'ingresso; con un ribasso anticipato si aspetta.",
    parametri: [
      { chiave: "AGENTS.context.enabled", etichetta: "Attivo", descrizione: "Spento, nessun filtro di contesto.", tipo: "bool" },
      { chiave: "AGENTS.context.useClaude", etichetta: "Lettura con claude e ricerca web", descrizione: "Richiede claude -p installato; cache 6 ore.", tipo: "bool" },
      { chiave: "AGENTS.context.unfavorableScale", etichetta: "Scala con contesto sfavorevole", descrizione: "Moltiplicatore dell'esposizione.", tipo: "numero", min: 0, max: 1, passo: 0.05 },
      { chiave: "AGENTS.context.neutralScale", etichetta: "Scala con contesto neutro", descrizione: "Moltiplicatore dell'esposizione.", tipo: "numero", min: 0, max: 1, passo: 0.05 },
      { chiave: "AGENTS.context.waitDaysBeforeEvent", etichetta: "Giorni di attesa prima della Fed", descrizione: "Nei giorni prima di una decisione della Fed tutto è neutro.", tipo: "intero", min: 0, max: 10 },
    ],
  },
  {
    agente: "kronos",
    titolo: "Kronos",
    ruolo: "Il modello di previsione: la fonte principale per anticipare la direzione.",
    come: "Una volta al giorno proietta le prossime sedute; vota solo le proiezioni più nette e nel verso del trend; oltre la soglia di anticipo sblocca o ferma gli ingressi degli altri agenti.",
    parametri: [
      { chiave: "AGENTS.kronos.horizon", etichetta: "Orizzonte (sedute)", descrizione: "Quante sedute avanti proietta.", tipo: "intero", min: 1, max: 20 },
      { chiave: "AGENTS.kronos.topShare", etichetta: "Quota di proiezioni tenute", descrizione: "Di serie 100%: ogni rialzo oltre la soglia vota (la forza cresce con la proiezione). Più bassa, solo le più nette.", tipo: "percento", min: 0.05, max: 1 },
      { chiave: "AGENTS.kronos.anticipaSoglia", etichetta: "Soglia di anticipo", descrizione: "Oltre questa proiezione (in valore assoluto) Kronos anticipa un rialzo o un ribasso.", tipo: "percento", min: 0.002, max: 0.1 },
      { chiave: "AGENTS.kronos.controTendenza.enabled", etichetta: "Ingressi contro tendenza", descrizione: "Sotto la media a 200 si entra solo se Kronos è netto e la probabilità di successo è sufficiente, a taglia ridotta.", tipo: "bool" },
      { chiave: "AGENTS.kronos.controTendenza.minRendimento", etichetta: "Contro tendenza: Kronos minimo", descrizione: "Rialzo previsto a 5 sedute sotto il quale non si va contro tendenza.", tipo: "percento", min: 0.005, max: 0.2 },
      { chiave: "AGENTS.kronos.controTendenza.minFiducia", etichetta: "Contro tendenza: probabilità minima", descrizione: "Probabilità che la proiezione si avveri (rendimento atteso rispetto alla volatilità).", tipo: "percento", min: 0.5, max: 0.95 },
      { chiave: "AGENTS.kronos.campioni.esplorazione.msPerSerie", etichetta: "Campioni: tempo per titolo, esplorazione (ms)", descrizione: "Prima scrematura del radar: chi entra nell'universo viene riproiettato con il budget delle giornaliere.", tipo: "intero", min: 300, max: 8_000 },
      { chiave: "AGENTS.kronos.campioni.max", etichetta: "Campioni: massimo", descrizione: "Quanti percorsi Kronos genera e media al massimo per previsione (più = più stabile, più lento).", tipo: "intero", min: 4, max: 128 },
      { chiave: "AGENTS.kronos.campioni.giorno.msPerSerie", etichetta: "Campioni: tempo per titolo, giornaliere (ms)", descrizione: "Tempo concesso a ogni titolo nelle proiezioni giornaliere: il motore chiede il massimo dei campioni che ci sta.", tipo: "intero", min: 300, max: 15_000 },
      { chiave: "AGENTS.kronos.campioni.intraday.msPerSerie", etichetta: "Campioni: tempo per titolo, intraday (ms)", descrizione: "Tempo concesso a ogni titolo e candela sulle proiezioni brevi, nell'analisi d'ingresso.", tipo: "intero", min: 100, max: 10_000 },
      { chiave: "AGENTS.kronos.cervello.affidabilita.kronos", etichetta: "Cervello: affidabilità di Kronos", descrizione: "Scala a priori (0-1): addestrato su 12 miliardi di candele da 45 borse, il più forte sui rendimenti nelle prove pubblicate.", tipo: "numero", min: 0, max: 1, passo: 0.01 },
      { chiave: "AGENTS.kronos.cervello.affidabilita.chronos2", etichetta: "Cervello: affidabilità di Chronos-2", descrizione: "Scala a priori (0-1): modello generico (dati misti e sintetici), debole sui rendimenti nelle prove pubblicate.", tipo: "numero", min: 0, max: 1, passo: 0.01 },
      { chiave: "AGENTS.kronos.cervello.affidabilita.timesfm", etichetta: "Cervello: affidabilità di TimesFM 2.5", descrizione: "Scala a priori (0-1): modello generico, sui rendimenti peggio del caso nelle prove pubblicate.", tipo: "numero", min: 0, max: 1, passo: 0.01 },
      { chiave: "AGENTS.kronos.cervello.minCampione", etichetta: "Cervello: previsioni prima di contare i risultati", descrizione: "Sotto questo numero di previsioni valutate un modello pesa solo per la sua affidabilità.", tipo: "intero", min: 20, max: 2000 },
      { chiave: "AGENTS.kronos.cervello.kronosMinimo", etichetta: "Cervello: quota minima di Kronos", descrizione: "Finché Kronos non risulta peggiore del caso, tiene almeno questa parte del peso.", tipo: "percento", min: 0, max: 1 },
      { chiave: "AGENTS.kronos.controTendenza.pesoFattore", etichetta: "Contro tendenza: quota del peso massimo", descrizione: "Quota del peso massimo per titolo usabile sotto la media a 200.", tipo: "percento", min: 0.1, max: 1 },
      { chiave: "AGENTS.kronos.model", etichetta: "Modello (al prossimo riavvio)", descrizione: "mini è veloce, small è il compromesso, base è il più lento.", tipo: "scelta", opzioni: ["mini", "small", "base"] },
    ],
  },
  {
    agente: "custodi",
    titolo: "Custodi",
    ruolo: "Un investitore per ogni titolo in trend: tesi, piano, rischio e dossier.",
    come: "Entra meglio sul rientro verso la media a 20 giorni, evita i prezzi troppo estesi, esce sotto la media a 50 o con slancio a 3 mesi negativo; il dossier (Kronos, grafico, notizie, contesto) e la memoria del titolo modulano la forza.",
    parametri: [
      { chiave: "AGENTS.custodi.enabled", etichetta: "Attivi", descrizione: "Spenti, niente custodi.", tipo: "bool" },
      { chiave: "AGENTS.custodi.pullbackSmaDays", etichetta: "Media del rientro (giorni)", descrizione: "Vicino a questa media l'ingresso è migliore.", tipo: "intero", min: 5, max: 60 },
      { chiave: "AGENTS.custodi.extendedPct", etichetta: "Esteso oltre la media a 50", descrizione: "Sopra questa distanza si entra solo a taglia ridotta.", tipo: "percento", min: 0.03, max: 0.5 },
      { chiave: "AGENTS.custodi.minProbabilita", etichetta: "Probabilità minima del dossier per votare l'acquisto", descrizione: "Sotto questa probabilità favorevole il trading agent non vota (è il suo «restare fuori»). Il capo ufficio la alza di un passo se la squadra o il singolo vincono meno del 51%.", tipo: "percento", min: 0.3, max: 0.8 },
      { chiave: "AGENTS.custodi.keepIdleTicks", etichetta: "Giri di attesa prima di lasciare", descrizione: "Dopo tanti giri fuori dai criteri il custode muore.", tipo: "intero", min: 1, max: 200 },
    ],
  },
  {
    agente: "intraday",
    titolo: "Intraday",
    ruolo: "Operazioni che si aprono e si chiudono in giornata, su candele scelte dalla volatilità.",
    come: "Rottura dei massimi a 20 candele o rientro sulla media a 20 candele, nel verso del trend giornaliero e di Kronos; obiettivo e stop dall'ATR; chiusura forzata prima della fine della giornata.",
    parametri: [
      { chiave: "AGENTS.intraday.enabled", etichetta: "Attivo", descrizione: "Spento, niente operazioni intraday.", tipo: "bool" },
      { chiave: "AGENTS.intraday.volFast", etichetta: "Volatilità per candele a 5 minuti", descrizione: "Sopra questa volatilità giornaliera si usa la candela corta.", tipo: "percento", min: 0.005, max: 0.1 },
      { chiave: "AGENTS.intraday.volMid", etichetta: "Volatilità per candele a 15 minuti", descrizione: "Tra questa e la precedente: 15 minuti; sotto: 4 ore.", tipo: "percento", min: 0.002, max: 0.08 },
      { chiave: "AGENTS.intraday.target.stocks", etichetta: "Obiettivo minimo titoli", descrizione: "Se l'ATR dice di più, vale l'ATR.", tipo: "percento", min: 0.002, max: 0.05 },
      { chiave: "AGENTS.intraday.target.crypto", etichetta: "Obiettivo minimo crypto", descrizione: "Se l'ATR dice di più, vale l'ATR.", tipo: "percento", min: 0.002, max: 0.1 },
      { chiave: "AGENTS.intraday.targetAtr", etichetta: "Obiettivo in ATR", descrizione: "Multiplo dell'ATR della candela.", tipo: "numero", min: 0.5, max: 5, passo: 0.1 },
      { chiave: "AGENTS.intraday.stopAtr", etichetta: "Stop in ATR", descrizione: "Multiplo dell'ATR della candela.", tipo: "numero", min: 0.3, max: 5, passo: 0.1 },
      { chiave: "AGENTS.intraday.minStopPct.stocks", etichetta: "Stop minimo titoli", descrizione: "Distanza minima dello stop dall'ingresso.", tipo: "percento", min: 0.001, max: 0.05 },
      { chiave: "AGENTS.intraday.minStopPct.crypto", etichetta: "Stop minimo crypto", descrizione: "Sopra il costo di andata e ritorno (0,5%): con uno stop più stretto ogni perdita costa quasi il doppio.", tipo: "percento", min: 0.002, max: 0.1 },
      { chiave: "AGENTS.intraday.kronos.minProb", etichetta: "Probabilità minima di Kronos", descrizione: "Probabilità che il rialzo previsto sulla candela e sull'orizzonte scelti si avveri.", tipo: "percento", min: 0.5, max: 0.95 },
      { chiave: "AGENTS.intraday.scadenzaOrizzonte", etichetta: "Scadenza dell'orizzonte (multiplo)", descrizione: "Oltre questo multiplo dell'orizzonte scelto, senza obiettivo e senza rialzo ancora probabile, si chiude.", tipo: "numero", min: 1, max: 4, passo: 0.1 },
      { chiave: "AGENTS.intraday.maxWeight", etichetta: "Peso massimo per operazione", descrizione: "Quota del conto che un'operazione intraday può occupare al massimo; la taglia vera la decide il rischio allo stop (40% di serie, raggiunto solo dalle occasioni più probabili).", tipo: "percento", min: 0.01, max: 0.5 },
      { chiave: "AGENTS.intraday.budget.quota", etichetta: "Budget intraday (investito insieme)", descrizione: "Quota del conto investita in operazioni intraday nello stesso momento: 100% di serie (dal 12/11/2026), divisa tra le occasioni in base alla probabilità e alla qualità; un'operazione al massimo un quarto del budget, il doppio se molto probabile (sempre entro il peso massimo).", tipo: "percento", min: 0.05, max: 1 },
      { chiave: "AGENTS.intraday.budget.maxCrypto", etichetta: "Quota massima in crypto", descrizione: "Quanto del conto può stare in crypto insieme: 100% di serie (dal 12/11/2026, era 20%). Le crypto si muovono insieme: più è alta, più il conto segue il mercato crypto.", tipo: "percento", min: 0.05, max: 1 },
      { chiave: "AGENTS.intraday.budget.riservaOccasioni.enabled", etichetta: "Riserva per le occasioni", descrizione: "A budget pieno, la liquidità rimasta va a un'occasione nettamente migliore (probabilità ≥ soglia + vantaggio).", tipo: "bool" },
      { chiave: "AGENTS.intraday.budget.riservaOccasioni.quota", etichetta: "Riserva: quota del conto", descrizione: "Quanta liquidità si tiene per le occasioni in più (20% di serie).", tipo: "percento", min: 0, max: 0.5 },
      { chiave: "AGENTS.intraday.budget.riservaOccasioni.extraProb", etichetta: "Riserva: vantaggio richiesto", descrizione: "Punti di probabilità sopra la soglia d'ingresso per usare la riserva.", tipo: "percento", min: 0, max: 0.3 },
      { chiave: "AGENTS.intraday.budget.riservaOccasioni.maxTrade", etichetta: "Riserva: massimo a operazione", descrizione: "Quota del conto che un'operazione può prendere dalla riserva.", tipo: "percento", min: 0.02, max: 0.2 },
      { chiave: "AGENTS.intraday.budget.reinvesti.enabled", etichetta: "Reinvesti il profitto accumulato", descrizione: "Il guadagno accumulato dal capitale di partenza si aggiunge al budget intraday (oltre la quota di serie), fino al tetto. Sotto il capitale di partenza vale la quota di serie.", tipo: "bool" },
      { chiave: "AGENTS.intraday.budget.reinvesti.quota", etichetta: "Parte del profitto reinvestita", descrizione: "100% = tutto il profitto accumulato va nel budget delle nuove operazioni.", tipo: "percento", min: 0, max: 1 },
      { chiave: "AGENTS.intraday.budget.reinvesti.tetto", etichetta: "Tetto del budget con il profitto", descrizione: "Quota massima del conto investita insieme in intraday anche con molto profitto reinvestito (conta solo con il budget sotto il 100%).", tipo: "percento", min: 0.5, max: 1 },
      { chiave: "AGENTS.cryptoAcquisti.enabled", etichetta: "Acquisti crypto", descrizione: "Spento dal 10/11/2026: nella prova sullo storico le crypto intraday vincevano il 20-25% dei trade. Le crypto già aperte si gestiscono fino all'uscita.", tipo: "bool" },
      { chiave: "AGENTS.intraday.sostituzione.enabled", etichetta: "Sostituzione dei trade deboli", descrizione: "Con budget o contanti pieni, si vende l'operazione aperta più debole (oggi non la si aprirebbe) per far posto a un'occasione nuova nettamente più probabile.", tipo: "bool" },
      { chiave: "AGENTS.intraday.sostituzione.margine", etichetta: "Sostituzione: vantaggio minimo", descrizione: "Punti di probabilità in più che l'occasione nuova deve avere rispetto a quella che si vende.", tipo: "percento", min: 0.03, max: 0.3 },
      { chiave: "AGENTS.intraday.sostituzione.maxGiorno", etichetta: "Sostituzioni al giorno", descrizione: "Al massimo questo numero di sostituzioni al giorno (una per giro).", tipo: "intero", min: 0, max: 10 },
      { chiave: "AGENTS.intraday.sostituzione.minMinuti", etichetta: "Sostituzione: minuti minimi in posizione", descrizione: "Un'operazione aperta da meno di questi minuti non si sostituisce.", tipo: "intero", min: 5, max: 240 },
      { chiave: "AGENTS.intraday.budget.rischioTrade", etichetta: "Rischio per operazione", descrizione: "Perdita massima allo stop di un'operazione intraday (stop + costi + scivolamento), in quota del conto: decide la taglia.", tipo: "percento", min: 0.0005, max: 0.01 },
      { chiave: "AGENTS.intraday.taglia.probabilita.enabled", etichetta: "Taglia secondo la probabilità", descrizione: "Più è probabile che la previsione si avveri, più si investe: alla soglia la metà del rischio di serie, 15 punti sopra il doppio (sempre dentro i tetti).", tipo: "bool" },
      { chiave: "AGENTS.intraday.taglia.probabilita.max", etichetta: "Moltiplicatore massimo della taglia", descrizione: "Quante volte il rischio di serie si investe quando la probabilità è ben sopra la soglia.", tipo: "numero", min: 1, max: 3, passo: 0.25 },
      { chiave: "AGENTS.intraday.kronos.minProbSenzaGrafico", etichetta: "Probabilità minima senza medie brevi in ordine", descrizione: "Quando le medie brevi della candela non sono ancora in ordine (anche per il rimbalzo).", tipo: "percento", min: 0.5, max: 0.95 },
      { chiave: "AGENTS.costi.margineCosti", etichetta: "Margine sui costi", descrizione: "Il rialzo previsto deve valere almeno tante volte i costi di andata e ritorno.", tipo: "numero", min: 1, max: 5, passo: 0.5 },
      { chiave: "AGENTS.intraday.ingressiGiorno.max", etichetta: "Ingressi al giorno per titolo", descrizione: "Dopo un'operazione chiusa in guadagno si può rientrare, fino a questo numero di ingressi al giorno.", tipo: "intero", min: 1, max: 6 },
      { chiave: "AGENTS.intraday.riporto.minProb", etichetta: "Probabilità minima per riportare al giorno dopo", descrizione: "A fine giornata un'operazione si tiene solo se Kronos sulle candele vede ancora salire con questa probabilità.", tipo: "percento", min: 0.5, max: 0.9 },
      { chiave: "AGENTS.intraday.evidenza.peso", etichetta: "Peso del dossier nella decisione", descrizione: "Quanto contano dossier e contesto nella probabilità con cui si entra (il resto è Kronos sulle candele).", tipo: "percento", min: 0, max: 0.4 },
      { chiave: "AGENTS.prudenzaMedie.intraday.sopra", etichetta: "Taglia sopra le medie a 50 e 200", descrizione: "Moltiplicatore della taglia intraday.", tipo: "numero", min: 0.2, max: 1, passo: 0.05 },
      { chiave: "AGENTS.prudenzaMedie.intraday.sotto50", etichetta: "Taglia sotto la media a 50", descrizione: "Moltiplicatore della taglia intraday (sopra la 200).", tipo: "numero", min: 0.2, max: 1, passo: 0.05 },
      { chiave: "AGENTS.prudenzaMedie.intraday.sotto200", etichetta: "Taglia sotto la media a 200", descrizione: "Moltiplicatore della taglia intraday (sopra la 50).", tipo: "numero", min: 0.2, max: 1, passo: 0.05 },
      { chiave: "AGENTS.prudenzaMedie.intraday.sottoEntrambe", etichetta: "Taglia sotto le medie a 50 e 200", descrizione: "Moltiplicatore della taglia intraday.", tipo: "numero", min: 0.2, max: 1, passo: 0.05 },
      { chiave: "AGENTS.intraday.maxExtensionAtr", etichetta: "Estensione massima (ATR)", descrizione: "Oltre tanti ATR sopra la rottura non si insegue.", tipo: "numero", min: 1, max: 8, passo: 0.5 },
      { chiave: "AGENTS.intraday.cryptoOreMax", etichetta: "Crypto: durata massima (ore)", descrizione: "Le crypto non chiudono mai: un'operazione intraday si chiude al più tardi dopo tante ore.", tipo: "intero", min: 1, max: 48 },
      { chiave: "AGENTS.intraday.minutiPrimaChiusura.ingresso", etichetta: "Azioni: ultimo ingresso (minuti prima della chiusura)", descrizione: "Dall'orario vero della borsa.", tipo: "intero", min: 5, max: 180 },
      { chiave: "AGENTS.intraday.minutiPrimaChiusura.uscita", etichetta: "Azioni: uscita (minuti prima della chiusura)", descrizione: "Le operazioni intraday sulle azioni si chiudono prima della chiusura della borsa.", tipo: "intero", min: 1, max: 60 },
      { chiave: "AGENTS.intraday.closeBy.stocks", etichetta: "Azioni: chiusura (riserva, ora di Roma)", descrizione: "Solo se Alpaca non dà l'orario di chiusura.", tipo: "ora" },
    ],
  },
];

export const agentSettingsPath = (stateDir: string) => join(stateDir, "impostazioni-agenti.json");
const ROOTS: Record<string, any> = { AGENTS, LIMITS };
const DEFAULTS = new Map<string, unknown>();
for (const c of AGENT_CARDS) for (const p of c.parametri) DEFAULTS.set(p.chiave, getPath(p.chiave));

export function getPath(chiave: string): unknown {
  const [root, ...rest] = chiave.split(".");
  let o: any = ROOTS[root!];
  for (const k of rest) o = o?.[k];
  return o;
}
export function setPath(chiave: string, value: unknown) {
  const [root, ...rest] = chiave.split(".");
  let o: any = ROOTS[root!];
  for (const k of rest.slice(0, -1)) o = o[k];
  o[rest[rest.length - 1]!] = value;
}
export const paramOf = (chiave: string) => AGENT_CARDS.flatMap((c) => c.parametri).find((p) => p.chiave === chiave);

// Controlla un valore contro lo schema: tipo e limiti. Restituisce il valore pulito o un errore.
export function validate(chiave: string, raw: unknown): { ok: true; value: unknown } | { ok: false; errore: string } {
  const p = paramOf(chiave);
  if (!p) return { ok: false, errore: `parametro sconosciuto: ${chiave}` };
  if (p.tipo === "bool") return { ok: true, value: raw === true || raw === "true" || raw === 1 };
  if (p.tipo === "scelta") return p.opzioni!.includes(String(raw)) ? { ok: true, value: String(raw) } : { ok: false, errore: `${p.etichetta}: valori ammessi ${p.opzioni!.join(", ")}` };
  if (p.tipo === "ora") return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false, errore: `${p.etichetta}: ora nel formato HH:MM` };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, errore: `${p.etichetta}: serve un numero` };
  if (p.tipo === "intero" && !Number.isInteger(n)) return { ok: false, errore: `${p.etichetta}: serve un numero intero` };
  if (p.min !== undefined && n < p.min) return { ok: false, errore: `${p.etichetta}: minimo ${p.min}` };
  if (p.max !== undefined && n > p.max) return { ok: false, errore: `${p.etichetta}: massimo ${p.max}` };
  return { ok: true, value: n };
}

export function readAgentSettings(stateDir: string): Record<string, unknown> {
  const p = agentSettingsPath(stateDir);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && v.valori && typeof v.valori === "object" ? v.valori : {};
  } catch {
    return {};
  }
}

// Applica il file al motore (ogni giro): prima i valori di serie, poi quelli cambiati, così togliere una voce la riporta di serie.
export function applyAgentSettings(stateDir: string): { applicati: string[]; errori: string[] } {
  const saved = readAgentSettings(stateDir);
  const applicati: string[] = [];
  const errori: string[] = [];
  for (const [k, d] of DEFAULTS) setPath(k, d);
  for (const [k, v] of Object.entries(saved)) {
    const r = validate(k, v);
    if (!r.ok) {
      errori.push(r.errore);
      continue;
    }
    setPath(k, r.value);
    applicati.push(k);
  }
  return { applicati, errori };
}

// Salva i valori cambiati (solo quelli diversi da quelli di serie) e li applica subito.
export function saveAgentSettings(stateDir: string, incoming: Record<string, unknown>): { ok: true; salvati: Record<string, unknown> } | { ok: false; errori: string[] } {
  const out: Record<string, unknown> = {};
  const errori: string[] = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined || v === "") continue; // vuoto = torna di serie
    const r = validate(k, v);
    if (!r.ok) {
      errori.push(r.errore);
      continue;
    }
    if (r.value !== DEFAULTS.get(k)) out[k] = r.value;
  }
  if (errori.length) return { ok: false, errori };
  writeJsonAtomic(agentSettingsPath(stateDir), { versione: 1, aggiornato: new Date().toISOString(), valori: out });
  applyAgentSettings(stateDir);
  return { ok: true, salvati: out };
}

// Per la dashboard: le schede con valore di serie e valore attuale di ogni parametro.
export function agentCardsWithValues(stateDir: string) {
  const saved = readAgentSettings(stateDir);
  return AGENT_CARDS.map((c) => ({ ...c, parametri: c.parametri.map((p) => ({ ...p, diSerie: DEFAULTS.get(p.chiave), attuale: p.chiave in saved ? saved[p.chiave] : DEFAULTS.get(p.chiave), cambiato: p.chiave in saved })) }));
}
