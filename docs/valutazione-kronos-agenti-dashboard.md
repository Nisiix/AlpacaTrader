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
