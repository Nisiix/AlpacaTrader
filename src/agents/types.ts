import type { Account, Position, Side } from "../broker/types.ts";
import type { Indicator } from "../indicators.ts";
import type { JournalFile } from "../journal.ts";
import type { CustodeStato } from "./custode.ts";
import type { IntradayStato } from "./intraday.ts";

// Un segnale è un'opinione: un agente, un titolo, un lato, una forza tra 0 e 1 e il perché in italiano.
// Nessun agente ordina niente: l'allocatore somma i segnali pesati e la gabbia decide cosa passa.
export interface Signal {
  agente: string;
  simbolo: string;
  lato: Side;
  forza: number; // 0..1
  orizzonteSedute: number;
  perche: string;
  // Regola di rischio, non opinione: l'allocatore la esegue senza sommarla agli altri voti.
  vincolante?: boolean;
  // Comparto a taglia ridotta (es. il rientro): peso massimo del titolo se lo votano solo segnali con questo limite.
  pesoMassimo?: number;
  // Vendita vincolante parziale: quota della posizione da vendere (1 = tutta).
  frazione?: number;
  // Voto di un'operazione intraday: la proposta che ne nasce si chiude in giornata.
  intraday?: boolean;
  // Proiezione di Kronos che sostiene il voto (rendimento a `horizon` sedute), se c'è.
  kronos?: number;
}

import type { FontiDati } from "./fonti.ts";

export interface AgentView {
  today: string; // YYYY-MM-DD ora di Roma
  now: Date;
  prices: Record<string, number>;
  closes: Record<string, number[]>; // sedute finite, dalla più vecchia
  indicators: Record<string, Indicator>;
  positions: Position[];
  account: Account;
  // Contanti già impegnati da ordini d'acquisto ancora aperti: l'allocatore non li ridistribuisce.
  cashImpegnato?: number;
  // Le proiezioni di Kronos utilizzabili prima del filtro del contesto. `previsioni` (filtrate: niente fiducia con eventi in
  // arrivo) servono a ciò che aumenta il rischio (ingressi, tenere); queste a ciò che lo riduce (uscire, controllare i costi):
  // una proiezione non fidata non può far comprare, ma può sempre far vendere o fermare un acquisto.
  previsioniKronos?: Record<string, number>;
  journal: JournalFile;
  // Rendimento previsto per simbolo (Kronos) quando il sidecar c'è; altrimenti assente.
  previsioni?: Record<string, number>;
  // Il percorso previsto da Kronos, seduta per seduta (rendimento rispetto all'ultima chiusura): serve a vedere i cali nel breve.
  percorsi?: Record<string, number[]>;
  // Contesto economico deciso prima degli altri agenti: settori in cui si aspetta, proiezioni di cui fidarsi.
  contesto?: MarketContext;
  // Borsa aperta adesso e finestra degli ingressi sui titoli: l'allocatore non spreca posti su titoli non negoziabili.
  mercatoAperto?: boolean;
  // Con la borsa aperta: quando chiude oggi (dall'orologio di Alpaca). Gli ingressi sulle azioni seguono l'orario vero.
  chiusuraBorsa?: string;
  finestraIngressi?: boolean;
  // Giornata: guadagno dal patrimonio di ieri e stato dell'obiettivo giornaliero (raggiunto → si incassa, niente nuovi ingressi).
  giornata?: { pnlPct: number; obiettivoRaggiunto: boolean; perditaOltre: boolean };
  // Fonti esterne (Fear & Greed delle crypto, funding dei perpetui): contorno per contesto e dossier.
  fonti?: FontiDati;
}

export type Outlook = "favorevole" | "neutro" | "sfavorevole";

export interface MarketContext {
  aggiornato: string;
  fonte: string; // "regole" | "claude" | "claude (cache)"
  generale: Outlook;
  settori: Record<string, Outlook>;
  motivo: string;
  // Titoli per cui oggi non si apre niente: si aspetta la candela successiva, con il perché.
  attendi: Record<string, string>;
  // Titoli per cui la proiezione (Kronos) può guidare uscite e ingressi.
  fidatiDellaProiezione: Record<string, boolean>;
}

export interface AgentReport {
  segnali: Signal[];
  // Solo l'agente del contesto: cosa ha deciso, per la vista degli altri agenti e per la dashboard.
  contesto?: MarketContext;
  // Solo gli agenti di rischio: moltiplicatore 0..1 dell'esposizione ammessa.
  rischio?: number;
  // Solo il regime: il moltiplicatore per le crypto (dal BTC), quando è diverso da quello delle azioni (dallo SPY).
  rischioCrypto?: number;
  note?: string[];
  // Solo l'agente dei custodi: lo stato di ogni custode (tesi, piano, rischio, livelli), per la dashboard.
  custodi?: CustodeStato[];
  // Solo l'agente intraday: operazioni aperte e candidate con candela, obiettivo e stop.
  intraday?: IntradayStato[];
}

export interface Agent {
  readonly name: string;
  observe(view: AgentView): AgentReport | Promise<AgentReport>;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
