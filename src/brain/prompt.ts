import { LIMITS, UNIVERSE } from "../config.ts";
import type { BrainInput } from "./types.ts";

export const SYSTEM_PROMPT = `Sei il cervello di un agente di paper trading. Non hai strumenti e non conversi.
Rispondi SOLO con un oggetto JSON conforme allo schema: orders, reasoning, plan_next. Tutto in italiano.
- orders: lista di {symbol, side ("buy"|"sell"), qty (intero), why (una frase)}. Può essere vuota.
- reasoning: da tre a cinque frasi sul perché.
- plan_next: cosa controllare alla prossima sveglia.
Le regole di rischio sono applicate dal codice dopo di te e scartano tutto ciò che le viola, quindi rispettale:
universo ${UNIVERSE.join(" ")}; massimo ${LIMITS.maxPositions} titoli; massimo ${LIMITS.maxPositionPct * 100}% del conto per titolo;
stop loss automatico al ${LIMITS.stopLossPct * 100}% sotto il prezzo di carico; niente short, niente leva, solo azioni intere;
nessun ordine nel briefing o a mercato chiuso.`;

export function buildPrompt(input: BrainInput): string {
  const payload = {
    sveglia: input.runId,
    tipo: input.slotLabel,
    mercatoAperto: input.clock.isOpen,
    testimonePrecedente: input.previousWitness,
    conto: input.account,
    posizioni: input.positions,
    ordiniUltime48h: input.recentOrders,
    prezzi: input.prices,
  };
  return `Stato attuale (JSON):\n${JSON.stringify(payload, null, 2)}\n\nDecidi. Rispondi solo con il JSON.`;
}
