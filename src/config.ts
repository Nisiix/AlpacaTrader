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
// Borse europee: il conto Alpaca (Trading API) tratta solo i mercati americani; le azioni europee si comprano come
// titoli europei quotati in America (ADR e azioni con doppia quotazione) e come ETF sull'Europa, negli orari della borsa
// americana (15:30-22:00 in Italia), con la stessa logica di tutti gli altri titoli. Settore "europa" (tetto 35%).
export const EUROPA: Record<string, string> = {
  ASML: "ASML (Paesi Bassi)", SAP: "SAP (Germania)", NVO: "Novo Nordisk (Danimarca)", AZN: "AstraZeneca (Regno Unito)", SHEL: "Shell (Regno Unito)", TTE: "TotalEnergies (Francia)", UL: "Unilever (Regno Unito)", SNY: "Sanofi (Francia)",
  VGK: "ETF Europa", EZU: "ETF Eurozona", EWG: "ETF Germania", EWI: "ETF Italia",
};
for (const s of Object.keys(EUROPA)) SECTORS[s] = "europa";
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
  // Dopo uno stop loss su un titolo: pausa di qualche ora (non giorni), poi si può rientrare ma con più margine
  // (AGENTS.intraday.rientro: probabilità più alta e una proiezione nuova). Niente blocchi di un titolo per giorni.
  stopLossPausaOre: 2,
  // Due rifiuti di Alpaca uguali (titolo + lato) entro brokerRejectWindowDays giorni: pausa di brokerRejectPausaOre ore
  // su quel titolo-lato (non giorni: un rifiuto tecnico si riprova lo stesso giorno o quello dopo).
  brokerRejectWindowDays: 5,
  brokerRejectPausaOre: 4,
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
  // Secondi dopo la chiusura di ogni candela da 5 minuti in cui parte il giro (i dati della candela chiusa sono già
  // disponibili); -1 = giri ogni tickMinutes da quando parte il processo, senza allineamento.
  allineamentoSecondi: 20,
  // 5 minuti (come i giri): più momenti per cogliere un'occasione, con le stesse soglie (le proiezioni restano in cache
  // finché la candela non cambia, quindi Kronos lavora solo dove serve).
  analisiMinuti: 5,
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
  // Sorveglianza del motore: un giro più lungo di questi minuti si considera bloccato e il motore riparte da solo.
  watchdogMinuti: 15,
  // Controllo della memoria (src/cli/agents.ts): ogni controlloMinuti; riavvio di Kronos se è cresciuto più di
  // crescitaKronosMb dall'avvio o se il PC ha meno di minLiberaMb liberi; riavvio del motore oltre maxMotoreMb.
  memoria: { controlloMinuti: 5, minLiberaMb: 1000, crescitaKronosMb: 1500, maxMotoreMb: 2500 },
  pages: { enabled: false, everyMinutes: 10, branch: "gh-pages", remote: "" },
  // Taglia proporzionale alla fiducia: la probabilità che la proiezione di Kronos si avveri (rendimento atteso diviso la
  // volatilità sull'orizzonte) porta il peso da minFactor (fiducia 50%) a 1 (fiducia ≥ fullAt); senza proiezione vale noForecast.
  sizing: { byKronos: true, minFactor: 0.4, fullAt: 0.8, noForecast: 0.6 },
  // Titoli che gli agenti possono comprare: senza IWM e TLT (attesa nulla o negativa con obiettivo +3% / stop -3%).
  // Le crypto entrano con enableCrypto (di serie nel motore degli agenti, --no-crypto per toglierle; --crypto altrove):
  // nel backtest ago 2025 - nov 2026 hanno tolto 5-6 punti.
  // La gabbia accetta comunque vendite su tutto UNIVERSE ∪ CRYPTO.
  // Più i titoli europei quotati in America (EUROPA): stessa logica, orari della borsa americana.
  universe: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "GLD", ...Object.keys(EUROPA)] as string[],
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
  kronos: { topShare: 1, horizon: 5, timeoutMs: 900_000, port: 8765, model: "small" as "mini" | "small" | "base", lookback: 400, samples: 3, anticipaSoglia: 0.01, maxAbs: 0.25, zMax: 4, controTendenza: { enabled: true, minRendimento: 0.02, minFiducia: 0.57, pesoFattore: 0.5 },
    // Il cervello delle previsioni: il sidecar fa girare accanto a Kronos altri modelli gratuiti (Chronos-2 di Amazon e
    // TimesFM 2.5 di Google, Apache 2.0; quelli non installati si saltano). Peso di un modello = affidabilità × risultato
    // misurato. Affidabilità (scala 0-1, metà dai dati finanziari dell'addestramento, metà dalle prove pubblicate sui
    // rendimenti, RankIC nel confronto di KiT, 2026): Kronos 1 (12 miliardi di candele da 45 borse; RankIC 0,034),
    // Chronos-2 0,13 (corpus generico e sintetico; RankIC 0,005), TimesFM 2.5 0,05 (generico; RankIC negativo). Risultato
    // misurato: ogni previsione si confronta col prezzo vero alla scadenza; sotto minCampione vale 1 (decide l'affidabilità),
    // poi è la bravura (direzioni giuste oltre il caso, ridotta dalla prudenza sui campioni piccoli) divisa per
    // bravuraAttesa, tra 0 e 3: chi non supera il caso pesa zero. Conti separati per giornaliero e per ogni candela.
    // Kronos, se non risulta peggiore del caso, tiene almeno kronosMinimo.
    // Dal 10/11/2026 solo Kronos (scelta dell'utente): Chronos-2 e TimesFM non si caricano più. Pesavano poco nelle
    // decisioni (affidabilità 0,13 e 0,05) e occupavano memoria nel sidecar (il PC è rimasto senza memoria il 10/11).
    // Per riaccenderli: aggiungerli qui (il cervello li ripesa da solo).
    modelli: ["kronos"] as string[],
    // Campioni di Kronos: quanti percorsi genera e media per ogni previsione. Più campioni = previsione più stabile
    // (l'errore casuale scende con la radice del numero: da 3 a 48 si divide per 4), ma il tempo cresce in proporzione.
    // Il motore misura quanto impiega davvero il PC e sale con i campioni finché il tempo per titolo resta in quello
    // concesso (il costo non è proporzionale: Kronos genera i campioni insieme). Giornaliere 6 s per titolo (una volta per
    // giornata conclusa: 70 titoli ≈ 7 minuti, si possono aspettare), intraday 3 s per titolo e candela (nell'analisi ogni
    // 15 minuti), esplorazione 1,5 s (è una prima scrematura: chi entra nell'universo viene riproiettato con più campioni),
    // grafici della dashboard e della pagina pubblica 0,7 s (solo indicativi: non tolgono tempo agli agenti). Intraday al
    // massimo 24 percorsi: bastano per la quota che sale e tengono il giro sotto i 5 minuti (con 40 una sola chiamata da 15
    // minuti durava 80 secondi).
    campioni: { min: 4, max: 128, giorno: { msPerSerie: 6_000, iniziali: 24 }, intraday: { msPerSerie: 3_000, iniziali: 16, max: 24 }, esplorazione: { msPerSerie: 1_500, iniziali: 8 }, grafico: { msPerSerie: 700, iniziali: 4 } },
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
  // Trade di più giorni. Profitto minimo: un trade che è arrivato ad `attivazione` di guadagno non deve tornare in perdita:
  // se ridiscende a `minimo` (costi coperti più un piccolo guadagno) si esce in profitto. Uscita a tempo: dopo `sedute`
  // (l'orizzonte di Kronos) un trade che non rende almeno il minimo e per cui Kronos non vede più rialzo si chiude, per
  // non perdere giorni (e capitale fermo) su un trade che non funziona.
  piuGiorni: { profittoMinimo: { enabled: true, attivazione: { stocks: 0.02, crypto: 0.04 }, minimo: { stocks: 0.004, crypto: 0.012 } }, tempo: { enabled: true, sedute: 5 } },
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
  // Acquisti crypto (tutti gli agenti): fermati il 10/11/2026. Nella prova sullo storico del 9/11 le crypto intraday hanno
  // vinto il 20-25% dei trade (−0,8% a trade) in tutte le varianti, le azioni l'83-93% (+0,7%). Le crypto già aperte si
  // gestiscono fino all'uscita (stop, obiettivi, uscite); la raccolta del controllo giornaliero continua a misurarle per
  // decidere se riaccenderle (dalla dashboard).
  cryptoAcquisti: { enabled: false },
  cryptoUniverse: { enabled: true, topMarketCap: 100, maxPairs: 40, refreshHours: 24, coingeckoUrl: "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1" },
  // Custodi: un agente per ogni crypto in portafoglio o tra le migliori candidate; ognuno segue il suo titolo
  // con tesi, piano e rischio dichiarati, dentro le stesse regole del motore.
  // Custodi senza numero fisso: uno per ogni titolo o crypto in trend (maxCandidates è solo una sicurezza).
  // minProbabilita: sotto questa probabilità favorevole del dossier il trading agent non vota l'acquisto (è il suo stesso
  // consiglio «restare fuori»); il capo ufficio può alzarla per la squadra e per la singola persona (src/agents/profili.ts).
  custodi: { enabled: true, maxCandidates: 100, pullbackSmaDays: 20, extendedPct: 0.15, keepIdleTicks: 12, minProbabilita: 0.57 },
  // Calibrazione del capo ufficio (src/agents/calibrazione.ts): sotto `obiettivo` di vittorie su almeno `minTrade` trade
  // chiusi un agente diventa più selettivo di un passo (al massimo `maxPassi`); da `buono` in su torna di un passo.
  calibrazione: { enabled: true, minTrade: 10, obiettivo: 0.51, buono: 0.55, maxPassi: 4 },
  // Coordinatore dell'apprendimento (src/agents/apprendimento.ts): finestra degli ultimi trade, campioni minimi, quanto
  // pesa la squadra per chi ha pochi trade, tetto ai passi di selettività sommati (squadra + persona).
  apprendimento: { finestra: 30, minTradePersona: 20, minTradeSquadra: 10, forzaSquadra: 10, maxPassiTotali: 4 },
  // Formazione in sala caffè: chi, sugli ultimi trade chiusi dal suo rientro (almeno minTrade), vince meno di `obiettivo`
  // e chiude in perdita va in sala caffè per `ore` ore a imparare da chi lavora bene; alla scrivania restano sempre
  // almeno `minOperativi` trading agents (e agenti generali) e almeno `minIntraday` operatori della sala intraday quando
  // c'è un'occasione (zero se non c'è niente da fare): se mancano, chi è in sala caffè e trova un'occasione rientra, per
  // primo chi c'è da più tempo.
  // Lo staff: un team di 20 persone che prendono le occasioni del motore (ognuna sia di più giorni sia intraday): pochi,
  // così ognuno accumula esperienza e i suoi parametri migliorano. Il team è fisso: nessuno esce, chi non lavora è in
  // sala caffè (in pausa o in formazione).
  persone: { totale: 20 },
  formazione: { enabled: true, minTrade: 20, obiettivo: 0.51, ore: 24, minOperativi: 10, minIntraday: 1 },
  // Evidenza combinata del dossier (Kronos, grafico, notizie, contesto) minima per un ingresso nuovo di più giorni:
  // sopra la media a 200 e, più alta, sotto la 200 (contro tendenza).
  // Stessa soglia della scrivania: si vota e si entra solo da «pronto» (57%); contro tendenza serve di più.
  evidenza: { min: 0.57, minContro: 0.65 },
  // Proposte del capo ufficio sulle impostazioni generali (src/agents/proposte.ts): solo con almeno minTrade operazioni
  // intraday chiuse e minGruppo nel gruppo che giustifica la proposta; analizza le ultime `finestra`; una proposta
  // rifiutata non torna per giorniRifiuto giorni. Il capo propone (nell'Ufficio si alza e alza la mano), decide l'utente dalla sua scheda.
  capo: { proposte: { minTrade: 30, minGruppo: 12, finestra: 200, giorniRifiuto: 7 } },
  // Il motore punta all'intraday: gli ingressi nuovi si decidono solo sulle candele (5 e 15 minuti, 1 e 4 ore) con gli
  // intraday agents; un trade si estende su più giorni solo se a fine giornata le proiezioni di Kronos sulle candele
  // restano dentro la forchetta del trade (intraday.riporto). I voti di più giorni (trend, custodi, Kronos a 5 sedute,
  // rientro) restano come contesto ma da soli non aprono posizioni. false = comportamento di prima.
  puntaIntraday: true,
  // Rimbalzo di breve: la media a 50 giorni diventa facoltativa. Con il prezzo sotto la 50 (anche sotto la 200), dopo un
  // calo netto nell'ultimo giorno (oltre caloMin o caloVol volte la volatilità giornaliera; la giornata conclusa o quella
  // in corso) si cerca il rimbalzo con gli intraday agents: tutto si decide sulle candele (5 min, 15 min, 1 ora, 4 ore) e
  // su Kronos per quelle candele, non a sedute o a giorni. Si entra se Kronos sulla candela scelta anticipa un rialzo
  // temporaneo che copre i costi con probabilità ≥ minFiducia, anche con le medie brevi non ancora in ordine; obiettivo
  // il rialzo previsto, scadenza l'orizzonte di Kronos su quella candela (prolungabile se le candele superiori vedono
  // ancora rialzo), stop della candela.
  // Il calo può essere anche di qualche giorno (giorni, soglia × fattoreGiorni) o delle ultime ore (dal massimo delle
  // ultime `ore` candele da 1 ora).
  rimbalzo: { enabled: true, caloMin: { stocks: 0.03, crypto: 0.05 }, caloVol: 1.5, minFiducia: 0.57, giorni: 3, fattoreGiorni: 1.5, ore: 8 },
  // Scaletta della prudenza secondo le medie giornaliere (la 200 conta più della 50): si investe anche sotto le medie,
  // con taglie via via più piccole. Più giorni: sopra entrambe piena, sotto la 50 ×0,75, sotto la 200 ×0,5, sotto
  // entrambe ×0,4. Intraday (candele 5 min - 4 ore): 1, 0,85, 0,75, 0,65. Sotto la 50 si preferisce il timeframe
  // breve: se c'è anche un voto intraday che da solo basta, si entra intraday invece che di più giorni.
  prudenzaMedie: { piuGiorni: { sopra: 1, sotto50: 0.75, sotto200: 0.5, sottoEntrambe: 0.4 }, intraday: { sopra: 1, sotto50: 0.85, sotto200: 0.75, sottoEntrambe: 0.65 } },
  // Contanti che restano sempre liberi (quota del patrimonio): il riparto del capitale divide il resto.
  riservaContanti: 0.01,
  // Costi di andata e ritorno su Alpaca: crypto 0,25% per lato (taker, livello base: percentuale, nessuna quota fissa);
  // azioni senza commissioni, solo tasse regolamentari sulle vendite arrotondate al centesimo (trascurabili sopra i 100 $).
  // Un ingresso di più giorni si fa solo se Kronos prevede almeno `margineCosti` volte il costo; una posizione nuova
  // vale la pena da `minNuova.pct` del conto e almeno `minNuova.usd` dollari.
  // Crypto: gli acquisti si fanno con ordini limite appena sotto il prezzo (ordiniLimite), che restano nel book e pagano
  // la commissione maker (0,15%) invece della taker (0,25%); le vendite restano a mercato (taker). Andata e ritorno
  // 0,40% invece di 0,50%. Un limite non eseguito entro scadenzaMinuti si cancella: al giro dopo si rivaluta.
  // Esecuzione: prima di inviare un acquisto il prezzo si rilegge; salito oltre maxRialzo dal prezzo su cui si è deciso,
  // non si compra (il giro dura un paio di minuti, l'occasione può essere passata).
  esecuzione: { maxRialzo: 0.003 },
  costi: { cryptoAndataRitorno: 0.004, azioniAndataRitorno: 0.0005, margineCosti: 2, ordiniLimite: { crypto: true, sotto: 0.0005, scadenzaMinuti: 10, sopraVendita: 0.001 } },
  // Su un conto piccolo (es. 1.000 $) i 100 $ fissi erano il 10% del conto: quasi nessun ingresso intraday ci arrivava.
  // Il minimo in dollari è al più `quotaConto` del conto (1.000 $ → 10 $; da 10.000 $ in su resta 100 $).
  minNuova: { pct: 0.002, usd: 100, quotaConto: 0.01 },
  // Frazioni di azione. Alpaca le accetta solo sui titoli con fractionable = true (si chiede una volta al giorno), con
  // ordini «day» (mai GTC) e almeno 1 $ (minimoUsd). Si compra a frazioni solo quando le azioni intere toglierebbero
  // troppo: con almeno un'azione intera e uno scarto entro tolleranzaIntere (12,4 → 12, il 3% in meno) si comprano intere,
  // così la posizione resta protetta per intero dallo stop GTC su Alpaca. Una posizione frazionaria ha due stop: le
  // azioni intere con uno stop GTC (vale anche a PC spento) e la frazione con uno stop «day», rinnovato ogni giorno al
  // primo giro a borsa aperta; prima di quel giro (e se Alpaca lo rifiuta) la frazione la protegge lo stop del motore.
  frazioni: { enabled: true, tolleranzaIntere: 0.1, minimoUsd: 1 },
  // Esplorazione: gli agenti in sala caffè passano in rassegna il radar (RADAR_SECTORS e le crypto rimaste fuori dal
  // tetto di coppie) ogni everyMinutes (di serie ogni minuto, anche tra un giro e l'altro), perGiro titoli alla volta;
  // finito il radar si ricomincia da capo (i prezzi cambiano, Kronos si chiede una volta al giorno per titolo). Un titolo che supera i criteri del motore (sopra la
  // media a 200, grafico in ordine, Kronos al rialzo oltre la soglia) entra nell'universo per giorniValida giorni; chi
  // l'ha trovato torna alla scrivania e lo vota. maxScoperte: quante scoperte nuove al giorno, al massimo.
  // Con il motore che punta all'intraday (puntaIntraday) i criteri sono quelli dell'intraday: il titolo deve muoversi
  // abbastanza in una giornata da coprire i costi più volte (volatilità giornaliera a 20 giorni ≥ intraday.volMin) e
  // Kronos a 5 sedute non deve vedere un calo netto; il resto (se, quando e su che candela entrare) lo decidono gli
  // intraday agents sulle candele. Niente voti di più giorni, e una scoperta con un voto intraday non si lascia.
  esplorazione: { enabled: true, everyMinutes: 1, perGiro: 6, maxScoperte: 100, giorniValida: 3, minTecnica: 0.5, intraday: { volMin: { azioni: 0.015, crypto: 0.03 } } },
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
    // 60% per tutte e due (10/11/2026): nella prova sullo storico del 9/11 la soglia al 60% ha dato il risultato migliore
    // (47% vinti, −0,24% a trade, contro 41% e −0,31% con 55%/57%).
    kronos: { orizzontiMin: [15, 30, 60, 120, 240, 480] as number[], maxCandele: 20, perGiro: 60, minProb: 0.6, minProbSenzaGrafico: 0.6, zMax: 4 },
    // Scelta della candela: la probabilità che conta è quella di un guadagno NETTO dei costi di andata e ritorno, Φ(z) con
    // z = (rialzo previsto − costi) / (volatilità delle candele × √candele), moltiplicato per l'affidabilità misurata della
    // candela dal cervello: quota di direzioni giuste di Kronos su quella candela, avvicinata a `prior` con il peso di `forza`
    // previsioni finte (un campione piccolo conta poco). Fattore = (quota − 50%) / (prior − 50%), tra 0 e `max`: una candela
    // su cui Kronos indovina come una moneta non fa entrare, una su cui indovina più del previsto pesa di più.
    // minClasse: con almeno tante previsioni verificate di una classe (azioni o crypto) su una candela valgono le sue,
    // altrimenti quelle complessive.
    affidabilita: { prior: 0.55, forza: 100, max: 1.5, minClasse: 150 },
    // Con i singoli percorsi di Kronos (il sidecar li manda): la probabilità è la quota di percorsi che chiudono sopra i
    // costi senza toccare lo stop, avvicinata a 50% secondo l'affidabilità della candela: 0,5 + fattore × (quota − 0,5).
    // Lo stop è il minimo che i percorsi peggiori toccano (il `quantileStop` dei minimi: l'80% dei percorsi resta sopra),
    // tra lo stop minimo e quello dell'ATR. Senza percorsi valgono Φ(z) e lo stop dell'ATR.
    // prudenza: i percorsi di Kronos misurano solo l'incertezza che Kronos vede, non quella sul modello: la quota si
    // avvicina ancora a 50% (× prudenza) finché la calibrazione sui trade veri non la corregge. Il primo giorno, stimate
    // 69-78%, vinti 3 su 6.
    percorsi: { minCampioni: 8, quantileStop: 0.2, prudenza: 0.5 },
    // Selezione prima di Kronos (meno titoli, più qualità): una coppia titolo-candela si proietta solo se in quel tempo il
    // prezzo si muove abbastanza da coprire i costi (volatilità sull'orizzonte più lungo ≥ movimentoMin × due volte i
    // costi); poi, per ogni candela, al massimo perCandela proiezioni nuove a giro: prima rotture e rientri, poi medie brevi
    // in ordine e rimbalzi, poi le altre per la probabilità vista all'ultima proiezione; `esplora` posti a rotazione per le
    // altre. Così il giro resta sotto i 5 minuti anche quando chiudono insieme le candele da 5, 15 minuti e 1 ora.
    selezione: { perCandela: { "5Min": 8, "15Min": 10, "1Hour": 16, "4Hour": 6 } as Record<string, number>, esplora: 2, movimentoMin: 1 },
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
    // Minimo 20 trade (come le lezioni del capo): con 8 bastavano 4 vinti su 9 per alzare la soglia di 5 punti.
    vittorie: { obiettivo: 0.51, ultimi: 20, minimo: 20, passo: 0.05 },
    // Le candele su cui si cerca l'ingresso: con Kronos si sceglie quella con la probabilità di successo più alta.
    candele: ["5Min", "15Min", "1Hour", "4Hour"] as string[],
    // Azioni: il feed gratuito di Alpaca è solo IEX (circa il 2% degli scambi): le candele da 5 e 15 minuti sono troppo
    // rumorose per Kronos. Per le azioni si usano solo 1 ora e 4 ore; le crypto hanno tutte le candele.
    candeleAzioni: ["1Hour", "4Hour"] as string[],
    // Obiettivo: con Kronos è il rialzo che Kronos prevede sull'orizzonte scelto (minuti o ore), mai sotto due volte i
    // costi di andata e ritorno (crypto 0,8%, azioni 0,1%); senza Kronos il maggiore tra questo minimo (azioni 0,3%,
    // crypto 1,2%) e targetAtr × ATR. Si entra solo se l'obiettivo vale almeno rapportoMin volte lo stop: un trade breve da
    // pochi minuti è possibile quando Kronos vede un movimento netto rispetto al rumore della candela.
    target: { stocks: 0.003, crypto: 0.012 },
    rapportoMin: 1.2,
    // Promozione: un'operazione intraday in guadagno che a fine finestra (chiusura della borsa, durata massima delle crypto)
    // rispetta i criteri del metodo di più giorni (trend o Kronos netto, Kronos a 5 sedute che copre i costi con probabilità
    // ≥ minProb, nessuna attesa del contesto né trimestrale vicina) non si chiude: passa alle regole di più giorni.
    promozione: { enabled: true, minProb: 0.55 },
    // Candele su cui Kronos non ha (ancora) un vantaggio misurato: con almeno minCampione previsioni verificate e un
    // fattore d'affidabilità sotto minFattore non si entra su quella candela; si continua a proiettarla poco (misuraPerGiro
    // coppie a giro) per misurarla, e torna utilizzabile appena il vantaggio compare.
    // Anche con almeno minCampioneContro previsioni e direzione giusta sotto minGiusti (peggio di una moneta) la candela non
    // si usa: né per entrare né come candela superiore che conferma o blocca (es. 4 ore: giusta il 41% su 44).
    // Con almeno minCampione previsioni e una resa media (seguendo il segno di Kronos, lorda dei costi) ≤ minResa la
    // candela non si usa neanche se la direzione è giusta più della metà delle volte: indovinare i movimenti piccoli e
    // sbagliare quelli grandi non rende.
    vantaggio: { minCampione: 300, minFattore: 0.25, misuraPerGiro: 6, minCampioneContro: 40, minGiusti: 0.5, minResa: 0 },
    // Le informazioni del dossier (Kronos a 5 sedute, grafico giornaliero, notizie e post, contesto con Fear & Greed e
    // funding) o, senza dossier, il contesto del settore pesano `peso` nella probabilità con cui si decide l'ingresso
    // (il resto è Kronos sulle candele): una parte minima, che sposta solo i casi al limite.
    evidenza: { peso: 0.15 },
    // Crypto intraday. I costi di andata e ritorno (0,4%) sono più grandi del vantaggio misurato di Kronos sulle candele
    // brevi: si entra sulle `candele` (1 e 4 ore) come per le azioni; sulle 5 e 15 minuti solo con un rialzo previsto di
    // almeno rialzoCosti volte i costi. Le crypto si muovono insieme: al massimo maxIngressiGiro ingressi crypto nuovi a
    // giro (prima i più probabili) e maxAperte operazioni crypto intraday aperte insieme, se no è una scommessa sola
    // ripetuta (nella prova sullo storico 7 crypto entrate nello stesso giro e uscite tutte allo stop).
    crypto: { candele: ["1Hour", "4Hour"] as string[], rialzoCosti: 3, maxIngressiGiro: 2, maxAperte: 3 },
    // Taglia intraday: gli indizi contrari tolgono penalitaIndizio di probabilità ciascuno (non dimezzano la taglia); i
    // fattori di rischio della taglia (fiducia, medie, stop, serie di perdite) non la portano sotto `pavimento` della
    // taglia massima.
    // pavimento 0,6 (dal 10/11/2026, era 0,3): con solo azioni e poche occasioni, la fiducia e la prudenza riducono la
    // taglia al massimo del 40%, così il budget dell'80% si usa davvero.
    taglia: { pavimento: 0.6, penalitaIndizio: 0.02 },
    // Lascia correre i trade in guadagno: dopo il pareggio lo stop segue il massimo a trailingAtr ATR della candela;
    // un'uscita «morbida» (obiettivo raggiunto senza altro rialzo, piccolo calo previsto da Kronos, orizzonte scaduto,
    // medie perse) su un trade che guadagna più di minGuadagnoCosti volte i costi alza lo stop a `blocca` del guadagno
    // (mai sotto 1,5 volte i costi) e chiude solo se la ragione resta per `conferma` candele di controllo di fila.
    lasciaCorrere: { enabled: true, trailingAtr: 2, blocca: 0.5, conferma: 2, minGuadagnoCosti: 2 },
    // Stop su Alpaca delle operazioni intraday al loro livello (quello che l'agente segue: −0,4%, pareggio, rialzi), non a
    // quello largo dei più giorni (−5/−10%): a PC spento o tra un giro e l'altro la perdita si ferma dove deve.
    stopSuAlpaca: true,
    // Più ingressi sullo stesso titolo nello stesso giorno: al massimo `max` volte al giorno. Dopo una chiusa in perdita
    // (stop compreso) vale `rientro`: pausa di qualche ora, poi più margine.
    // Rientro dopo una perdita sul titolo (qualsiasi agente, stop compresi): nessun blocco di giorni. Pausa di `pausaOre`
    // ore dalla chiusura, poi per `finestraOre` ore la soglia di probabilità sale di `extraProb` (rientro valutato con
    // più margine), sempre con una proiezione nuova di Kronos (la stessa che ha fatto il trade non rientra).
    rientro: { pausaOre: 2, finestraOre: 24, extraProb: 0.03 },
    ingressiGiorno: { max: 3 },
    // Riporto al giorno dopo (sostituisce la promozione a posizione di più giorni): a fine giornata un'operazione si tiene
    // se le proiezioni di Kronos sulle sue candele e su quelle superiori restano dentro la forchetta del trade (nessuna
    // tocca lo stop, la più lunga vede salire con probabilità ≥ minProb); il giorno dopo decidono di nuovo le candele.
    // Al massimo maxRiporti volte.
    riporto: { enabled: true, minProb: 0.55, maxRiporti: 5 },
    // Stop minimo: sulle crypto sopra il costo di andata e ritorno (0,5%), altrimenti ogni stop costa quasi il doppio.
    targetAtr: 1.5, stopAtr: 1.2, minStopPct: { stocks: 0.004, crypto: 0.01 },
    // Peso massimo di un'operazione intraday (un titolo). La taglia vera la decide il rischio allo stop (budget.rischioTrade).
    maxWeight: 0.25,
    // Budget dell'intraday. Taglia di un trade: perdita allo stop (stop + costi + scivolamento) ≤ rischioTrade del conto,
    // al massimo maxWeight; un trade con lo stop largo (crypto, 4 ore, trend) è da solo più piccolo, uno con lo stop
    // stretto (azioni su 1 ora, −0,4%) può arrivare al 25%. Investito in intraday nello stesso momento: al massimo
    // `quota` del conto (80%, dal 10/11/2026: su 1.000 $ si investono 800 $ divisi tra le occasioni della giornata); le
    // crypto, che si muovono insieme, al massimo maxCrypto; un trade da solo al massimo maxQuotaTrade del budget (25% → 20%
    // del conto: servono almeno 4 titoli per riempirlo). Se le occasioni chiedono più del budget, si divide per qualità.
    // riservaOccasioni: il resto del conto (20%) resta liquido per un'occasione in più a budget pieno, ma solo se nettamente
    // migliore (probabilità d'ingresso ≥ soglia + extraProb) e al massimo maxTrade del conto a operazione.
    budget: { quota: 0.8, rischioTrade: 0.0025, scivolamento: 0.002, maxCrypto: 0.2, maxQuotaTrade: 0.25,
      riservaOccasioni: { enabled: true, quota: 0.2, extraProb: 0.1, maxTrade: 0.1 },
      // Profitto reinvestito: il guadagno accumulato dal capitale di partenza (state/benchmark.json) si aggiunge al budget
      // per la parte `quota` (1 = tutto), fino a `tetto` del conto. Sotto il capitale di partenza vale la quota di serie.
      // Il budget è una quota del patrimonio: il profitto è già reinvestito all'80%; con il tetto all'80% la parte in più
      // non si aggiunge (resta la riserva per le occasioni). Conta se la quota scende sotto il tetto.
      reinvesti: { enabled: true, quota: 1, tetto: 0.8 } },
    // Sostituzione dei trade deboli: con budget o contanti pieni (spazio libero sotto `mancanza` di quanto chiede la
    // migliore occasione nuova), si vende l'operazione aperta più debole per far posto a quella. Debole: aperta da almeno
    // `minMinuti`, nessuna uscita già decisa, non sostenuta dalle candele superiori né in corsa, e probabilità di salire
    // sulla sua candela di controllo sotto la soglia d'ingresso (oggi non la si aprirebbe). La nuova deve avere almeno
    // `margine` punti di probabilità in più (netta dei costi, contro una che non li conta: il confronto è prudente).
    // Al massimo una a giro e `maxGiorno` al giorno; mai quando nello stesso giro si vende già altro (lo spazio si libera da sé).
    // traClassi: false = un'azione si sostituisce solo con un'azione e una crypto con una crypto (le probabilità delle
    // crypto sono risultate troppo ottimiste: nella prova del 9/11 MSFT e AAPL in guadagno vendute per LINK e ADA all'81%).
    sostituzione: { enabled: true, mancanza: 0.5, minMinuti: 30, margine: 0.1, maxGiorno: 4, traClassi: false },
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

