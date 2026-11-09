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
// Il radar dell'esplorazione: azioni e ETF liquidi fuori dall'universo fisso, con il loro settore. Gli agenti in pausa li
// passano in rassegna; quelli che superano i criteri del motore entrano nell'universo per qualche giorno.
export const RADAR_SECTORS: Record<string, string> = {
  AMD: "tecnologia", AVGO: "tecnologia", GOOGL: "tecnologia", META: "tecnologia", AMZN: "tecnologia", TSLA: "tecnologia", NFLX: "tecnologia", ORCL: "tecnologia", CRM: "tecnologia", ADBE: "tecnologia", PLTR: "tecnologia", MU: "tecnologia", QCOM: "tecnologia", CSCO: "tecnologia", IBM: "tecnologia", NOW: "tecnologia", UBER: "tecnologia", SMH: "tecnologia", XLK: "tecnologia",
  JPM: "finanza", BAC: "finanza", GS: "finanza", MS: "finanza", V: "finanza", MA: "finanza", XLF: "finanza",
  LLY: "salute", UNH: "salute", JNJ: "salute", ABBV: "salute", MRK: "salute", XLV: "salute",
  XOM: "energia", CVX: "energia", XLE: "energia",
  COST: "consumi", WMT: "consumi", HD: "consumi", MCD: "consumi", KO: "consumi", PEP: "consumi", NKE: "consumi", DIS: "consumi", XLY: "consumi",
  DIA: "indici", EFA: "indici", EEM: "indici",
};
export const sectorOf = (symbol: string) => SECTORS[symbol] ?? RADAR_SECTORS[symbol] ?? (isCrypto(symbol) ? "crypto" : "altro");
// Stablecoin e token ancorati: mai in portafoglio, non hanno trend.
export const STABLECOINS = new Set(["USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "PYUSD", "USDS", "USD1", "BUSD", "FRAX", "LUSD", "GUSD", "USDP", "WBTC", "WETH", "STETH", "WSTETH", "CBBTC", "WEETH", "RETH", "LBTC", "SUSDE", "SUSDS", "BSC-USD", "USDTB", "USDD", "RLUSD", "XAUT", "PAXG", "USDG", "USDY", "USD0", "EURC", "USDL", "BUIDL", "CUSD", "SUSD", "MUSD", "DOLA"]);
// Prezzo limite dello stop_limit crypto: mezzo punto sotto lo stop, così scatta e viene eseguito anche con un buco.
export const CRYPTO_STOP_LIMIT_GAP = 0.005;

export const LIMITS = {
  // Scelta dell'utente: al massimo il 10% del patrimonio per titolo, e meno se la proiezione di Kronos è incerta
  // (vedi AGENTS.sizing). Nessun numero fisso di titoli: tanti quante sono le occasioni (il tetto qui è solo una sicurezza;
  // il limite vero è la liquidità, con il 10% per titolo).
  maxPositions: 1000,
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
  // Titoli che si muovono insieme: tetto complessivo per settore (sectorOf: anche i titoli scoperti dall'esplorazione e le
  // crypto, che salgono e scendono insieme). groupMaxBySector cambia il tetto per un settore preciso.
  groupMaxPct: 0.35,
  groupMaxBySector: {} as Record<string, number>,
  // Interruttore: oltre questa perdita dal massimo gli acquisti si fermano, e si riarma da solo dopo breakerRearmSessions
  // giorni di borsa (nel backtest su 550 sedute il riarmo manuale mai fatto costava 13 punti di rendimento).
  maxDrawdownPct: 0.05,
  breakerRearmSessions: 5,
  // Spento per scelta dell'utente: nessun interruttore sul conto, decidono gli agenti (stop per posizione, uscite, gabbia).
  // Dalle schede si può riaccendere come freno d'emergenza.
  breakerEnabled: false,
  // Perdita in giornata oltre la quale l'interruttore classico ferma gli acquisti: vale solo con breakerEnabled (spento);
  // nel motore degli agenti il limite del giorno è AGENTS.daily.maxLossPct (0 = nessun limite).
  maxDailyLossPct: 0.02,
  // Dopo uno stop loss su un titolo, niente riacquisto per questi giorni di borsa.
  stopLossCooldownDays: 5,
  // Due rifiuti di Alpaca uguali (titolo + lato) entro questi giorni bloccano quel titolo-lato per altrettanti giorni.
  brokerRejectWindowDays: 5,
};

// Storico giornaliero da chiedere: media a 200 giorni più margine per festività.
export const DAILY_BARS_DAYS = 320; // media a 200 + momentum a 12 mesi (252) con margine

export const TIMEZONE = "Europe/Rome";


export const HTTP_TIMEOUT_MS = 15_000;
export const TELEGRAM_TIMEOUT_MS = 10_000;

// Un lock più vecchio di così è considerato morto anche se il PID esiste (PID riciclato).
export const LOCK_MAX_AGE_MS = 15 * 60_000;


// Quanti tentativi di verifica per un ordine con esito incerto (timeout, rete).
export const SUBMIT_VERIFY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

// Diario dei trade: soglie del campione per le statistiche, classi di ingresso (momentum, volatilità), giorni di memoria
// degli ID degli ordini già visti.
export const JOURNAL = {
  minReliable: 30,
  minIndicative: 10,
  strongMomentum: 0.03,
  highVol: 0.015,
  keepIdsDays: 30,
};

// Motore degli agenti (bun run agents): processo sempre acceso sul tuo PC, orizzonte a 20 sedute.
// A un mese la direzione "sale" ha ragione nel 61-67% dei casi sullo storico 2020-2026: è l'orizzonte scelto.
export const AGENTS = {
  // Un giro ogni tickMinutes: conto, uscite, stop, protezione del profitto, operazioni intraday aperte. L'analisi per
  // decidere se investire e su cosa (scansione intraday con Kronos sulle candele, nuovi acquisti) ogni analisiMinuti:
  // tre volte il tempo per Kronos, quindi più campioni e previsioni più stabili.
  tickMinutes: 5,
  analisiMinuti: 15,
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
  // Obiettivo del giorno con difesa del guadagno (scelta dell'utente): raggiunto il +10% sul patrimonio di ieri gli agenti
  // continuano a investire (Livermore: non si ferma un giorno buono); se però il guadagno del giorno torna al +5%
  // (pavimentoPct), i trade non favorevoli si vendono per difendere quel guadagno: per le posizioni di più giorni Kronos a
  // 5 sedute sotto la soglia di rialzo, per l'intraday né la candela breve né quelle superiori vedono ancora salire.
  // Nessun tetto alla perdita (0).
  daily: { enabled: true, targetPct: 0.1, pavimentoPct: 0.05, maxLossPct: 0 },
  // Pagina pubblica su GitHub Pages: istantanea in sola lettura spinta sul ramo gh-pages ogni everyMinutes minuti.
  // Spenta di serie: la pagina è visibile a chiunque abbia il link (conto, posizioni, operazioni). remote vuoto = origin.
  pages: { enabled: false, everyMinutes: 10, branch: "gh-pages", remote: "" },
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
  // Per classe: le azioni guardano lo SPY, le crypto il BTC (sotto la media a 200 o con volatilità oltre highVolCrypto).
  // Con il contesto non si sommano: vale la riduzione più forte tra regime e contesto.
  regime: { bearScale: 0.5, highVolDaily: 0.015, highVolScale: 0.5, highVolCrypto: 0.045 },
  // Rientro (mean reversion di Connors): RSI(2) sotto 10 con prezzo sopra la media a 200; uscita a RSI(2) sopra 70 o dopo
  // 5 sedute; taglia piccola (5% del conto): gli obiettivi brevi funzionano sulla mean reversion, non sul trend.
  pullback: { rsiDays: 2, rsiEntry: 10, rsiExit: 70, maxHoldSessions: 5, maxWeight: 0.05 },
  // Kronos (sidecar Python, opzionale): si considerano solo le previsioni più nette (quota) e solo se concordano col trend.
  // Kronos: il sidecar lo accende il motore (tools/kronos, venv da installa-kronos); porta e modello qui. Le proiezioni si
  // calcolano una volta al giorno sulle barre giornaliere e restano in state/previsioni.json (anche per la dashboard).
  // Kronos è la fonte principale per anticipare la direzione: una proiezione oltre anticipaSoglia (in valore assoluto)
  // vale come segnale di rialzo o ribasso in arrivo: sblocca l'attesa del contesto (rialzo) o ferma gli ingressi (ribasso).
  // maxAbs: proiezioni oltre questa misura (in valore assoluto) sono rumore del modello e non si usano.
  // controTendenza: sotto la media a 200 si entra solo se Kronos anticipa almeno minRendimento con probabilità di successo
  // (Φ del rendimento atteso sulla volatilità) almeno minFiducia; peso massimo ridotto a pesoFattore × 10%.
  kronos: { topShare: 1, horizon: 5, timeoutMs: 900_000, port: 8765, model: "small" as "mini" | "small" | "base", lookback: 400, samples: 3, anticipaSoglia: 0.01, maxAbs: 0.25, zMax: 4, controTendenza: { enabled: true, minRendimento: 0.02, minFiducia: 0.6, pesoFattore: 0.5 },
    // Il cervello delle previsioni: il sidecar fa girare accanto a Kronos altri modelli gratuiti (Chronos-2 di Amazon e
    // TimesFM 2.5 di Google, Apache 2.0; quelli non installati si saltano). Peso di un modello = affidabilità × risultato
    // misurato. Affidabilità (scala 0-1, metà dai dati finanziari dell'addestramento, metà dalle prove pubblicate sui
    // rendimenti, RankIC nel confronto di KiT, 2026): Kronos 1 (12 miliardi di candele da 45 borse; RankIC 0,034),
    // Chronos-2 0,13 (corpus generico e sintetico; RankIC 0,005), TimesFM 2.5 0,05 (generico; RankIC negativo). Risultato
    // misurato: ogni previsione si confronta col prezzo vero alla scadenza; sotto minCampione vale 1 (decide l'affidabilità),
    // poi è la bravura (direzioni giuste oltre il caso, ridotta dalla prudenza sui campioni piccoli) divisa per
    // bravuraAttesa, tra 0 e 3: chi non supera il caso pesa zero. Conti separati per giornaliero e per ogni candela.
    // Kronos, se non risulta peggiore del caso, tiene almeno kronosMinimo.
    modelli: ["kronos", "chronos2", "timesfm"] as string[],
    // Campioni di Kronos: quanti percorsi genera e media per ogni previsione. Più campioni = previsione più stabile
    // (l'errore casuale scende con la radice del numero: da 3 a 48 si divide per 4), ma il tempo cresce in proporzione.
    // Il motore misura quanto impiega davvero il PC e sale con i campioni finché il tempo per titolo resta in quello
    // concesso (il costo non è proporzionale: Kronos genera i campioni insieme). Giornaliere 6 s per titolo (una volta per
    // giornata conclusa: 70 titoli ≈ 7 minuti, si possono aspettare), intraday 3 s per titolo e candela (nell'analisi ogni
    // 15 minuti), esplorazione 1,5 s (è una prima scrematura: chi entra nell'universo viene riproiettato con più campioni),
    // grafici della dashboard e della pagina pubblica 0,7 s (solo indicativi: non tolgono tempo agli agenti).
    campioni: { min: 4, max: 128, giorno: { msPerSerie: 6_000, iniziali: 24 }, intraday: { msPerSerie: 3_000, iniziali: 16 }, esplorazione: { msPerSerie: 1_500, iniziali: 8 }, grafico: { msPerSerie: 700, iniziali: 4 } },
    cervello: { minCampione: 100, prudenza: 50, kronosMinimo: 0.5, maxAperte: 6000, bravuraAttesa: 0.03, affidabilita: { kronos: 1, chronos2: 0.13, timesfm: 0.05 } as Record<string, number>, affidabilitaIgnota: 0.05 } },
  // Riepilogo su Telegram una volta al giorno, alla prima passata dopo quest'ora di Roma.
  summaryAfter: "22:05",
  // Presa di profitto parziale (agente "profitto"): a +3% vende metà e lascia correre il resto col trend. Scelta col
  // walk-forward (allora con bun run sweep, ora tolto): in prova alza i vinti dal 32% al 37% con rendimento quasi uguale e perdita massima minore.
  // La presa di profitto totale a +5% arriva al 45% di vinti ma costa 5-9 punti di rendimento.
  // Se Kronos anticipa altro rialzo (≥ anticipaSoglia) la presa di profitto aspetta: si lascia correre.
  takeProfit: { enabled: true, pct: 0.03, fraction: 0.5 },
  // Politica di uscita (agente "uscite", segnali vincolanti che la gabbia non può votare via), per le posizioni di più
  // giorni: le operazioni intraday hanno le loro uscite (obiettivo, stop, Kronos sulle candele brevi) e qui restano
  // soggette solo allo stop di emergenza. Stop (anche come stop GTC su Alpaca): con stopMode "volatilita" tra il 5% e il 10%
  // dal carico (stops.ts); con "fisso" stopPct. Proiezione di Kronos netta al ribasso (≤ -anticipaSoglia, la stessa soglia con
  // cui si compra): si esce subito, in guadagno o in perdita. mode "obiettivo": a targetPct si incassa, a meno che la
  // proiezione dica che c'è altro da prendere: allora si lascia correre con uno stop che segue il massimo e non restituisce
  // più di giveBackPct, mai sotto il carico + lockPct.
  // Stop troppo stretto: NVDA (3% di volatilità al giorno) usciva sul rumore. Obiettivo +4% dove le barriere lo pagano.
  // mode "trend": niente obiettivo fisso, stop che segue il massimo a trailAtr × ATR (ATR ≈ prezzo × volatilità giornaliera);
  // mode "obiettivo": incasso a targetPct (per titolo) con trailing solo se la proiezione dice di continuare.
  // stopMode "volatilita": stop a 2,5 × vol × √5 tra il 5% e il 10% (stops.ts), con taglia già ridotta dalla volatilità;
  // stopMode "fisso": stopPct. La letteratura (Lei-Li, Han-Zhou-Zhu) dà ragione agli stop larghi scalati sulla volatilità.
  // trailAtr 0 = nessun trailing: nel backtest 2024-2026 il trailing a 3 ATR dal massimo toglieva 19 punti (usciva sul rumore
  // mentre il trend continuava); l'uscita di trend resta quella della gabbia (chiusura sotto la media a 50).
  // Protezione del profitto: con una posizione in guadagno (oltre il margine dei costi), se Kronos nelle prossime
  // `sedute` vede un calo che lo azzererebbe, si vende subito con il profitto di adesso.
  protezioneProfitto: { enabled: true, sedute: 2, margine: { stocks: 0.002, crypto: 0.006 } },
  // Uscita prima delle trimestrali (azioni): nell'ultima seduta prima dei conti (lo stesso giorno se escono dopo la
  // chiusura, il giorno prima se escono prima dell'apertura o l'orario non è noto), negli ultimi minutiPrimaChiusura
  // minuti. Salto atteso ai conti = max(movimentoMin, movimentoVol × volatilità giornaliera). In guadagno oltre il salto
  // atteso: si incassa metà e si tiene metà (il cuscinetto copre anche un salto contrario). In guadagno più piccolo: metà se
  // Kronos vede ancora rialzo con probabilità ≥ fiduciaTenere, altrimenti tutto. In perdita: tutto, salvo una perdita
  // piccola (sotto un quarto del salto atteso) con Kronos favorevole: metà. Kronos non conosce i conti, quindi decide solo
  // tra metà e tutto, mai di tenere tutto.
  trimestrali: { uscita: true, minutiPrimaChiusura: 90, movimentoVol: 3, movimentoMin: 0.03, fiduciaTenere: 0.6 },
  exit: { enabled: true, mode: "trend" as "trend" | "obiettivo", stopMode: "volatilita" as "volatilita" | "fisso", stopPct: 0.03, trailAtr: 0, targetPct: 0.03, targetBySymbol: { GLD: 0.04, MSFT: 0.04, QQQ: 0.04 } as Record<string, number>, giveBackPct: 0.02, lockPct: 0.005 },
  // Contesto economico (agente "contesto"): prima di ogni trade. Regole sui dati di mercato e sul calendario eventi sempre;
  // in più, se c'è `claude -p`, una lettura della situazione economica con ricerca web ogni refreshHours (cache in state/macro.json).
  // Sfavorevole: esposizione × unfavorableScale, nessun ingresso nuovo e niente fiducia nella proiezione per quel settore
  // (si aspetta la candela successiva). Neutro: esposizione × neutralScale, si entra ma la proiezione non guida le uscite.
  // breadthUnfavorable/breadthNeutral: quota media (per settore a rischio) di titoli sopra la media a 50 sotto la quale il clima
  // generale diventa sfavorevole / neutro. retryMinutes: dopo un errore di claude si riprova solo dopo tanti minuti.
  context: { enabled: true, useClaude: true, refreshHours: 6, retryMinutes: 60, unfavorableScale: 0.5, neutralScale: 0.75, waitDaysBeforeEvent: 2, breadthUnfavorable: 0.3, breadthNeutral: 0.5 },
  dashboardPort: 8787,
  eventsKeepDays: 60,
  // Universo crypto: tutte le coppie USD negoziabili su Alpaca che stanno nella top N per capitalizzazione
  // (CoinGecko, una volta al giorno, cache in state/crypto-universe.json). Senza CoinGecko: tutte le coppie di Alpaca.
  cryptoUniverse: { enabled: true, topMarketCap: 100, maxPairs: 40, refreshHours: 24, coingeckoUrl: "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1" },
  // Custodi: un agente per ogni crypto in portafoglio o tra le migliori candidate; ognuno segue il suo titolo
  // con tesi, piano e rischio dichiarati, dentro le stesse regole del motore.
  // Custodi senza numero fisso: uno per ogni titolo o crypto in trend (maxCandidates è solo una sicurezza).
  // minProbabilita: sotto questa probabilità favorevole del dossier il trading agent non vota l'acquisto (è il suo stesso
  // consiglio «restare fuori»); il capo ufficio può alzarla per la squadra e per la singola persona (src/agents/profili.ts).
  custodi: { enabled: true, maxCandidates: 100, pullbackSmaDays: 20, extendedPct: 0.15, keepIdleTicks: 12, minProbabilita: 0.45 },
  // Calibrazione del capo ufficio (src/agents/calibrazione.ts): sotto `obiettivo` di vittorie su almeno `minTrade` trade
  // chiusi un agente diventa più selettivo di un passo (al massimo `maxPassi`); da `buono` in su torna di un passo.
  calibrazione: { enabled: true, minTrade: 5, obiettivo: 0.51, buono: 0.6, maxPassi: 4 },
  // Formazione in sala caffè: chi, sugli ultimi trade chiusi dal suo rientro (almeno minTrade), vince meno di `obiettivo`
  // e chiude in perdita va in sala caffè per `ore` ore a imparare da chi lavora bene; alla scrivania restano sempre
  // almeno `minOperativi` trading agents (e agenti generali) e almeno `minIntraday` operatori della sala intraday quando
  // c'è un'occasione (zero se non c'è niente da fare): se mancano, chi è in sala caffè e trova un'occasione rientra, per
  // primo chi c'è da più tempo.
  // Lo staff: quante persone prendono le occasioni del motore (ognuna sia di più giorni sia intraday). Una posizione
  // aperta ha sempre una persona, anche oltre questo numero.
  persone: { totale: 28 },
  formazione: { enabled: true, minTrade: 5, obiettivo: 0.51, ore: 24, minOperativi: 10, minIntraday: 1 },
  // Evidenza combinata del dossier (Kronos, grafico, notizie, contesto) minima per un ingresso nuovo di più giorni:
  // sopra la media a 200 e, più alta, sotto la 200 (contro tendenza).
  evidenza: { min: 0.5, minContro: 0.6 },
  // Contanti che restano sempre liberi (quota del patrimonio): il riparto del capitale divide il resto.
  riservaContanti: 0.01,
  // Costi di andata e ritorno su Alpaca: crypto 0,25% per lato (taker, livello base: percentuale, nessuna quota fissa);
  // azioni senza commissioni, solo tasse regolamentari sulle vendite arrotondate al centesimo (trascurabili sopra i 100 $).
  // Un ingresso di più giorni si fa solo se Kronos prevede almeno `margineCosti` volte il costo; una posizione nuova
  // vale la pena da `minNuova.pct` del conto e almeno `minNuova.usd` dollari.
  costi: { cryptoAndataRitorno: 0.005, azioniAndataRitorno: 0.0005, margineCosti: 2 },
  minNuova: { pct: 0.002, usd: 100 },
  // Esplorazione: gli agenti in sala caffè passano in rassegna il radar (RADAR_SECTORS e le crypto rimaste fuori dal
  // tetto di coppie) ogni everyMinutes (di serie ogni minuto, anche tra un giro e l'altro), perGiro titoli alla volta;
  // finito il radar si ricomincia da capo (i prezzi cambiano, Kronos si chiede una volta al giorno per titolo). Un titolo che supera i criteri del motore (sopra la
  // media a 200, grafico in ordine, Kronos al rialzo oltre la soglia) entra nell'universo per giorniValida giorni; chi
  // l'ha trovato torna alla scrivania e lo vota. maxScoperte: quante scoperte nuove al giorno, al massimo.
  esplorazione: { enabled: true, everyMinutes: 1, perGiro: 6, maxScoperte: 100, giorniValida: 3, minTecnica: 0.5 },
  // Intraday (agente "intraday"): operazioni che si aprono e chiudono nella stessa giornata. Titoli e crypto usano le
  // stesse candele (5 min, 15 min, 1 ora, 4 ore): di ognuna si usa solo quella che sta nel tempo rimasto (una candela da
  // 4 ore per le azioni solo nelle prime ore di seduta). Con Kronos si sceglie la coppia candela + orizzonte (da 15 minuti
  // a ore) con la probabilità più alta; senza Kronos la candela dalla volatilità. Esce all'obiettivo, allo stop (ATR),
  // quando Kronos sulla candela più breve cambia idea, a orizzonte scaduto, o comunque prima della chiusura.
  intraday: {
    enabled: true,
    timeframes: { fast: "5Min", mid: "15Min", slow: "4Hour" } as Record<"fast" | "mid" | "slow", string>,
    // Soglie di volatilità giornaliera (deviazione standard dei rendimenti a 20 giorni) per la scelta della candela.
    volFast: 0.03, volMid: 0.015,
    bars: 120, // candele di storia per medie, ATR e massimi
    // Kronos sulle candele intraday: per ogni titolo e candela una sola proiezione (fino a maxCandele candele, ricalcolata
    // a ogni candela chiusa) da cui si leggono più orizzonti, in minuti: dai quarti d'ora alle ore. Si sceglie la coppia
    // candela + orizzonte con la probabilità di successo più alta, purché stia nel tempo rimasto, il rialzo previsto copra
    // `costi.margineCosti` volte i costi e la probabilità sia ≥ minProb. perGiro = coppie titolo-candela guardate a giro.
    // zMax: una proiezione oltre zMax volte la volatilità delle candele sull'orizzonte (o oltre kronos.maxAbs) è rumore del
    // modello (succede sui prezzi minuscoli, es. 0,000005 $) e non si usa, come le giornaliere fuori misura.
    // minProbSenzaGrafico: con le medie brevi della candela non in ordine (né rottura né rientro) decide Kronos da solo,
    // ma serve una probabilità più alta e la taglia si dimezza (un'inversione anticipata, non un trend già visibile).
    kronos: { orizzontiMin: [15, 30, 60, 120, 240, 480] as number[], maxCandele: 20, perGiro: 60, minProb: 0.55, minProbSenzaGrafico: 0.65, zMax: 4 },
    // Scelta della candela: la probabilità che conta è quella di un guadagno NETTO dei costi di andata e ritorno, Φ(z) con
    // z = (rialzo previsto − costi) / (volatilità delle candele × √candele), moltiplicato per l'affidabilità misurata della
    // candela dal cervello: quota di direzioni giuste di Kronos su quella candela, avvicinata a `prior` con il peso di `forza`
    // previsioni finte (un campione piccolo conta poco). Fattore = (quota − 50%) / (prior − 50%), tra 0 e `max`: una candela
    // su cui Kronos indovina come una moneta non fa entrare, una su cui indovina più del previsto pesa di più.
    affidabilita: { prior: 0.55, forza: 100, max: 1.5 },
    // Dopo `perdite` operazioni intraday chiuse in perdita di fila oggi, la taglia degli ingressi nuovi × fattore.
    serieNegativa: { perdite: 3, fattore: 0.5 },
    // Scaduto l'orizzonte scelto (× questo fattore) senza obiettivo e senza rialzo ancora probabile, si chiude.
    scadenzaOrizzonte: 1.5,
    // Pareggio: quando il guadagno arriva a `quota` della strada verso l'obiettivo (e almeno a 2 volte il margine dei
    // costi), lo stop sale sopra il carico (carico + metà margine): un trade già in guadagno non chiude più in perdita.
    pareggio: { enabled: true, quota: 0.6 },
    // Percentuale di vittorie per candela (obiettivo dell'utente: almeno 51%): sugli ultimi `ultimi` trade intraday chiusi
    // di quella candela (minimo `minimo`), sotto `obiettivo` la probabilità richiesta per entrare sale di `passo`, sotto
    // `obiettivo` − 0,11 di 2 passi. Le altre candele restano aperte: gli ingressi continuano, si spostano dove si vince.
    vittorie: { obiettivo: 0.51, ultimi: 20, minimo: 8, passo: 0.05 },
    // Le candele su cui si cerca l'ingresso: con Kronos si sceglie quella con la probabilità di successo più alta.
    candele: ["5Min", "15Min", "1Hour", "4Hour"] as string[],
    // Obiettivo: con Kronos è il rialzo che Kronos prevede sull'orizzonte scelto (minuti o ore), mai sotto questo minimo,
    // che copre i costi con margine (azioni 0,3%, crypto 1,2% contro lo 0,5% di andata e ritorno); senza Kronos il maggiore
    // tra minimo e targetAtr × ATR. Si entra solo se l'obiettivo vale almeno rapportoMin volte lo stop: un trade breve da
    // pochi minuti è possibile quando Kronos vede un movimento netto rispetto al rumore della candela.
    target: { stocks: 0.003, crypto: 0.012 },
    rapportoMin: 1.2,
    // Promozione: un'operazione intraday in guadagno che a fine finestra (chiusura della borsa, durata massima delle crypto)
    // rispetta i criteri del metodo di più giorni (trend o Kronos netto, Kronos a 5 sedute che copre i costi con probabilità
    // ≥ minProb, nessuna attesa del contesto né trimestrale vicina) non si chiude: passa alle regole di più giorni.
    promozione: { enabled: true, minProb: 0.55 },
    // Stop minimo: sulle crypto sopra il costo di andata e ritorno (0,5%), altrimenti ogni stop costa quasi il doppio.
    targetAtr: 1.5, stopAtr: 1.2, minStopPct: { stocks: 0.004, crypto: 0.01 },
    maxWeight: 0.1, // peso massimo di un'operazione intraday (comparto a taglia ridotta)
    // Finestre, ora di Roma: ingressi solo se resta tempo per chiudere in giornata; poi chiusura forzata.
    // Crypto: sempre aperte, un'operazione intraday dura al massimo cryptoOreMax ore. Azioni: tutta la seduta vera
    // (orologio di Alpaca): ingressi fino a minutiPrimaChiusura.ingresso dalla chiusura, uscita a minutiPrimaChiusura.uscita.
    // entry/closeBy delle azioni valgono solo se Alpaca non dà l'orario di chiusura.
    cryptoOreMax: 12,
    minutiPrimaChiusura: { ingresso: 30, uscita: 15 },
    entry: { stocks: { from: "15:35", to: "21:30" } },
    closeBy: { stocks: "21:45" },
    rsiMax: 70, // solo informativo nelle note
    maxExtensionAtr: 3, // oltre tanti ATR sopra la media a 20 candele non si entra
  },
};

// Sostituisce le crypto nell'universo degli agenti con la lista data (le azioni restano).
export function setCryptoUniverse(pairs: string[]) {
  const stocks = AGENTS.universe.filter((s) => !isCrypto(s));
  AGENTS.universe.splice(0, AGENTS.universe.length, ...stocks, ...pairs);
}

// Aggiunge BTC/USD ed ETH/USD all'universo degli agenti (24 ore su 24): di serie nel motore, --no-crypto le toglie.
export function enableCrypto() {
  for (const c of CRYPTO) if (!AGENTS.universe.includes(c)) AGENTS.universe.push(c);
}

