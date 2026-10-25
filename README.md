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
bun run backtest [--days 500]      # rigioca gabbia e metodo sulle chiusure storiche
bun run cloud-wake                 # il comando delle sessioni cloud programmate (vedi sotto)
bun test                           # test con broker e cervello finti
```

`--fake` su ogni comando usa broker finto (`state/fake/fake-broker.json`), cervello finto e Telegram su file
(`state/fake/telegram-outbox.log`). Con `--fake` si può anche passare `--now 2026-09-24T15:41:00+02:00`.

| Sveglia | Ora Roma | Cosa fa |
|---|---|---|
| Briefing | 09:00 | legge il conto, fissa il piano, nessun ordine |
| Apertura | 15:40 | entra o aggiusta |
| Metà seduta | 18:30 | controlla, stop loss |
| Chiusura | 21:40 | chiude la giornata e fa il resoconto |

## Regole della gabbia (`src/cage.ts`, numeri in `src/config.ts`)

- Universo fisso: SPY QQQ IWM AAPL MSFT NVDA GLD TLT. Niente short, niente leva, solo azioni intere.
- Massimo 5 titoli, massimo 20% del conto per titolo, e meno se il titolo è volatile: valore × volatilità giornaliera (20 giorni) ≤ 0,25% del conto.
- Gruppo tecnologia (QQQ NVDA MSFT AAPL) al massimo 35% insieme.
- Metodo dichiarato: si compra solo sopra la media mobile a 50 giorni.
- Stop loss al -3% dal prezzo di carico: lo vende il codice a ogni sveglia **e** c'è uno stop GTC su Alpaca per ogni posizione.
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
| `src/cage.ts` | regole: universo, 5 titoli, 20% e volatilità, gruppo tech, trend, stop loss 3%, no short/leva, orari |
| `src/indicators.ts` | media mobile, volatilità, momentum |
| `src/lessons.ts` | registro degli errori |
| `src/breaker.ts` | interruttore sulla perdita |
| `src/stops.ts` | uno stop GTC su Alpaca per ogni posizione |
| `src/benchmark.ts` | confronto con SPY compra e tieni |
| `src/backtest.ts` | la gabbia rigiocata sullo storico |
| `src/execute.ts` | invio con ID deterministico, verifica dopo timeout, mai doppioni |
| `src/lock.ts`, `src/reconcile.ts` | lock con le intenzioni, riconciliazione dopo una morte |
| `src/witness.ts` | testimone atomico in `state/witness.json` + copia in `state/history/` |
| `src/telegram.ts`, `src/report.ts` | messaggi, allarmi ⚠️, resoconto |
| `src/log.ts` | log in `logs/<sveglia>.log`, chiavi oscurate |
| `src/wake.ts` | il giro di una sveglia |
| `src/cli/` | `schedule`, `once`, `status`, `telegram-chat-id`, `breaker-reset`, `backtest`, `cloud-wake` |
