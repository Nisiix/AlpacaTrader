# Come decide il motore degli agenti

Questo documento spiega cosa fa il bot e perché, nell'ordine in cui lo fa. Vale per il motore sempre acceso
(`bun run agents`, su Windows `avvia-bot.cmd`); i numeri stanno in `src/config.ts` e quasi tutti si cambiano dalla pagina
Impostazioni della dashboard. Tutto gira su un conto **paper** Alpaca: nessun denaro vero. Il motore si rifiuta di partire
con un indirizzo o una chiave che non siano paper.

---

## 1. Il ritmo

| Cosa | Quando | Perché |
|---|---|---|
| **Giro** | ogni **5 minuti**, giorno e notte, feriali e festivi | conto, prezzi, uscite, stop, protezione del profitto, operazioni intraday aperte |
| **Analisi d'ingresso** | ogni **15 minuti** (dentro un giro) | decidere se investire e su cosa: scansione intraday con Kronos e nuovi acquisti; tre volte il tempo per Kronos |
| **Esplorazione** | ogni **minuto**, se qualche agente è in pausa | passare in rassegna il radar dei titoli fuori dall'universo |
| **Storico e proiezioni giornaliere** | appena c'è una **giornata conclusa** nuova | azioni dalle 16:15 di New York (22:15 italiane), crypto a mezzanotte UTC (01:00) |
| **Universo crypto, trimestrali** | una volta al giorno | top 100 per capitalizzazione negoziabili su Alpaca; date dei conti da Nasdaq |
| **Riepilogo Telegram** | dopo le 22:05 | profitto e perdita del giorno, per operazione e per agente |

Non ci sono sveglie a orari fissi: le azioni seguono l'orologio vero della borsa (Alpaca: apertura, chiusura, festivi,
ora legale), le crypto lavorano 24 ore su 24.

---

## 2. Un giro, passo per passo

1. **Universo.** Azioni di base (SPY, QQQ, AAPL, MSFT, NVDA, GLD), crypto del giorno (fino a 40 coppie) e i titoli
   scoperti dall'esplorazione ancora attivi.
2. **Alpaca.** Conto, posizioni, ordini, orologio della borsa, prezzi.
3. **Trimestrali** (una volta al giorno) e **storico giornaliero** (solo giornate concluse, 320 sedute).
4. **Memoria del rischio.** Registro degli errori (dopo uno stop niente riacquisto per 5 giorni di borsa; due rifiuti
   uguali di Alpaca bloccano quel titolo per 5 giorni), limite del giorno, diario dei trade.
5. **Previsioni.** Kronos e il cervello delle previsioni (capitolo 3), riportate al prezzo di adesso.
6. **Fonti esterne.** Fear & Greed delle crypto, funding dei futures; le notizie le leggono i custodi.
7. **Contesto economico**, prima di tutti gli altri agenti: decide dove aspettare e di quali proiezioni fidarsi.
8. **Gli agenti votano**, tutti sulla stessa vista. Nessun agente ordina niente da solo.
9. **L'ufficio rivede i voti**: gli esploratori votano le loro scoperte, il **capo ufficio** applica i richiami, la
   **sala caffè** le lezioni di squadra.
10. **Allocatore**: dai voti alle quantità (capitolo 5).
11. **Gabbia**: l'ultima parola, con regole scritte nel codice.
12. **Invio** degli ordini, **stop GTC su Alpaca** per ogni posizione, diario, stato per la dashboard, eventi, Telegram.
13. **Sala caffè ed esplorazione**: chi non ha niente da fare va in pausa e cerca nuove occasioni.

---

## 3. Le previsioni

### Kronos, la fonte principale

Kronos è un modello addestrato su 12 miliardi di candele di 45 borse. Gira in un processo Python a parte (il «sidecar»),
che il motore accende da solo. Prevede il percorso del prezzo:

- **giornaliero**: le prossime 5 sedute, per tutto l'universo, una volta per giornata conclusa;
- **intraday**: le prossime candele da 5 e 15 minuti, 1 ora, 4 ore, letto a più orizzonti (15 e 30 minuti, 1, 2, 4,
  8 ore).

Ogni previsione è la media di più **campioni** (percorsi generati). Più campioni, previsione più stabile: l'errore
casuale scende con la radice del numero. Il motore misura quanto impiega il PC e **sale con i campioni** finché il tempo
per titolo resta in quello concesso: **6 s** per le giornaliere, **3 s** per l'intraday, **1,5 s** per l'esplorazione
(una prima scrematura: chi entra nell'universo si riproietta col budget pieno), **0,7 s** per i grafici; tra 4 e 128
campioni.

### Giornate concluse e prezzo di adesso

- Lo storico contiene solo **giornate finite**, e si rinnova appena ne finisce una: le medie, le uscite di trend e
  Kronos lavorano sempre sull'ultima seduta conclusa.
- Kronos prevede il rendimento **dall'ultima chiusura**. Prima di ogni decisione la previsione e il percorso si riportano
  **al prezzo di adesso**: se Kronos vedeva +2% e il titolo oggi è già salito del 2,5%, da qui l'attesa è negativa e non
  si compra; se il calo previsto è già avvenuto, non si vende sul fondo.
- Proiezioni oltre ±25% (giornaliere), oltre ±25% o oltre 4 volte la volatilità delle candele (intraday) sono **rumore
  del modello** e non si usano (succede sui prezzi minuscoli, es. 0,000005 $).
- Se il sidecar non risponde, restano le ultime proiezioni, con la giornata su cui sono state calcolate.

### La probabilità di successo

Per ogni previsione il motore calcola la probabilità che si avveri: Φ(rendimento atteso / (volatilità × √orizzonte)).
Un +4% su un titolo che si muove del 5% al giorno vale meno di un +4% su uno che si muove dell'1%. Questa probabilità
decide taglie, ingressi contro tendenza, scelta della candela intraday e uscite.

### Il cervello delle previsioni

Accanto a Kronos il sidecar può far girare **Chronos-2** (Amazon) e **TimesFM 2.5** (Google), gratuiti, se installati
con `installa-kronos`. La previsione usata è la **media pesata**: peso = **affidabilità a priori** × **risultati
misurati**.

| Modello | Addestramento | Prove pubblicate sui rendimenti | Affidabilità |
|---|---|---|---|
| Kronos | 12 miliardi di candele da 45 borse | RankIC 0,034 (il migliore) | **1** |
| Chronos-2 | dati generici e sintetici | RankIC 0,005 | **0,13** |
| TimesFM 2.5 | dati generici e sintetici | RankIC negativo | **0,05** |

Ogni previsione di ogni modello si confronta con il prezzo vero alla scadenza. Fino a 100 previsioni valutate conta solo
l'affidabilità (Kronos ~85%); poi la quota di direzioni giuste oltre il caso la conferma, la alza o la azzera, con conti
separati per il giornaliero e per ogni candela. Kronos tiene almeno metà del peso finché non risulta peggiore del caso.

### Di quali previsioni fidarsi

Con un evento in arrivo (Fed nei prossimi giorni per azioni ed ETF, trimestrale del titolo) il contesto non si fida della
proiezione **per entrare o per tenere**. Per **uscire** e per **controllare i costi** vale sempre: una proiezione non
fidata può far vendere o fermare un acquisto, mai far comprare.

---

## 4. L'ufficio: gli agenti e i loro compiti

| Agente | Compito | Vota |
|---|---|---|
| **kronos** | proiezioni a 5 sedute | compra i rialzi oltre +1% (forza 0,5 → 1 con la proiezione); sotto la media a 200 solo contro tendenza (≥ +2% con probabilità ≥ 57%, metà taglia); vende (0,5) un titolo in portafoglio con ribasso netto |
| **trend** | sopra le medie a 50 e 200 giorni, rendimento a 12 mesi positivo (crypto anche a 3 mesi), classifica per momentum a 6 mesi | compra (1 → 0,5 per classifica); vende chi chiude sotto la 50, salvo Kronos ancora al rialzo |
| **rientro** | RSI(2) sotto 10 sopra la media a 200 | compra a taglia ridotta (5%); esce a RSI 70 o dopo 5 sedute |
| **custodi** | un investitore per ogni titolo in trend, con rialzo netto di Kronos o in portafoglio; nessun numero fisso | tesi, piano, rischio e dossier; vota ingressi e uscite (sotto) |
| **intraday** | operazioni da minuti a ore su candele brevi | capitolo 6 |
| **uscite** | regole vincolanti di ogni posizione | capitolo 7 |
| **profitto** | posizioni a +3% | vende metà, salvo Kronos che vede altro rialzo |
| **orizzonte** | posizioni di 60 sedute | chiede di uscire se lo slancio è finito |
| **regime** | SPY per le azioni, BTC per le crypto | rischio ammesso: sotto la media a 200 o con volatilità alta, esposizione dimezzata |
| **contesto** | ampiezza dei mercati per settore, Fed, Fear & Greed, lettura macro con `claude -p` ogni 6 ore | rischio ammesso (neutro × 0,75, sfavorevole × 0,5) e «attese»: settore debole senza rialzo di Kronos, ribasso anticipato, eventi |

Regime e contesto guardano entrambi la salute del mercato: vale la riduzione più forte, non il prodotto. Dove Kronos
anticipa un rialzo, o per l'intraday, la riduzione del contesto non si applica.

### Il custode

Nasce quando un titolo merita attenzione e muore dopo 12 giri fuori dai criteri. Dichiara **tesi**, **piano** (entrare sul
rientro verso la media a 20, ordinato, o aspettare se oltre il 15% sopra la 50; uscire sotto la 50 o con slancio a 3 mesi
negativo), **rischio** e un **dossier** che diventa la **probabilità che il titolo sia favorevole**:

- Kronos 45%: probabilità di rialzo a 5 sedute;
- grafico 25%: massimi e minimi, rotture, medie, rientri, eccessi, RSI, compressione di volatilità;
- notizie 15%: Google News, Alpaca/Benzinga, X (con token);
- contesto 15%: favorevole, neutro, sfavorevole; per le crypto anche Fear & Greed e funding.

Più la **memoria del titolo** dal diario: con 3 o più trade in perdita su quel simbolo entra con metà taglia e forza ridotta.

### Il capo ufficio

A ogni giro rilegge il diario per ogni agente (e per la squadra dei custodi): trade, vinti, risultato, Kronos all'ingresso.
Con meno di 3 trade è «nuovo»; in attivo con almeno il 55% di vinti «bene» (65% «ottimo»); in attivo con pochi vinti «da
seguire»; in perdita **richiamato**: i suoi voti d'acquisto di più giorni sotto una soglia di Kronos (la maggiore tra
+1%, la soglia migliore dell'ufficio e la media dei suoi trade vinti) non contano, gli altri pesano il 60%. Un voto
intraday richiamato non perde forza ma **taglia** (×0,6): la soglia a 5 sedute è un altro orizzonte, e l'ingresso sulle
candele brevi resta deciso da Kronos con i suoi filtri. Le vendite non si toccano.

### La sala caffè

Dai trade chiusi raggruppa per tipo d'ingresso, settore e forza di Kronos: con almeno 3 trade, vinti sotto il 40% e
media negativa → **prudenza** (×0,85 sul voto), vinti dal 60% e media positiva → **fiducia** (×1,1), in totale tra ×0,7
e ×1,15. Sui voti intraday la prudenza riduce la **taglia**, non la forza (e la fiducia non la aumenta): così
l'esperienza dei trade di più giorni non basta a far saltare un'occasione che Kronos vede sulle candele da 5 o 15 minuti. Chi non ha niente da fare va in pausa; chi ha di nuovo un trade da aprire torna alla scrivania nello stesso giro.
I colleghi si scambiano solo dati veri: dossier, proiezioni, candele, lezioni.

### L'esplorazione

Ogni minuto, gli agenti in pausa passano 6 titoli del **radar** (azioni ed ETF liquidi fuori dall'universo: tecnologia,
finanza, salute, energia, consumi, indici) con i criteri del motore: sopra la media a 200, momentum a 12 mesi positivo,
grafico almeno al 50%, Kronos oltre +1% e non fuori misura (sotto la 200 solo contro tendenza). Chi trova
un'opportunità torna alla scrivania, il titolo **entra nell'universo per 3 giorni** e lo scopritore lo vota finché
l'opportunità regge. Si chiude quando è comprato (lo segue il suo custode), quando svanisce o dopo 3 giorni.

---

## 5. Entrare: dal voto all'ordine

### L'allocatore

1. **Somma i voti** pesati per titolo (tutti gli agenti con peso 1; richiami e lezioni li hanno già corretti). Da +0,5
   si compra, da −0,5 si vende. Le regole vincolanti vendono senza voto.
2. **Filtri per un ingresso nuovo di più giorni**:
   - il contesto non dice di aspettare;
   - **costi**: Kronos deve prevedere almeno **2 volte** i costi di andata e ritorno (crypto 0,5% → +1%; azioni ~0,05%
     → +0,1%); con Kronos attivo, senza proiezione utilizzabile non si entra;
   - **evidenza combinata** del dossier: almeno 57% sopra la media a 200, 65% sotto.

   **Voti misti**: se sullo stesso titolo votano sia agenti di più giorni sia l'intraday e uno di questi filtri fa
   aspettare l'ingresso di più giorni, si guarda la sola parte intraday: se da sola arriva a +0,5 entra come **trade
   intraday** (sua taglia, suo obiettivo e stop, chiusura in giornata o promozione), invece di perdere l'occasione.
3. **Taglia**: al massimo il **10% del conto** per titolo, meno se il titolo è nervoso (valore × volatilità giornaliera ≤
   0,25% del conto) × rischio ammesso × **fiducia in Kronos** (50% → 40% della taglia, ≥ 80% → piena) × evidenza (al
   minimo metà) × la **scaletta delle medie** (sotto).
4. **Riparto del capitale**: nessun numero fisso di titoli o di agenti. Se i contanti (meno l'1% di riserva e meno gli
   ordini d'acquisto ancora aperti) non bastano, si dividono in proporzione alla **qualità** (fiducia × evidenza ×
   punteggio), rispettando il **35% per settore** in ordine di punteggio. Una posizione nuova vale la pena da 0,2% del
   conto e 100 $; un'aggiunta da 2%.
5. Gli acquisti si decidono solo nei giri con **analisi d'ingresso** (ogni 5 minuti); le vendite in ogni giro.

### Proposte del capo ufficio

Oltre a giudicare le persone, il capo ufficio guarda i risultati delle operazioni intraday chiuse (le ultime 200) e,
solo con dati sufficienti (almeno 30 operazioni e almeno 12 nel gruppo che giustifica il cambio), **propone all'utente**
di cambiare un'impostazione generale, con il valore attuale, quello proposto e il perché in numeri
(`src/agents/proposte.ts`, `AGENTS.capo.proposte`). Le regole:

- operazioni entrate con probabilità vicina alla soglia (entro 5 punti) in perdita → soglia più alta; risultati molto
  buoni ma meno di un'operazione al giorno → soglia senza medie in ordine più bassa di un punto;
- nel complesso in perdita → taglia per operazione più piccola; resa costante (vinte ≥ 55%, guadagni/perdite ≥ 1,4)
  → un po' più grande (massimo 15%);
- un livello della scaletta delle medie in perdita → più prudenza su quel livello; molto positivo → un po' meno;
- operazioni con obiettivo vicino ai costi in perdita → margine sui costi più alto;
- chiusure per tempo scaduto in perdita → scadenza dell'orizzonte più corta;
- rientri nello stesso giorno in perdita → meno ingressi al giorno per titolo;
- operazioni riportate al giorno dopo in perdita → riporto più selettivo.

Il capo non cambia niente da solo: nell'ufficio 3D si alza in piedi con la mano alzata e l'avviso «proposta per te»; la proposta è nella sua scheda (clic sul capo, sull'avviso o sul suo nome nell'elenco) e arriva su Telegram; «Accetta» la salva
come le altre impostazioni, «Rifiuta» la tiene ferma 7 giorni. Dopo un'accettazione la stessa impostazione si riguarda
solo con almeno 12 operazioni nuove. Per queste analisi ogni ingresso intraday registra nel diario anche la posizione
rispetto alle medie a 50 e 200 (`misure.medie`).

### Voti e tempi

- **Quanti voti**: ogni agente vota con una forza (0-1) e il punteggio di un titolo è la somma dei voti d'acquisto
  meno quelli di vendita (tutti gli agenti pesano 1). Si compra da +0,5. Con il motore che punta all'intraday conta la
  sola parte intraday: il voto dell'intraday agent vale 1, quindi **basta il suo voto** (deciso dalle candele e da
  Kronos su quelle candele); i voti di vendita d'opinione lo possono abbassare.
- **Quando**: i giri sono **allineati alla chiusura delle candele da 5 minuti** (partono 20 secondi dopo: :00:20,
  :05:20, ...). In ogni giro l'intraday legge le candele appena chiuse e Kronos le riproietta solo se è chiusa una
  candela nuova; il voto e l'ordine arrivano nello stesso giro, dopo circa 1-2 minuti (il tempo di Kronos).
- **Prezzo riletto**: prima di inviare un acquisto il prezzo si rilegge; se nel frattempo è salito oltre lo 0,3%
  l'acquisto non parte e si rivaluta al giro dopo. Le crypto entrano con un ordine limite sul prezzo di adesso.
- Lo stato del motore registra la durata di ogni agente e delle fasi del giro (`tempi`).

### Titoli europei

Il conto Alpaca (Trading API) tratta solo i mercati americani: le borse europee (Xetra e le altre) sono riservate ai
broker partner. Le azioni europee entrano quindi come **titoli europei quotati in America** e **ETF sull'Europa**
(`EUROPA` in `src/config.ts`): ASML, SAP, Novo Nordisk (NVO), AstraZeneca (AZN), Shell (SHEL), TotalEnergies (TTE),
Unilever (UL), Sanofi (SNY) e gli ETF VGK (Europa), EZU (Eurozona), EWG (Germania), EWI (Italia). Fanno parte
dell'universo fisso con la stessa logica di tutti gli altri titoli, negli orari della borsa americana (15:30-22:00 in
Italia), settore «europa» con il tetto del 35%.

### Il motore punta all'intraday

Di serie (`AGENTS.puntaIntraday`) gli ingressi nuovi si decidono **solo sulle candele** (5 e 15 minuti, 1 e 4 ore; le
azioni 1 e 4 ore) con gli intraday agents e Kronos su quelle candele. I voti di più giorni (trend, trading agents,
Kronos a 5 sedute, rientro) restano come contesto ma da soli non aprono posizioni: l'allocatore entra solo con la parte
intraday, altrimenti il titolo resta in attesa.

Un trade si estende su più giorni solo per **riporto** (`AGENTS.intraday.riporto`): a fine giornata (chiusura della
borsa, 12 ore per le crypto) l'operazione si tiene se le proiezioni di Kronos sulla sua candela e su quelle superiori,
all'orizzonte più lungo, restano **dentro la forchetta del trade** (nessuna arriva allo stop) e la più lunga vede ancora
salire con probabilità ≥ 55%; niente riporto con una trimestrale il giorno dopo, al massimo 5 volte. Il giorno dopo
decidono di nuovo le candele: obiettivo e stop restano quelli del trade, l'orizzonte è quello della proiezione usata
per il riporto e la durata massima delle crypto riparte dal riporto. Le regole a sedute (uscita a tempo, rientro a 5
sedute, uscita di trend) non riguardano questi trade.

### Come si decide un ingresso intraday (riassunto)

- **Candele con un vantaggio misurato**: Kronos si usa solo sulle candele dove indovina la direzione più del caso
  (`intraday.vantaggio`: con almeno 300 previsioni verificate e affidabilità sotto 0,25 la candela non fa entrare; si
  continua a proiettarla poco, 6 coppie a giro, per misurarla, e torna utilizzabile appena il vantaggio compare).
- **Probabilità**: con le medie brevi in ordine (o rottura/rientro) quella della persona (55% di serie); senza, 57%
  (come la soglia generale). La probabilità con cui si decide è per l'**85% Kronos sulle candele** e per il **15% il
  dossier** del titolo (Kronos a 5 sedute, grafico giornaliero, notizie e post, contesto con Fear & Greed e funding)
  o, senza dossier, il contesto del settore (favorevole 60%, neutro 50%, sfavorevole 40%) (`intraday.evidenza`).
- **Costi**: le crypto si comprano con **ordini limite** appena sotto il prezzo (0,05%), che pagano la commissione
  maker (0,15%) invece della taker (0,25%); le vendite restano a mercato. Andata e ritorno 0,40%: il rialzo previsto
  deve essere almeno 0,8%. Un limite non eseguito in 10 minuti si cancella (`costi.ordiniLimite`).
- **Obiettivo** = il rialzo previsto da Kronos (mai sotto due volte i costi), e deve valere almeno 1,2 volte lo stop.
- **Rientri**: dopo un'operazione chiusa in guadagno si può rientrare sullo stesso titolo nello stesso giorno, al
  massimo 3 ingressi; dopo una chiusa in perdita no, fino al giorno dopo (`intraday.ingressiGiorno`).

### La scaletta delle medie (prudenza)

Si investe anche sotto le medie giornaliere, con taglie via via più piccole (la 200 conta più della 50;
`AGENTS.prudenzaMedie`, `livelloMedie` in `src/agents/fiducia.ts`):

| Prezzo | Più giorni | Intraday (candele 5 min - 4 ore) |
|---|---|---|
| sopra la 50 e la 200 | ×1 | ×1 |
| sotto la 50, sopra la 200 | ×0,75 (serve Kronos ≥ +1%) | ×0,85 |
| sopra la 50, sotto la 200 | ×0,5 (contro tendenza) | ×0,75 |
| sotto la 50 e la 200 | ×0,4 (contro tendenza) | ×0,65 |

Sotto la 50 (downtrend) si **preferisce il timeframe breve**: se sul titolo c'è anche un voto intraday che da solo
basta, si entra come trade intraday invece che di più giorni. Sotto la 200 resta il tetto del 5% del conto.

### Il rimbalzo di breve (media a 50 facoltativa)

La media a 50 giorni non è più un requisito assoluto. Se un titolo o una crypto è sotto la 50 (anche sotto la 200) e
ha avuto un **calo netto improvviso** (nell'ultimo giorno oltre il 3% per le azioni, il 5% per le crypto, o 1,5 volte la
sua volatilità giornaliera; negli ultimi 3 giorni oltre 1,5 volte quella soglia; o nelle ultime 8 ore dal massimo
sulle candele da 1 ora: `caloNetto` in `src/agents/fiducia.ts`), il rimbalzo
lo cercano gli **intraday agents**, e tutto si decide **sulle candele**, non a sedute o a giorni:

- Kronos proietta le candele da 5 e 15 minuti, 1 e 4 ore (le azioni 1 e 4 ore); si sceglie la candela e l'orizzonte
  con la probabilità più alta di un rialzo che copre due volte i costi;
- con le medie brevi della candela non ancora in ordine (normale dopo un calo) basta una probabilità **≥ 57%**
  (`AGENTS.rimbalzo.minFiducia`) invece del 65%; il grafico giornaliero sotto la sua media non dimezza la taglia (è la
  premessa), le medie brevi non in ordine sì;
- **obiettivo** il rialzo previsto da Kronos sull'orizzonte scelto, **stop** della candela, **scadenza** l'orizzonte di
  Kronos su quella candela; se le candele superiori vedono ancora un rialzo netto il trade prosegue con il loro
  obiettivo e il loro orizzonte (stesse regole di ogni operazione intraday, chiusura entro la giornata di borsa o le
  12 ore per le crypto).

Il calo dell'ultimo giorno resta nel diario (`misure.rimbalzo`) per giudicare questi ingressi.

### La gabbia

Il codice che dice l'ultima parola (`src/cage.ts`):

- titoli solo a **borsa aperta**, crypto sempre; niente short, niente leva; azioni intere, crypto frazionarie (minimo 10 $);
- massimo **10% per titolo** (meno se nervoso) e **35% per settore** (anche crypto e titoli scoperti);
- metodo: sopra la media a 200 e sopra la 50, **oppure** con un rialzo netto di Kronos (≥ +1%); sotto la 200 solo contro
  tendenza (Kronos ≥ +2% con probabilità ≥ 57%, metà taglia). L'intraday (compreso il rimbalzo di breve) ha le sue
  regole;
- niente acquisti di azioni ed ETF nel **giorno della Fed** (le crypto sì) e di un titolo nei **2 giorni di borsa prima
  della trimestrale** fino al giorno dei conti;
- registro degli errori, contanti sufficienti, un ordine aperto uguale non si duplica;
- **stop loss** e **uscita di trend** eseguiti dal codice, senza voto (non rimandati se una vendita è già in corso).

---

## 6. L'intraday: trade da pochi minuti a più giorni

Decide **Kronos sulle candele brevi**, non le medie giornaliere né il contesto macro.

### Ingresso (nell'analisi ogni 15 minuti)

Titoli e crypto usano le **stesse candele: 5 e 15 minuti, 1 ora, 4 ore**, ognuna solo se può completarsi nel tempo
rimasto (azioni fino a 30 minuti dalla chiusura vera; crypto entro la durata massima di 12 ore).

1. **Grafico della candela**: EMA 9 sopra EMA 20 e prezzo sopra la 9, oppure rottura dei massimi delle 20 candele o
   rientro sulla media a 20; mai oltre 3 ATR sopra (si insegue). Se il grafico non è ancora allineato **decide Kronos da
   solo**: serve una probabilità più alta (65%) e la taglia si dimezza (è un'inversione anticipata).
2. **Kronos, e quale time frame**: una proiezione per titolo e candela, letta a ogni orizzonte che sta nel tempo rimasto
   (da 15 minuti a 8 ore). Candele e orizzonti diversi si confrontano sulla stessa scala, la **probabilità di un
   guadagno netto dei costi**: Φ((rialzo previsto − costi) / (volatilità delle candele × √candele)), moltiplicata per
   l'**affidabilità misurata di Kronos su quella candela** (il cervello conta quante volte ha preso la direzione giusta;
   un campione piccolo resta vicino al valore atteso del 55%). Se su una candela Kronos indovina come una moneta, quella
   candela non fa più entrare e si sceglie un'altra. Esempio vero: sulle 5 minuti Kronos ha preso la direzione 27 volte
   su 100 (63 valutate) → affidabilità ×0, gli ingressi passano a 15 minuti e 1 ora. Il rialzo deve coprire **2 volte i
   costi** e la probabilità essere almeno 55% (65% se decide Kronos da solo). Fino a 40 coppie titolo-candela per analisi.
3. **Coerenza tra le candele**: le altre candele già proiettate, lette allo stesso orizzonte, non devono prevedere un
   calo; se sì, il segnale è rumore della candela e non si entra.
4. **Triple Screen (Elder): le candele superiori decidono la direzione.** Per un ingresso su 5 o 15 minuti si leggono
   Kronos su **1 ora e 4 ore** (su 1 ora: 4 ore), all'orizzonte più lungo nel tempo rimasto:
   - se prevedono un **calo oltre i costi**, il rialzo breve va controcorrente: **non si entra**;
   - se prevedono un **rialzo netto** probabile, il trade diventa **di trend**: obiettivo finale e orizzonte delle candele
     superiori, **stop della loro candela** (deciso adesso, mai allargato dopo) e taglia ridotta in proporzione allo stop,
     così il rischio in euro resta quello del trade breve;
   - altrimenti è un trade breve.
5. **Obiettivo = il rialzo che Kronos prevede** sull'orizzonte scelto, mai sotto il minimo dei costi (azioni 0,3%,
   crypto 1,2%). **Stop** = 1,2 ATR della candela (minimo 0,4% azioni, 1% crypto). Si entra solo se l'obiettivo vale
   almeno **1,2 volte lo stop**.
6. **Aspettativa positiva (Thorp)**: probabilità × guadagno netto − (1 − probabilità) × perdita allo stop (costi
   compresi) deve essere maggiore di zero.
7. **Taglia**: 10% del conto × fiducia (55% → metà, 70% → piena); il grafico della candela superiore sotto la sua media
   (se non è un trade di trend) e il Kronos a 5 sedute contrario la dimezzano ciascuno; uno stop più largo la riduce in
   proporzione; dopo **3 operazioni intraday in perdita di fila** nella giornata, ancora × 0,5. Il richiamo del capo
   (×0,6) e la prudenza della sala caffè (×0,85) riducono la **taglia**, non la forza del voto: l'ingresso resta deciso
   da Kronos.

Esempio: Kronos vede +1,5% in 15 minuti sulle candele da 5 minuti di BTC, con probabilità alta; su 1 ora e 4 ore niente
di contrario; stop 1% → si entra con obiettivo +1,5% e controllo sulle candele da 1 minuto. Se il prezzo arriva
all'obiettivo e Kronos non vede altro, si incassa: un trade di pochi minuti. Se invece su 1 ora Kronos vede +1,8% in 8
ore, lo stesso ingresso diventa un trade di trend con obiettivo +1,8% e stop della candela da 1 ora. (Verificato nel
motore vero, `tests/intraday-motore.test.ts`.)

### Mentre è aperta (a ogni giro, ogni 5 minuti)

La posizione si segue sulla **candela più breve** (5 min → 1 min, 15 min → 5 min, 1 ora → 15 min, 4 ore → 1 ora), con
Kronos sull'orizzonte d'ingresso, e sulle **candele superiori** (1 ora, 4 ore):

- **trade di trend** (le candele superiori restano a favore): valgono solo obiettivo, stop e fine giornata. Un calo
  previsto sulla candela da 1 minuto, l'orizzonte breve scaduto o la media breve persa **non lo chiudono**: sono le false
  perdite di pochi minuti dentro un movimento che continua sulle ore. Un trade nato breve diventa di trend se a metà
  strada le candele superiori iniziano a vedere il rialzo continuare (lo stop resta dov'è);
- se le candele superiori **girano al ribasso**, il trade torna alle regole brevi qui sotto;
- **pareggio**: arrivato al 60% della strada verso l'obiettivo (e almeno a 2 volte il margine dei costi), lo stop sale
  sopra il carico: un trade già in guadagno non chiude più in perdita;
- **all'obiettivo**: se Kronos vede ancora salire (candela breve ≥ 60% o candele superiori a favore) **si lascia correre**
  e lo stop sale sopra il carico; se no si incassa;
- Kronos vede un calo che azzererebbe il guadagno → **protezione del profitto**, si incassa;
- in perdita, Kronos vede un calo verso lo stop con rialzo al 35% o meno → **si taglia prima**;
- **orizzonte scaduto** (1,5 volte quello d'ingresso) senza obiettivo e senza rialzo probabile → si chiude;
- due candele chiuse sotto la media a 20 → il movimento è finito, ma **solo se il prezzo era stato sopra la media**: un
  ingresso deciso da Kronos sotto la media (ripartenza anticipata) non si chiude per la ragione per cui è entrato;
- stop; limite del giorno raggiunto → si incassa.

### A fine finestra: chiudere o continuare

Alla chiusura della borsa (azioni, 15 minuti prima) o dopo 12 ore (crypto), l'operazione si chiude **salvo che il trend
continui**: se è in guadagno e il metodo di più giorni la comprerebbe adesso (sopra la media a 200, sopra la 50 o Kronos
netto, Kronos a 5 sedute oltre 2 volte i costi con probabilità ≥ 55%, nessuna attesa del contesto né trimestrale nei
prossimi giorni) viene **promossa a posizione di più giorni** e da lì la seguono le regole del capitolo 7.

Un'operazione intraday ha solo le sue uscite: la proiezione a 5 sedute, la presa di profitto e l'uscita di trend
giornaliera non la toccano (resta lo stop di emergenza). Un ingresso per titolo al giorno, contato a ordine eseguito.

---

## 7. Uscire da una posizione di più giorni

Regole vincolanti dell'agente **uscite**, in quest'ordine:

1. **Stop sulla volatilità**: 2,5 × volatilità giornaliera × √5, tra il 5% e il 10% dal carico; c'è anche uno **stop
   GTC su Alpaca** che vale a motore spento (crypto: `stop_limit`).
2. **Trimestrale in arrivo**: nell'ultima seduta utile (stesso giorno se i conti escono dopo la chiusura, il giorno prima
   se prima dell'apertura o orario ignoto), negli ultimi 90 minuti. Salto atteso = 3 × volatilità (almeno 3%):

   | Posizione | Decisione |
   |---|---|
   | guadagno oltre il salto atteso | vende **metà**: il cuscinetto copre un salto contrario |
   | guadagno più piccolo | **metà** se Kronos vede rialzo con probabilità ≥ 60%, altrimenti **tutto** |
   | perdita | **tutto**; solo una perdita piccola con Kronos favorevole: **metà** |

   Kronos non conosce i conti, quindi sceglie solo tra metà e tutto. Se il motore era spento, decide appena la borsa apre.
3. **Protezione del profitto**: in guadagno oltre i costi (0,2% azioni, 0,6% crypto) e Kronos vede nelle prossime 2
   sedute un calo che lo azzererebbe → si incassa adesso.
4. **Proiezione netta al ribasso** (−1% o meno a 5 sedute, dal prezzo di adesso) → si esce.

Poi, non vincolanti o della gabbia: **presa di profitto** a +3% (metà, salvo Kronos ancora al rialzo), **uscita di
trend** (chiusura sotto la media a 50, salvo Kronos ancora al rialzo), **custodi** e **trend** (sotto la 50), **orizzonte**
(60 sedute e slancio finito), **rientro** (RSI 70 o 5 sedute). Un titolo comprato oggi non si vende per un voto
d'opinione prima di una candela giornaliera nuova: escono solo stop e regole vincolanti.

---

## 8. Limiti del giorno e sicurezze

- **Obiettivo del giorno con difesa del guadagno**: toccato il +10% del patrimonio rispetto alla chiusura di ieri, gli
  agenti **continuano a investire** (un giorno buono non si ferma). Se poi il guadagno del giorno torna al **+5%**, scatta
  la difesa: si vendono i trade **non favorevoli** (posizioni di più giorni con Kronos a 5 sedute sotto +1%; intraday
  quando né la candela breve né quelle superiori vedono ancora salire); quelli favorevoli restano. Il massimo del giorno
  è salvato in `state/giornata.json`, quindi vale anche dopo un riavvio. Nessun limite alla perdita del giorno:
  proteggono stop e uscite.
- **Interruttore** (−5% dal massimo): spento di serie, attivabile dalle impostazioni come freno d'emergenza.
- **Niente medie al ribasso (Livermore)**: nessuna aggiunta a una posizione in perdita.
- **Prezzi degli ordini con i decimali giusti**: azioni 2 (4 sotto il dollaro), crypto 4 cifre significative fino a 9
  decimali (lo stop di PEPE a 0,0000045 non diventa più 0).
- **Ordini**: un ID per giro (un nuovo tentativo non si duplica; Alpaca rifiuta l'ID già usato), verifica dopo un timeout,
  stop tolto prima di una vendita, quantità crypto troncate al milionesimo, briciole senza stop.
- **Esecuzioni nel diario a inizio giro**: un acquisto eseguito tra un giro e l'altro entra nel diario prima che agenti e
  gabbia decidano, così è subito «aperto oggi» e, se intraday, segue solo le sue regole. Prima entrava a fine giro e le
  regole di più giorni (uscita di trend, proiezione a 5 sedute) lo vendevano dopo 5 minuti.
- **Un solo processo** sullo stato (`state/run.lock`). Dopo un riavvio il motore riparte da `state/`.

---

## 9. Cosa impara il motore

- **Capo ufficio** e **sala caffè** (capitolo 4), dal diario dei trade, da subito e con limiti.
- **Gli agenti come persone** (`src/agents/persone.ts`): ogni agente ha un nome. Fissi per gli agenti generali (Roberto
  capo ufficio, Marco trend, Giulia rientro, Paolo regime, Sara orizzonte, Luca uscite, Davide presa di profitto, Elena
  contesto, Chiara Kronos, Andrea capo degli intraday agents). Le altre persone sono uno **staff unico**
  (`state/persone.json`, un team fisso di 20: nessuno esce, chi non lavora è in sala caffè, in pausa o in formazione): nessuna appartiene a un titolo né a un tipo di
  operazione. Il motore trova le occasioni con i suoi criteri e a ogni giro le assegna: un'occasione è una posizione
  aperta, un titolo pronto a entrare (dossier ≥ 57%) o un voto d'acquisto, di più giorni o intraday. Chi lavora su un
  titolo ci resta finché l'occasione dura; le nuove vanno alla persona libera più brava in quel tipo di operazione
  ((vinti + 1) / (trade + 2) sui suoi trade di quel tipo, se ne ha, altrimenti su tutti), a parità a chi aspetta da più
  tempo, e a chi ha trovato il titolo con l'esplorazione. Chi non ha un'occasione aspetta in sala caffè. Ogni trade salva
  nel diario le persone che l'hanno preso (`contesto.persone`). Le zone dell'ufficio (Trading agents, Intraday agents)
  sono i due tipi di operazione, non due squadre: un titolo, una persona, una posizione (se più giorni e intraday lo
  vogliono entrambi lo tiene chi ci lavora già o ha la posizione, altrimenti l'operazione di più giorni). Alla scrivania
  solo chi è pronto a entrare o segue una posizione: un titolo «in attesa», un acquisto fermato dalla gabbia o
  un'azione fuori orario rimandano la persona in sala caffè. Il capo ufficio resta fuori dallo staff, col suo compito.
- **Profili personali** (`src/agents/profili.ts`, `state/profili.json`): ogni persona ha impostazioni sue, per entrambi
  i tipi d'operazione, che valgono sul titolo su cui lavora. Più giorni: medie e momentum del trend, RSI, sedute e peso
  del rientro, soglia, media del rientro ed estensione del dossier. Intraday: probabilità minima e peso. La
  calibrazione del capo è separata per tipo (p:Nome sui trade di più giorni, p:Nome|intraday su quelli intraday); in
  sala caffè si ricalibra il tipo in cui la persona ha perso. Più l'**obiettivo del giorno**
  personale (di serie 10%, +1 punto dopo un giorno in cui lo tocca, −1 dopo un giorno chiuso in perdita, tra 3% e 25%):
  guadagno dei suoi trade di oggi sul capitale che ci ha messo; toccato, continua; se torna a metà, si vendono i suoi
  trade non favorevoli (Kronos sotto la soglia di anticipo). L'obiettivo del conto non c'è più nelle Generali. Le
  impostazioni si cambiano nella scheda della persona; il capo calibra la sua soglia d'ingresso; la sala caffè la
  ricalibra (sotto). Kronos è uguale per tutti.
- **Capo ufficio per persona** (`src/agents/capo.ts`): giudica ogni persona sui trade che ha preso e sulle sue sessioni
  (giorni chiusi in guadagno o in perdita), e gli agenti generali sui trade che hanno votato; i richiami valgono per la
  persona che prende il voto, ovunque lavori.
- **Calibrazione del capo** (`src/agents/calibrazione.ts`): quando un agente vince meno del 51% dei suoi trade chiusi
  (almeno 5, contati dall'ultima correzione) il capo rende più selettivo di un passo il suo parametro d'ingresso; quando
  torna sopra il 60% lo riavvicina di un passo al valore di base. Parametri: probabilità minima intraday (+2,5 punti a
  passo, fino al 70%), probabilità minima del dossier dei trading agents (squadra +5 punti fino al 65%, e una soglia
  personale per ognuno fino al 70%), fiducia minima di Kronos contro tendenza (+5 punti fino all'80%), RSI d'ingresso del
  rientro (−1 fino a 4). Al massimo 4 passi; mai sotto il valore di base della scheda, mai fuori dai limiti della scheda
  né dai principi del motore. Stato in `state/calibrazione.json`.
- **Formazione in sala caffè** (`src/agents/formazione.ts`): una persona che, sui trade chiusi dal suo ultimo rientro
  (almeno 5), vince meno del 51% e chiude in perdita va in sala caffè per 24 ore. Non apre nuovi trade (vendite, stop e
  regole d'uscita restano) e ascolta chi lavora bene (almeno 51% di vinti e risultato positivo, almeno 3 trade). Torna
  col bagaglio: proiezione minima di Kronos da cui partivano i trade vinti dei colleghi (tra la soglia di anticipo e il
  5%), sotto la quale i suoi voti d'acquisto non valgono; tipo d'ingresso migliore; per l'intraday le candele su cui
  vincono (fuori da quelle, taglia ×0,7). Prima della fine dei 24 h si rientra solo con un'occasione: se il capo la
  giudica valida col bagaglio (Kronos sopra la soglia imparata, o una candela su cui i colleghi vincono), oppure se alla
  scrivania servono persone (almeno 10 trading agents con gli agenti generali, almeno 1 operatore intraday quando c'è un'occasione; la sala intraday può restare vuota se non c'è niente da fare): allora
  rientra per primo chi è in sala caffè da più tempo, con forza ×0,8 o taglia ×0,7 se l'occasione non passa il bagaglio.
  Entrando in sala caffè la persona **ricalibra le sue impostazioni**: se i colleghi bravi del suo reparto le hanno
  diverse, va a metà strada verso la loro media; se sono tutte uguali (primi giri), si ricalibra sui dati (contesto di
  mercato, quanto erano estesi i suoi trade persi, che tipo d'ingresso perdeva) verso ingressi più selettivi e taglie più
  piccole, sempre dentro i limiti della scheda.
  Stato in `state/formazione.json`.
- **Sicurezza dell'apprendimento** (`src/agents/apprendimento.ts`): nessun acquisto senza una persona alla scrivania
  (con lo staff attivo); si vota e si entra solo da «pronto» (dossier e evidenza ≥ 57%, contro tendenza 65%). Un
  coordinatore unico giudica chi impara: ultimi 30 trade, almeno 20 per una persona e 10 per una squadra, vittorie della
  persona avvicinate a quelle della squadra ((vinti + 10 × squadra) / (trade + 10)), giudizio prima sul guadagno medio a
  trade e sul profit factor e poi sul vincolo del 51%; si stringe con guadagno medio negativo o vittorie sotto il 51%, si
  allenta con guadagno medio positivo e vittorie ≥ 55%; passi di squadra più persona ≤ 4. Il richiamo del capo agisce
  solo sugli agenti generali; per le persone agiscono calibrazione e formazione. Assegnazione con Thompson sampling
  (estrazione da Beta(vinti + 1, persi + 1)); un'occasione data a chi ha meno dati ha taglia ×0,75. Le impostazioni
  personali riguardano solo selettività e taglia (le regole del mercato sono del motore); quelle ricalibrate in sala
  caffè passano da una **prova in ombra** (`valutaProve`): sui trade chiusi dopo la proposta, con le misure salvate
  all'ingresso (`contesto.misure`, `contesto.impostazioni`), si confronta il risultato con le soglie nuove e con quelle
  in uso; dopo 15 trade si adottano se almeno pari, entro 30 giorni o si scartano. I mentori sono scelti sullo stesso tipo
  di titolo (crypto o azioni) e, se ci sono abbastanza trade, sullo stesso clima di mercato.
- **Statistica verificata** (`src/agents/statistica.ts`): calibrazione isotonica delle probabilità di riuscita (≥ 50
  trade per tipo) e meta-modello logistico sulle misure d'ingresso (≥ 100 trade; sotto il 45% non si entra), attivi solo
  se migliorano il Brier score sul 30% di trade più recenti (non usati per imparare). Kelly frazionario (¼): con
  aspettativa stimata negativa il trade non si fa; il peso è al più quota di rischio / distanza dello stop.
- **Più giorni**: profitto minimo (arrivato a +2%, crypto +4%, non si torna sotto +0,4%, crypto +1,2%) e uscita a
  tempo (dopo 5 sedute, crypto 5 giorni, se non rende il minimo e Kronos non vede più rialzo). La giornata personale
  parte dall'ultima chiusura giornaliera per i trade aperti prima di oggi. Intraday sulle azioni solo su 1 e 4 ore.
- **Capitale sui vincenti**: oltre alla percentuale di trade vinti (obiettivo 51%) il diario misura la parte del capitale
  investito finita nei trade in guadagno: sopra il 50% si è investito di più dove si è vinto. La dimensione di ogni
  ingresso cresce già con la probabilità (fiducia di Kronos per i trading agents, probabilità netta per l'intraday).
- **Vittorie per candela** (obiettivo: almeno il 51% di trade chiusi in guadagno): sugli ultimi 20 trade intraday chiusi
  di ogni candela (almeno 8), se si vince meno del 51% per entrare su quella candela servono 5 punti di probabilità in
  più (10 sotto il 40%). Gli ingressi non si fermano: si spostano sulle candele dove si vince.
- **Cervello delle previsioni**: quanto vale ogni modello, per il giornaliero e per ogni candela.
- **Memoria per titolo** dei custodi.
- **Registro degli errori**: solo sicurezza (dopo uno stop, dopo due rifiuti di Alpaca).
- **Biblioteca degli agenti** (`src/agents/biblioteca.ts`): i principi dei libri di trading più noti tradotti in regole
  che tutti gli agenti condividono, perché passano dagli stessi controlli. Elder (Triple Screen, regola del 2%),
  Lefèvre/Livermore (taglia le perdite, lascia correre, mai medie al ribasso), Thorp (aspettativa positiva), Tharp
  (rischio costante per operazione), Douglas e Kahneman (probabilità, niente rincorsa dopo le perdite), Murphy (trend,
  medie, più time frame), Covel/Faith (trend following con stop ATR), O'Neil (titoli forti, perdite tagliate), Schwager
  (gestione del rischio), Taleb (diffidare delle previsioni estreme), Lo (mercati adattivi: pesare ciò che funziona),
  Malkiel (costi e rumore). Graham (margine di sicurezza sui bilanci) non si applica a orizzonti da minuti a giorni. Gli
  agenti non «leggono» i libri: ogni principio è un controllo del codice.
- **Kronos e i prezzi minuscoli**: Kronos normalizza ogni serie con (x − media) / (dev. std + 1e-5); su PEPE (0,000005 $)
  la deviazione standard è 1e-7 e la serie diventava piatta, con proiezioni fuori misura. Le serie sotto 1 $ ora arrivano
  al modello scalate (ultima chiusura = 100): i rendimenti non cambiano.

---

## 10. Dove vedere tutto

Dashboard su `http://127.0.0.1:8787` (anche da telefono e, in sola lettura, sulla pagina pubblica di GitHub Pages).
Menu a sinistra (sul telefono si apre con ☰):

- **Dashboard**: frase di stato; capitale (patrimonio totale, investito, liquidità, risultato sulle posizioni aperte,
  oggi, rischio, confronto con SPY); **rendimento per periodo** (oggi, 7 e 30 giorni, mese, anno, tutto o date a
  scelta: variazione del patrimonio dallo storico di Alpaca, realizzato, operazioni chiuse e vinte, migliore e
  peggiore, ribasso massimo, grafico del patrimonio, giorno per giorno); profitto e perdita di oggi, situazione in breve;
- **Ufficio**: la mappa 3D con gli agenti e a destra il loro elenco col nome di ognuno (passando sopra un nome l'avatar
  si alza e si illumina; clic per la scheda della persona: chi è, cosa fa, la calibrazione del capo e **le sue
  impostazioni**, modificabili lì; sugli schermi grandi la scheda si apre su due colonne). Gli agenti generali hanno una
  scrivania solo se sono effettivi, cioè hanno votato l'ingresso di almeno un trade; gli altri lavorano come strumenti
  comuni e le loro regole stanno in Impostazioni → Generali. La **lavagna dei risultati** si apre in un dialogo (clic
  sulla lavagna): per agente e per giorno trade vinti e persi, percentuale, capitale sui vincenti,
  risultato. Sotto, a schede: Trading agents (nome dell'agente e titolo seguito), Decisioni, Esplorazione, Sala caffè;
- Ovunque compare un codice si vede anche il **nome del titolo o della crypto** (Apple Inc., Bitcoin), chiesto ad
  Alpaca una volta per simbolo e tenuto in `state/nomi-titoli.json`;
- **Investimenti**: card dei titoli in portafoglio e in osservazione; clic per il **grafico** (TradingView Lightweight
  Charts, Apache 2.0, incluso nel repository) con time frame 1m, 5m, 15m, 1h, 4h, 1G, medie, volumi, carico, stop,
  obiettivo, operazioni e la **proiezione dei modelli con il cono** al 50% e all'80%; le candele da 1 e 5 minuti si
  aggiornano ogni 15 secondi; poi operazioni intraday, simulazioni e tabella delle posizioni;
- **Log operazioni**: acquisti e vendite eseguiti negli ultimi 7 giorni, con ricerca e filtri, risultato di ogni vendita;
- **Impostazioni**: Generali (regole del motore e della gabbia, conto Alpaca, pagina pubblica su GitHub Pages, e le
  regole degli agenti generali senza scrivania), chiavi, riavvio;
- **Guida**.

Telegram riceve ordini, allarmi e il riepilogo serale.

---

## Perché così

- **Kronos guida, il resto protegge.** Kronos anticipa la direzione ed è il miglior modello pubblico sui rendimenti, ma
  resta rumoroso: per questo serve probabilità, copertura dei costi, gabbia e uscite scritte nel codice.
- **Ogni decisione al momento giusto.** Dati di giornate concluse, previsioni riportate al prezzo di adesso, analisi
  d'ingresso con il tempo per molti campioni, controllo delle posizioni ogni 5 minuti.
- **Il capitale va alle occasioni migliori**, senza numeri fissi di titoli o agenti, con tetti per titolo e per settore.
- **Nessun backtest promette il futuro**: i valori di base vengono da backtest 2021–2026 sul motore di allora; oggi la
  misura è il diario dei trade veri e il confronto di ogni previsione con il prezzo reale.
