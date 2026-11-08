import { AGENTS, LIMITS } from "../config.ts";
import type { JournalFile } from "../journal.ts";
import { romeTime } from "../slots.ts";

// La biblioteca degli agenti: i principi dei libri di trading e di economia più noti, tradotti in regole che il motore
// applica davvero. Gli agenti non «leggono» i libri: ogni principio qui sotto corrisponde a un controllo nel codice (indicato
// in `nelMotore`), e tutti gli agenti lo condividono perché passano dallo stesso allocatore, dalla stessa gabbia e dalle
// stesse regole di uscita. Dove un libro non c'entra con il trading su candele (es. l'analisi dei bilanci) lo si dice.

export interface Principio {
  id: string;
  autore: string;
  libro: string;
  principio: string;
  nelMotore: string;
  applicato: boolean;
}

const pc = (x: number) => `${+(x * 100).toFixed(1)}%`;

export const BIBLIOTECA: Principio[] = [
  { id: "triple-screen", autore: "Alexander Elder", libro: "Come si diventa un trader vincente (Trading for a Living)", principio: "Triple Screen: la direzione la dà la candela lunga, il momento d'ingresso quella breve.", nelMotore: "Un ingresso su candele da 5 o 15 minuti richiede che Kronos su 1 ora e 4 ore non preveda un calo oltre i costi; se lì prevede un rialzo netto il trade diventa di trend (obiettivo e stop delle ore) e i cali di pochi minuti non lo chiudono.", applicato: true },
  { id: "elder-2", autore: "Alexander Elder", libro: "Come si diventa un trader vincente", principio: "Regola del 2%: mai rischiare più del 2% del conto su un'operazione.", nelMotore: `Al massimo ${pc(LIMITS.maxPositionPct)} del conto per titolo con stop al massimo a ${pc(LIMITS.stop.maxPct)}: rischio massimo ${pc(LIMITS.maxPositionPct * LIMITS.stop.maxPct)} per operazione; l'intraday rischia molto meno (taglia ≤ ${pc(AGENTS.intraday.maxWeight)} con stop di 1-3%).`, applicato: true },
  { id: "elder-6", autore: "Alexander Elder", libro: "Come si diventa un trader vincente", principio: "Regola del 6%: se le perdite del mese arrivano al 6% del conto, stop ai nuovi trade fino al mese dopo.", nelMotore: `Perdite realizzate del mese (diario) oltre ${pc(AGENTS.biblioteca.meseMaxPerdita)} del patrimonio: niente nuovi acquisti fino al mese successivo; vendite e stop restano attivi.`, applicato: true },
  { id: "livermore", autore: "Edwin Lefèvre (Jesse Livermore)", libro: "Memorie di un operatore di borsa (Reminiscences of a Stock Operator)", principio: "Taglia le perdite, lascia correre i profitti; non mediare mai al ribasso.", nelMotore: "Stop su ogni posizione (anche su Alpaca); oltre l'obiettivo, se Kronos vede altro rialzo, si lascia correre con lo stop alzato; nessuna aggiunta a una posizione in perdita.", applicato: true },
  { id: "thorp", autore: "Edward O. Thorp", libro: "Beat the Market / Un uomo per tutti i mercati", principio: "Si gioca solo con aspettativa positiva (criterio di Kelly).", nelMotore: "Un ingresso intraday passa solo se probabilità × guadagno netto − (1 − probabilità) × perdita allo stop (costi compresi) è maggiore di zero.", applicato: true },
  { id: "tharp", autore: "Van K. Tharp", libro: "Trade Your Way to Financial Freedom", principio: "La taglia della posizione decide il risultato: rischio costante per operazione.", nelMotore: "Taglia scalata sulla volatilità del titolo e sulla fiducia in Kronos; un trade di trend con stop più largo ha la taglia ridotta in proporzione, così il rischio in euro non cambia.", applicato: true },
  { id: "douglas", autore: "Mark Douglas / Daniel Kahneman", libro: "Trading in the Zone / Pensieri lenti e veloci", principio: "Pensare in probabilità e non rincorrere le perdite (avversione alla perdita, effetto disposizione).", nelMotore: `Dopo ${AGENTS.intraday.serieNegativa.perdite} operazioni intraday in perdita di fila nella giornata la taglia scende a ×${AGENTS.intraday.serieNegativa.fattore}; ogni decisione viene da regole e probabilità, e un trade in guadagno non si chiude in anticipo se il trend continua.`, applicato: true },
  { id: "murphy", autore: "John J. Murphy", libro: "Analisi tecnica dei mercati finanziari", principio: "Trend, medie mobili, rotture e conferma su più time frame.", nelMotore: "Medie a 50 e 200 giorni per il trend, EMA 9/20, rotture dei massimi e rientri sulla media sulle candele intraday, candela superiore come correttivo.", applicato: true },
  { id: "turtle", autore: "Michael Covel / Curtis Faith", libro: "Trend Following / Way of the Turtle", principio: "Segui il trend con stop basati sulla volatilità (ATR).", nelMotore: "Agente trend; stop a multipli di volatilità giornaliera (posizioni di più giorni) e di ATR della candela (intraday).", applicato: true },
  { id: "oneil", autore: "William O'Neil", libro: "How to Make Money in Stocks (CAN SLIM)", principio: "Compra i titoli forti vicino ai massimi, taglia le perdite al 7-8%.", nelMotore: `Sopra la media a 200 e momentum a 12 mesi positivo per gli ingressi di più giorni; stop tra ${pc(LIMITS.stop.minPct)} e ${pc(LIMITS.stop.maxPct)} dal carico.`, applicato: true },
  { id: "schwager", autore: "Jack D. Schwager", libro: "Market Wizards", principio: "Prima la gestione del rischio: limiti di perdita e disciplina.", nelMotore: "Interruttore sul patrimonio, obiettivo e perdita giornaliera, gabbia con limiti per titolo e per settore (35%), stop su Alpaca anche a computer spento.", applicato: true },
  { id: "taleb", autore: "Nassim N. Taleb", libro: "Il cigno nero / Giocati dal caso", principio: "Diffida delle previsioni estreme e proteggiti dalle code.", nelMotore: "Le proiezioni di Kronos fuori misura (oltre 4 volte la volatilità o ±25%) si scartano come rumore; limiti di volatilità per titolo e di portafoglio.", applicato: true },
  { id: "lo", autore: "Andrew W. Lo", libro: "Adaptive Markets", principio: "Le strategie funzionano finché il mercato non cambia: adattarsi a ciò che rende.", nelMotore: "Il cervello misura quanto spesso Kronos indovina la direzione su ogni candela e pesa di conseguenza la scelta del time frame; capo ufficio e sala caffè correggono gli agenti con i risultati del diario.", applicato: true },
  { id: "malkiel", autore: "Burton G. Malkiel", libro: "A Random Walk Down Wall Street", principio: "Costi e rumore mangiano i rendimenti: molti segnali brevi sono caso.", nelMotore: "Il rialzo previsto deve coprire 2 volte i costi di andata e ritorno; la probabilità che decide la candela è quella di un guadagno netto dei costi.", applicato: true },
  { id: "graham", autore: "Benjamin Graham", libro: "L'investitore intelligente", principio: "Margine di sicurezza sul valore dei bilanci.", nelMotore: "Non applicato: il motore non legge bilanci e lavora su orizzonti da minuti a giorni; ne resta lo spirito nel rapporto obiettivo/stop minimo (1,2) e nell'uscita prima delle trimestrali.", applicato: false },
];

// Regola del 6% di Elder: perdite realizzate nel mese corrente (ora di Roma) rispetto al patrimonio.
export function perditaDelMese(journal: JournalFile, today: string, equity: number): { pnl: number; pct: number; oltre: boolean } {
  const mese = today.slice(0, 7);
  let pnl = 0;
  for (const t of journal.trade) {
    if (t.stato !== "chiuso" || !t.chiusoIl) continue;
    if (romeTime(new Date(t.chiusoIl)).date.slice(0, 7) !== mese) continue;
    pnl += (t.incassato ?? 0) - (t.costo ?? 0);
  }
  const pct = equity > 0 ? pnl / equity : 0;
  return { pnl, pct, oltre: pct <= -AGENTS.biblioteca.meseMaxPerdita };
}
