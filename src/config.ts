// Unico endpoint di trading ammesso. Non è configurabile, di proposito.
export const PAPER_TRADING_URL = "https://paper-api.alpaca.markets";
// Dati di mercato (solo lettura, prezzi). Stesso host per paper e live.
export const MARKET_DATA_URL = "https://data.alpaca.markets";

export const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"] as const;

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
  // Interruttore: oltre questa perdita dal massimo gli acquisti si fermano finché non lo riarmi tu.
  maxDrawdownPct: 0.05,
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
