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
export const CRYPTO_QTY_DECIMALS = 6;
// Prezzo limite dello stop_limit crypto: mezzo punto sotto lo stop, così scatta e viene eseguito anche con un buco.
export const CRYPTO_STOP_LIMIT_GAP = 0.005;

export const LIMITS = {
  maxPositions: 5,
  maxPositionPct: 0.2,
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
  // Oltre questa perdita in giornata niente acquisti fino a domani.
  maxDailyLossPct: 0.02,
  // Dopo uno stop loss su un titolo, niente riacquisto per questi giorni di borsa.
  stopLossCooldownDays: 5,
  // Due rifiuti di Alpaca uguali (titolo + lato) entro questi giorni bloccano quel titolo-lato per altrettanti giorni.
  brokerRejectWindowDays: 5,
};

// Storico giornaliero da chiedere: media a 200 giorni più margine per festività.
export const DAILY_BARS_DAYS = 260;

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
  horizonSessions: 20,
  // Titoli che gli agenti possono comprare: senza IWM e TLT (attesa nulla o negativa con obiettivo +3% / stop -3%).
  // Le crypto si aggiungono con --crypto (enableCrypto): nel backtest ago 2025 - nov 2026 hanno tolto 5-6 punti.
  // La gabbia accetta comunque vendite su tutto UNIVERSE ∪ CRYPTO.
  universe: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "GLD"] as string[],
  // Finestra degli ingressi, ora di Roma: dopo i primi 10 minuti di seduta, fino a metà pomeriggio USA.
  entryWindow: { from: "15:40", to: "17:30" },
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
  // Rientro sul trend: prezzo tra la media a 50 e il 2% sopra, dopo che nelle ultime 20 sedute era almeno il 4% sopra.
  pullback: { nearPct: 0.02, runUpPct: 0.04, lookback: 20 },
  // Pesi degli agenti dal diario: scendono se un agente perde con un campione almeno indicativo, salgono se vince con campione affidabile.
  weights: { base: 1, losing: 0.5, winning: 1.2 },
  // Kronos (sidecar Python, opzionale): si considerano solo le previsioni più nette (quota) e solo se concordano col trend.
  kronos: { topShare: 0.25, horizon: 5, timeoutMs: 90_000 },
  // Riepilogo su Telegram una volta al giorno, alla prima passata dopo quest'ora di Roma.
  summaryAfter: "22:05",
  // Presa di profitto secca (agente "profitto"): spenta di serie, si accende con --profitto; il backtest la misura.
  takeProfit: { enabled: false, pct: 0.02 },
  // Politica di uscita (agente "uscite", segnali vincolanti che la gabbia non può votare via):
  // stop a -3% dal carico (anche come stop GTC su Alpaca); a +3% (o +4% per titolo) si incassa, a meno che la proiezione (Kronos) dica
  // che c'è altro da prendere: allora si lascia correre con uno stop che segue il massimo e non restituisce più del
  // rischio (giveBackPct), mai sotto il carico + lockPct. Proiezione negativa: si esce subito, in guadagno o in perdita.
  // Stop a -3%: con -2% NVDA (3% di volatilità al giorno) usciva sul rumore. Obiettivo +4% dove le barriere lo pagano.
  exit: { enabled: true, stopPct: 0.03, targetPct: 0.03, targetBySymbol: { GLD: 0.04, MSFT: 0.04, QQQ: 0.04 } as Record<string, number>, giveBackPct: 0.02, lockPct: 0.005 },
  // Contesto economico (agente "contesto"): prima di ogni trade. Regole sui dati di mercato e sul calendario eventi sempre;
  // in più, se c'è `claude -p`, una lettura della situazione economica con ricerca web ogni refreshHours (cache in state/macro.json).
  // Sfavorevole: esposizione × unfavorableScale, nessun ingresso nuovo e niente fiducia nella proiezione per quel settore
  // (si aspetta la candela successiva). Neutro: esposizione × neutralScale, si entra ma la proiezione non guida le uscite.
  context: { enabled: true, useClaude: true, refreshHours: 6, unfavorableScale: 0.5, neutralScale: 0.75, waitDaysBeforeEvent: 2 },
  dashboardPort: 8787,
  eventsKeepDays: 60,
};

// Aggiunge BTC/USD ed ETH/USD all'universo degli agenti (24 ore su 24). Scelta esplicita, non di serie.
export function enableCrypto() {
  for (const c of CRYPTO) if (!AGENTS.universe.includes(c)) AGENTS.universe.push(c);
}
