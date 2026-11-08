# Agente di paper trading Alpaca

Due modi di lavorare, stesso conto paper, stesse regole:

- **Motore degli agenti** (`bun run agents`): processo sempre acceso sul tuo PC, orizzonte a 20 sedute, più agenti
  che osservano e votano, dashboard 3D locale. È la strada scelta dopo la valutazione in `docs/`.
- **Sveglie** (`bun run schedule` / cloud): 4 volte al giorno con `claude -p`, come prima.

## Motore degli agenti

```sh
bun run agents                       # ogni 5 minuti: conto, agenti, gabbia, ordini, stop, diario; dashboard su http://127.0.0.1:8787
bun run agents --fake --once         # un giro con broker finto, senza dashboard
bun run agents --kronos http://127.0.0.1:8765   # aggiunge l'agente Kronos (sidecar in tools/kronos/server.py)
bun run dashboard                    # solo la dashboard, in lettura, sullo stato esistente
```

Opzioni: `--tick 5` (minuti tra un giro e l'altro), `--port 8787`, `--no-dashboard`, `--fake`, `--once`, `--no-crypto` (toglie le crypto, che nel motore sono di serie e lavorano 24 ore su 24 con la stessa logica dei titoli), `--no-kronos`, `--kronos url` (sidecar già acceso altrove), `--profitto`.
Da tenere acceso il PC (o un altro processo con lo stesso `state/`): il motore riparte da `state/` dopo un riavvio,
il lock e gli ID deterministici evitano doppioni anche con le sveglie classiche.

| Agente | Cosa guarda | Segnali |
|---|---|---|
| `trend` | chiusura sopra le medie a 50 e 200 giorni, **rendimento a 12 mesi positivo** (momentum assoluto, altrimenti liquidità), classifica per momentum a 6 mesi; crypto anche a 3 mesi positivi | compra i migliori 5 (forza 1 → 0,5 per classifica); vende chi ha in mano sotto la 50 |
| `rientro` | mean reversion di Connors: RSI(2) sotto 10 con prezzo sopra la media a 200 | compra (0,7) con **taglia massima 5%**; esce (vincolante) a RSI(2) sopra 70 o dopo 5 sedute, solo per i trade aperti da lui solo |
| `regime` | SPY contro la sua media a 200 giorni e la volatilità a 20 giorni | nessun ordine: dimezza l'esposizione ammessa quando il mercato è debole o nervoso |
| `orizzonte` | trade aperti da **60 sedute** (un trimestre) | vende (0,8) solo se lo slancio è finito; se il trend regge tace |
| `contesto` | **prima di ogni trade**: situazione economica generale e per settore (regole sui dati: SPY e media a 200, volatilità, oro e obbligazioni in salita con SPY in calo, titoli del settore sotto la 50, Fed nei prossimi 2 giorni; più, se c'è `claude -p`, una lettura con ricerca web ogni 6 ore in `state/macro.json`) | nessun ordine: esposizione × 0,75 (neutro) o × 0,5 (sfavorevole); con contesto sfavorevole nel settore **non si apre niente e si aspetta la candela successiva**; la proiezione di Kronos guida ingressi e uscite **solo** con contesto favorevole |
| `uscite` | ogni posizione: perdita dal carico, massimo visto, proiezione di Kronos se il contesto si fida | **vincolante** (non si vota). Di serie (`mode: "trend"`): stop **scalato sulla volatilità** (2,5 × vol × √5, tra 5% e 10%, anche come stop GTC su Alpaca), nessun obiettivo (l'uscita normale è il trend della gabbia), proiezione negativa: esce subito. Opzioni: `trailAtr` per uscire anche a N ATR dal massimo; `mode: "obiettivo"` per la vecchia politica a +3%/+4% con stop fisso -3% |
| `kronos` | previsioni del modello a 5 sedute (percorso giorno per giorno), calcolate una volta al giorno sulle barre giornaliere e salvate in `state/previsioni.json`; tenute solo il 25% più nette e nel verso del trend | compra/vende (0,5); le stesse proiezioni guidano `uscite` e disegnano gli scenari nella dashboard |
| `custodi` | **un investitore per ogni crypto seguita**: nasce per le crypto in portafoglio e per le migliori candidate del trend (sopra le medie 50/200, slancio a 12 e 3 mesi positivo, le prime 5 per momentum a 6 mesi); ognuno dichiara tesi, piano e rischio e segue solo il suo titolo | entra (0,6; 0,8 sul rientro verso la media a 20; 0,25 se il prezzo è oltre il 15% sopra la 50), esce sotto la media a 50 (0,9) o con slancio a 3 mesi negativo (0,6); muore dopo 12 giri fuori dai criteri |
| `profitto` | guadagno oltre +3% su un trade non ancora alleggerito | **vincolante**: vende metà e lascia correre il resto col trend (`AGENTS.takeProfit`: `fraction` 1 per vendere tutto, `enabled: false` per spegnerlo) |

L'**allocatore** somma i segnali pesati (peso 1 per tutti finché il diario non ha un campione; poi 0,5 a chi perde,
1,2 a chi vince con campione affidabile), compra sopra 0,5 e vende sotto -0,5; il peso obiettivo di un titolo è il massimo
della gabbia (20%, meno se volatile) × rischio del regime e del contesto, con il tetto del comparto (5% per il rientro);
poi la **volatilità di portafoglio**: se le posizioni volute supererebbero il 12% annuo (√252 × 0,8 × Σ peso × volatilità),
le taglie nuove scendono in proporzione. Poi tutto passa dalla **gabbia** (`src/cage.ts`):
acquisti solo nella finestra 15:40-17:30 di Roma e una sola volta al giorno per titolo, vendite e stop a mercato aperto.
Lo stop GTC su Alpaca è scalato sulla volatilità (5-10%); la politica di uscita si regola in `src/config.ts` (`AGENTS.exit`).
Gli agenti comprano solo in `AGENTS.universe` (SPY QQQ AAPL MSFT NVDA GLD: niente IWM e TLT, che con obiettivo +3% e
stop -3% hanno attesa nulla o negativa); una posizione vecchia resta sorvegliata e vendibile.

**Crypto** (di serie nel motore degli agenti, `--crypto` nel backtest e nelle sveglie): l'universo è **tutte le coppie USD negoziabili su
Alpaca che stanno nella top 100 per capitalizzazione** (CoinGecko, rinnovato una volta al giorno in `state/crypto-universe.json`; senza
CoinGecko restano le coppie di Alpaca; stablecoin e token ancorati esclusi; massimo 40 coppie, `AGENTS.cryptoUniverse`). La scelta di
cosa comprare resta del motore: trend, momentum, custodi, allocatore, gabbia. 24 ore su 24, anche a borsa chiusa e fuori finestra, un ingresso al giorno per coppia,
quantità frazionarie (6 decimali, minimo 10 $), stop su Alpaca come `stop_limit` (Alpaca non accetta lo `stop` a
mercato sulle crypto) con limite mezzo punto sotto. Le posizioni crypto di Alpaca (`BTCUSD`) sono normalizzate a `BTC/USD`.
L'interruttore a -5% dal massimo si **riarma da solo dopo 5 giorni di borsa** (nel backtest: da +4,3% a +17,7%).
Il backtest applica 5 punti base di costi per lato e confronta con SPY, 60/40 e GTAA di Faber sullo stesso universo.

Ogni cosa che succede finisce nel **registro eventi** `state/events/AAAA-MM-GG.jsonl` (prezzi, segnali, rischio,
allocazione, ordini, rifiuti, stop, trade, allarmi) e nello stato `state/agents-status.json`. La **dashboard**
(`src/dashboard/`) li legge e risponde in italiano semplice a quattro domande, in ordine: va tutto bene (frase di stato: motore acceso, Alpaca raggiungibile, borsa aperta/chiusa, crypto), quanto guadagno oggi (patrimonio, conto del giorno realizzato e non), cosa ho in mano (posizioni) e cosa hanno deciso gli agenti e perché (ordini, rifiuti raggruppati per motivo, punteggi, agenti). Sotto, apribile, il pavimento 3D dei mercati (altezza = peso in portafoglio, colore = guadagno/perdita), agenti in
orbita che lanciano i segnali verso i titoli, anello della gabbia, pannelli con posizioni, punteggi, ordini, rifiuti,
stop, diario ed eventi in diretta via WebSocket. Three.js è servito dal pacchetto npm: funziona senza internet.
Telegram riceve ogni ordine inviato, gli allarmi e un riepilogo dopo le 22:05 con il **conto di profitto e perdita della
giornata**: ogni vendita eseguita oggi con guadagno o perdita in dollari e in percentuale (carico → uscita, parziale o
chiusura, motivo), il totale realizzato, il conto per agente (chi aveva votato l'ingresso), gli acquisti del giorno e il non
realizzato sulle posizioni aperte. Lo stesso conto è nella dashboard ("Profitto e perdita di oggi") e in
`state/agents-status.json` (`pnlOggi`); il diario conserva ogni esecuzione con la sua data (`acquisti`, `vendite`).
Nel fine settimana il riepilogo parte solo se c'è stato movimento (crypto).

![dashboard](docs/dashboard.png)

### Installazione su Windows

`installa-windows.ps1` crea il progetto in `D:\Applicazioni\WebDev\Bot alpaca agents` (o nella cartella passata come
argomento): controlla git e bun, clona il repo sul branch del motore, installa, crea `secrets.ts`, lancia i test e mette sul
desktop il collegamento "Bot alpaca agents" che avvia `bun run agents` (nella cartella c'è anche `avvia-bot.cmd`, stesso effetto con un doppio clic; `imposta-telegram.cmd` ricava e scrive il chat id). Da PowerShell:

```powershell
irm https://raw.githubusercontent.com/Nisiix/AlpacaTrader/ccr-f218832d-solbom/installa-windows.ps1 -OutFile installa-windows.ps1
powershell -ExecutionPolicy Bypass -File installa-windows.ps1
```

### Backtest del motore (dati Alpaca, esecuzione alla chiusura, costi 5 punti base per lato)

Configurazione di serie: momentum assoluto a 12 mesi, rientro RSI(2) a taglia ridotta, regime, orizzonte 60 sedute, contesto
economico (regole), volatilità di portafoglio 12%, stop sulla volatilità, uscita di trend della gabbia, presa di profitto
parziale (metà a +3%, scelta con `bun run sweep`, walk-forward 2021-2023 → 2024-2026).

| Periodo | Variante | Rendimento | Perdita max | Trade | Vinti | Attesa/trade | Giorni + | Mesi + |
|---|---|---|---|---|---|---|---|---|
| 2021-2026 (1327 sedute) | **di serie** | **+65,1%** | **-7,6%** | 162 | 43% | +1,35% | 53% | 55% |
| | trend puro (senza presa di profitto) | +66,2% | -7,9% | 165 | 40% | +2,06% | 52% | 55% |
| | presa di profitto totale +5% | +42,1% | -7,4% | 281 | 49% | +0,96% | 52% | 56% |
| | vecchia politica: obiettivo +3%/+4%, stop fisso -3% | +44,5% | -7,4% | 431 | 51% | +0,69% | 53% | 53% |
| | SPY / 60-40 / GTAA Faber | +79,8% / +34,3% / +84,7% | SPY -25% nel 2022 | | | | | |
| 2024-2026 (497 sedute) | **di serie** | +12,8% | -6,1% | 70 | 36% | +0,18% | 54% | 65% |
| | trend puro | +17,6% | -5,6% | 66 | 30% | +1,36% | 54% | 74% |
| | SPY / 60-40 / GTAA Faber | +26,0% / +15,5% / +15,6% | | | | | | |

Il complessivo è positivo in tutti i periodi (2021-2026: +69.500 $ dai trade chiusi su 100.000 $, vinti +104.300 $,
persi -34.700 $). Giorno per giorno si chiude in positivo il 53-54% delle volte: nessuna strategia pubblicata fa meglio di
così con costanza, il guadagno sta nel fatto che i giorni buoni valgono più dei cattivi. Qualunque vantaggio di backtest
va tagliato del 25-50% (McLean-Pontiff). Nel backtest le crypto entrano solo con `--crypto`; nel motore reale sono di serie per scelta dell'utente (`--no-crypto` per toglierle).

`bun run sweep [--days 2600]` ripete l'ottimizzazione prudente: 40 combinazioni (presa di profitto, trailing, stop,
finestra del momentum), scelte sul primo 60% dello storico e verificate sul resto.

### Kronos, il sidecar Python

Kronos (modello open source per candele OHLCV, MIT) è parte del motore: `installa-kronos.cmd` (Windows) o `installa-kronos.sh`
scarica il codice del modello in `tools/kronos/kronos-src`, crea `tools/kronos/venv` e installa torch per CPU. Da lì in poi
`bun run agents` **accende il sidecar da solo** (`tools/kronos/server.py --model small --port 8765`), gli manda le barre che ha
già scaricato (niente chiavi Alpaca nel sidecar) e salva le proiezioni del giorno in `state/previsioni.json`. I pesi del modello
arrivano da Hugging Face al primo avvio (1-2 minuti); il motore intanto lavora senza proiezioni e lo dice nella dashboard.
`--kronos http://host:porta` usa un sidecar già acceso, `--no-kronos` lo esclude. Modello, porta e campioni in `AGENTS.kronos`.

### Dashboard: scheda per titolo

«Titolo per titolo»: scegli un titolo (posizioni e custodi per primi) e vedi le ultime 120 candele con medie 20/50/200, carico e
stop del motore, le operazioni fatte (▲▼ dal diario), e lo **scenario di Kronos**: il percorso previsto per le prossime sedute con il
cono d'incertezza (una volatilità e mezza). «Chiedi agli agenti adesso» fa valutare quel titolo a tutti gli agenti con i prezzi
di quel momento (`/api/valuta`): voti, punteggio, cosa direbbe la gabbia, livelli, custode. È una prova a secco: nessun ordine
parte dalla dashboard. Dati: `/api/bars`, `/api/previsioni`, `/api/journal`.

## Sveglie (modalità classica)

Si sveglia 4 volte al giorno (ora di Roma, lun-ven), legge il conto, chiede una decisione a `claude -p`,
la passa nella gabbia di regole, invia gli ordini ammessi, scrive il testimone e manda il resoconto su Telegram.
Solo paper: l'endpoint `https://paper-api.alpaca.markets` è scritto nel codice.

## Avvio

```sh
cp secrets.example.ts secrets.ts   # poi riempi i campi (chiavi paper PK..., token e chat id del bot)
bun run telegram-chat-id [--scrivi]   # dopo aver scritto /start al bot: stampa il chat id; con --scrivi lo mette in secrets.ts (su Windows: doppio clic su imposta-telegram.cmd)
bun run schedule                   # resta acceso, ogni 30 s lancia la sveglia dovuta
bun run once [--slot 15:40] [--force]   # una sveglia subito (la più recente di oggi)
bun run status                     # lock, ultimo testimone, conto
bun run breaker-reset              # riarma l'interruttore sulla perdita (dopo che hai guardato cosa è successo)
bun run backtest [--days 500] [--riarmo 5]   # rigioca sulle chiusure storiche la gabbia col metodo trend e poi il motore degli agenti (4 varianti)
bun run cloud-wake                 # il comando delle sessioni cloud programmate (vedi sotto)
bun test                           # test con broker e cervello finti
```

`--fake` su ogni comando usa broker finto (`state/fake/fake-broker.json`), cervello finto e Telegram su file
(`state/fake/telegram-outbox.log`). Con `--fake` si può anche passare `--now 2026-09-24T15:41:00+02:00`.

| Sveglia | Ora Roma | Cosa fa |
|---|---|---|
| Briefing | 09:00 | legge il conto, fissa il piano, nessun ordine |
| Apertura | 15:40 | l'unica che compra; uscite di trend sulle chiusure di ieri |
| Metà seduta | 18:30 | controlla, vende solo con un motivo, stop |
| Chiusura | 21:40 | chiude la giornata e fa il resoconto (il venerdì anche il riepilogo) |

## Regole della gabbia (`src/cage.ts`, numeri in `src/config.ts`)

- Universo fisso: SPY QQQ IWM AAPL MSFT NVDA GLD TLT. Niente short, niente leva, solo azioni intere.
- Massimo 5 titoli, massimo 20% del conto per titolo, e meno se il titolo è volatile: valore × volatilità giornaliera (20 giorni) ≤ 0,25% del conto.
- Gruppo tecnologia (QQQ NVDA MSFT AAPL) al massimo 35% insieme.
- Metodo dichiarato: trend following lento. Si compra solo se l'ultima chiusura è sopra la media a 50 **e** a 200 giorni
  (e il prezzo del momento sopra la 50); tra i candidati il modello preferisce il momentum a 6 mesi.
- Uscita normale: alla sveglia di apertura il codice vende tutta la posizione se ieri ha chiuso sotto la media a 50 giorni.
- Acquisti solo alla sveglia di apertura. Le medie si calcolano su sedute finite: la barra di oggi non entra.
- Stop di protezione contro i crolli: 2,5 × volatilità giornaliera × √5, al mezzo punto, tra il 5% e il 10% dal prezzo di carico
  (SPY ~5%, AAPL/MSFT ~6-7%, titoli nervosi 10%). Lo vende il codice a ogni sveglia **e** c'è uno stop GTC su Alpaca.
- Calendario di Fed e trimestrali (`src/events.ts`, **da aggiornare a mano**): niente acquisti nel giorno della Fed,
  né di AAPL/MSFT/NVDA nei 2 giorni di borsa prima dei conti. Il lunedì al briefing arriva un promemoria se mancano date future.
- Voto a maggioranza: `claude -p` risponde 3 volte in parallelo; passa solo l'ordine proposto da almeno 2 risposte,
  con la quantità più prudente. Con meno di 2 risposte valide nessun ordine del modello (stop e uscite di trend restano).
- Registro degli errori (`state/lessons.json`): dopo uno stop loss niente riacquisto per 5 giorni di borsa; due rifiuti di Alpaca uguali bloccano quel titolo-lato per 5 giorni.
- Interruttore (`state/breaker.json`): -5% dal massimo blocca gli acquisti per 5 giorni di borsa (o finché non lanci `breaker-reset`), poi si riarma da solo; -2% in giornata li blocca fino a domani.
- Nessun ordine nel briefing, a mercato chiuso o con più di 20 minuti di ritardo.

## Nel cloud, a PC spento

Ogni sveglia è una sessione cloud programmata che lancia `bun run cloud-wake`:
lo stato (testimone, lock, registro, interruttore, log) vive sul branch `stato` di questo repo,
la sveglia viene "prenotata" con un push (due sessioni insieme: ne lavora una sola) e lo stato
si salva appena il testimone è scritto, ogni 15 secondi e alla fine, anche su SIGTERM.
Conta solo la prenotazione arrivata su GitHub, e scade 20 minuti dopo l'orario della sveglia.
Ogni comando git ha un timeout: se GitHub non risponde la sveglia lavora lo stesso (gli ordini doppi
li blocca l'id dell'ordine) e se lo stato non arriva su GitHub lo dice su Telegram.
Nella routine il comando va lanciato con un timeout di almeno 25 minuti: aspetta l'orario e poi lavora. Le chiavi arrivano come variabili d'ambiente:
`ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
L'ambiente cloud deve poter raggiungere `paper-api.alpaca.markets`, `data.alpaca.markets` e `api.telegram.org`.
Il repo deve essere **privato**: il branch `stato` contiene conto e posizioni.

## File

| File | Responsabilità |
|---|---|
| `src/config.ts` | endpoint, universo, limiti, orari |
| `src/guard.ts` | rifiuta di partire con endpoint o chiavi live |
| `src/slots.ts` | ora di Roma, ID sveglia, sveglie dovute e saltate |
| `src/broker/` | interfaccia, Alpaca REST v2, broker finto su file |
| `src/brain/` | `claude -p` senza strumenti con schema JSON, validazione, cervello finto |
| `src/cage.ts` | regole: universo, 5 titoli, 20% e volatilità, gruppo tech, medie 50/200, uscita di trend, stop, eventi, no short/leva, orari |
| `src/indicators.ts` | media mobile, volatilità, momentum |
| `src/lessons.ts` | registro degli errori |
| `src/journal.ts` | diario dei trade: contesto, fiducia e previsione all'ingresso, risultato all'uscita, statistiche; per i primi 90 giorni e 30 trade chiusi solo raccolta, poi blocchi su titoli e tipi di ingresso perdenti (solo restrittivi) |
| `src/breaker.ts` | interruttore sulla perdita |
| `src/stops.ts` | distanza dello stop dalla volatilità, uno stop GTC su Alpaca per ogni posizione |
| `src/events.ts` | calendario di Fed e trimestrali, blocchi e promemoria |
| `src/brain/vote.ts` | voto a maggioranza su più risposte del modello |
| `src/benchmark.ts` | confronto con SPY e con un 60/40 SPY/TLT comprati e tenuti |
| `src/backtest.ts` | la gabbia rigiocata sullo storico |
| `src/execute.ts` | invio con ID deterministico, verifica dopo timeout, mai doppioni |
| `src/lock.ts`, `src/reconcile.ts` | lock con le intenzioni, riconciliazione dopo una morte |
| `src/witness.ts` | testimone atomico in `state/witness.json` + copia in `state/history/` |
| `src/telegram.ts`, `src/report.ts` | messaggi, allarmi ⚠️, resoconto |
| `src/log.ts` | log in `logs/<sveglia>.log`, chiavi oscurate |
| `src/wake.ts` | il giro di una sveglia |
| `src/cli/` | `schedule`, `once`, `status`, `telegram-chat-id`, `breaker-reset`, `backtest`, `cloud-wake`, `agents`, `dashboard` |
| `src/agents/` | motore: `types`, `bus` (registro eventi), agenti `trend` `pullback` `regime` `horizon` `kronos`, `allocator`, `engine` (il giro) |
| `src/dashboard/` | server Bun (HTTP + WebSocket + Three.js locale) e pagina `index.html` |
| `tools/kronos/` | prova di Kronos sui dati Alpaca e sidecar `server.py` per l'agente |
| `docs/` | valutazione, risultati grezzi |
