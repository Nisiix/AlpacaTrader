# Agente di paper trading Alpaca

Si sveglia 4 volte al giorno (ora di Roma, lun-ven), legge il conto, chiede una decisione a `claude -p`,
la passa nella gabbia di regole, invia gli ordini ammessi, scrive il testimone e manda il resoconto su Telegram.
Solo paper: l'endpoint `https://paper-api.alpaca.markets` è scritto nel codice.

## Avvio

```sh
cp secrets.example.ts secrets.ts   # poi riempi i campi (chiavi paper PK..., token e chat id del bot)
bun run telegram-chat-id           # dopo aver scritto /start al bot: stampa il chat id
bun run schedule                   # resta acceso, ogni 30 s lancia la sveglia dovuta
bun run once [--slot 15:30] [--force]   # una sveglia subito (la più recente di oggi)
bun run status                     # lock, ultimo testimone, conto
bun test                           # test con broker e cervello finti
```

`--fake` su ogni comando usa broker finto (`state/fake/fake-broker.json`), cervello finto e Telegram su file
(`state/fake/telegram-outbox.log`). Con `--fake` si può anche passare `--now 2026-09-24T15:31:00+02:00`.

| Sveglia | Ora Roma | Cosa fa |
|---|---|---|
| Briefing | 09:00 | legge il conto, fissa il piano, nessun ordine |
| Apertura | 15:30 | entra o aggiusta |
| Metà seduta | 18:30 | controlla, stop loss |
| Chiusura | 21:40 | chiude la giornata e fa il resoconto |

## File

| File | Responsabilità |
|---|---|
| `src/config.ts` | endpoint, universo, limiti, orari |
| `src/guard.ts` | rifiuta di partire con endpoint o chiavi live |
| `src/slots.ts` | ora di Roma, ID sveglia, sveglie dovute e saltate |
| `src/broker/` | interfaccia, Alpaca REST v2, broker finto su file |
| `src/brain/` | `claude -p` senza strumenti con schema JSON, validazione, cervello finto |
| `src/cage.ts` | regole: universo, 5 titoli, 20%, stop loss 3%, no short/leva, solo interi, orari |
| `src/execute.ts` | invio con ID deterministico, verifica dopo timeout, mai doppioni |
| `src/lock.ts`, `src/reconcile.ts` | lock con le intenzioni, riconciliazione dopo una morte |
| `src/witness.ts` | testimone atomico in `state/witness.json` + copia in `state/history/` |
| `src/telegram.ts`, `src/report.ts` | messaggi, allarmi ⚠️, resoconto |
| `src/log.ts` | log in `logs/<sveglia>.log`, chiavi oscurate |
| `src/wake.ts` | il giro di una sveglia |
| `src/cli/` | `schedule`, `once`, `status`, `telegram-chat-id` |
