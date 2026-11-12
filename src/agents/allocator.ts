import type { ProposedOrder } from "../ordini.ts";
import { maxWeightFor } from "../cage.ts";
import { livelloMedie, pesoControTendenza, sotto200 } from "./fiducia.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, LIMITS, isCrypto, sectorOf } from "../config.ts";
import { dailyVol } from "../indicators.ts";
import { romeTime } from "../slots.ts";
import { aFrazioni, frazionabile, intere, roundQty } from "../broker/types.ts";
import { soloIntraday } from "./posizioni.ts";
import { guadagniAperti, quotaBudget } from "./budget.ts";
import type { AgentReport, AgentView, Signal } from "./types.ts";

export interface Score {
  simbolo: string;
  punteggio: number;
  compra: number;
  vende: number;
  agenti: string[];
  perche: string[];
  // Se tutti i voti di acquisto vengono da comparti a taglia ridotta, il peso massimo che chiedono.
  pesoMassimo?: number;
  // Se tutti i voti di acquisto sono intraday, l'operazione lo è (si chiude in giornata).
  intraday?: boolean;
  // La proiezione di Kronos più netta tra i voti d'acquisto.
  kronos?: number;
  // Probabilità che la proiezione si avveri (decide la taglia).
  fiducia?: number | null;
  // Evidenza combinata del dossier (Kronos, grafico, notizie e post, contesto con Fear & Greed e funding).
  evidenza?: number | null;
  // Con voti misti (più giorni e intraday) la sola parte intraday: se l'ingresso di più giorni deve aspettare (contesto,
  // costi, evidenza), l'occasione sulle candele brevi segnalata da Kronos può comunque entrare come trade intraday.
  parteIntraday?: { compra: number; pesoMassimo?: number; perche: string[]; probIngresso?: number };
  // Probabilità d'ingresso dell'intraday (la più alta tra i voti): decide l'accesso alla riserva per le occasioni.
  probIngresso?: number;
}

// La sola parte intraday di un punteggio misto, come punteggio a sé (vendite d'opinione comprese).
export function soloParteIntraday(sc: Score): Score | null {
  const pi = sc.parteIntraday;
  if (!pi || sc.intraday) return null;
  const { parteIntraday: _, kronos: __, evidenza: ___, ...base } = sc;
  return { ...base, punteggio: pi.compra - sc.vende, compra: pi.compra, intraday: true, pesoMassimo: pi.pesoMassimo, agenti: ["intraday"], perche: pi.perche, ...(pi.probIngresso !== undefined ? { probIngresso: pi.probIngresso } : {}) };
}

export interface Allocation {
  proposte: ProposedOrder[];
  punteggi: Score[];
  rischio: number;
  pesi: Record<string, number>;
  // Titoli che avrebbero un punteggio da acquisto ma il contesto dice di aspettare la candela successiva.
  inAttesa: { simbolo: string; motivo: string }[];
}

// I titoli con un trade aperto oggi (ora di Roma) nel diario.
export function openedToday(view: AgentView): Set<string> {
  const out = new Set<string>();
  for (const t of view.journal.trade) if (t.stato === "aperto" && romeTime(new Date(t.apertoIl)).date === view.today) out.add(t.simbolo);
  return out;
}

export function scoreSignals(signals: Signal[], weights: Record<string, number>): Score[] {
  const by = new Map<string, Score>();
  for (const s of signals) {
    if (s.vincolante) continue;
    const sc = by.get(s.simbolo) ?? { simbolo: s.simbolo, punteggio: 0, compra: 0, vende: 0, agenti: [], perche: [] };
    const w = (weights[s.agente] ?? 1) * s.forza;
    if (s.lato === "buy") {
      sc.compra += w;
      sc.intraday = sc.compra === w ? !!s.intraday : sc.intraday && !!s.intraday;
      if (s.kronos !== undefined && (sc.kronos === undefined || s.kronos > sc.kronos)) sc.kronos = s.kronos;
      if (s.intraday) {
        const pi = sc.parteIntraday ?? { compra: 0, perche: [] };
        pi.compra += w;
        if (s.pesoMassimo !== undefined) pi.pesoMassimo = Math.min(pi.pesoMassimo ?? Infinity, s.pesoMassimo);
        const pr = s.misure?.ingresso ?? s.misure?.probabilita;
        if (pr !== undefined) { pi.probIngresso = Math.max(pi.probIngresso ?? 0, pr); sc.probIngresso = Math.max(sc.probIngresso ?? 0, pr); }
        pi.perche.push(`${s.agente}: ${s.perche}`);
        sc.parteIntraday = pi;
      }
      // Un voto senza limite di taglia (es. il trend) toglie il limite; se tutti i voti lo hanno, vale il più piccolo.
      if (s.pesoMassimo === undefined) sc.pesoMassimo = Infinity;
      else if (sc.pesoMassimo !== Infinity) sc.pesoMassimo = Math.min(sc.pesoMassimo ?? Infinity, s.pesoMassimo);
    } else sc.vende += w;
    sc.punteggio = sc.compra - sc.vende;
    if (!sc.agenti.includes(s.agente)) sc.agenti.push(s.agente);
    sc.perche.push(`${s.agente}: ${s.perche}`);
    by.set(s.simbolo, sc);
  }
  for (const sc of by.values()) if (sc.pesoMassimo === Infinity) delete sc.pesoMassimo;
  return [...by.values()].sort((a, b) => b.punteggio - a.punteggio);
}

// Fiducia nella proiezione di Kronos: P(rendimento > 0) = Φ(atteso / (volatilità × √orizzonte)). Da lì il fattore di taglia.
export function kronosConfidence(view: AgentView, symbol: string): { p: number | null; factor: number } {
  const fc = view.previsioni?.[symbol];
  const vol = view.closes[symbol] ? dailyVol(view.closes[symbol]!, LIMITS.volLookbackDays) : null;
  const c = AGENTS.sizing;
  if (fc === undefined || vol === null || vol <= 0) return { p: null, factor: c.noForecast };
  const z = fc / (vol * Math.sqrt(AGENTS.kronos.horizon));
  const p = 0.5 * (1 + erf(z / Math.SQRT2));
  const t = Math.max(0, Math.min(1, (p - 0.5) / (c.fullAt - 0.5)));
  return { p, factor: c.minFactor + (1 - c.minFactor) * t };
}
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// Volatilità annua attesa del portafoglio: √252 × corr × Σ peso × volatilità giornaliera (corr < 1 sconta la diversificazione).
export function portfolioVol(weights: Record<string, number>, closes: Record<string, number[]>): number {
  let sum = 0;
  for (const [s, w] of Object.entries(weights)) sum += w * ((closes[s] ? dailyVol(closes[s]!, LIMITS.volLookbackDays) : null) ?? LIMITS.fallbackDailyVol);
  return Math.sqrt(252) * AGENTS.volTarget.corr * sum;
}

// Dai punteggi agli ordini proposti. La gabbia (applyCage) resta a valle: qui si decide solo quanto si vorrebbe.
export function allocate(view: AgentView, reports: Record<string, AgentReport>, weights: Record<string, number>): Allocation {
  const signals = Object.values(reports).flatMap((r) => r.segnali);
  // Rischio ammesso: regime (per classe: SPY per le azioni, BTC per le crypto) e contesto guardano entrambi la salute del
  // mercato, quindi non si moltiplicano: vale la riduzione più forte. Gli altri agenti di rischio, se ci sono, moltiplicano.
  // Kronos è la fonte principale, il contesto fa da contorno: quando Kronos anticipa un rialzo sul titolo (o il voto è
  // intraday), la riduzione del contesto non si applica; il regime resta.
  const altri = Object.entries(reports).reduce((a, [n, r]) => (n === "contesto" || n === "regime" ? a : a * (r.rischio ?? 1)), 1);
  const rischioDi = (simbolo: string, conContesto: boolean) => {
    const g = reports.regime;
    const reg = isCrypto(simbolo) ? (g?.rischioCrypto ?? g?.rischio ?? 1) : (g?.rischio ?? 1);
    return Math.min(reg, conContesto ? (reports.contesto?.rischio ?? 1) : 1) * altri;
  };
  const rischio = rischioDi("SPY", true);
  const dossierOf = (s: string) => Object.values(reports).flatMap((r) => r.custodi ?? []).find((c) => c.simbolo === s)?.dossier?.probabilita ?? null;
  const kronosSu = (s: string) => (view.previsioni?.[s] ?? -1) >= AGENTS.kronos.anticipaSoglia;
  const punteggi = scoreSignals(signals, weights);
  const proposte: ProposedOrder[] = [];
  const inAttesa: { simbolo: string; motivo: string }[] = [];
  const held = new Map(view.positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const equity = view.account.equity;
  const conf = (x: number) => (x >= 1 ? "alta" : x >= 0.7 ? "media" : "bassa");

  // Prima le regole vincolanti (stop, obiettivo, proiezione contraria): vendono tutto, senza voto.
  const forced = new Set<string>();
  // Vendite di sostituzione (intera posizione): il loro ricavato e il loro posto nel budget e nel settore vanno subito
  // agli acquisti di questo giro.
  const liberate = new Map<string, number>();
  for (const s of signals) {
    if (!s.vincolante || s.lato !== "sell" || forced.has(s.simbolo)) continue;
    const p = held.get(s.simbolo);
    if (!p) continue;
    forced.add(s.simbolo);
    // Vendita parziale (es. metà): da una posizione a frazioni si vende a frazioni; da una a azioni intere si vendono
    // intere, salvo che non ne venga nemmeno una (metà di un'azione) e il titolo sia frazionabile.
    const parziale = s.frazione && s.frazione < 1;
    const giaFrazioni = !isCrypto(s.simbolo) && Math.abs(p.qty - Math.round(p.qty)) > 1e-9;
    const qty = parziale ? roundQty(s.simbolo, p.qty * s.frazione!, isCrypto(s.simbolo) ? undefined : giaFrazioni || (intere(p.qty * s.frazione!) === 0 && aFrazioni(s.simbolo))) : p.qty;
    if (qty <= 0) continue;
    const libera = !!s.libera && !parziale;
    if (libera) liberate.set(s.simbolo, qty * (view.prices[s.simbolo] ?? p.currentPrice) * (1 - (isCrypto(s.simbolo) ? AGENTS.costi.cryptoAndataRitorno / 2 : 0) - AGENTS.intraday.budget.scivolamento));
    proposte.push({ symbol: s.simbolo, side: "sell", qty, why: `${s.agente}: ${s.perche}`, confidence: "alta", expect: libera ? "sostituzione: il ricavato va all'occasione nuova" : s.frazione && s.frazione < 1 ? "presa di profitto parziale" : "regola di rischio", ...(libera ? { libera: true } : {}) });
  }
  // Comprati oggi: i voti di vendita "di opinione" (trend, custodi, punteggio) aspettano una candela giornaliera nuova;
  // le uscite vincolanti (stop, obiettivo, intraday, proiezione contraria) restano sopra e valgono sempre.
  const apertiOggi = openedToday(view);
  for (const sc of punteggi) {
    const p = held.get(sc.simbolo);
    if (forced.has(sc.simbolo)) continue;
    if (sc.punteggio <= AGENTS.sellScore && p && (apertiOggi.has(sc.simbolo) || soloIntraday(view.journal, sc.simbolo))) continue;
    if (sc.punteggio <= AGENTS.sellScore && p) {
      proposte.push({ symbol: sc.simbolo, side: "sell", qty: p.qty, why: sc.perche.join(" · "), confidence: conf(-sc.punteggio), expect: `uscita: punteggio ${sc.punteggio.toFixed(2)}` });
    }
  }
  // Prima i pesi obiettivo di chi si vuole comprare, poi un solo fattore di scala se la volatilità di portafoglio supera l'obiettivo.
  let slots = LIMITS.maxPositions - held.size;
  const wanted: { sc: Score; w: number; p?: { qty: number } }[] = [];
  // Perché un ingresso nuovo di più giorni deve aspettare (null se può entrare): contesto, proiezione, costi, evidenza.
  const attesaPiuGiorni = (sc: Score, price: number | undefined): string | null => {
    const wait = view.contesto?.attendi[sc.simbolo];
    if (wait) return wait;
    if (!price || price <= 0) return null;
    // Il rendimento previsto deve coprire i costi: crypto 0,5% andata e ritorno (×2 di margine), azioni quasi nulli.
    // Il controllo dei costi riduce il rischio: usa la proiezione anche se il contesto non la ritiene affidabile per entrare.
    const grezze = view.previsioniKronos ?? view.previsioni;
    const fcCosti = grezze?.[sc.simbolo] ?? sc.kronos;
    const costo = isCrypto(sc.simbolo) ? AGENTS.costi.cryptoAndataRitorno : AGENTS.costi.azioniAndataRitorno;
    // Con Kronos attivo ma senza una proiezione utilizzabile per il titolo non si può dire che il rialzo copra i costi: si aspetta.
    if (grezze !== undefined && fcCosti === undefined) return "nessuna proiezione di Kronos utilizzabile: non si può verificare che il rialzo copra i costi";
    if (fcCosti !== undefined && fcCosti < costo * AGENTS.costi.margineCosti)
      return `Kronos prevede ${(fcCosti * 100).toFixed(2)}%: non copre ${AGENTS.costi.margineCosti} volte i costi di andata e ritorno (${(costo * 100).toFixed(2)}%)`;
    // Evidenza combinata: il dossier del custode mette insieme Kronos (45%), grafico (25%), notizie e post (15%) e contesto
    // con Fear & Greed e funding (15%); sopra la media a 200 basta evidenza.min, sotto serve evidenza.minContro.
    const contro = sotto200(view.closes[sc.simbolo], price);
    const ev = dossierOf(sc.simbolo);
    const minEv = contro ? AGENTS.evidenza.minContro : AGENTS.evidenza.min;
    if (ev !== null && ev < minEv) return `evidenza combinata ${(Math.floor(ev * 1000) / 10).toFixed(1).replace(".", ",")}% sotto il minimo ${Math.round(minEv * 100)}%${contro ? " richiesto sotto la media a 200" : ""} (Kronos, grafico, notizie, contesto)`;
    return null;
  };
  for (let sc of punteggi) {
    // Gli acquisti si decidono solo nei giri con analisi d'ingresso (ogni AGENTS.analisiMinuti); negli altri si controlla.
    if (view.analisi === false) break;
    if (sc.punteggio < AGENTS.buyScore) break;
    if (forced.has(sc.simbolo)) continue;
    // Titoli azionari a borsa chiusa (o fuori finestra, salvo intraday): non si propongono e non occupano un posto,
    // così i posti liberi vanno alle crypto, che trattano sempre.
    if (!isCrypto(sc.simbolo) && (view.mercatoAperto === false || (view.finestraIngressi === false && !sc.intraday))) continue;
    // L'attesa del contesto (settore debole, Kronos a 5 sedute al ribasso) riguarda gli ingressi di più giorni: un voto
    // solo intraday segue Kronos sulle candele brevi, le sue medie brevi e i suoi stop, e non aspetta il contesto.
    const price = view.prices[sc.simbolo];
    const p = held.get(sc.simbolo);
    // Le attese che valgono solo per un ingresso di più giorni. Se scattano su un punteggio misto e la parte intraday da
    // sola supera la soglia, si entra come trade intraday (taglia e uscite dell'intraday) invece di lasciar perdere l'occasione.
    // Il motore punta all'intraday: un ingresso (o un'aggiunta) di più giorni non si fa; se sul titolo c'è anche un voto
    // intraday che da solo basta, entra quello (candele da 5 minuti a 4 ore).
    if (AGENTS.puntaIntraday && !sc.intraday) {
      const alt = soloParteIntraday(sc);
      if (alt && alt.punteggio >= AGENTS.buyScore) {
        alt.perche = [...alt.perche, "ufficio: il motore punta all'intraday, entra solo la parte intraday (candele)"];
        punteggi[punteggi.indexOf(sc)] = alt;
        sc = alt;
      } else {
        inAttesa.push({ simbolo: sc.simbolo, motivo: "il motore punta all'intraday: si entra solo quando lo decidono le candele (5 minuti - 4 ore) e Kronos su quelle candele" });
        continue;
      }
    }
    // Sotto la media a 50 (downtrend) si preferisce il timeframe breve: se sul titolo c'è anche un voto intraday che da
    // solo basta, si entra come trade intraday (candele da 5 minuti a 4 ore) invece che di più giorni.
    if (!p && !sc.intraday) {
      const liv = livelloMedie(view.closes[sc.simbolo], price);
      const alt = liv && liv.livello !== "sopra" && liv.livello !== "sotto200" ? soloParteIntraday(sc) : null;
      if (alt && alt.punteggio >= AGENTS.buyScore) {
        alt.perche = [...alt.perche, `ufficio: ${liv!.etichetta}: si preferisce il timeframe breve, entra solo la parte intraday`];
        punteggi[punteggi.indexOf(sc)] = alt;
        sc = alt;
      }
    }
    const attesa = p || sc.intraday ? null : attesaPiuGiorni(sc, price);
    if (attesa) {
      const alt = soloParteIntraday(sc);
      if (alt && alt.punteggio >= AGENTS.buyScore) {
        alt.perche = [...alt.perche, `ufficio: ingresso di più giorni in attesa (${attesa}); entra solo la parte intraday`];
        punteggi[punteggi.indexOf(sc)] = alt;
        sc = alt;
      } else {
        inAttesa.push({ simbolo: sc.simbolo, motivo: attesa });
        continue;
      }
    }
    if (!price || price <= 0) continue;
    if (!p && slots <= 0) continue;
    // Livermore: non si media mai al ribasso. Un'aggiunta a una posizione in perdita non si fa.
    if (p && p.currentPrice > 0 && p.currentPrice < p.avgEntryPrice) {
      inAttesa.push({ simbolo: sc.simbolo, motivo: `posizione in perdita (${(((p.currentPrice / p.avgEntryPrice) - 1) * 100).toFixed(2)}%): non si aggiunge, non si media al ribasso (Livermore)` });
      continue;
    }
    // Evidenza combinata: il dossier del custode mette insieme Kronos (45%), grafico (25%), notizie e post (15%) e contesto
    // con Fear & Greed e funding (15%). Per un ingresso nuovo di più giorni deve arrivare almeno a evidenza.min (sopra la
    // media a 200) o evidenza.minContro (sotto la 200): chiunque abbia votato, le altre fonti possono fermare l'ingresso.
    const contro = !sc.intraday && sotto200(view.closes[sc.simbolo], price);
    const ev = sc.intraday ? null : dossierOf(sc.simbolo);
    sc.evidenza = ev;
    const minEv = contro ? AGENTS.evidenza.minContro : AGENTS.evidenza.min;
    let w = maxWeightFor(view.closes[sc.simbolo]).max * rischioDi(sc.simbolo, !(kronosSu(sc.simbolo) || sc.intraday)) * (AGENTS.scaleByScore ? Math.min(1, sc.punteggio) : 1);
    // Intraday: la taglia viene dal rischio allo stop (agente intraday), poi il rischio del mercato; il tetto della
    // volatilità giornaliera (maxWeightFor) vale per i trade di più giorni, non per un trade con lo stop a −0,4%.
    // Mai oltre il tetto per titolo della gabbia (lo stesso numero): sopra, la gabbia scartava l'ordine intero invece di
    // ridurlo (una persona con il peso personale alto chiedeva fino al 37,5%).
    if (sc.intraday && sc.pesoMassimo !== undefined) w = Math.min(Math.max(LIMITS.maxPositionPct, AGENTS.intraday.maxWeight), sc.pesoMassimo * rischioDi(sc.simbolo, false));
    else if (sc.pesoMassimo !== undefined) w = Math.min(w, sc.pesoMassimo);
    // Taglia proporzionale alla fiducia nella proiezione di Kronos: più è probabile che il rialzo si avveri, più si investe.
    // Solo per i trade di più giorni: un trade intraday ha già la sua taglia dalla probabilità sulle candele (Kronos a 5
    // sedute non c'entra: prima lo riduceva fino a ×0,4).
    if (AGENTS.sizing.byKronos && !sc.intraday) {
      const f = kronosConfidence(view, sc.simbolo);
      sc.fiducia = f.p;
      w *= f.factor;
    }
    // E all'evidenza combinata: al minimo richiesto metà taglia, dall'80% in su taglia piena.
    if (ev !== null) w *= Math.max(0.5, Math.min(1, 0.5 + ((ev - minEv) / Math.max(0.05, 0.8 - minEv)) * 0.5));
    // Sotto la media a 200 (contro tendenza) sempre più prudente che sopra: a parità di fiducia ed evidenza la taglia si
    // moltiplica per la quota contro tendenza (metà di serie) e non supera mai quella quota del peso massimo.
    // Scaletta della prudenza secondo le medie (più giorni): sopra entrambe piena, sotto la 50 ×0,75, sotto la 200 ×0,5,
    // sotto entrambe ×0,4; sotto la 200 mai oltre il peso massimo contro tendenza.
    const liv = sc.intraday ? null : livelloMedie(view.closes[sc.simbolo], price);
    if (liv) w *= AGENTS.prudenzaMedie.piuGiorni[liv.livello];
    if (contro) w = Math.min(w, pesoControTendenza());
    if (!p) slots--;
    wanted.push({ sc, w, p });
  }
  let scale = 1;
  if (AGENTS.volTarget.enabled && equity > 0) {
    const heldW: Record<string, number> = {};
    for (const p of held.values()) if (!wanted.some((x) => x.sc.simbolo === p.symbol)) heldW[p.symbol] = (p.qty * (view.prices[p.symbol] ?? p.currentPrice)) / equity;
    const newW: Record<string, number> = Object.fromEntries(wanted.map((x) => [x.sc.simbolo, x.w]));
    const volHeld = portfolioVol(heldW, view.closes);
    const volNew = portfolioVol(newW, view.closes);
    const room = Math.max(0, AGENTS.volTarget.annual - volHeld);
    if (volNew > room) scale = volNew > 0 ? room / volNew : 0;
  }
  // Riparto del capitale: nessun numero fisso di titoli o di agenti. Se i contanti non bastano per tutto quello che gli
  // agenti chiedono, si dividono in proporzione alla qualità di ogni occasione (fiducia in Kronos × evidenza del dossier ×
  // punteggio dei voti), senza dare a nessuno più di quanto ha chiesto; quello che avanza va agli altri.
  const asks = wanted.map((x) => {
    const price = view.prices[x.sc.simbolo]!;
    const have = x.p ? x.p.qty * price : 0;
    const q = Math.max(0.05, (x.sc.fiducia ?? 0.6) * (x.sc.evidenza ?? 0.6) * Math.min(2, Math.max(0.1, x.sc.punteggio)));
    return { ...x, price, have, chiesto: Math.max(0, x.w * scale * equity - have), q, dato: 0 };
  });
  // Budget dell'intraday: investito in operazioni intraday nello stesso momento al massimo budget.quota del conto, le
  // crypto al massimo budget.maxCrypto. Se le occasioni chiedono di più si divide in proporzione alla qualità. Prima del
  // tetto per settore: se no il settore si riempiva in ordine di punteggio e al terzo titolo dello stesso settore non
  // restava niente, anche quando poi il budget riduceva i primi due.
  const bud = AGENTS.intraday.budget;
  const intradayAperta = (s: string) => view.journal.trade.some((t) => t.simbolo === s && t.stato === "aperto" && t.contesto?.agenti?.includes("intraday") && !t.contesto?.promossa);
  const valoreAperto = (pred: (s: string) => boolean) => [...held.values()].filter((p) => intradayAperta(p.symbol) && !liberate.has(p.symbol) && pred(p.symbol)).reduce((a, p) => a + p.qty * (view.prices[p.symbol] ?? p.currentPrice), 0);
  const tagliati = new Map<string, string>();
  const ripartisci = (gruppo: typeof asks, spazio: number, perche: string) => {
    const tot = gruppo.reduce((a, x) => a + x.chiesto, 0);
    if (tot <= spazio || tot <= 0) return;
    const dati = new Map(gruppo.map((x) => [x, 0]));
    let left = Math.max(0, spazio);
    let aperti = gruppo.filter((x) => x.chiesto > 0);
    for (let round = 0; round < 6 && left > 1 && aperti.length; round++) {
      const qs = aperti.reduce((a, x) => a + x.q * x.chiesto, 0);
      for (const x of aperti) dati.set(x, dati.get(x)! + Math.min(x.chiesto - dati.get(x)!, (left * x.q * x.chiesto) / qs));
      left = Math.max(0, spazio) - [...dati.values()].reduce((a, v) => a + v, 0);
      aperti = aperti.filter((x) => x.chiesto - dati.get(x)! > 1);
    }
    for (const x of gruppo) { if (dati.get(x)! < x.chiesto - 0.01) tagliati.set(x.sc.simbolo, perche); x.chiesto = dati.get(x)!; }
  };
  const nuoviIntraday = asks.filter((x) => x.sc.intraday && !x.p);
  // Gli acquisti ancora in corso (ordini limite crypto non eseguiti) contano come già investiti: se no il giro dopo,
  // con l'ordine ancora aperto, si sforava il budget.
  const inCorso = view.cashImpegnato ?? 0;
  const cryptoAperto = valoreAperto(isCrypto) + inCorso, intradayAperto = valoreAperto(() => true) + inCorso;
  ripartisci(nuoviIntraday.filter((x) => isCrypto(x.sc.simbolo)), bud.maxCrypto * equity - cryptoAperto, `crypto intraday già al ${((cryptoAperto / Math.max(1, equity)) * 100).toFixed(0)}% del conto (massimo ${Math.round(bud.maxCrypto * 100)}%: si muovono insieme)`);
  // Con il profitto reinvestito il budget cresce oltre la quota di serie (vedi budget.ts).
  const qb = quotaBudget(equity, view.capitaleBase, bud.quota, guadagniAperti(view.positions, view.prices));
  const voluto = new Map(nuoviIntraday.map((x) => [x, x.chiesto]));
  ripartisci(nuoviIntraday, qb.quota * equity - intradayAperto, `budget intraday: ${((intradayAperto / Math.max(1, equity)) * 100).toFixed(0)}% del conto già investito in operazioni intraday (massimo ${Math.round(qb.quota * 100)}%${qb.reinvestito > 0.5 ? `, con ${qb.reinvestito.toFixed(2)} $ di profitto reinvestito` : ""}), il resto diviso tra le occasioni per qualità`);
  // Riserva per le occasioni: a budget pieno, un'occasione nettamente migliore (probabilità d'ingresso ≥ soglia +
  // extraProb) prende dalla riserva (il resto del conto) fino a maxTrade, le più probabili per prime.
  const ro = bud.riservaOccasioni;
  if (ro.enabled) {
    let riserva = ro.quota * equity - Math.max(0, intradayAperto - qb.quota * equity);
    const prob = (x: (typeof asks)[number]) => x.sc.probIngresso ?? 0;
    const forti = nuoviIntraday.filter((x) => tagliati.has(x.sc.simbolo) && prob(x) >= AGENTS.intraday.kronos.minProb + ro.extraProb).sort((a, b) => prob(b) - prob(a));
    for (const x of forti) {
      if (riserva <= 1) break;
      const extra = Math.min(voluto.get(x)! - x.chiesto, ro.maxTrade * equity, riserva);
      if (extra <= 0) continue;
      x.chiesto += extra;
      riserva -= extra;
      if (x.chiesto >= voluto.get(x)! - 0.01) tagliati.delete(x.sc.simbolo);
      else tagliati.set(x.sc.simbolo, `budget intraday pieno: dalla riserva per le occasioni (probabilità ${Math.round(prob(x) * 100)}%) al massimo ${Math.round(ro.maxTrade * 100)}% del conto in più`);
    }
  }
  // Tetto per settore (lo stesso della gabbia): se le occasioni di un settore chiedono più dello spazio rimasto, si divide
  // in proporzione alla qualità (come il budget), così i contanti non vanno a un titolo che la gabbia poi rifiuterebbe.
  // Prima si riempiva in ordine di punteggio: con il budget al 50% il terzo titolo dello stesso settore restava a zero.
  const usato = new Map<string, number>();
  for (const p of held.values()) if (!liberate.has(p.symbol)) usato.set(sectorOf(p.symbol), (usato.get(sectorOf(p.symbol)) ?? 0) + p.qty * (view.prices[p.symbol] ?? p.currentPrice));
  for (const sec of new Set(asks.map((x) => sectorOf(x.sc.simbolo)))) {
    if (sec === "altro") continue;
    const tetto = LIMITS.groupMaxBySector[sec] ?? LIMITS.groupMaxPct;
    ripartisci(asks.filter((x) => sectorOf(x.sc.simbolo) === sec), tetto * equity * 0.999 - (usato.get(sec) ?? 0), `settore ${sec} al tetto del ${Math.round(tetto * 100)}% del conto: lo spazio rimasto diviso per qualità`);
  }
  const avail = Math.max(0, view.account.cash + [...liberate.values()].reduce((a, x) => a + x, 0) - (view.cashImpegnato ?? 0) - equity * AGENTS.riservaContanti);
  const totale = asks.reduce((a, x) => a + x.chiesto, 0);
  let riparto = false;
  if (totale > avail && totale > 0) {
    riparto = true;
    let left = avail;
    let open = asks.filter((x) => x.chiesto > 0);
    for (let round = 0; round < 6 && left > 1 && open.length; round++) {
      const qs = open.reduce((a, x) => a + x.q * x.chiesto, 0);
      for (const x of open) x.dato += Math.min(x.chiesto - x.dato, (left * x.q * x.chiesto) / qs);
      left = avail - asks.reduce((a, x) => a + x.dato, 0);
      open = open.filter((x) => x.chiesto - x.dato > 1);
    }
  } else for (const x of asks) x.dato = x.chiesto;
  for (const { sc, w, p, price, have, chiesto, dato } of asks) {
    const target = have + dato;
    const delta = target - have;
    // Aggiunte a una posizione già aperta solo se valgono la pena (minAddPct); una posizione nuova anche piccola, se il
    // riparto del capitale l'ha resa tale, purché sopra lo 0,2% del conto.
    const minimo = Math.max(AGENTS.minNuova.pct * equity, Math.min(AGENTS.minNuova.usd, AGENTS.minNuova.quotaConto * equity));
    if (p ? delta / equity < AGENTS.minAddPct : delta < minimo) {
      // Un ingresso nuovo troppo piccolo non sparisce in silenzio: resta in attesa con il perché.
      if (!p && sc.compra > 0 && tagliati.has(sc.simbolo)) inAttesa.push({ simbolo: sc.simbolo, motivo: tagliati.get(sc.simbolo)! });
      else if (!p && sc.compra > 0) inAttesa.push({ simbolo: sc.simbolo, motivo: `taglia troppo piccola: ${delta.toFixed(2)} $ (${((delta / Math.max(1, equity)) * 100).toFixed(2)}% del conto) sotto il minimo di ${minimo.toFixed(2)} $ per una posizione nuova` });
      continue;
    }
    const qty = roundQty(sc.simbolo, delta / price);
    if (qty <= 0 || (isCrypto(sc.simbolo) && qty * price < CRYPTO_MIN_NOTIONAL)) {
      if (!p) inAttesa.push({ simbolo: sc.simbolo, motivo: !isCrypto(sc.simbolo) && delta < price && !aFrazioni(sc.simbolo) ? `${delta.toFixed(2)} $ non bastano per un'azione intera (${price.toFixed(2)} $) e ${frazionabile(sc.simbolo) === false ? "il titolo non è frazionabile su Alpaca" : AGENTS.frazioni.enabled ? "Alpaca non ha ancora detto se il titolo è frazionabile" : "le frazioni di azione sono spente"}` : `taglia troppo piccola per un ordine (${(qty * price).toFixed(2)} $)` });
      continue;
    }
    proposte.push({ symbol: sc.simbolo, side: "buy", qty, why: sc.perche.join(" · "), confidence: conf(sc.punteggio), expect: `${sc.intraday ? "intraday: " : ""}peso obiettivo ${((target / equity) * 100).toFixed(1)}% del conto${riparto && chiesto > 0 ? ` (riparto del capitale: ${Math.round((dato / chiesto) * 100)}% di quanto chiesto, ${(w * scale * 100).toFixed(1)}%)` : ""}${sc.fiducia !== undefined ? ` (fiducia nella proiezione ${sc.fiducia === null ? "n.d." : `${(sc.fiducia * 100).toFixed(0)}%`})` : ""}${scale < 1 ? ` (ridotto per la volatilità di portafoglio, obiettivo ${(AGENTS.volTarget.annual * 100).toFixed(0)}% annuo)` : ""}`, intraday: sc.intraday || undefined, kronos: sc.kronos });
  }
  return { proposte, punteggi, rischio, pesi: weights, inAttesa };
}
