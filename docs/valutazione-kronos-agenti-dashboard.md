# Valutazione: Kronos, trading multi-agente rapido, piattaforma di monitoraggio 3D

Data: 8 novembre 2026. Branch: `ccr-f218832d-solbom`. Tutto quanto segue è misurato su dati reali
(conto paper, branch `stato`, barre Alpaca IEX) o provato in questa sessione; dove è un'opinione lo dico.

## Sintesi

1. **Il problema attuale non è "cosa comprare" ma "quanto tempo si sta fuori dal mercato".** In 550 sedute storiche la
   gabbia rende +4,3% contro +35,2% di SPY, e 1674 acquisti su 1765 rifiuti sono stati bloccati dall'interruttore
   (-5% dal massimo, che nel backtest non viene mai riarmato). Con riarmo automatico dopo 5 sedute il rendimento sale a
   +17,7%. Due settimane di paper (3 trade, tutti in perdita, -2,4% contro -3,0% di SPY) non bastano a giudicare, ma il
   backtest sì: la strategia è troppo prudente per un mercato che sale, e nei ribassi perde comunque (stop su AAPL -5,3%).
2. **Kronos si integra senza difficoltà tecniche** (MIT, 4-100 M parametri, gira su CPU in 0,6-2 s a previsione, sidecar
   Python chiamato da Bun). **Ma zero-shot, sul nostro universo, non prevede la direzione meglio del caso**: accuratezza
   di direzione 41-56% (una costante fa 50-67%), errore medio sempre peggiore di "il prezzo non cambia", correlazione di
   rango debole e positiva solo sulle barre giornaliere (fino a +0,17 su SPY con il modello small), nulla o negativa a
   5 minuti e sul Bitcoin orario. Va usato come *una* caratteristica in più (distribuzione dei campioni, intervallo di
   prezzo, volatilità attesa), mai come oracolo, e va rifinito (fine-tuning) sui nostri simboli e frequenze prima di
   pesarlo nelle decisioni. Per il trading rapido intraday, oggi, non porta niente.
3. **Un motore multi-agente a media frequenza è fattibile con Alpaca** (dati IEX in tempo reale, 1000 richieste al
   minuto sul paper, websocket fino a 30 simboli gratis, crypto 24 ore su 24, frazionarie). **Non può essere `claude -p`
   a decidere al minuto**: 20 secondi e un costo per chiamata. Gli agenti rapidi devono essere codice (regole + modelli
   leggeri come Kronos) in un processo sempre acceso; il modello linguistico resta supervisore a bassa frequenza.
   L'architettura a sveglie cloud 4 volte al giorno non regge il tempo reale: serve una macchina accesa.
4. **La piattaforma di monitoraggio 3D è fattibile e a basso rischio**: server Bun che pubblica un registro eventi
   (decisioni, segnali, ordini, P&L) via WebSocket, pagina Three.js per la vista d'insieme e pannelli 2D per i dettagli.
   Si può fare subito anche sul sistema attuale, leggendo il branch `stato`.

Raccomandazione: una **fase 0 di un giorno** (riarmo dell'interruttore e regola di regime, con backtest), poi **registro
eventi + dashboard**, poi **Kronos come sidecar e backtest intraday con i costi**, e solo dopo il motore multi-agente in
paper **affiancato** a quello attuale per 4-6 settimane. Dettagli e piano in fondo.

---

## 1. Dove siamo: i numeri

### Conto paper (branch `stato`, testimone del 6/11 ore 21:40)

| Voce | Valore |
|---|---|
| Patrimonio | 97.620 $ (partenza 100.000 $ il 25/10) |
| Rendimento dal 25/10 | -2,38% · SPY -3,01% · 60/40 SPY/TLT -1,49% |
| Posizioni | AAPL 40 (-2,7%), MSFT 28 (-3,5%), contanti 69% |
| Trade chiusi | 3, tutti in perdita: AAPL -5,28% (stop), MSFT -2,18% (uscita di trend), SPY -1,31% (scelta del modello) |
| Diario | "solo raccolta dati" fino al 24/01/2027: le statistiche non influenzano ancora nulla |

### Backtest della gabbia su 550 sedute (dati Alpaca, `bun run backtest --days 750`)

| Variante | Rendimento | SPY | 60/40 | Perdita massima | Note |
|---|---|---|---|---|---|
| Come oggi (interruttore mai riarmato) | **+4,33%** | +35,18% | +18,22% | -5,41% | 44 ordini, 20 uscite di trend, 0 stop; **1674 rifiuti "interruttore scattato"** |
| Riarmo automatico dopo 5 sedute | **+17,65%** | +35,18% | +18,22% | -8,72% | stesso metodo, il conto resta investito |

Limiti del backtest (già scritti nel codice): esecuzione alla chiusura, stop controllato una volta al giorno, niente
costi né slippage, calendario eventi assente. Sono limiti che lo rendono *ottimista*, quindi i numeri veri sarebbero peggiori.

### Diagnosi

- **L'interruttore è il freno principale.** Una perdita del 5% dal massimo è fisiologica anche per SPY (succede quasi
  ogni anno) e il blocco resta finché qualcuno lancia `breaker-reset` a mano. Nel conto reale non è ancora scattato,
  ma il backtest mostra cosa farà.
- **Pochi ingressi, un solo momento al giorno, filtri severi** (sopra 50 e 200 giorni, prezzo sopra la 50 in giornata,
  gruppo tecnologia al 35%, 0,25% di rischio giornaliero per posizione). Il risultato è un conto per metà o più in
  contanti: il confronto giusto è il 60/40 e anche quello lo batte solo con il riarmo.
- **Le tre perdite di ottobre-novembre** sono coerenti con il metodo: ingressi su massimi (AAPL +4,9% sopra la media)
  seguiti da una correzione di mercato (SPY -3%). Il trend following lento perde così per costruzione; guadagna solo se
  poi i trend durano mesi. Non è un errore del modello linguistico: ha fatto quello che il prompt chiede.
- **Due settimane non misurano nulla.** Con 3 trade non si distingue fortuna da metodo; il diario lo sa e aspetta 30.
  Qualunque cambiamento va giudicato con backtest e con settimane di paper, non con il saldo di oggi.

---

## 2. Kronos

### Cos'è

[Kronos](https://github.com/shiyu-coder/Kronos) ("A Foundation Model for the Language of Financial Markets",
[arXiv 2508.02739](https://arxiv.org/abs/2508.02739), accettato ad AAAI 2026, licenza MIT) è un modello generativo
decoder-only per candele OHLCV: un tokenizer trasforma open/high/low/close/volume/amount in token discreti e un
transformer li prevede in autoregressione, pre-addestrato su dati di oltre 45 borse. Si chiede "le prossime N candele"
e si ottengono candele campionate (temperatura `T`, nucleus `top_p`, `sample_count` campioni mediati).

| Modello | Tokenizer | Contesto | Parametri | Pubblico |
|---|---|---|---|---|
| Kronos-mini | Kronos-Tokenizer-2k | 2048 | 4,1 M | sì |
| Kronos-small | Kronos-Tokenizer-base | 512 | 24,7 M | sì |
| Kronos-base | Kronos-Tokenizer-base | 512 | 102,3 M | sì |
| Kronos-large | Kronos-Tokenizer-base | 512 | 499 M | **no** |

Pesi su Hugging Face (`NeoQuasar/*`, ultimo aggiornamento settembre 2025, ~516.000 download del mini), repo aggiornato
ad aprile 2026, pipeline di fine-tuning inclusa (Qlib, azioni cinesi, dati giornalieri, serve GPU), webui Flask di prova.
Il README stesso avverte: "simplified example and not a production-ready quantitative trading system", costi e slippage
non modellati.

### Prova fatta in questa sessione

Ambiente: CPU 4 core, nessuna GPU, torch 2.15, pesi scaricati da Hugging Face (ho aggiunto `huggingface.co` e i suoi
CDN agli host dell'ambiente cloud). Dati: barre Alpaca IEX (giornaliere dal 2020, 5 minuti da luglio 2026, crypto 1 ora
dal 2025). Script in `tools/kronos/` (`fetch_alpaca.py`, `eval_kronos.py`). Protocollo: previsione *rolling* sulle
ultime 150 finestre, 400 barre di storia, 3 campioni, `T=1`, `top_p=0.9`; per ogni orizzonte confronto il rendimento
previsto con quello reale.

Metriche: **direzione** = quota di previsioni con il segno giusto, da confrontare con la **costante migliore** (dire
sempre "sale" o sempre "scende"); **IC** = correlazione di rango tra rendimento previsto e reale (0 = nessuna relazione;
con 150 osservazioni l'errore standard è circa ±0,08); **MAE prev / MAE zero** = errore medio assoluto della previsione
contro quello di "il prezzo non cambia"; **segui il segno** = rendimento medio per barra di chi comprasse quando il
modello prevede rialzo e vendesse allo scoperto quando prevede ribasso (senza costi).

| Serie | Modello | s/prev. | Orizzonte | Direzione | Costante migliore | IC | MAE prev / MAE zero | Segui il segno (per barra) |
|---|---|---|---|---|---|---|---|---|
| SPY giornaliera | mini | 0.58 | 1 barre | 51% | 53% | +0.07 | 0.82% / 0.62% | +0.040% |
| SPY giornaliera | mini | 0.58 | 3 barre | 47% | 61% | +0.09 | 1.26% / 1.06% | +0.058% |
| SPY giornaliera | mini | 0.58 | 5 barre | 54% | 57% | +0.10 | 1.65% / 1.44% | +0.074% |
| SPY giornaliera | small | 2.86 | 1 barre | 55% | 53% | +0.17 | 0.71% / 0.62% | +0.019% |
| SPY giornaliera | small | 2.86 | 3 barre | 53% | 61% | +0.14 | 1.26% / 1.06% | +0.166% |
| SPY giornaliera | small | 2.86 | 5 barre | 54% | 57% | +0.14 | 1.72% / 1.44% | +0.369% |
| QQQ giornaliera | mini | 0.61 | 1 barre | 56% | 55% | +0.11 | 1.24% / 1.07% | +0.141% |
| QQQ giornaliera | mini | 0.61 | 3 barre | 47% | 58% | -0.14 | 2.27% / 1.90% | -0.233% |
| QQQ giornaliera | mini | 0.61 | 5 barre | 53% | 55% | -0.03 | 3.02% / 2.64% | +0.068% |
| NVDA giornaliera | mini | 0.6 | 1 barre | 51% | 51% | +0.15 | 2.14% / 1.89% | +0.302% |
| NVDA giornaliera | mini | 0.6 | 3 barre | 55% | 50% | +0.16 | 3.54% / 3.46% | +0.306% |
| NVDA giornaliera | mini | 0.6 | 5 barre | 51% | 55% | +0.09 | 4.71% / 4.39% | +0.596% |
| AAPL giornaliera | small | 2.88 | 1 barre | 48% | 56% | +0.06 | 1.52% / 1.21% | +0.021% |
| AAPL giornaliera | small | 2.88 | 3 barre | 45% | 66% | +0.01 | 2.56% / 2.17% | -0.220% |
| AAPL giornaliera | small | 2.88 | 5 barre | 46% | 67% | -0.00 | 3.34% / 2.85% | -0.242% |
| SPY 5 minuti | mini | 1.29 | 1 barre | 46% | 56% | -0.13 | 0.09% / 0.06% | -0.006% |
| SPY 5 minuti | mini | 1.29 | 7 barre | 45% | 56% | -0.07 | 0.24% / 0.18% | -0.030% |
| SPY 5 minuti | mini | 1.29 | 12 barre | 48% | 59% | +0.00 | 0.31% / 0.26% | -0.032% |
| NVDA 5 minuti | small | 6.54 | 1 barre | 45% | 59% | -0.16 | 0.24% / 0.16% | -0.014% |
| NVDA 5 minuti | small | 6.54 | 7 barre | 41% | 61% | -0.13 | 0.78% / 0.51% | -0.035% |
| NVDA 5 minuti | small | 6.54 | 12 barre | 55% | 57% | +0.08 | 1.11% / 0.72% | +0.082% |
| BTCUSD 1 ora | mini | 0.69 | 1 barre | 54% | 53% | +0.04 | 0.28% / 0.23% | +0.024% |
| BTCUSD 1 ora | mini | 0.69 | 4 barre | 51% | 55% | -0.08 | 0.61% / 0.51% | +0.005% |
| BTCUSD 1 ora | mini | 0.69 | 6 barre | 53% | 53% | -0.03 | 0.72% / 0.63% | -0.021% |
| BTCUSD 1 ora | small | 3.28 | 1 barre | 47% | 53% | -0.06 | 0.29% / 0.23% | -0.019% |
| BTCUSD 1 ora | small | 3.28 | 4 barre | 47% | 55% | +0.03 | 0.69% / 0.51% | -0.077% |
| BTCUSD 1 ora | small | 3.28 | 6 barre | 49% | 53% | +0.10 | 0.94% / 0.63% | -0.028% |

### Lettura dei risultati

- **Zero-shot non batte il caso sulla direzione**: 41-56% contro una costante che fa altrettanto o meglio (su AAPL
  "sempre sale" fa 67%, Kronos 46%). L'errore medio è *peggiore* di "non cambia nulla" in tutte le 27 righe, come ci si
  aspetta da candele campionate con `T=1` (il campionamento aggiunge rumore; con più campioni o `T` più bassa ci si
  avvicina alla mediana ma non si guadagna direzione).
- **Sulle barre giornaliere c'è un filo di informazione nell'ordinamento** (IC +0,07…+0,17 su SPY, NVDA, QQQ a 1 barra;
  SPY small a 5 barre: "segui il segno" +0,37% per finestra), dello stesso ordine di grandezza dei fattori classici e
  dentro l'errore statistico di 150 osservazioni (±0,08): utile al più come **caratteristica** dentro un modello più
  ampio, non come segnale da solo. Su AAPL è zero.
- **Intraday e crypto zero-shot non funzionano**: a 5 minuti su SPY e NVDA la direzione è 41-48% con IC negativo
  (-0,13/-0,16 a 1 barra), sul Bitcoin orario IC attorno a zero e "segui il segno" negativo. Proprio il terreno del
  trading rapido è quello dove oggi Kronos aiuta meno, almeno sui volumi IEX e senza fine-tuning.
- **Il modello è addestrato soprattutto su mercati asiatici e su volume consolidato**: i nostri volumi IEX sono il 2-3% del
  totale USA. Il tokenizer usa volume e amount, quindi il fine-tuning sui nostri dati (o il passaggio ai dati SIP a
  pagamento) è il primo passo per dargli una chance vera.
- **Costi di calcolo**: 0,6 s (mini) e 2,9 s (small) per previsione giornaliera, 1,3 s e 6,5 s a 5 minuti (orizzonte 12 barre), su CPU a thread singolo con 3 campioni. Per 8-30 simboli a 5
  minuti basta un processo Python su una macchina normale; per 1 minuto su 30 simboli serve `predict_batch` o una GPU.

### Come lo integrerei

```
Bun (agente) ──HTTP locale──▶ sidecar Python (FastAPI) ──▶ Kronos (torch, CPU/GPU)
                      ◀── JSON: per simbolo e orizzonte: mediana, quantili 10/90, prob. rialzo, volatilità attesa
```

- Interfaccia TypeScript `Forecaster` accanto a `Brain` e `Broker`, con versione finta per i test (come già per broker e
  cervello). Timeout e fallback: se il sidecar non risponde si decide senza di lui.
- Le uscite di Kronos entrano negli `indicatori` che già arrivano al cervello e alla gabbia: `probRialzo5g`,
  `intervallo10_90`, `volAttesa`. Nella gabbia può modulare la **taglia** (volatilità attesa) e vietare ingressi contro
  una distribuzione molto sbilanciata; non deve comprare da solo finché il diario non mostra che il suo segnale paga.
- Fine-tuning: pipeline del repo (`finetune/`), dati giornalieri e a 5 minuti dei nostri simboli, validazione *walk-forward*
  (addestra fino a una data, misura dopo), mai sulle stesse barre su cui poi si misura. Serve una GPU anche piccola
  (Colab/cloud a ore); l'inferenza resta su CPU.
- Hugging Face e i CDN devono essere raggiungibili dove gira il sidecar (già aggiunti all'ambiente cloud).

**Verdetto**: fattibile e poco costoso da integrare; **oggi non migliora l'analisi predittiva da solo**. Vale come
secondo passo, dopo aver messo in piedi la misurazione (registro eventi, backtest con costi) che dice se paga.

---

## 3. Un modello di trading più rapido, con più agenti

### Cosa chiede la richiesta e cosa dicono i vincoli

Richiesta: acquisti e vendite continui, più agenti che osservano il mercato e decidono all'istante.

| Vincolo | Misurato / verificato | Conseguenza |
|---|---|---|
| `claude -p` | ~20 s a risposta, 3 risposte per voto, costo per chiamata | non può decidere al minuto; resta supervisore (ogni ora o a eventi) |
| Alpaca paper REST | `X-Ratelimit-Limit: 1000` al minuto | ampio margine per 10-30 simboli |
| Alpaca dati gratis | IEX in tempo reale, websocket 30 simboli, storico 1 min completo (390 barre/seduta su SPY), ultimi 15 min di storico non interrogabili ma `latest` sì | sufficiente per 5-15 min; fragile per 1 min su titoli poco scambiati su IEX |
| Crypto | `crypto_status: ACTIVE`, barre e ordini 24/7, BTC/ETH | mercato "continuo" ideale per provare un motore sempre acceso |
| Frazionarie | `fractionable: true` | taglie più fini, non più "solo azioni intere" |
| Esecuzione paper | eseguita al prezzo corrente, senza code né slippage | il paper **sovrastima** una strategia rapida: vanno aggiunti costi nel backtest |
| Dove gira | oggi sveglie cloud 4/giorno, stato su git | serve un processo sempre acceso (VPS, Raspberry, PC acceso, o una sessione cloud lunga con cron di riavvio) |

Avvertenza onesta: **più operazioni = più costi e più rumore**. Spread e slippage di 2-5 punti base per lato su 20
operazioni al giorno fanno 1-2% al mese di attrito. Un sistema rapido deve avere un vantaggio misurabile superiore ai costi
e va dimostrato in backtest *con* i costi prima del paper. Propongo **media frequenza** (barre 5-15 minuti, 5-30
operazioni al giorno, posizioni da ore a giorni), non alta frequenza.

### Architettura proposta (tutto in Bun/TypeScript, riusando ciò che c'è)

```
                 ┌────────────── websocket IEX / crypto ──────────────┐
                 ▼                                                    │
  [Mercato] barre 1m→5m→15m, book top, orologio ──▶ bus eventi (in processo, append-only JSONL events/AAAA-MM-GG.jsonl)
                 │
                 ├─▶ [Agente trend intraday]  ──┐
                 ├─▶ [Agente mean reversion]  ──┤   segnali {simbolo, lato, forza, orizzonte, perché, fiducia}
                 ├─▶ [Agente breakout/volume] ──┼─▶ [Allocatore] pesa i segnali col track record del diario ─▶ proposte
                 ├─▶ [Agente Kronos]          ──┤
                 ├─▶ [Agente regime/eventi]   ──┘   (claude -p ogni ora: regime, notizie, veto; mai ordini diretti)
                 │
                 ▼
  [Risk manager = gabbia intraday] esposizione per simbolo/gruppo/totale, perdita giornaliera, stop e trailing,
  limite di operazioni al giorno, kill switch, nessun ordine se dati vecchi o websocket caduto
                 │
                 ▼
  [Esecutore] ordini limit/bracket, ID deterministici, verifica, riconciliazione (execute.ts, lock.ts, reconcile.ts già pronti)
                 │
                 ▼
  [Diario + Testimone + Telegram] (journal.ts, witness.ts, telegram.ts) e [Dashboard] che legge il bus
```

- **Agenti = codice**, ognuno con regole chiare, test e *track record* separato nel diario (già esiste il concetto di
  setup e fiducia). L'allocatore aumenta il peso di chi ha ragione e azzera chi perde: è la forma utile di "apprendimento".
- **Il modello linguistico** passa da "cervello che decide gli ordini" a "supervisore": regime di mercato, calendario
  eventi (oggi a mano in `events.ts`), veto, spiegazioni in italiano per Telegram e dashboard.
- **La gabbia resta sovrana**, riscritta per l'intraday: niente interruttore a riarmo manuale, ma limiti giornalieri con
  riarmo automatico e riduzione di taglia dopo perdite; stop basati sulla volatilità della barra, non del giorno.
- **Si parte dal crypto o da 3-5 simboli liquidi** (SPY, QQQ, NVDA, BTC, ETH) e si allarga solo con prove.
- **Sforzo**: 3-4 settimane di lavoro per un motore in paper con backtest intraday e costi; il resto è misura.

### Cosa farei comunque, anche senza il motore nuovo

- Interruttore con riarmo automatico (5 sedute) o sostituito da una regola di regime (SPY sotto la 200: metà taglia).
- Ingressi anche alla sveglia di metà seduta e taglie più generose quando la volatilità è bassa.
- 60/40 come *posizione di base* invece dei contanti: il backtest dice che stare liquidi è la perdita più grande.

---

## 4. Piattaforma di monitoraggio con grafica 3D

### Fattibilità

Alta, e indipendente dal motore di trading. Serve una sola cosa che oggi manca: un **registro eventi** unico e leggibile
(oggi le decisioni stanno sparse tra testimone, diario, log di testo e Telegram). Con un file JSONL al giorno in cui ogni
agente scrive `{quando, agente, tipo, simbolo, dati, perché}`, la dashboard è una pagina che lo legge in diretta.

### Componenti

| Pezzo | Scelta | Perché |
|---|---|---|
| Server | Bun, `Bun.serve` con HTTP + WebSocket, stesso repo (`src/dashboard/`) | nessuna dipendenza nuova, legge stato e registro, pubblica ogni evento |
| Sorgente dati oggi | `state/` locale oppure il branch `stato` via API GitHub (polling ogni minuto) | funziona già con le sveglie cloud |
| Sorgente dati domani | il bus eventi del motore multi-agente | tempo reale vero |
| Vista 3D | Three.js (vanilla, o react-three-fiber se si sceglie React) | standard, leggero, WebGL ovunque |
| Grafici 2D | lightweight-charts (TradingView) per candele e P&L, tabelle HTML | i numeri si leggono meglio in 2D |
| Accesso | localhost di serie; se esposto in rete, token in header e solo HTTPS | mostra conto e posizioni |

### Cosa si vede

- **Pavimento dei mercati**: una colonna per simbolo, altezza = esposizione, colore = P&L non realizzato, pulsazione
  quando arrivano barre; gruppi (tecnologia, obbligazioni, oro, crypto) raggruppati nello spazio.
- **Agenti** come nodi attorno al pavimento: ogni segnale è un raggio verso il simbolo (verde compra, rosso vende,
  intensità = fiducia); l'allocatore e la gabbia sono anelli intermedi dove i raggi passano o vengono respinti
  (rifiuti visibili col motivo).
- **Linea del tempo** delle decisioni con il "perché" in italiano, filtrabile per agente e simbolo.
- **Pannello P&L**: realizzato, non realizzato, per giorno/trade/agente, confronto con SPY e 60/40 (già calcolato in
  `benchmark.ts`), statistiche del diario per setup.
- **Ordini**: inviati, eseguiti, rifiutati, stop attivi su Alpaca, con lo stato aggiornato dalla riconciliazione.
- **Salute**: ultimo battito del websocket, ritardo dei dati, lock, allarmi (gli stessi che vanno su Telegram).

Avvertenza: il 3D vale come colpo d'occhio e per mostrare "chi sta facendo cosa"; per controllare un ordine serve la
tabella. Proporrei entrambe le viste nella stessa pagina.

### Sforzo

- Registro eventi + server + pagina con pavimento 3D e pannelli base: 1-2 settimane.
- Replay storico (rivedere una giornata), filtri, agenti animati: altra settimana.

---

## 5. Piano proposto e decisioni da prendere

| Fase | Cosa | Tempo | Rischio | Valore atteso |
|---|---|---|---|---|
| 0 | Riarmo automatico dell'interruttore / regola di regime, ingressi anche a metà seduta; backtest prima e dopo | 1 giorno | basso | backtest da +4% a ~+18% su 550 sedute |
| 1 | Registro eventi JSONL + dashboard (server Bun, 3D + 2D) sul sistema attuale, lettura del branch `stato` | 1-2 settimane | basso | vedi subito tutto; serve comunque al motore nuovo |
| 2 | Sidecar Kronos (`Forecaster`), suoi output nel diario e negli indicatori; backtest intraday con costi; fine-tuning se c'è GPU | 2-3 settimane | medio | si scopre se Kronos paga, senza rischiare ordini |
| 3 | Motore multi-agente a media frequenza in paper, su crypto + 3-5 simboli, affiancato all'attuale per 4-6 settimane | 3-4 settimane + prova | medio-alto | strategia nuova giudicata con numeri, non con il saldo di due settimane |

Decisioni che spettano a te:

1. **Dove far girare un processo sempre acceso** (VPS da 5-10 €/mese, Raspberry, PC acceso, sessione cloud lunga).
2. **Crypto sì o no** come primo banco di prova del motore continuo (è l'unico mercato 24/7 su Alpaca).
3. **Budget GPU a ore** per il fine-tuning di Kronos, oppure restare al zero-shot come semplice caratteristica.
4. **Fase 0 subito?** È una modifica di poche righe in `config.ts`/`breaker.ts` con test, e il backtest la sostiene.

## Appendice: riproducibilità

- Backtest: `bun run backtest --days 750` e `bun run backtest --days 750 --riarmo 5` (chiavi Alpaca nell'ambiente).
- Kronos: `tools/kronos/README.md`. Risultati grezzi JSON in `docs/kronos-risultati/`.
- Fonti: [repo Kronos](https://github.com/shiyu-coder/Kronos) · [paper](https://arxiv.org/abs/2508.02739) ·
  [Kronos-mini su Hugging Face](https://huggingface.co/NeoQuasar/Kronos-mini) · [Kronos-base](https://huggingface.co/NeoQuasar/Kronos-base) ·
  [Alpaca, piani dati di mercato](https://docs.alpaca.markets/docs/about-market-data-api).

---

## Addendum (8 novembre, sera): soglia del 60%, GitHub, PC acceso

### "Mi serve una direzione indovinata di almeno il 60%"

Il 60% su ogni barra, su strumenti liquidi come SPY, non lo raggiunge nessun modello pubblico: la direzione del giorno
dopo è indovinabile al 51-55% anche dai sistemi professionali, e il vantaggio sta nella taglia delle vincite rispetto
alle perdite, non nella frequenza. Tre vie misurate sui nostri dati portano però **sopra il 60%**, con costi diversi:

**1. Allungare l'orizzonte.** La quota di finestre in cui il prezzo è più alto dopo h sedute (storico 2020-2026 | ultime 250):

| | 1 seduta | 5 | 10 | 20 | 60 |
|---|---|---|---|---|---|
| SPY | 54% / 52% | 59% / 53% | 63% / 53% | **67% / 62%** | 77% / 86% |
| QQQ | 55% / 53% | 58% / 51% | 61% / 50% | 64% / 52% | 71% / 72% |
| NVDA | 53% / 50% | 57% / 50% | 57% / 46% | 62% / 56% | 70% / 73% |
| AAPL | 53% / 53% | 56% / 56% | 58% / 58% | 61% / 63% | 65% / 77% |
| TLT | 49% / 48% | 46% / 43% | 43% / 36% | 39% / 28% | 31% / 15% |

A un mese "sale" ha ragione nel 61-67% dei casi su azioni e indici; a tre mesi oltre il 70%. È la ragione per cui il
trend following lento funziona *se resta investito*: la direzione la dà la deriva del mercato, non la previsione.
Il 60% chiesto è quindi compatibile con una strategia a orizzonte di settimane, **non** con il trading rapido intraday,
dove la direzione della prossima barra è una moneta (46-55% in tutte le prove) e i costi mangiano il resto.

**2. Essere selettivi.** Agire solo quando Kronos è "deciso" (rendimento previsto nel 25% o 10% più ampio). Kronos-small,
250 finestre giornaliere dell'ultimo anno (`tools/kronos/selectivity.py`, righe in `docs/kronos-risultati/rows_*.csv`):

| | tutte le previsioni | top 25% (63 casi) | top 10% (25 casi) |
|---|---|---|---|
| SPY, 1 seduta | 55% | **60%** | 56% |
| SPY, 2 sedute | 52% | 59% | 60% |
| NVDA, 2 sedute | 54% | **62%** | **72%** |
| NVDA, 3 sedute | 56% | 60% | 68% |
| NVDA, 4-5 sedute | 56-57% | 57-59% | 64-68% |

Con 63 casi l'intervallo di confidenza è circa ±12 punti, con 25 casi ±19: questi numeri *suggeriscono* che la
selettività aiuti, non lo dimostrano. Vanno ripetuti su più anni, più simboli e dopo il fine-tuning. Se reggono,
il modo d'uso è: Kronos propone solo nel 10-25% dei giorni, la gabbia decide la taglia, il diario misura.

**3. Combinare.** Orizzonte di 5-20 sedute + filtro di trend (già in gabbia) + Kronos selettivo come conferma + costi
bassi perché si opera poco. È la direzione opposta a "buy e sell costanti", e lo dico perché i dati lo dicono.

Metrica da adottare al posto del 60%: **attesa per operazione dopo i costi** (percentuale vinti × vincita media −
percentuale persi × perdita media − spread e slippage) e **rendimento contro il 60/40**. Un sistema al 45% di direzione
con vincite doppie delle perdite guadagna; uno al 60% con stop stretti e take profit piccoli può perdere.

### "È possibile far girare il sistema tramite GitHub?"

Sì, con limiti precisi, e in parte lo fa già (le sveglie cloud programmate salvano lo stato sul branch `stato`).

| Modo | Cosa può fare | Limiti |
|---|---|---|
| **GitHub Actions a orario** (`on: schedule`, cron) | sveglie ogni 15-30 minuti nelle ore di borsa, ogni run parte da un runner nuovo, legge/scrive il branch `stato`, chiavi nei *secrets* | intervallo minimo 5 minuti; ritardi di 5-30 minuti frequenti all'inizio dell'ora e salti nei giorni di carico; nessun websocket; ogni run paga 1-2 minuti di avvio (bun install, eventuale Kronos con cache); Kronos richiede torch in cache (il pacchetto CPU, non quello CUDA da 5 GB) |
| **GitHub Actions come processo lungo** | un job fino a 6 ore che resta collegato al websocket | a 2 run al giorno per coprire la seduta sono ~140 ore al mese: oltre le 2.000 minuti gratuiti del piano Free, circa 50 $ al mese al prezzo 2026 di 0,006 $ al minuto; se GitHub termina il job si perde il tempo reale finché non riparte |
| **Sessioni cloud di Claude Code programmate** (oggi) | sveglie con `claude -p` disponibile | intervallo minimo orario: va bene per il supervisore, non per il motore rapido |

Conclusione: **per una strategia a orizzonte di giorni/settimane (quella che i dati sostengono) GitHub basta**, anche
gratis: un workflow ogni 15-30 minuti in orario di borsa sta dentro i minuti gratuiti (26 run × ~2 min × 21 giorni ≈
1.100 minuti al mese) e il codice attuale è già fatto per riprendere da uno stato salvato su git. **Per il tempo reale
vero** (websocket, decisioni in secondi) GitHub non è lo strumento.

### "Mi serve un PC sempre acceso?"

No, se il sistema lavora a sveglie (ogni 15-30 minuti o più): bastano GitHub Actions o le sessioni cloud attuali.
Sì, o un suo equivalente, se si vuole un processo sempre collegato al mercato. Equivalenti al posto del PC:

- **VPS economico** (Hetzner, Contabo, OVH: 4-6 € al mese, 2 vCPU/4 GB): la soluzione normale per un motore sempre acceso,
  Kronos-mini/small su CPU ci gira.
- **Oracle Cloud Always Free**: dal giugno 2026 ridotto a 2 OCPU ARM e 12 GB, spesso "out of capacity", ma gratuito e
  sufficiente se si ottiene l'istanza.
- **Raspberry Pi 5 a casa**: costo una tantum, consumo di pochi watt, ma dipende dalla tua connessione e corrente.
- **Container su Fly.io/Railway**: 5-10 $ al mese, riavvii automatici, log in cloud.

In tutti i casi il codice resta quello: stato su git o su disco, testimone, lock, riconciliazione dopo una morte sono
già scritti per sopravvivere a riavvii. Raccomandazione: **non comprare né accendere nulla finché il backtest con costi
non mostra un motore che batte il 60/40**; nel frattempo GitHub Actions (o le sveglie attuali, con l'interruttore
riparato) copre tutto ciò che serve per una strategia a orizzonte di settimane.

---

## Addendum (8 novembre, notte): cosa è stato costruito

Decisioni prese: orizzonte a 20 sedute (quello con il 61-67% storico), motore in locale su un PC acceso, niente VPS
né GitHub a pagamento. Implementato e provato in questo branch:

- **Interruttore con riarmo automatico** dopo 5 giorni di borsa (`src/breaker.ts`): il backtest di serie su 550 sedute
  passa da +4,33% a **+17,65%** (SPY +35,18%, 60/40 +18,22%), perdita massima -8,72%, 208 ordini, 3 scatti dell'interruttore.
- **Motore degli agenti** `bun run agents` (`src/agents/`): trend, rientro, regime, orizzonte, Kronos opzionale;
  allocatore a punteggi con pesi dal diario; gabbia invariata a valle; stop GTC su Alpaca; diario con gli agenti che hanno
  votato ogni ingresso; registro eventi JSONL; Telegram per ordini, allarmi e riepilogo serale.
- **Dashboard 3D locale** (`src/dashboard/`, porta 8787) con Three.js servito dal pacchetto npm (funziona offline).
- **Sidecar Kronos** (`tools/kronos/server.py`) per l'agente `kronos`, spento di serie.
- **Test**: 15 nuovi (agenti, allocatore, interruttore, motore con broker finto, dashboard), 114 in tutto, tutti verdi.
- **Prova su dati reali a mercato chiuso** (8/11, stato separato): 3 segnali (AAPL trend+rientro 1,2; MSFT trend 1,0),
  regime "SPY sopra la media a 200", nessuna proposta perché le posizioni sono già al peso obiettivo. Nessun ordine.

Cosa manca e va deciso con i prossimi dati: il backtest *del motore* (oggi il backtest rigioca la gabbia con il metodo
trend; rientro, orizzonte e pesi degli agenti non sono ancora simulati), e almeno 4-6 settimane di paper con il diario
prima di toccare i pesi a mano.


---

## Addendum (8 novembre, mattina): backtest del motore, obiettivi di profitto, installazione sul PC

### Il backtest ora rigioca anche il motore

`bun run backtest` stampa prima la gabbia con il metodo trend (le sveglie) e poi quattro varianti del motore degli agenti,
tutte su 550 sedute reali, esecuzione alla chiusura, senza costi né slippage (quindi ottimiste):

| Variante | Rendimento | Perdita max | Trade chiusi | Vinti | Attesa/trade | Esposizione | Durata |
|---|---|---|---|---|---|---|---|
| trend, rientro, regime, orizzonte, pesi dal diario (stop gabbia 5-10%) | +13,60% | -8,57% | 86 | 34% | +0,64% | 57% | 27 g |
| + presa di profitto secca a +2% | **+16,93%** | **-7,32%** | 143 | 47% | +0,73% | 54% | 16 g |
| + uscite: stop -2%, incasso a +3% (la politica richiesta, senza proiezioni) | +14,85% | -7,62% | 281 | 45% | +0,29% | 49% | 7 g |
| + uscite: stop -2%, incasso a +4% | +13,18% | -9,00% | 235 | 39% | +0,36% | 53% | 9 g |
| riferimento: gabbia + trend con riarmo automatico | +17,65% | -8,72% | 208 ordini | | | | |
| riferimento: SPY / 60-40 | +35,18% / +18,22% | | | | | | |

Il diario inizia a pesare gli agenti dopo 90 giorni e 30 trade (da aprile-giugno nel backtest): il trend finisce a 1,2,
il rientro a 0,5 nella variante base (23 trade, attesa -0,6%). Con il peso obiettivo scollegato dal punteggio
(`scaleByScore: false`) l'esposizione sale dal 49% al 57% e il rendimento da +7,7% a +13,6%: stare investiti conta più
di scegliere bene. Le proiezioni di Kronos non sono nel backtest (servirebbe rigiocare il modello su 550 giorni × 8 titoli):
lì le uscite incassano sempre all'obiettivo.

### "Almeno il 3-4% al giorno, oltre il 50% di successi, uscite a -2% / +3-4%"

Numeri sulle ultime 500 sedute (massimi e minimi veri delle barre, entrata alla chiusura, entro 20 sedute):

| Titolo | tocca +2% prima di -2% | tocca +3% prima di -2% | attesa (+3/-2) | tocca +4% prima di -2% | attesa (+4/-2) |
|---|---|---|---|---|---|
| SPY | 50% | 37% | -0,13% | 27% | -0,39% |
| QQQ | 54% | 43% | +0,16% | 36% | +0,14% |
| AAPL | 56% | 45% | +0,25% | 41% | +0,44% |
| MSFT | 56% | 46% | +0,31% | 41% | +0,46% |
| NVDA | 53% | 46% | +0,31% | 40% | +0,38% |
| GLD | 61% | 53% | +0,65% | 46% | +0,76% |
| TLT | 41% | 32% | -0,39% | 20% | -0,78% |

E quanto si muove un titolo in un giorno: SPY chiude almeno il 2% sopra l'apertura nello 0,6% dei giorni, NVDA nell'11,8%;
a 5 minuti, +2% prima di -1% dentro la seduta succede nell'1,2% dei casi su SPY e nel 30% su NVDA; BTC tocca +2% prima
di -1% in 24 ore nel 30% dei casi.

Cosa dicono questi numeri, senza giri di parole:

- **Il 3-4% al giorno sul conto non è raggiungibile** con questo universo e queste regole: con il 20% massimo per titolo,
  un +3% sul conto richiede un +15% in un giorno su una posizione piena, o cinque posizioni che fanno tutte +3% lo stesso
  giorno. SPY fa +2% in un giorno 3 volte l'anno. Nemmeno i fondi migliori del mondo fanno il 3% al giorno (sarebbe oltre
  il 1.000% all'anno). L'obiettivo realistico per questo sistema è **battere il 60/40 e avvicinarsi a SPY con meno
  perdita massima**: nel backtest siamo a +15-17% in 2,2 anni contro +18% del 60/40 e +35% di SPY.
- **Oltre il 50% di successi con uscita a +3% e stop -2% non c'è**: 37-53% a seconda del titolo (GLD è l'unico sopra il 50%).
  Però **non serve**: con premio 3 e rischio 2 si guadagna già dal 40% di successi, e infatti l'attesa è positiva su
  tutto tranne SPY, IWM e TLT. La metrica giusta è l'attesa per trade dopo i costi, non la percentuale di vinti.
- **La politica richiesta è implementata e misurata** (agente `uscite`): nel backtest rende +14,85% con perdita massima
  -7,6%, 45% di vinti e 281 trade in 2,2 anni (uno ogni 2 giorni di borsa). Costa 2 punti rispetto alla presa di profitto
  secca a +2% e 3 rispetto al trend puro: lo stop a -2% esce spesso sul rumore (NVDA si muove del 3% al giorno).
  Con le proiezioni di Kronos a decidere se lasciare correre, il risultato cambierà: va misurato in paper, perché zero-shot
  Kronos ha mostrato poco segnale (sezione 2) e le sue proiezioni negative faranno uscire anche da trade buoni.
- **Perdita minima con Kronos**: l'uscita anticipata su proiezione negativa c'è (vincolante). Il rischio opposto è
  reale: con una previsione che indovina la direzione il 50% delle volte, metà delle uscite anticipate saranno sbagliate.

### Installazione in `D:\Applicazioni\WebDev\Bot alpaca agents`

Da questa sessione cloud non posso scrivere sul tuo PC (nessuna cartella condivisa via Remote Control). Lo script
`installa-windows.ps1` fa tutto con un comando: vedi README, sezione "Installazione su Windows".

---

## Addendum (8 novembre, pomeriggio): tre leve, stop -3%, crypto, e cosa dice la letteratura

### Cosa è cambiato nel codice

- **Universo degli agenti** (`AGENTS.universe`): SPY, QQQ, AAPL, MSFT, NVDA, GLD, BTC/USD, ETH/USD. IWM e TLT non si
  comprano più (attesa nulla o negativa con obiettivo +3% / stop -2%), ma una posizione vecchia resta sorvegliata e
  vendibile. La gabbia accetta UNIVERSE ∪ CRYPTO.
- **Obiettivo per titolo** (`AGENTS.exit.targetBySymbol`): +4% su GLD, MSFT e QQQ (dove le barriere pagano di più), +3%
  sugli altri. **Stop a -3%** (`AGENTS.exit.stopPct`), anche come stop GTC su Alpaca.
- **Crypto su Alpaca**: prezzi e barre dagli endpoint `v1beta3/crypto`, simboli normalizzati (`BTCUSD` delle posizioni →
  `BTC/USD`), quantità frazionarie a 6 decimali, ordine minimo 10 $, `time_in_force: gtc`, stop come `stop_limit` con
  limite mezzo punto sotto (Alpaca rifiuta lo `stop` a mercato sulle crypto: verificato con una sonda a prezzo impossibile,
  poi cancellata). La gabbia lascia passare le crypto a mercato chiuso e fuori finestra (24 ore su 24), con un ingresso al
  giorno per coppia; gli stop delle crypto si aggiornano anche a borsa chiusa. Il backtest allinea le crypto (7 giorni su 7)
  sulle sedute di SPY.
- **Test**: 122, tutti verdi.

### Backtest, 550 sedute, solo titoli (le crypto hanno storico Alpaca più corto: sotto)

| Variante | senza contesto | con contesto (regole) | Perdita max (con) | Trade | Vinti | Attesa/trade |
|---|---|---|---|---|---|---|
| Agenti base (stop gabbia 5-10%), universo senza IWM/TLT | +13,5% | +14,2% | -5,7% | 71 | 28% | +0,79% |
| + presa di profitto secca +2% | +17,8% | +11,9% | -5,8% | 110 | 48% | +0,52% |
| + uscite: stop -3%, obiettivo +3% (+4% GLD/MSFT/QQQ), **di serie** | +14,8% | +11,5% | **-5,1%** | 152 | 47% | +0,42% |
| + uscite: stop -3%, obiettivo +4% | +13,5% | +12,0% | -7,8% | 161 | 43% | +0,39% |
| riferimento: gabbia + trend con riarmo | +17,7% | | -8,7% | | | |
| riferimento: SPY / 60-40 | +35,2% / +18,2% | | | | | |

- **Stop -3% contro -2%**: stesso rendimento, 100 trade in meno (186 contro 281), attesa per trade da +0,29% a +0,51%,
  e il "rientro" da perdente (-0,60%) a vincente (+0,63%): lo stop stretto gli tagliava le gambe.
- **Il contesto economico** (regole sui dati: SPY sotto la 200, volatilità, settore con la maggioranza dei titoli sotto la
  50, oro e obbligazioni in salita con SPY in calo, Fed vicina) **costa 2-6 punti di rendimento** nel periodo 2024-2026,
  che è stato rialzista, e abbassa la perdita massima. È il prezzo dell'aspettare la candela successiva quando il quadro
  è dubbio: in un mercato in discesa il segno si inverte. Nel vivo si aggiunge la lettura con `claude -p` e ricerca web.

### Crypto nel motore: misurate, e per ora fuori di serie

Backtest su 312 sedute (agosto 2025 - novembre 2026, il periodo coperto dalle barre crypto di Alpaca), tutto allineato
sulle sedute di SPY, configurazione di serie (uscite +3%/-3%, contesto):

| Universo | Rendimento | Perdita max | Trade | Vinti | Attesa/trade |
|---|---|---|---|---|---|
| titoli | **+9,3%** | -5,1% | 108 | 49% | +0,62% |
| titoli + BTC/USD, ETH/USD | **+3,0%** | -5,3% | 139 | 43% | +0,17% |
| riferimento: SPY / 60-40 | +15,6% / +8,9% | | | | |

Nelle altre varianti il danno è uguale o peggiore (base: da +8,7% a +3,3%; profitto +2%: da +7,4% a -2,0%). In quel periodo
BTC ed ETH hanno alternato salite brevi e discese lunghe: il trend a 50/200 giorni li compra tardi e li vende sullo stop.
Quindi il supporto crypto resta nel codice, completo e testato, ma **si accende solo con `--crypto`** (anche nel backtest):
la "costanza" richiesta, oggi, le crypto la peggiorano. Da riprovare con il filtro di momentum assoluto (punto 7 sotto).

### Strategie migliori in giro? Cosa dicono bot open source e letteratura

Ricerca fatta su freqtrade, Jesse, Hummingbot, NautilusTrader, OctoBot, Lumibot, repo "alpaca trading bot" e sulla
letteratura accademica (fonti in fondo). Sintesi onesta:

- **Nessun bot open source distribuisce una strategia con prove credibili di profitto.** Sono infrastrutture di
  esecuzione e backtest. Le strategie popolari nelle loro comunità (scalper multi-indicatore a 5-15 minuti con tabelle di
  take-profit e stop fissi, tipo NostalgiaForInfinity su freqtrade) sono proprio quelle che la documentazione di freqtrade
  stessa sconsiglia; un test indipendente su 7 strategie pubbliche le ha trovate tutte in perdita su 24 mesi.
  Il nostro progetto non è indietro rispetto a loro.
- **Le evidenze pubblicate solide, per azioni ed ETF long-only su dati giornalieri, sono tre**: (1) i filtri di trend a
  lungo periodo (media a 200 giorni / 10 mesi, Faber) **riducono le perdite massime** ma non alzano il rendimento;
  (2) il momentum a 6-12 mesi tra asset aggiunge un rendimento modesto (Antonacci, Moskowitz-Ooi-Pedersen; dopo la
  pubblicazione gli effetti calano del 25-50%, McLean-Pontiff); (3) la **taglia inversa alla volatilità** migliora Sharpe e
  code (Harvey et al., Barroso-Santa Clara). Il nostro motore ha già tutte e tre. Nessuna produce "3-4% a trade con
  costanza": producono rendimenti vicini al mercato con metà delle perdite, su orizzonti di mesi.
- **Stop fissi e obiettivi fissi**: Kaminski-Lo (2014) mostrano che uno stop aggiunge valore solo quando i rendimenti
  persistono (cioè dopo che il trend si è rotto), non come percentuale stretta; Lei-Li (2009) trovano che stop fissi e
  trailing non cambiano il rendimento, solo il rischio, e con soglie di 5-20 deviazioni standard (larghe); Han-Zhou-Zhu
  trovano che per il momentum lo stop utile è al 10%, e il 5% è il peggiore tra quelli provati; i test CXO su SPY
  trovano che un take-profit fisso tra l'1% e il 15% non batte "compra e tieni" al netto dei costi. È coerente con il
  nostro backtest: la variante con uscite fisse rende meno del trend puro, in un periodo fortemente rialzista.
- **Crypto spot**: l'unica cosa con supporto pubblicato è il trend/momentum giornaliero (Liu-Tsyvinski 2021): taglia le
  perdite massime da -90% a -70%, con lunghi periodi piatti; i parametri ottimizzati su un anno non predicono l'anno
  dopo (arXiv 2009.12155). Le strategie scalper delle comunità non hanno risultati live verificati.
- **Modelli fondazionali (Kronos, Chronos, TimesFM)**: studi del 2025 trovano R² negativo zero-shot sulle azioni USA e
  nessuna strategia economicamente utile; un test indipendente di Kronos su date fuori campione non trova vantaggio.
  Conferma quanto misurato qui nella sezione 2.

**Cambiamenti suggeriti dalla letteratura, in ordine di priorità** (da provare nel backtest, non da adottare a occhi chiusi):

1. Uscita di trend o trailing largo (2,5-3 ATR, o chiusura sotto la 50) al posto dell'obiettivo fisso: meno vinti, vincite
   più grandi, più trend catturato.
2. Stop scalato sulla volatilità (8-10% sui titoli nervosi) con taglia ridotta di conseguenza: stesso rischio per trade,
   molte meno uscite sul rumore. Lo stop a -3% appena introdotto va in questa direzione ma è ancora stretto per NVDA e crypto.
3. Taglia sulla volatilità di portafoglio (obiettivo 10-12% annuo) invece del solo tetto per titolo.
4. Riesame mensile o settimanale sul momentum 6-12 mesi, al posto delle 20 sedute.
5. Filtro di momentum assoluto (rendimento a 12 mesi > 0) oltre alle medie, con la liquidità come posizione di riposo.
6. Il "rientro" come comparto separato a breve orizzonte (RSI(2) sotto 10 sopra la 200, uscita in 3-5 giorni) con obiettivi
   piccoli: gli obiettivi fissi funzionano sulla mean reversion, non sul trend.
7. Crypto solo in trend (sopra la media a 100-200 giorni e rendimento a 1-3 mesi positivo), con stop larghi.
8. Confronto onesto: contro GTAA/GEM sullo stesso universo e il 60/40, su 2010-2026 includendo 2018, 2020 e 2022, con
   costi e slippage del feed IEX, e un taglio del 25-50% a qualunque vantaggio di backtest.

Da evitare: tabelle di take-profit ottimizzate (pattern freqtrade), stop stretti fissi, breakout Donchian a 20 giorni su
ETF large cap, previsioni di direzione da modelli fondazionali nel ciclo live, ottimizzazione di parametri su finestre
corte in crypto, e l'aspettativa di un 3-4% a trade costante: nessuna strategia long-only pubblicata lo consegna.

Fonti principali: [Moskowitz-Ooi-Pedersen](https://papers.ssrn.com/abstract=2089463) · [Faber GTAA, estensione 2006-2025](https://concretumgroup.substack.com/p/global-tactical-asset-allocation) ·
[Volatility targeting, Harvey et al.](https://quantpedia.com/the-impact-of-volatility-targeting-on-equities-bonds-commodities-and-currencies) ·
[Kaminski-Lo, stop-loss](https://dspace.mit.edu/bitstream/handle/1721.1/114876/Lo_When%20Do%20Stop-Loss.pdf) · [Lei-Li, trailing stop](https://www.cxoadvisory.com/?p=1821) ·
[Stop-gain su SPY](https://www.cxoadvisory.com/?p=25241) · [Momentum crashes e stop al 10%](https://www.cxoadvisory.com/technical-trading/stop-losses-to-avoid-stock-momentum-crashes/) ·
[McLean-Pontiff](https://Www.Gwern.net/doc/economics/2016-mclean.pdf) · [Liu-Tsyvinski, crypto](https://econpapers.repec.org/RePEc:oup:rfinst:v:34:y:2021:i:6:p:2689-2727) ·
[Parametri instabili in crypto](https://arxiv.org/pdf/2009.12155v1.pdf) · [TSFM in finanza, 2025](https://arxiv.org/abs/2511.18578) · [Test indipendente di Kronos](https://dev.to/alexbsolodev/we-tested-the-viral-ai-chart-model-on-dates-it-cant-have-seen-no-edge-4n1g) ·
[freqtrade, strategy 101](https://docs.freqtrade.io/en/2025.3/strategy-101/) · [Hummingbot, intervista market maker](https://hummingbot.org/blog/interview-with-liquidity-miner-dominator008/) · [Lumibot](https://gittrend.io/repo/Lumiwealth/lumibot).
