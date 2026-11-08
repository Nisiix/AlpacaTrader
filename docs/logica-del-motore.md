# Come decide il motore degli agenti

Questo documento spiega, in ordine, cosa fa il bot a ogni giro e perché. Vale per `bun run agents` (il motore sempre
acceso); i numeri sono in `src/config.ts` e si possono cambiare lì. Tutto gira su un conto **paper** Alpaca: nessun
denaro vero.

## 1. Il ritmo

Ogni 5 minuti (`AGENTS.tickMinutes`) il motore fa un **giro**. Un giro è sempre lo stesso, giorno e notte, feriali e
festivi: quello che cambia è cosa la gabbia lascia passare (i titoli azionari solo a borsa aperta, le crypto sempre).

1. **Universo del giorno.** Una volta al giorno rinnova l'elenco delle crypto: tutte le coppie USD negoziabili su Alpaca
   che stanno nella top 100 per capitalizzazione (CoinGecko), stablecoin escluse, massimo 40. I titoli azionari sono
   fissi: SPY, QQQ, AAPL, MSFT, NVDA, GLD (scelti con i backtest). Dentro questo universo la scelta è quotidiana.
2. **Alpaca.** Conto, posizioni, ordini recenti, orologio di borsa, prezzi di tutto l'universo.
3. **Barre giornaliere.** Una volta al giorno scarica le candele giornaliere di tutto (320 sedute) e le salva in
   `state/bars.json`: servono alle medie, alla volatilità, al momentum e ai grafici della dashboard.
4. **Memoria del rischio.** Interruttore sulla perdita (a −5% dal massimo blocca gli acquisti, si riarma da solo dopo 5
   giorni di borsa), registro degli errori (lezioni: dopo uno stop niente riacquisto per 5 giorni, due rifiuti uguali
   bloccano il titolo), diario dei trade.
5. **Kronos.** Una volta al giorno chiede al sidecar le proiezioni a 5 sedute per tutto l'universo (percorso giorno per
   giorno) e le salva in `state/previsioni.json`. Kronos è la fonte principale per **anticipare** la direzione. Le
   proiezioni oltre ±25% sono rumore del modello: il motore le toglie a tutti (agenti, contesto, gabbia), non le usa né per
   entrare né per aspettare; restano sul grafico con la nota «fuori misura».
6. **Contesto economico** (agente `contesto`), prima di tutti gli altri. Regole sui dati: SPY sopra o sotto la media a
   200, volatilità, oro e obbligazioni che salgono con SPY che scende, settori con la maggioranza dei titoli sotto la
   media a 50 (il settore crypto si misura su tutto l'universo crypto), **ampiezza**: la quota media, settore per settore
   con lo stesso peso, di titoli a rischio (indici, tecnologia, crypto; non oro e obbligazioni, che sono rifugi) sopra la
   media a 50 — sotto il 50% il clima è al massimo neutro, sotto il 30% sfavorevole, anche con SPY sopra la 200 —, Fed
   nei prossimi 2 giorni. Più, se c'è
   `claude -p`, una lettura con ricerca web ogni 6 ore (se claude risponde con un errore, il motivo va nel registro e
   si riprova dopo un'ora: intanto valgono le regole). Esito: favorevole / neutro / sfavorevole, generale e per settore.
   **Il contesto corrente non decide da solo**: se Kronos anticipa un rialzo (≥ +1% a 5 sedute) il settore debole non
   ferma l'ingresso; se anticipa un ribasso (≤ −1%) si aspetta anche con contesto buono. Gli eventi (Fed, trimestrali)
   bloccano comunque.
7. **Gli agenti osservano** la stessa vista (prezzi, chiusure, indicatori, posizioni, diario, proiezioni, contesto) e
   votano. Nessun agente ordina niente.
8. **L'allocatore** somma i voti pesati per titolo. Sopra +0,5 si compra, sotto −0,5 si vende; le regole vincolanti
   (stop, obiettivo, fine giornata, proiezione contraria) vendono senza voto. Decide il peso di ogni posizione: **al
   massimo il 10% del conto** (meno se il titolo è nervoso), **proporzionale alla fiducia nella proiezione di Kronos**
   (probabilità che si avveri = rendimento atteso / volatilità sull'orizzonte: 50% → 40% del peso, ≥ 80% → peso pieno,
   senza proiezione 60%). Fino a 8 titoli. Il limite di volatilità annua (12%) è spento per scelta dell'utente. A borsa
   chiusa non spreca posti sui titoli azionari: i posti liberi vanno alle crypto.
9. **La gabbia** (`src/cage.ts`) è il codice che dice l'ultima parola: titoli solo a borsa aperta (crypto sempre),
   niente short, niente leva, solo azioni intere (crypto frazionarie, minimo 10 $), massimo 8 posizioni, massimo 10% per
   titolo, gruppi correlati limitati, mai sotto la media a 200 giorni; sopra la 50 **oppure** con un rialzo netto
   anticipato da Kronos (≥ +1%: un solo pattern contrario è prudenza, non blocco); niente acquisti nel giorno della Fed o
   nei 2 giorni prima di una trimestrale (non per l'intraday, che si chiude in giornata), lezioni del registro, stop loss e
   uscita di trend eseguiti dal codice. Un acquisto per titolo al giorno (l'ID dell'ordine lo impedisce).
   **Obiettivo giornaliero**: raggiunto il +1% del patrimonio rispetto alla chiusura di ieri, niente nuovi acquisti fino a
   domani e l'intraday incassa; oltre il −2% niente nuovi acquisti (gli stop proteggono il resto). I profitti restano nel
   conto e le taglie sono percentuali del patrimonio corrente: si reinvestono da soli.
10. **Invio** degli ordini ammessi, stop GTC su Alpaca per ogni posizione (scalato sulla volatilità, 5–10%; sulle crypto
    `stop_limit`), diario aggiornato con le esecuzioni, lezioni, stato per la dashboard, eventi nel registro, Telegram.
11. **Riepilogo** su Telegram dopo le 22:05 con il conto di profitto e perdita del giorno: ogni vendita in $ e %, il
    totale realizzato, il conto per agente, il non realizzato.

## 2. Gli agenti

| Agente | Cosa guarda | Cosa vota |
|---|---|---|
| **trend** | chiusura sopra le medie a 50 e 200 giorni, rendimento a 12 mesi positivo (crypto: anche a 3 mesi), classifica per momentum a 6 mesi | compra i migliori 5 (forza 1 → 0,5); vende chi ha chiuso sotto la 50 |
| **rientro** | RSI(2) sotto 10 con prezzo sopra la media a 200 | compra a taglia ridotta (5%), esce a RSI 70 o dopo 5 sedute |
| **regime** | SPY contro la media a 200, volatilità | rischio ammesso: 1 o 0,5 (moltiplica le taglie) |
| **orizzonte** | posizioni vecchie di 60 sedute | chiede di uscire se lo slancio è finito |
| **uscite** | ogni posizione: stop sulla volatilità, massimo visto, proiezione di Kronos | **vincolante**: stop, presa di profitto, proiezione negativa → vende |
| **profitto** | posizioni a +3% | vende metà e lascia correre il resto (walk-forward: più vinti, perdita massima minore) |
| **contesto** | vedi sopra | niente ordini: esposizione × 0,75 (neutro) o × 0,5 (sfavorevole), ma non sui titoli dove Kronos anticipa un rialzo (lì la taglia la decide la fiducia nella proiezione); chi aspetta (evento «in attesa», non un ordine rifiutato) |
| **kronos** | proiezioni a 5 sedute; scarta quelle oltre ±25% (rumore), classifica rialzi e ribassi separatamente e tiene il 25% più netto di ciascuno | compra (0,5 → 1 con la proiezione) sopra la media a 200; vende (0,5) i titoli in portafoglio con ribasso anticipato |
| **custodi** | **un investitore per ogni titolo o crypto in trend** (o in portafoglio): nessun numero fisso, tanti quanti sono i titoli che meritano attenzione, zero se il mercato non offre niente | vedi sotto |
| **intraday** | candele a 5 min / 15 min / 4 ore, scelte dalla volatilità | operazioni che si chiudono in giornata, vedi sotto |

### Il custode

Nasce quando un titolo rispetta i criteri del trend (sopra le medie, slancio a 12 mesi positivo; per le crypto anche a
3 mesi), **oppure quando Kronos anticipa un rialzo netto su un titolo sopra la media a 200**, o quando è in portafoglio;
muore dopo 12 giri fuori dai criteri. Dichiara sempre:

- **Tesi**: perché il titolo merita attenzione (medie, slancio).
- **Piano**: entrare ora (meglio sul rientro verso la media a 20 giorni: forza 0,8; ingresso ordinato 0,6; prezzo oltre il
  15% sopra la media a 50: solo 0,25, meglio aspettare), tenere finché il prezzo resta sopra la media a 50, uscire sotto
  la 50 (0,9) o con slancio a 3 mesi negativo (0,6).
- **Rischio**: stop sulla volatilità, peso massimo, numero massimo di posizioni.
- **Dossier**, aggiornato a ogni giro, con quattro fonti e un peso ciascuna → **probabilità che il titolo sia favorevole**
  e **prossima azione** in chiaro:
  - Kronos (45%): probabilità di rialzo = rendimento atteso a 5 sedute diviso la volatilità sull'orizzonte (normale).
  - Grafico (25%): massimi e minimi crescenti o calanti, rottura dei massimi a 20 sedute, medie allineate, rientro sulla
    media a 20, eccesso oltre il 15% sopra la 50, RSI(14) oltre 75 o sotto 30, compressione di volatilità, slancio a 3 mesi.
  - Notizie (15%): titoli recenti da Google News e, con un bearer token in Impostazioni, i post su X (ogni ora), tono da
    parole chiave (rally, ETF, approvazione… contro hack, crollo, causa…).
  - Contesto (15%): favorevole 0,8 / neutro 0,5 / sfavorevole o in attesa 0,2.
- **Memoria del titolo**: dal diario, i trade passati su quel simbolo (quanti, vinti, media, quanti chiusi dallo stop, quale
  ingresso ha reso di più). Con 3 o più trade in perdita il custode entra con **metà taglia e forza ridotta**; con storia
  positiva entra con più fiducia; se ha reso solo il rientro, l'ingresso "in trend" vale meno.

La forza del voto d'ingresso segue il dossier (50% → invariata, 80% → +30%, 30% → −20%) e la memoria; un ribasso anticipato
da Kronos (≤ −1%) ferma l'ingresso anche in trend; un rialzo anticipato (≥ +1%) lo rafforza del 15%. Le uscite sono regole
e non si modulano.

### L'intraday

Decide **Kronos, non il contesto macro**: entra se Kronos vede un rialzo (≥ +0,5%) oppure, senza proiezione contraria, se il
giornaliero è in trend; mai contro un ribasso previsto. I pattern di più orizzonti sono prudenza: giornaliero sotto le medie,
settimanale in calo (un mese sotto −2%, o negativo con medie brevi girate), intraday con le candele per lo più sotto la
media a 20 → **due contrari = fuori, uno contrario = metà taglia e serve un Kronos netto (≥ +1%)**. I candidati sono
ordinati per proiezione.

- **Candela**: volatilità giornaliera a 20 giorni ≥ 3% → 5 minuti; ≥ 1,5% → 15 minuti; altrimenti 4 ore.
- **Ingresso**: rottura dei massimi delle 20 candele precedenti con un movimento di almeno mezzo ATR, oppure rientro sulla
  media a 20 candele (trend sulla candela già in corso, tocco della media, ripartenza sopra il massimo della candela del
  rientro). Non si entra oltre 3 ATR sopra il livello di rottura (si insegue).
- **Obiettivo**: il maggiore tra 1% (titoli) / 2% (crypto) e 1,5 ATR. **Stop**: 1,2 ATR (minimo 0,4%). Rapporto
  obiettivo/stop almeno 1,2. Si entra solo se il movimento atteso prima della chiusura (ATR × √candele rimaste) copre
  almeno l'80% dell'obiettivo.
- **Finestre** (ora di Roma): titoli 15:45–20:30, chiusura forzata 21:45; crypto 00:10–20:00, chiusura forzata 23:30.
- **Uscite vincolanti**: obiettivo raggiunto, stop, due candele chiuse sotto la media a 20, fine giornata.
- Peso massimo 10% del conto per operazione, al massimo 3 operazioni aperte, un ingresso per titolo al giorno. Se il
  processo riparte, le operazioni aperte si ricostruiscono dal diario e dal carico.

## Il capo ufficio

A ogni giro, prima che i voti vengano sommati, il capo ufficio rilegge il diario: per ogni agente (generali e custodi)
conta i trade chiusi, i vinti, il risultato medio e la proiezione di Kronos che c'era all'ingresso. Con meno di 3 trade
l'agente è «nuovo»; in attivo con almeno il 55% di vinti è «bene» o «ottimo»; in attivo ma con pochi vinti è «da seguire»
(consiglio: la soglia di Kronos che nell'ufficio ha reso di più); in perdita è **richiamato**: finché non migliora i suoi voti
d'acquisto sotto una soglia minima di Kronos (la maggiore tra 1%, la soglia migliore dell'ufficio e la proiezione media dei suoi
trade vinti) non contano, gli altri pesano il 60%; riceve consigli presi da chi ha avuto successo (tipo d'ingresso migliore,
troppe uscite dallo stop). Le vendite non si toccano. Il capo non fa ordini.

## 3. Cosa impara il motore

- **Pesi degli agenti**: dal diario, dopo il periodo di osservazione (30 trade chiusi): chi ha votato ingressi che perdono
  scende a 0,5, chi vince con campione affidabile sale a 1,2.
- **Lezioni**: un titolo o un tipo d'ingresso che perde con costanza non si compra per un po' (solo stringendo, mai
  allargando).
- **Memoria per titolo** (custodi): vedi sopra.
- **Proiezioni** e **universo** si rinnovano ogni giorno; i custodi nascono e muoiono con i criteri.

## 4. Perché così

- Il metodo di fondo (trend sopra le medie, momentum assoluto, stop sulla volatilità, uscita di trend, presa di profitto
  parziale, volatilità di portafoglio al 12%) è quello che nei backtest 2021–2026 ha dato +65% con perdita massima −7,6% e
  giornate positive il 53–54% delle volte: il guadagno sta nel fatto che i giorni buoni valgono più dei cattivi.
- Kronos è la fonte principale per anticipare, ma da solo è rumoroso (zero-shot): per questo guida solo le proiezioni più
  nette e sempre dentro le regole della gabbia.
- Ogni ingresso intraday ha obiettivo e stop dichiarati prima di entrare e una scadenza certa (la fine della giornata):
  niente posizioni che "si vedrà domani".
- Il contesto, le notizie e la memoria affinano; la gabbia protegge. Qualunque vantaggio di backtest va letto tagliato del
  25–50%.

## Ingressi contro tendenza guidati da Kronos

Sotto la media a 200 il motore non compra per trend, ma **Kronos può anticipare un'inversione**: se prevede almeno **+2% a
5 sedute** (mai oltre ±25%) con **probabilità di successo almeno del 60%** (Φ del rendimento atteso sulla volatilità del
titolo × √5), l'agente Kronos, il custode del titolo e lo scopritore della sala caffè possono votare l'acquisto. La taglia
è al massimo **metà del peso massimo** (5% del conto) e scala con la fiducia; la gabbia rifiuta oltre. Le uscite restano
quelle di sempre: stop sulla volatilità su Alpaca, si tiene finché Kronos vede il rialzo, si esce quando la proiezione gira
(custode, agente uscite, uscita di trend della gabbia). Parametri nella scheda di Kronos.

## Scelta dei titoli: Kronos più tutte le fonti

Un ingresso nuovo di più giorni (non intraday) passa da tre filtri, chiunque abbia votato:
1. **voti e punteggio** (Kronos, trend, rientro, custodi, esplorazione), con richiami del capo e lezioni della sala caffè;
2. **evidenza combinata** del dossier del custode: Kronos 45%, grafico 25%, notizie e post (Google News, Alpaca/Benzinga,
   X) 15%, contesto 15% (con Fear & Greed e funding per le crypto). Sotto **50%** (sopra la media a 200) o **60%** (sotto
   la 200) non si entra: il titolo resta in attesa con il motivo;
3. **taglia**: peso massimo × fiducia in Kronos (probabilità che la proiezione si avveri) × evidenza (al minimo metà,
   dall'80% piena). **Sotto la media a 200** la taglia si moltiplica ancora per 0,5 e non supera mai il 5% del conto:
   a parità di tutto, contro tendenza si investe sempre la metà.

## Niente numeri fissi: riparto del capitale

Non c'è un numero massimo di agenti, titoli o operazioni (le posizioni hanno solo una sicurezza tecnica a 1000; Kronos
vota ogni rialzo oltre la soglia; l'intraday non ha più il tetto di 3 operazioni; l'esplorazione non ha un tetto di
scoperte). Quello che limita è il **capitale**: se i contanti (meno l'1% di riserva) non bastano per tutto quello che gli
agenti chiedono, l'allocatore li **divide in proporzione alla qualità** di ogni occasione, cioè fiducia in Kronos ×
evidenza del dossier × punteggio dei voti, senza dare a nessuno più di quanto ha chiesto; quello che avanza va agli altri.
Una posizione nuova vale la pena sopra lo 0,2% del conto; le aggiunte a una posizione aperta sopra il 2%.

## Intraday: candela e orizzonte con la probabilità più alta

Titoli e crypto usano **le stesse candele: 5 e 15 minuti, 1 ora e 4 ore**. Si valuta solo una candela che può completarsi
nel tempo rimasto (azioni: fino a 15 minuti dalla chiusura vera di Alpaca; crypto: durata massima 12 ore), quindi la 4 ore
per le azioni vale solo nelle prime ore di seduta.

Su ogni candela servono medie brevi in ordine (EMA 9 sopra EMA 20 e prezzo sopra la 9, oppure rottura/rientro),
obiettivo raggiungibile e rapporto obiettivo/stop ≥ 1,2. Poi **una sola proiezione di Kronos per candela**, letta a più
**orizzonti, dai quarti d'ora alle ore** (15, 30 minuti, 1, 2, 4, 8 ore, nei limiti di 20 candele e del tempo rimasto):
- per ogni orizzonte, rendimento previsto e **probabilità di successo** (rendimento sulla volatilità delle candele);
- vale solo se il rialzo copre **2 volte i costi** di andata e ritorno (crypto 1%, azioni 0,1%);
- si sceglie la coppia **candela + orizzonte** con la probabilità più alta (almeno 55%).

La taglia scala con la fiducia (55% → metà, 70% e oltre → piena); grafico superiore e Kronos a 5 sedute contrari la
dimezzano ciascuno. Stop minimo 0,4% sulle azioni e **1% sulle crypto** (sopra il costo di 0,5%).

La posizione si segue sulla candela **più breve** (5 min → 1 min, 15 min → 5 min, 1 ora → 15 min, 4 ore → 1 ora), con
Kronos sull'orizzonte d'ingresso (senza superare il tempo rimasto):
- vede ancora salire con almeno il 60% → oltre l'obiettivo **si lascia correre**, lo stop sale sopra il carico;
- vede un calo che azzererebbe il guadagno → **si incassa** (protezione del profitto);
- in perdita, vede un calo verso lo stop con rialzo al 35% o meno → **si taglia prima**;
- **orizzonte scaduto** (1,5 volte quello d'ingresso) senza obiettivo e senza rialzo probabile → si chiude;
- restano stop, obiettivo, media a 20 persa e chiusura di giornata.

Un'operazione intraday ha **solo queste uscite**: la proiezione a 5 sedute, la presa di profitto a +3% e l'uscita di trend
giornaliera non la toccano (resta lo stop di emergenza). Il blocco «un ingresso al giorno per titolo» scatta a ordine
eseguito: un voto scartato dall'allocatore o dalla gabbia si ripresenta al giro dopo.

## Protezione del profitto

Con una posizione in guadagno oltre i costi (0,2% azioni, 0,6% crypto), se Kronos vede nelle **prossime 2 sedute** (dal
percorso previsto giorno per giorno) un calo che riporterebbe il guadagno a zero, l'agente uscite **vende subito**: meglio
un profitto minore che tornare a pari o in perdita. Proiezione a 5 sedute **netta al ribasso** (−1% o meno, la stessa
soglia con cui si compra) su un titolo in portafoglio → si esce. La presa di profitto parziale a +3% aspetta se Kronos
anticipa altro rialzo.

## Il cervello delle previsioni: Kronos e gli altri modelli

Accanto a Kronos il sidecar fa girare altri due modelli gratuiti (Apache 2.0) sulla stessa serie: **Chronos-2** (Amazon) e
**TimesFM 2.5** (Google). Kronos legge le candele intere ed è addestrato sui mercati; gli altri due sono modelli generici
sulla serie delle chiusure. Gli studi su dati finanziari dicono che i modelli generici, usati così come sono, prevedono
poco la direzione dei rendimenti: per questo non si fa una media alla cieca, ma **ogni modello deve dimostrare quanto vale**.

- Ogni previsione di ogni modello (giornaliera a 5 sedute e su ogni candela intraday) si registra e, alla scadenza, si
  confronta con il prezzo vero: direzione giusta o sbagliata, e quanto avrebbe reso seguirla.
- La previsione usata dal motore è la **media dei percorsi pesata sulla bravura** di ogni modello: quota di direzioni
  giuste oltre il 50%, ridotta quando il campione è piccolo. Conti separati per previsione giornaliera e per candela
  (5 min, 15 min, 1 ora, 4 ore): un modello può valere sulle candele brevi e non sul giornaliero.
- Un modello conta solo dopo **100 previsioni valutate**; prima si fa solo misurare e decide Kronos. Chi non supera il
  caso ha peso zero. Kronos, finché non risulta peggiore del caso, tiene **almeno metà del peso**.
- Tutto il resto del motore resta com'è: probabilità, soglie, costi, taglie e uscite lavorano sulla previsione combinata.
- Nella pagina Dashboard, «Cervello delle previsioni» mostra per ogni modello previsioni valutate, direzione giusta, resa e
  peso di adesso. Se Chronos-2 o TimesFM non sono installati (installa-kronos), si lavora con il solo Kronos.

## Fiducia nelle proiezioni: ridurre il rischio sì, aumentarlo no

Con eventi in arrivo (Fed nei prossimi giorni, trimestrale) il contesto non si fida della proiezione **per entrare o per
tenere**. Per **uscire** e per **controllare i costi** la proiezione vale sempre: una proiezione non fidata non può far
comprare, ma può sempre far vendere o fermare un acquisto. Con Kronos attivo, un titolo senza proiezione utilizzabile
non entra (non si può verificare che il rialzo copra i costi).

## Ordini e contanti

Il riparto del capitale non ridistribuisce i contanti già impegnati da ordini d'acquisto aperti. Uno stop o un'uscita di
trend non si rimanda se una vendita è già in corso. Non ci sono sveglie: acquisti e uscite seguono la seduta vera.

## Sala caffè: gli agenti imparano gli uni dagli altri

A ogni giro, dopo i richiami del capo ufficio, il motore (`src/agents/caffe.ts`):

1. **Lezioni di squadra.** Dai trade chiusi del diario (esclusi quelli chiusi dalla vecchia uscita in giornata) raggruppa
   per tipo d'ingresso, settore, forza di Kronos all'ingresso e ingresso + settore. Con almeno 3 trade nel gruppo: vinti
   sotto il 40% e media negativa → **prudenza**; vinti dal 60% e media positiva → **fiducia**.
2. **Apprendimento.** Ogni voto d'acquisto non vincolante che ricade in una lezione cambia forza: ×0,85 per lezione di
   prudenza, ×1,1 per lezione di fiducia, in totale mai sotto ×0,7 né sopra ×1,15, e mai oltre 1. Vendite e regole non si
   toccano. Il voto porta scritto da quale lezione viene.
3. **Chi va in pausa.** Alla scrivania: chi vota, chi frena il rischio (regime, contesto sotto 100%), i custodi con una
   posizione, un'uscita, un ingresso pronto o un voto, gli operatori intraday in posizione o con un ingresso votato. Tutti
   gli altri vanno in sala caffè. Chi ha di nuovo un trade da aprire torna alla scrivania nello stesso giro.
4. **Cosa si dicono.** Solo dati veri: il dossier dei custodi (probabilità, Kronos, grafico, notizie, memoria) a un
   collega dello stesso settore, la lettura degli agenti generali, le candele degli operatori intraday, le proiezioni più
   nette di Kronos e quelle scartate, le lezioni di squadra raccontate da chi ne ha più esperienza, la lezione comune del
   capo ufficio.

### Esplorazione: chi è in pausa cerca nuove occasioni

Gli agenti in sala caffè non restano fissi sul loro titolo (`src/agents/esplorazione.ts`). Ogni minuto (anche tra un giro e l'altro), se qualcuno è
in pausa, prendono i prossimi 8 titoli del **radar** (azioni ed ETF liquidi fuori dall'universo, in `RADAR_SECTORS` con il
loro settore: tecnologia, finanza, salute, energia, consumi, indici; le crypto della top 100 negoziabili su Alpaca sono
già tutte nell'universo) e li passano con i criteri del motore:

1. storico sufficiente, **sopra la media a 200**, momentum a 12 mesi positivo, lettura del grafico almeno al 50%;
2. **Kronos** al rialzo oltre la soglia (+1% a 5 sedute) e non fuori misura (oltre ±25% è rumore).

Chi trova un'opportunità (di preferenza un custode dello stesso settore, poi un custode o un operatore della stessa classe,
crypto o azioni, poi chiunque sia in pausa) **torna alla scrivania** e lo annuncia ai colleghi. Il titolo **entra
nell'universo per 3 giorni**: da lì prezzi, contesto, custode, gabbia, stop e uscite lo trattano come ogni altro titolo. Lo
scopritore lo **vota a ogni giro** (forza da Kronos e dal grafico) finché l'opportunità regge; il voto passa da punteggi,
richiami del capo, lezioni della sala caffè, allocatore e gabbia. La scoperta si chiude quando il titolo è comprato (lo
segue il suo custode), quando Kronos non vede più il rialzo o il prezzo scende sotto la 200 (svanita), o dopo 3 giorni
(scaduta); un titolo del radar in portafoglio resta nell'universo finché lo si tiene. Al massimo 6 scoperte al giorno;
i settori nuovi non pesano sull'ampiezza del contesto.

Il capo ufficio giudica anche la **squadra dei custodi** insieme: un custode segue un titolo solo e raramente arriva a 3
trade; il richiamo della squadra vale per ogni custode che non ha ancora un giudizio proprio.

## 5. Dove vedere tutto

Dashboard su `http://127.0.0.1:8787`, quattro voci: **Dashboard** (frase di stato, soldi, situazione in breve), **Titoli**
(grafico con candele giorno/4 ore/1 ora/15/5 minuti, scheda del titolo in un dialogo «Analisi/Riepilogo investimento» e, sotto,
la parte «Oggi»: profitto e perdita di oggi, posizioni, ultimo giro, intraday quando c'è un'operazione aperta, simulazioni, registro della giornata con le azioni ripetute
a ogni giro raggruppate), **Titoli** (candele con medie, carico, stop, candela di oggi in formazione, scelte del motore,
scenario di Kronos, dossier del custode; «Chiedi agli agenti adesso» per una valutazione a secco), **Agenti** (Squadra: capo
ufficio, custodi, punteggi e voti; Ufficio 3D), **Impostazioni** (schede degli agenti, chiavi e riavvio, guida). La stessa
pagina, in sola lettura, può essere pubblicata su GitHub Pages. Telegram riceve ordini, allarmi e il riepilogo serale.
