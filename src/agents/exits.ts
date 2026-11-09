import { AGENTS, LIMITS, isCrypto } from "../config.ts";
import { dailyVol } from "../indicators.ts";
import { prossimaTrimestrale } from "../events.ts";
import { stopPctFor } from "../stops.ts";
import { kronosProb } from "./fiducia.ts";
import { soloIntraday } from "./posizioni.ts";
import { addTradingDays } from "../slots.ts";
import type { Agent, AgentReport, AgentView, Signal } from "./types.ts";

export interface ExitPolicy {
  mode: "trend" | "obiettivo";
  stopMode: "volatilita" | "fisso";
  trailAtr: number; // modalità trend: stop che segue il massimo a trailAtr × ATR
  stopPct: number; // perdita massima dal carico (stopMode fisso)
  targetPct: number; // guadagno a cui si incassa, se la proiezione non dice di continuare
  targetBySymbol?: Record<string, number>; // obiettivi diversi per titolo (dove le barriere pagano di più)
  giveBackPct: number; // quanto può restituire dal massimo chi continua
  lockPct: number; // sotto carico + lockPct non si scende più, una volta oltre l'obiettivo
}

// Le regole di uscita del conto, come agente con segnali vincolanti. La proiezione (Kronos, se c'è) decide solo
// se oltre l'obiettivo si incassa o si lascia correre con lo stop che segue; con proiezione negativa si esce subito.
// Uscita prima di una trimestrale (solo azioni): null se non è il momento; altrimenti cosa vendere (1 tutto, 0,5 metà,
// 0 niente: la metà è già stata venduta) e perché. Il momento: l'ultima seduta prima dei conti, negli ultimi minuti; se
// quella seduta è passata senza uscire (motore spento) e i conti non sono ancora usciti, appena la borsa è aperta.
export function uscitaTrimestrale(v: AgentView, simbolo: string, gain: number, fc: number | undefined, giaAlleggerita: boolean): { frazione: number; perche: string } | null {
  const t = AGENTS.trimestrali;
  if (!t.uscita || isCrypto(simbolo) || v.mercatoAperto === false) return null;
  const tri = prossimaTrimestrale(simbolo, v.today);
  if (!tri) return null;
  const minutiAllaChiusura = v.chiusuraBorsa ? (Date.parse(v.chiusuraBorsa) - v.now.getTime()) / 60_000 : null;
  const ultimaSeduta = v.today === tri.ultimaSeduta && (minutiAllaChiusura === null || minutiAllaChiusura <= t.minutiPrimaChiusura);
  const mancata = v.today > tri.ultimaSeduta && (v.today < tri.date || (v.today === tri.date && tri.quando === "dopo"));
  if (!ultimaSeduta && !mancata) return null;
  const vol = (v.closes[simbolo] ? dailyVol(v.closes[simbolo]!, LIMITS.volLookbackDays) : null) ?? LIMITS.fallbackDailyVol;
  const salto = Math.max(t.movimentoMin, t.movimentoVol * vol);
  const prob = kronosProb(v.closes[simbolo], fc);
  const kronosSi = fc !== undefined && fc > 0 && prob !== null && prob >= t.fiduciaTenere;
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const quando = tri.quando === "dopo" ? `il ${tri.date} dopo la chiusura` : tri.quando === "prima" ? `il ${tri.date} prima dell'apertura` : `il ${tri.date} (orario non comunicato)`;
  const k = fc === undefined ? "Kronos n.d." : `Kronos ${pct(fc)}${prob !== null ? ` (${Math.round(prob * 100)}%)` : ""}`;
  const base = `trimestrale ${quando}, salto atteso ±${(salto * 100).toFixed(1)}%, posizione ${pct(gain)}, ${k}`;
  const meta = (perche: string) => (giaAlleggerita ? { frazione: 0, perche: `${base}: metà già venduta, il resto resta (${perche})` } : { frazione: 0.5, perche: `${base}: si vende metà (${perche})` });
  if (gain >= salto) return meta("il guadagno copre anche un salto contrario: metà in tasca, metà resta per un salto favorevole");
  if (gain >= 0) return kronosSi ? meta("guadagno più piccolo del salto atteso, ma Kronos vede ancora rialzo") : { frazione: 1, perche: `${base}: si vende tutto (il guadagno non copre il salto atteso e Kronos non vede altro rialzo)` };
  if (-gain < salto / 4 && kronosSi) return meta("perdita piccola e Kronos favorevole: si riduce il rischio senza chiudere");
  return { frazione: 1, perche: `${base}: si vende tutto (in perdita, i conti non devono poterla allargare)` };
}

export class ExitAgent implements Agent {
  readonly name = "uscite";
  constructor(private policy: ExitPolicy = AGENTS.exit) {}

  observe(v: AgentView): AgentReport {
    const segnali: Signal[] = [];
    const { giveBackPct, lockPct } = this.policy;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    for (const p of v.positions) {
      if (p.qty <= 0 || p.avgEntryPrice <= 0) continue;
      const price = v.prices[p.symbol] ?? p.currentPrice;
      const gain = price / p.avgEntryPrice - 1;
      const trade = v.journal.trade.find((t) => t.simbolo === p.symbol && t.stato === "aperto");
      const peak = Math.max(trade?.massimo ?? 0, price, p.avgEntryPrice);
      const forecast = v.previsioni?.[p.symbol];
      const sell = (perche: string, frazione?: number) => segnali.push({ agente: this.name, simbolo: p.symbol, lato: "sell", forza: 1, orizzonteSedute: 0, perche, vincolante: true, ...(frazione ? { frazione } : {}) });
      // Il rientro ha le sue uscite brevi: qui restano solo lo stop e la proiezione.
      const soloRientro = trade?.contesto?.agenti?.length === 1 && trade.contesto.agenti[0] === "rientro";
      const stopPct = this.policy.stopMode === "fisso" ? this.policy.stopPct : stopPctFor(v.closes[p.symbol]);
      if (gain <= -stopPct) {
        sell(`perdita ${pct(gain)} oltre lo stop del ${pct(stopPct)}${this.policy.stopMode === "fisso" ? "" : " (scalato sulla volatilità)"}`);
        continue;
      }
      // Un'operazione intraday ha le sue uscite (obiettivo, stop e Kronos sulle candele brevi): qui resta solo lo stop di emergenza.
      if (soloIntraday(v.journal, p.symbol)) continue;
      // Per uscire vale anche la proiezione che il contesto non considera affidabile per entrare (riduce il rischio).
      const fcUscita = v.previsioniKronos?.[p.symbol] ?? forecast;
      // Difesa del guadagno del giorno: toccato l'obiettivo, il conto è tornato al pavimento. Chi non è favorevole (Kronos
      // a 5 sedute sotto la soglia di rialzo) si vende; chi lo è resta.
      const difesa = v.difesaPersonale?.[p.symbol];
      if (difesa && !(fcUscita !== undefined && fcUscita >= AGENTS.kronos.anticipaSoglia)) {
        sell(`difesa del guadagno del giorno: ${difesa}, e su ${p.symbol} Kronos non vede rialzo (${fcUscita === undefined ? "n.d." : pct(fcUscita)}): si vende a ${pct(gain)}`);
        continue;
      }
      // Trimestrale in arrivo: decisione sull'ultima seduta utile, da guadagno o perdita, salto atteso e Kronos.
      const conti = uscitaTrimestrale(v, p.symbol, gain, fcUscita, trade ? trade.quantita < trade.comprate - 1e-9 : false);
      if (conti) {
        if (conti.frazione !== 0) sell(conti.perche, conti.frazione);
        continue;
      }
      // Rimbalzo di breve: obiettivo il rialzo previsto da Kronos all'ingresso, al massimo maxSedute sedute (giorni per le
      // crypto). Lo stop, la proiezione che gira e le altre regole valgono come per tutti.
      const rimb = trade?.contesto?.misure?.rimbalzo !== undefined ? trade.contesto.misure : null;
      if (rimb && trade?.apertoIl) {
        const r = AGENTS.rimbalzo;
        const crypto = isCrypto(p.symbol);
        const ob = Math.max(rimb.obiettivo ?? 0, crypto ? r.minRendimento.crypto : r.minRendimento.stocks);
        if (gain >= ob) { sell(`rimbalzo preso: ${pct(gain)} dal carico, obiettivo ${pct(ob)} raggiunto`); continue; }
        const scaduto = crypto ? (v.now.getTime() - Date.parse(trade.apertoIl)) / 86_400_000 >= r.maxSedute : v.today >= addTradingDays(trade.apertoIl.slice(0, 10), r.maxSedute);
        if (scaduto) { sell(`rimbalzo di breve: dopo ${r.maxSedute} ${crypto ? "giorni" : "sedute"} il trade rende ${pct(gain)} senza aver toccato l'obiettivo (${pct(ob)}): si esce`); continue; }
      }
      // Protezione del profitto: in guadagno (oltre i costi) e Kronos vede nel breve un calo che lo azzererebbe → si incassa
      // adesso un profitto minore invece di rischiare di tornare a pari o in perdita.
      const pp = AGENTS.protezioneProfitto;
      const margine = isCrypto(p.symbol) ? pp.margine.crypto : pp.margine.stocks;
      const path = v.percorsi?.[p.symbol]?.slice(0, pp.sedute) ?? (fcUscita !== undefined ? [fcUscita] : []);
      const dip = path.length ? Math.min(...path) : null;
      if (pp.enabled && gain > margine && dip !== null && dip < 0 && (1 + gain) * (1 + dip) - 1 <= margine) {
        sell(`protezione del profitto: in guadagno del ${pct(gain)}, ma Kronos vede ${pct(dip)} nelle prossime ${pp.sedute} sedute, che lo azzererebbe: si incassa adesso`);
        continue;
      }
      // Profitto minimo sui più giorni: arrivato all'attivazione, il trade non torna in perdita; se ridiscende al minimo
      // (costi coperti più un piccolo guadagno) si esce in profitto.
      const pg = AGENTS.piuGiorni;
      const crypto = isCrypto(p.symbol);
      const minimo = crypto ? pg.profittoMinimo.minimo.crypto : pg.profittoMinimo.minimo.stocks;
      const picco = peak / p.avgEntryPrice - 1;
      if (pg.profittoMinimo.enabled && picco >= (crypto ? pg.profittoMinimo.attivazione.crypto : pg.profittoMinimo.attivazione.stocks) && gain <= minimo) {
        sell(`profitto minimo: il trade era arrivato a ${pct(picco)} ed è sceso a ${pct(gain)}: si esce in guadagno prima che torni in perdita`);
        continue;
      }
      // Uscita a tempo: dopo l'orizzonte di Kronos (sedute di borsa per le azioni, giorni per le crypto) un trade che non
      // rende almeno il minimo e per cui Kronos non vede più rialzo si chiude: niente giorni persi su un trade che non va.
      if (pg.tempo.enabled && trade?.apertoIl) {
        const giorni = crypto ? (v.now.getTime() - Date.parse(trade.apertoIl)) / 86_400_000 : null;
        const scaduto = crypto ? giorni! >= pg.tempo.sedute : v.today >= addTradingDays(trade.apertoIl.slice(0, 10), pg.tempo.sedute);
        if (scaduto && gain < minimo && !(fcUscita !== undefined && fcUscita >= AGENTS.kronos.anticipaSoglia)) {
          sell(`uscita a tempo: dopo ${pg.tempo.sedute} ${crypto ? "giorni" : "sedute"} il trade rende ${pct(gain)} (meno del minimo ${pct(minimo)}) e Kronos non vede più rialzo: si libera il capitale`);
          continue;
        }
      }
      // Stessa soglia con cui si compra (anticipaSoglia): un -0,2% non è una proiezione netta, e uscire sul rumore costa.
      if (fcUscita !== undefined && fcUscita <= -AGENTS.kronos.anticipaSoglia) {
        sell(`proiezione negativa (${pct(fcUscita)}) su un titolo in portafoglio: si esce ${gain >= 0 ? "in guadagno" : "limitando la perdita"} (${pct(gain)})`);
        continue;
      }
      if (soloRientro) continue;
      if (this.policy.mode === "trend") {
        // Si lascia correre: l'uscita normale è quella di trend della gabbia. Con trailAtr > 0 si esce anche se dal massimo
        // il prezzo torna indietro di trailAtr × ATR (ATR ≈ prezzo × volatilità).
        if (this.policy.trailAtr <= 0) continue;
        const vol = (v.closes[p.symbol] ? dailyVol(v.closes[p.symbol]!, LIMITS.volLookbackDays) : null) ?? LIMITS.fallbackDailyVol;
        const trail = Math.min(0.25, this.policy.trailAtr * vol);
        if (peak > p.avgEntryPrice && price <= peak * (1 - trail)) sell(`dal massimo ${peak.toFixed(2)} il prezzo è sceso del ${pct(1 - price / peak)} (oltre ${this.policy.trailAtr} ATR = ${pct(trail)}): il trend si è girato, si esce a ${pct(gain)}`);
        continue;
      }
      const targetPct = this.policy.targetBySymbol?.[p.symbol] ?? this.policy.targetPct;
      const peakGain = peak / p.avgEntryPrice - 1;
      if (peakGain < targetPct) continue; // sotto l'obiettivo decide il resto del motore (trend, orizzonte, stop)
      const expectsMore = forecast !== undefined && forecast > 0;
      if (!expectsMore) {
        sell(`guadagno ${pct(gain)} oltre l'obiettivo del ${pct(targetPct)} e nessuna proiezione di ulteriore rialzo: si incassa`);
        continue;
      }
      const floor = Math.max(p.avgEntryPrice * (1 + lockPct), peak * (1 - giveBackPct));
      if (price <= floor) sell(`dal massimo ${peak.toFixed(2)} il prezzo è tornato a ${price.toFixed(2)}: si incassa ${pct(gain)} prima di restituire più del ${pct(giveBackPct)}`);
    }
    const targets = Object.entries(this.policy.targetBySymbol ?? {}).map(([k, t]) => `${k} ${pct(t)}`).join(", ");
    const stopNote = this.policy.stopMode === "fisso" ? `stop ${pct(this.policy.stopPct)}` : `stop sulla volatilità (${pct(LIMITS.stop.minPct)}-${pct(LIMITS.stop.maxPct)})`;
    const exitNote = this.policy.mode === "trend" ? (this.policy.trailAtr > 0 ? `uscita anche a ${this.policy.trailAtr} ATR dal massimo` : "nessun obiettivo: esce il trend della gabbia") : `obiettivo ${pct(this.policy.targetPct)}${targets ? ` (${targets})` : ""}, restituzione massima ${pct(giveBackPct)}`;
    return { segnali, note: segnali.length ? undefined : [`${stopNote}, ${exitNote}`] };
  }
}
