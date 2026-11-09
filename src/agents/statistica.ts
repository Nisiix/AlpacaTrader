import type { JournalFile, Trade } from "../journal.ts";

// Imparare dal diario, in modo verificato. Due strumenti, attivi solo quando i dati bastano e solo se, provati sui trade
// più recenti (che non hanno usato per imparare), fanno meglio di non usarli:
// 1. Calibrazione delle probabilità: la probabilità di riuscita che il motore stima (dossier per i trade di più giorni,
//    Kronos sulle candele per l'intraday) si confronta con quante volte i trade sono davvero finiti in guadagno, e si
//    corregge con una regressione isotonica (più probabilità stimata non può voler dire meno riuscita).
// 2. Meta-modello (meta-labeling, López de Prado): il motore decide se e dove entrare; un secondo modello, una regressione
//    logistica sulle misure del momento dell'ingresso, stima la probabilità che quel trade finisca in guadagno. Sotto
//    META.minimo il trade non si fa; sopra, la taglia cresce con la probabilità.
// La misura di bontà è il Brier score (errore quadratico medio tra probabilità e esito): più basso è meglio.

export const CAL = { minimo: 50, test: 0.3 };
export const META = { minimo: 100, test: 0.3, soglia: 0.45, margine: 0.002 };
type Tipo = "trading" | "intraday";
const pnl = (t: Trade) => t.incassato - t.costo;
const tipoDi = (t: Trade): Tipo => t.contesto?.tipo ?? (t.contesto?.livelli ? "intraday" : "trading");
const chiusiConEsito = (j: JournalFile) => j.trade.filter((t) => t.stato === "chiuso" && t.chiusoIl).sort((a, b) => a.chiusoIl!.localeCompare(b.chiusoIl!));
const brier = (xs: { p: number; y: number }[]) => (xs.length ? xs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / xs.length : 1);

// ---------- 1. Calibrazione delle probabilità (regressione isotonica, algoritmo PAV) ----------
interface Mappa { x: number[]; y: number[] }
function isotonica(punti: { p: number; y: number }[]): Mappa {
  const s = [...punti].sort((a, b) => a.p - b.p);
  const blocchi: { somma: number; n: number; pMedia: number }[] = [];
  for (const q of s) {
    blocchi.push({ somma: q.y, n: 1, pMedia: q.p });
    while (blocchi.length > 1 && blocchi.at(-2)!.somma / blocchi.at(-2)!.n > blocchi.at(-1)!.somma / blocchi.at(-1)!.n) {
      const b = blocchi.pop()!, a = blocchi.pop()!;
      blocchi.push({ somma: a.somma + b.somma, n: a.n + b.n, pMedia: (a.pMedia * a.n + b.pMedia * b.n) / (a.n + b.n) });
    }
  }
  return { x: blocchi.map((b) => b.pMedia), y: blocchi.map((b) => b.somma / b.n) };
}
function applica(m: Mappa, p: number): number {
  if (!m.x.length) return p;
  if (p <= m.x[0]!) return m.y[0]!;
  if (p >= m.x.at(-1)!) return m.y.at(-1)!;
  let i = 1;
  while (m.x[i]! < p) i++;
  const t = (p - m.x[i - 1]!) / Math.max(1e-9, m.x[i]! - m.x[i - 1]!);
  return m.y[i - 1]! + t * (m.y[i]! - m.y[i - 1]!);
}
export interface StatoCalibrazione { n: number; attiva: boolean; brierGrezzo: number | null; brierCalibrato: number | null }
let mappe: Partial<Record<Tipo, Mappa>> = {};
export function aggiornaProbabilita(j: JournalFile): Record<Tipo, StatoCalibrazione> {
  const out = {} as Record<Tipo, StatoCalibrazione>;
  mappe = {};
  for (const tipo of ["trading", "intraday"] as Tipo[]) {
    const punti = chiusiConEsito(j).filter((t) => tipoDi(t) === tipo && t.contesto?.misure?.probabilita !== undefined).map((t) => ({ p: t.contesto!.misure!.probabilita!, y: pnl(t) > 0 ? 1 : 0 }));
    if (punti.length < CAL.minimo) { out[tipo] = { n: punti.length, attiva: false, brierGrezzo: null, brierCalibrato: null }; continue; }
    const taglio = Math.floor(punti.length * (1 - CAL.test));
    const m = isotonica(punti.slice(0, taglio));
    const prova = punti.slice(taglio);
    const bg = brier(prova), bc = brier(prova.map((x) => ({ p: applica(m, x.p), y: x.y })));
    const attiva = bc < bg;
    if (attiva) mappe[tipo] = isotonica(punti);
    out[tipo] = { n: punti.length, attiva, brierGrezzo: bg, brierCalibrato: bc };
  }
  return out;
}
// La probabilità corretta (uguale alla grezza finché la calibrazione non è attiva).
export const calibraP = (tipo: Tipo, p: number) => (mappe[tipo] ? applica(mappe[tipo]!, p) : p);

// ---------- 2. Meta-modello (regressione logistica) ----------
export interface Caratteristiche { probabilita: number; kronos: number; distanzaMedia: number; vol: number; momentum: number; crypto: number; intraday: number }
const NOMI: (keyof Caratteristiche)[] = ["probabilita", "kronos", "distanzaMedia", "vol", "momentum", "crypto", "intraday"];
export const caratteristicheDi = (t: Trade): Caratteristiche | null => {
  const c = t.contesto;
  if (!c || c.misure?.probabilita === undefined) return null;
  return { probabilita: c.misure.probabilita, kronos: c.kronos ?? 0, distanzaMedia: c.distanzaMedia ?? 0, vol: c.volGiornaliera ?? 0, momentum: c.momentum20 ?? 0, crypto: t.simbolo.includes("/") ? 1 : 0, intraday: tipoDi(t) === "intraday" ? 1 : 0 };
};
interface Modello { media: number[]; dev: number[]; pesi: number[] }
const sigmoide = (z: number) => 1 / (1 + Math.exp(-z));
function addestra(xs: number[][], ys: number[]): Modello {
  const k = xs[0]!.length;
  const media = Array.from({ length: k }, (_, i) => xs.reduce((a, x) => a + x[i]!, 0) / xs.length);
  const dev = Array.from({ length: k }, (_, i) => Math.sqrt(xs.reduce((a, x) => a + (x[i]! - media[i]!) ** 2, 0) / xs.length) || 1);
  const z = xs.map((x) => [1, ...x.map((v, i) => (v - media[i]!) / dev[i]!)]);
  const pesi = new Array(k + 1).fill(0);
  // Discesa del gradiente con un po' di regolarizzazione (L2): pochi dati, pochi pesi grandi.
  for (let it = 0; it < 400; it++) {
    const g = new Array(k + 1).fill(0);
    for (let n = 0; n < z.length; n++) { const e = sigmoide(z[n]!.reduce((a, v, i) => a + v * pesi[i]!, 0)) - ys[n]!; for (let i = 0; i <= k; i++) g[i] += e * z[n]![i]!; }
    for (let i = 0; i <= k; i++) pesi[i] -= 0.1 * (g[i] / z.length + (i ? 0.01 * pesi[i] : 0));
  }
  return { media, dev, pesi };
}
const prevedi = (m: Modello, x: number[]) => sigmoide(m.pesi[0]! + x.reduce((a, v, i) => a + ((v - m.media[i]!) / m.dev[i]!) * m.pesi[i + 1]!, 0));
let meta: Modello | null = null;
export interface StatoMeta { n: number; attivo: boolean; brierBase: number | null; brierModello: number | null }
export function aggiornaMeta(j: JournalFile): StatoMeta {
  meta = null;
  const dati = chiusiConEsito(j).map((t) => ({ c: caratteristicheDi(t), y: pnl(t) > 0 ? 1 : 0 })).filter((d): d is { c: Caratteristiche; y: number } => d.c !== null);
  if (dati.length < META.minimo) return { n: dati.length, attivo: false, brierBase: null, brierModello: null };
  const xs = dati.map((d) => NOMI.map((k) => d.c[k])), ys = dati.map((d) => d.y);
  const taglio = Math.floor(dati.length * (1 - META.test));
  const m = addestra(xs.slice(0, taglio), ys.slice(0, taglio));
  const base = ys.slice(0, taglio).reduce((a, y) => a + y, 0) / taglio;
  const prova = xs.slice(taglio).map((x, i) => ({ x, y: ys[taglio + i]! }));
  const bb = brier(prova.map((q) => ({ p: base, y: q.y }))), bm = brier(prova.map((q) => ({ p: prevedi(m, q.x), y: q.y })));
  const attivo = bm < bb - META.margine;
  if (attivo) meta = addestra(xs, ys);
  return { n: dati.length, attivo, brierBase: bb, brierModello: bm };
}
// Probabilità che il trade finisca in guadagno secondo il meta-modello (null se non è attivo).
export const probMeta = (c: Caratteristiche) => (meta ? prevedi(meta, NOMI.map((k) => c[k])) : null);

// ---------- 3. Taglia: Kelly frazionario ----------
// Quota del capitale da rischiare secondo Kelly: f = p − (1 − p) / b (p probabilità di guadagno, b guadagno medio /
// perdita media). Se f ≤ 0 l'aspettativa stimata è negativa: il trade non si fa. Si usa un quarto di Kelly (il Kelly
// pieno è troppo aggressivo con stime incerte); il peso massimo della posizione è quota / distanza dello stop.
export const KELLY = { frazione: 0.25, bDiSerie: 1.5, minimoTrade: 20 };
export function rapportoVinciPerdi(j: JournalFile, tipo: Tipo): number | null {
  const ts = chiusiConEsito(j).filter((t) => tipoDi(t) === tipo).slice(-60);
  const v = ts.filter((t) => pnl(t) > 0).map((t) => pnl(t) / t.costo), p = ts.filter((t) => pnl(t) <= 0).map((t) => -pnl(t) / t.costo);
  if (v.length < KELLY.minimoTrade / 2 || p.length < KELLY.minimoTrade / 2) return null;
  const mv = v.reduce((a, x) => a + x, 0) / v.length, mp = p.reduce((a, x) => a + x, 0) / p.length;
  return mp > 0 ? mv / mp : null;
}
export function pesoKelly(p: number, b: number, stop: number): number | null {
  const f = p - (1 - p) / b;
  if (f <= 0) return null;
  return (KELLY.frazione * f) / Math.max(0.005, stop);
}
