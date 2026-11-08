// Unico endpoint di trading ammesso. Non è configurabile, di proposito.
export const PAPER_TRADING_URL = "https://paper-api.alpaca.markets";
// Dati di mercato (solo lettura, prezzi). Stesso host per paper e live.
export const MARKET_DATA_URL = "https://data.alpaca.markets";

export const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"] as const;
// Coppie crypto di Alpaca: 24 ore su 24, quantità frazionarie, ordine minimo 10 $, stop solo come stop_limit.
export const CRYPTO = ["BTC/USD", "ETH/USD"] as const;
export const isCrypto = (symbol: string) => symbol.includes("/");
export const CRYPTO_MIN_NOTIONAL = 10;
// Settori: servono al contesto economico per dire "in questo settore oggi si aspetta".
export const SECTORS: Record<string, string> = { SPY: "indici", IWM: "indici", QQQ: "tecnologia", AAPL: "tecnologia", MSFT: "tecnologia", NVDA: "tecnologia", GLD: "oro", TLT: "obbligazioni", "BTC/USD": "crypto", "ETH/USD": "crypto" };
export const sectorOf = (symbol: string) => SECTORS[symbol] ?? (isCrypto(symbol) ? "crypto" : "altro");
// Stablecoin e token ancorati: mai in portafoglio, non hanno trend.
export const STABLECOINS = new Set(["USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "PYUSD", "USDS", "USD1", "BUSD", "FRAX", "LUSD", "GUSD", "USDP", "WBTC", "WETH", "STETH", "WSTETH", "CBBTC", "WEETH", "RETH", "LBTC", "SUSDE", "SUSDS", "BSC-USD", "USDTB", "USDD", "RLUSD", "XAUT", "PAXG", "USDG", "USDY", "USD0", "EURC", "USDL", "BUIDL", "CUSD", "SUSD", "MUSD", "DOLA"]);
export const CRYPTO_QTY_DECIMALS = 6;
// Prezzo limite dello stop_limit crypto: mezzo punto sotto lo stop, così scatta e viene eseguito anche con un buco.
export const CRYPTO_STOP_LIMIT_GAP = 0.005;

export const LIMITS = {
  // Scelta dell'utente: al massimo il 10% del patrimonio per titolo, e meno se la proiezione di Kronos è incerta
  // (vedi AGENTS.sizing). Nessun numero fisso di titoli: tanti quante sono le occasioni (il tetto qui è solo una sicurezza;
  // il limite vero è la liquidità, con il 10% per titolo).
  maxPositions: 100,
  maxPositionPct: 0.1,
  // Stop di protezione: non è più l'uscita normale (quella è il trend), serve solo contro i crolli.
  // Distanza = multiplo × volatilità giornaliera × √giorni, arrotondata al mezzo punto e tenuta tra min e max.
  stop: { volMultiple: 2.5, horizonDays: 5, minPct: 0.05, maxPct: 0.1 },
  // Una posizione non deve poter muovere il conto di più di così in un giorno tipico (valore × volatilità giornaliera).
  dailyRiskPerPositionPct: 0.0025,
  // Volatilità usata quando lo storico non basta: prudente, come un titolo nervoso.
  fallbackDailyVol: 0.03,
  volLookbackDays: 20,
  // Metodo dichiarato: si compra solo sopra la media a 50 E a 200 giorni; si esce quando la chiusura va sotto la 50.
  trendSmaDays: 50,
  longSmaDays: 200,
  // Classifica tra i candidati: momentum a 6 mesi (circa 120 giorni di borsa).
  rankMomentumDays: 120,
  // Niente acquisti di singoli titoli in questi giorni di borsa prima della trimestrale (giorno compreso).
  earningsBlackoutDays: 2,
  // Titoli che si muovono insieme: tetto complessivo.
  groups: [{ name: "tecnologia", symbols: ["QQQ", "NVDA", "MSFT", "AAPL"], maxPct: 0.35 }],
  // Interruttore: oltre questa perdita dal massimo gli acquisti si fermano, e si riarma da solo dopo breakerRearmSessions
  // giorni di borsa (nel backtest su 550 sedute il riarmo manuale mai fatto costava 13 punti di rendimento).
  maxDrawdownPct: 0.05,
  breakerRearmSessions: 5,
  // Spento per scelta dell'utente: nessun interruttore sul conto, decidono gli agenti (stop per posizione, uscite, gabbia).
  // Dalle schede si può riaccendere. Le sveglie classiche (bun run schedule) lo usano sempre.
  breakerEnabled: false,
  // Oltre questa perdita in giornata niente acquisti fino a domani.
  maxDailyLossPct: 0.02,
  // Dopo uno stop loss su un titolo, niente riacquisto per questi giorni di borsa.
  stopLossCooldownDays: 5,
  // Due rifiuti di Alpaca uguali (titolo + lato) entro questi giorni bloccano quel titolo-lato per altrettanti giorni.
  brokerRejectWindowDays: 5,
};

// Storico giornaliero da chiedere: media a 200 giorni più margine per festività.
export const DAILY_BARS_DAYS = 320; // media a 200 + momentum a 12 mesi (252) con margine

// Le decisioni di ingresso e le uscite di trend si prendono solo a questa sveglia, sulle chiusure complete.
export const ENTRY_SLOT: SlotKind = "open";

// Voto a maggioranza: il cervello risponde più volte in parallelo, passa solo l'ordine proposto da almeno quorum risposte.
export const BRAIN_VOTES = { calls: 3, quorum: 2 };

export const TIMEZONE = "Europe/Rome";

export type SlotKind = "briefing" | "open" | "mid" | "close";

export interface SlotDef {
  time: string; // HH:MM ora di Roma
  kind: SlotKind;
  label: string;
}

// Sveglie dal lunedì al venerdì, ora di Roma.
export const SLOTS: SlotDef[] = [
  { time: "09:00", kind: "briefing", label: "Briefing" },
  { time: "15:40", kind: "open", label: "Apertura" }, // 10 minuti dopo l'apertura USA: spread e prezzi più calmi
  { time: "18:30", kind: "mid", label: "Metà seduta" },
  { time: "21:40", kind: "close", label: "Chiusura" },
];

// Oltre questo ritardo una sveglia non manda ordini: il momento è passato.
export const MAX_LATENESS_MIN = 20;
// Lo scheduler lancia una sveglia solo entro questa finestra dal suo orario.
export const SCHEDULE_GRACE_MIN = 20;
export const SCHEDULE_TICK_MS = 30_000;
// Differenza tra orologio della macchina e di Alpaca oltre la quale scatta l'allarme.
export const CLOCK_SKEW_ALARM_MIN = 2;

export const HTTP_TIMEOUT_MS = 15_000;
export const TELEGRAM_TIMEOUT_MS = 10_000;
export const BRAIN_TIMEOUT_MS = 180_000;

// Un lock più vecchio di così è considerato morto anche se il PID esiste (PID riciclato).
export const LOCK_MAX_AGE_MS = 15 * 60_000;

// Una prenotazione di sveglia cloud scade questi minuti dopo l'orario della sveglia: chi l'ha presa è morto o bloccato,
// perché una sveglia viva lavora pochi minuti.
export const CLAIM_TTL_MIN = 20;

// Quanti tentativi di verifica per un ordine con esito incerto (timeout, rete).
export const SUBMIT_VERIFY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

// Diario dei trade. Per i primi mesi raccoglie e misura soltanto: le statistiche non arrivano al modello
// e non creano blocchi finché non sono passati observeDays dal primo trade E ci sono minReliable trade chiusi.
export const JOURNAL = {
  observeDays: 90,
  minReliable: 30,
  minIndicative: 10,
  minForLesson: 6,
  lessonDays: 10,
  strongMomentum: 0.03,
  highVol: 0.015,
  keepIdsDays: 30,
  recentForBrain: 10,
};

// Motore degli agenti (bun run agents): processo sempre acceso sul tuo PC, orizzonte a 20 sedute.
// A un mese la direzione "sale" ha ragione nel 61-67% dei casi sullo storico 2020-2026: è l'orizzonte scelto.
export const AGENTS = {
  tickMinutes: 5,
  // Riesame del trade a 60 sedute (un trimestre): la letteratura sul momentum lavora su 1-12 mesi, non su 20 sedute.
  horizonSessions: 60,
  // Momentum assoluto (dual momentum): si compra solo se il rendimento a 12 mesi è positivo; altrimenti liquidità.
  absMomentum: { days: 252, min: 0 },
  // Crypto solo in trend: oltre alle medie e al momentum a 12 mesi, rendimento a 3 mesi positivo.
  cryptoMomentumDays: 63,
  // Volatilità di portafoglio obiettivo (annua): oltre, le taglie nuove si riducono in proporzione.
  // Spento per scelta dell'utente: il motore punta al massimo profitto dentro l'obiettivo giornaliero (AGENTS.daily),
  // non a una volatilità annua. Restano i tetti per titolo (20%, rischio giornaliero per posizione) e la gabbia.
  volTarget: { enabled: false, annual: 0.12, corr: 0.8 },
  // Obiettivo giornaliero: raggiunto il guadagno del giorno (patrimonio contro la chiusura di ieri) niente nuovi acquisti
  // fino a domani e le operazioni intraday incassano; oltre la perdita massima del giorno niente nuovi acquisti (le
  // posizioni restano protette dagli stop). I profitti restano nel conto e le taglie sono percentuali del patrimonio
  // corrente: il guadagno di oggi si reinveste da solo domani.
  // Tetto generale del giorno (scelta dell'utente): raggiunto il +10% sul patrimonio di ieri gli agenti non investono più
  // per oggi; continuano a girare in simulazione (le operazioni che avrebbero fatto, con esito virtuale, in
  // state/simulazioni/) per imparare, e si riparte domani con i criteri del motore. Nessun tetto alla perdita (0).
  daily: { enabled: true, targetPct: 0.1, maxLossPct: 0 },
  // Taglia proporzionale alla fiducia: la probabilità che la proiezione di Kronos si avveri (rendimento atteso diviso la
  // volatilità sull'orizzonte) porta il peso da minFactor (fiducia 50%) a 1 (fiducia ≥ fullAt); senza proiezione vale noForecast.
  sizing: { byKronos: true, minFactor: 0.4, fullAt: 0.8, noForecast: 0.6 },
  // Titoli che gli agenti possono comprare: senza IWM e TLT (attesa nulla o negativa con obiettivo +3% / stop -3%).
  // Le crypto entrano con enableCrypto (di serie nel motore degli agenti, --no-crypto per toglierle; --crypto altrove):
  // nel backtest ago 2025 - nov 2026 hanno tolto 5-6 punti.
  // La gabbia accetta comunque vendite su tutto UNIVERSE ∪ CRYPTO.
  universe: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "GLD"] as string[],
  // Finestra degli ingressi sui titoli, ora di Roma: tutta la seduta (dopo i primi 5 minuti, fino a 5 minuti dalla
  // chiusura). Le crypto non hanno finestra. Il bot decide a ogni giro se investire o no.
  entryWindow: { from: "15:35", to: "21:55" },
  // Punteggio netto (somma pesata dei segnali) oltre il quale si compra / sotto il quale si vende.
  buyScore: 0.5,
  sellScore: -0.5,
  // Se true il peso obiettivo di un titolo scende col punteggio (0,5 → metà peso); se false il punteggio serve solo
  // a scegliere e ordinare i titoli, e il peso è quello massimo della gabbia × rischio del regime.
  scaleByScore: false,
  // Peso minimo di un'aggiunta: sotto il 2% del conto l'ordine non vale il costo.
  minAddPct: 0.02,
  // Regime: con SPY sotto la media a 200 giorni l'esposizione si dimezza; con volatilità alta pure.
  regime: { bearScale: 0.5, highVolDaily: 0.015, highVolScale: 0.5 },
  // Rientro (mean reversion di Connors): RSI(2) sotto 10 con prezzo sopra la media a 200; uscita a RSI(2) sopra 70 o dopo
  // 5 sedute; taglia piccola (5% del conto): gli obiettivi brevi funzionano sulla mean reversion, non sul trend.
  pullback: { rsiDays: 2, rsiEntry: 10, rsiExit: 70, maxHoldSessions: 5, maxWeight: 0.05 },
  // Pesi degli agenti dal diario: scendono se un agente perde con un campione almeno indicativo, salgono se vince con campione affidabile.
  weights: { base: 1, losing: 0.5, winning: 1.2 },
  // Kronos (sidecar Python, opzionale): si considerano solo le previsioni più nette (quota) e solo se concordano col trend.
  // Kronos: il sidecar lo accende il motore (tools/kronos, venv da installa-kronos); porta e modello qui. Le proiezioni si
  // calcolano una volta al giorno sulle barre giornaliere e restano in state/previsioni.json (anche per la dashboard).
  // Kronos è la fonte principale per anticipare la direzione: una proiezione oltre anticipaSoglia (in valore assoluto)
  // vale come segnale di rialzo o ribasso in arrivo: sblocca l'attesa del contesto (rialzo) o ferma gli ingressi (ribasso).
  // maxAbs: proiezioni oltre questa misura (in valore assoluto) sono rumore del modello e non si usano.
  kronos: { topShare: 0.25, horizon: 5, timeoutMs: 600_000, port: 8765, model: "small" as "mini" | "small" | "base", lookback: 400, samples: 3, anticipaSoglia: 0.01, maxAbs: 0.25 },
  // Riepilogo su Telegram una volta al giorno, alla prima passata dopo quest'ora di Roma.
  summaryAfter: "22:05",
  // Presa di profitto parziale (agente "profitto"): a +3% vende metà e lascia correre il resto col trend. Scelta col
  // walk-forward (bun run sweep): in prova alza i vinti dal 32% al 37% con rendimento quasi uguale e perdita massima minore.
  // La presa di profitto totale a +5% arriva al 45% di vinti ma costa 5-9 punti di rendimento.
  takeProfit: { enabled: true, pct: 0.03, fraction: 0.5 },
  // Politica di uscita (agente "uscite", segnali vincolanti che la gabbia non può votare via):
  // stop a -3% dal carico (anche come stop GTC su Alpaca); a +3% (o +4% per titolo) si incassa, a meno che la proiezione (Kronos) dica
  // che c'è altro da prendere: allora si lascia correre con uno stop che segue il massimo e non restituisce più del
  // rischio (giveBackPct), mai sotto il carico + lockPct. Proiezione negativa: si esce subito, in guadagno o in perdita.
  // Stop a -3%: con -2% NVDA (3% di volatilità al giorno) usciva sul rumore. Obiettivo +4% dove le barriere lo pagano.
  // mode "trend": niente obiettivo fisso, stop che segue il massimo a trailAtr × ATR (ATR ≈ prezzo × volatilità giornaliera);
  // mode "obiettivo": incasso a targetPct (per titolo) con trailing solo se la proiezione dice di continuare.
  // stopMode "volatilita": stop a 2,5 × vol × √5 tra il 5% e il 10% (stops.ts), con taglia già ridotta dalla volatilità;
  // stopMode "fisso": stopPct. La letteratura (Lei-Li, Han-Zhou-Zhu) dà ragione agli stop larghi scalati sulla volatilità.
  // trailAtr 0 = nessun trailing: nel backtest 2024-2026 il trailing a 3 ATR dal massimo toglieva 19 punti (usciva sul rumore
  // mentre il trend continuava); l'uscita di trend resta quella della gabbia (chiusura sotto la media a 50).
  exit: { enabled: true, mode: "trend" as "trend" | "obiettivo", stopMode: "volatilita" as "volatilita" | "fisso", stopPct: 0.03, trailAtr: 0, targetPct: 0.03, targetBySymbol: { GLD: 0.04, MSFT: 0.04, QQQ: 0.04 } as Record<string, number>, giveBackPct: 0.02, lockPct: 0.005 },
  // Contesto economico (agente "contesto"): prima di ogni trade. Regole sui dati di mercato e sul calendario eventi sempre;
  // in più, se c'è `claude -p`, una lettura della situazione economica con ricerca web ogni refreshHours (cache in state/macro.json).
  // Sfavorevole: esposizione × unfavorableScale, nessun ingresso nuovo e niente fiducia nella proiezione per quel settore
  // (si aspetta la candela successiva). Neutro: esposizione × neutralScale, si entra ma la proiezione non guida le uscite.
  context: { enabled: true, useClaude: true, refreshHours: 6, unfavorableScale: 0.5, neutralScale: 0.75, waitDaysBeforeEvent: 2 },
  dashboardPort: 8787,
  eventsKeepDays: 60,
  // Universo crypto: tutte le coppie USD negoziabili su Alpaca che stanno nella top N per capitalizzazione
  // (CoinGecko, una volta al giorno, cache in state/crypto-universe.json). Senza CoinGecko: tutte le coppie di Alpaca.
  cryptoUniverse: { enabled: true, topMarketCap: 100, maxPairs: 40, refreshHours: 24, coingeckoUrl: "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1" },
  // Custodi: un agente per ogni crypto in portafoglio o tra le migliori candidate; ognuno segue il suo titolo
  // con tesi, piano e rischio dichiarati, dentro le stesse regole del motore.
  // Custodi senza numero fisso: uno per ogni titolo o crypto in trend (maxCandidates è solo una sicurezza).
  custodi: { enabled: true, maxCandidates: 100, pullbackSmaDays: 20, extendedPct: 0.15, keepIdleTicks: 12 },
  // Intraday (agente "intraday"): operazioni che si aprono e chiudono nella stessa giornata, solo nel verso del trend
  // giornaliero. L'agente sceglie da solo la candela (5 min / 15 min / 4 ore) dalla volatilità del titolo: più è nervoso,
  // più la candela è corta. Entra su rottura dei massimi delle ultime 20 candele o su rientro sulla media a 20 candele;
  // esce all'obiettivo, allo stop (ATR), alla rottura al ribasso della media a 20 candele, o comunque prima della chiusura.
  intraday: {
    enabled: true,
    timeframes: { fast: "5Min", mid: "15Min", slow: "4Hour" } as Record<"fast" | "mid" | "slow", string>,
    // Soglie di volatilità giornaliera (deviazione standard dei rendimenti a 20 giorni) per la scelta della candela.
    volFast: 0.03, volMid: 0.015,
    bars: 120, // candele di storia per medie, ATR e massimi
    target: { stocks: 0.01, crypto: 0.02 }, // obiettivo di profitto; se l'ATR dice di più, vale l'ATR × targetAtr
    targetAtr: 1.5, stopAtr: 1.2, minStopPct: 0.004,
    maxWeight: 0.1, // peso massimo di un'operazione intraday (comparto a taglia ridotta)
    maxOpen: 3, // operazioni intraday aperte contemporaneamente
    // Finestre, ora di Roma: ingressi solo se resta tempo per chiudere in giornata; poi chiusura forzata.
    entry: { stocks: { from: "15:45", to: "20:30" }, crypto: { from: "00:10", to: "20:00" } },
    closeBy: { stocks: "21:45", crypto: "23:30" },
    rsiMax: 70, // solo informativo nelle note
    maxExtensionAtr: 3, // oltre tanti ATR sopra la media a 20 candele non si entra
  },
};

// Sostituisce le crypto nell'universo degli agenti con la lista data (le azioni restano).
export function setCryptoUniverse(pairs: string[]) {
  const stocks = AGENTS.universe.filter((s) => !isCrypto(s));
  AGENTS.universe.splice(0, AGENTS.universe.length, ...stocks, ...pairs);
}

// Aggiunge BTC/USD ed ETH/USD all'universo degli agenti (24 ore su 24). Nel motore (bun run agents) è di serie,
// --no-crypto le toglie; nelle sveglie classiche e nei backtest resta una scelta esplicita (--crypto).
export function enableCrypto() {
  for (const c of CRYPTO) if (!AGENTS.universe.includes(c)) AGENTS.universe.push(c);
}

// Backtest: costi per lato (spread + slippage sul feed IEX) in punti base, applicati a ogni esecuzione.
export const BACKTEST = { costBps: 5 };
