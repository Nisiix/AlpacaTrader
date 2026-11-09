import type { ProposedOrder } from "../ordini.ts";
import { maxWeightFor } from "../cage.ts";
import { pesoControTendenza, pesoRimbalzo, rimbalzo, sotto200 } from "./fiducia.ts";
import { AGENTS, CRYPTO_MIN_NOTIONAL, LIMITS, isCrypto, sectorOf } from "../config.ts";
import { dailyVol } from "../indicators.ts";
import { romeTime } from "../slots.ts";
import { roundQty } from "../broker/types.ts";
import { soloIntraday } from "./posizioni.ts";
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
  parteIntraday?: { compra: number; pesoMassimo?: number; perche: string[] };
}

// La sola parte intraday di un punteggio misto, come punteggio a sé (vendite d'opinione comprese).
export function soloParteIntraday(sc: Score): Score | null {
  const pi = sc.parteIntraday;
  if (!pi || sc.intraday) return null;
  const { parteIntraday: _, kronos: __, evidenza: ___, ...base } = sc;
  return { ...base, punteggio: pi.compra - sc.vende, compra: pi.compra, intraday: true, pesoMassimo: pi.pesoMassimo, agenti: ["intraday"], perche: pi.perche };
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
  for (const s of signals) {
    if (!s.vincolante || s.lato !== "sell" || forced.has(s.simbolo)) continue;
    const p = held.get(s.simbolo);
    if (!p) continue;
    forced.add(s.simbolo);
    const qty = s.frazione && s.frazione < 1 ? roundQty(s.simbolo, p.qty * s.frazione) : p.qty;
    if (qty <= 0) continue;
    proposte.push({ symbol: s.simbolo, side: "sell", qty, why: `${s.agente}: ${s.perche}`, confidence: "alta", expect: s.frazione && s.frazione < 1 ? "presa di profitto parziale" : "regola di rischio" });
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
    // Il rimbalzo di breve ha già le sue condizioni (calo netto, Kronos al rialzo con probabilità sufficiente): basta
    // l'evidenza minima anche sotto la 200.
    const rimb = rimbalzo(sc.simbolo, view.closes[sc.simbolo], price, view.previsioni?.[sc.simbolo] ?? sc.kronos).ok;
    const contro = !rimb && sotto200(view.closes[sc.simbolo], price);
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
    const rimb = !sc.intraday && !p && rimbalzo(sc.simbolo, view.closes[sc.simbolo], price, view.previsioni?.[sc.simbolo] ?? sc.kronos).ok;
    const contro = !sc.intraday && !rimb && sotto200(view.closes[sc.simbolo], price);
    const ev = sc.intraday ? null : dossierOf(sc.simbolo);
    sc.evidenza = ev;
    const minEv = contro ? AGENTS.evidenza.minContro : AGENTS.evidenza.min;
    let w = maxWeightFor(view.closes[sc.simbolo]).max * rischioDi(sc.simbolo, !(kronosSu(sc.simbolo) || sc.intraday)) * (AGENTS.scaleByScore ? Math.min(1, sc.punteggio) : 1);
    if (sc.pesoMassimo !== undefined) w = Math.min(w, sc.pesoMassimo);
    // Taglia proporzionale alla fiducia nella proiezione di Kronos: più è probabile che il rialzo si avveri, più si investe.
    if (AGENTS.sizing.byKronos) {
      const f = kronosConfidence(view, sc.simbolo);
      sc.fiducia = f.p;
      w *= f.factor;
    }
    // E all'evidenza combinata: al minimo richiesto metà taglia, dall'80% in su taglia piena.
    if (ev !== null) w *= Math.max(0.5, Math.min(1, 0.5 + ((ev - minEv) / Math.max(0.05, 0.8 - minEv)) * 0.5));
    // Sotto la media a 200 (contro tendenza) sempre più prudente che sopra: a parità di fiducia ed evidenza la taglia si
    // moltiplica per la quota contro tendenza (metà di serie) e non supera mai quella quota del peso massimo.
    if (contro) w = Math.min(w * AGENTS.kronos.controTendenza.pesoFattore, pesoControTendenza());
    // Rimbalzo di breve: stessa prudenza, taglia ridotta e mai oltre il suo peso massimo.
    if (rimb) w = Math.min(w * AGENTS.rimbalzo.pesoFattore, pesoRimbalzo());
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
  // Tetto per settore (lo stesso della gabbia): si riempie in ordine di punteggio, così i contanti non vanno a un titolo
  // che la gabbia poi rifiuterebbe per settore pieno, lasciando fermi soldi che altri avrebbero usato.
  const usato = new Map<string, number>();
  for (const p of held.values()) usato.set(sectorOf(p.symbol), (usato.get(sectorOf(p.symbol)) ?? 0) + p.qty * (view.prices[p.symbol] ?? p.currentPrice));
  for (const x of asks) {
    const sec = sectorOf(x.sc.simbolo);
    if (sec === "altro") continue;
    const spazio = Math.max(0, (LIMITS.groupMaxBySector[sec] ?? LIMITS.groupMaxPct) * equity * 0.999 - (usato.get(sec) ?? 0));
    x.chiesto = Math.min(x.chiesto, spazio);
    usato.set(sec, (usato.get(sec) ?? 0) + x.chiesto);
  }
  const avail = Math.max(0, view.account.cash - (view.cashImpegnato ?? 0) - equity * AGENTS.riservaContanti);
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
    if (p ? delta / equity < AGENTS.minAddPct : delta < Math.max(AGENTS.minNuova.pct * equity, AGENTS.minNuova.usd)) continue;
    const qty = roundQty(sc.simbolo, delta / price);
    if (qty <= 0 || (isCrypto(sc.simbolo) && qty * price < CRYPTO_MIN_NOTIONAL)) continue;
    proposte.push({ symbol: sc.simbolo, side: "buy", qty, why: sc.perche.join(" · "), confidence: conf(sc.punteggio), expect: `${sc.intraday ? "intraday: " : ""}peso obiettivo ${((target / equity) * 100).toFixed(1)}% del conto${riparto && chiesto > 0 ? ` (riparto del capitale: ${Math.round((dato / chiesto) * 100)}% di quanto chiesto, ${(w * scale * 100).toFixed(1)}%)` : ""}${sc.fiducia !== undefined ? ` (fiducia nella proiezione ${sc.fiducia === null ? "n.d." : `${(sc.fiducia * 100).toFixed(0)}%`})` : ""}${scale < 1 ? ` (ridotto per la volatilità di portafoglio, obiettivo ${(AGENTS.volTarget.annual * 100).toFixed(0)}% annuo)` : ""}`, intraday: sc.intraday || undefined, kronos: sc.kronos });
  }
  return { proposte, punteggi, rischio, pesi: weights, inAttesa };
}
