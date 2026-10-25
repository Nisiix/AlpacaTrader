# Agente di paper trading Alpaca

Si sveglia 4 volte al giorno (ora di Roma, lun-ven), legge il conto, chiede una decisione a `claude -p`,
la passa nella gabbia di regole, invia gli ordini ammessi, scrive il testimone e manda il resoconto su Telegram.
Solo paper: l'endpoint `https://paper-api.alpaca.markets` è scritto nel codice.

## Avvio

```sh
cp secrets.example.ts secrets.ts   # poi riempi i campi (chiavi paper PK..., token e chat id del bot)
bun run telegram-chat-id           # dopo aver scritto /start al bot: stampa il chat id
bun run schedule                   # resta acceso, ogni 30 s lancia la sveglia dovuta
bun run once [--slot 15:40] [--force]   # una sveglia subito (la più recente di oggi)
bun run status                     # lock, ultimo testimone, conto
bun run breaker-reset              # riarma l'interruttore sulla perdita (dopo che hai guardato cosa è successo)
bun run backtest [--days 500] [--riarmo 5]   # rigioca gabbia e metodo sulle chiusure storiche
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
- Interruttore (`state/breaker.json`): -5% dal massimo blocca gli acquisti finché non lanci `breaker-reset`; -2% in giornata li blocca fino a domani.
- Nessun ordine nel briefing, a mercato chiuso o con più di 20 minuti di ritardo.

## Nel cloud, a PC spento

Ogni sveglia è una sessione cloud programmata che lancia `bun run cloud-wake`:
lo stato (testimone, lock, registro, interruttore, log) vive sul branch `stato` di questo repo,
la sveglia viene "prenotata" con un push (due sessioni insieme: ne lavora una sola) e lo stato
si salva ogni 15 secondi e alla fine. Le chiavi arrivano come variabili d'ambiente:
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
| `src/cli/` | `schedule`, `once`, `status`, `telegram-chat-id`, `breaker-reset`, `backtest`, `cloud-wake` |
