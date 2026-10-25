import type { Brain, BrainInput, Decision } from "./types.ts";

// Cervello finto: risponde sempre la stessa cosa.
export const FAKE_DECISION: Decision = {
  orders: [
    { symbol: "SPY", side: "buy", qty: 10, why: "Esposizione di base all'indice americano.", confidence: "media", expect: "SPY resta sopra la media a 50 giorni nelle prossime due settimane." },
    { symbol: "GLD", side: "buy", qty: 5, why: "Un po' di oro come contrappeso.", confidence: "bassa", expect: "GLD si muove poco e attenua i cali." },
  ],
  reasoning: "Risposta fissa del cervello finto. Compra SPY e GLD in piccole quantità. Serve solo a provare il giro della sveglia.",
  plan_next: "Controllare che gli ordini siano stati eseguiti e che non ci siano stop loss.",
};

export class FakeBrain implements Brain {
  readonly name = "finto";
  constructor(private decision: Decision = FAKE_DECISION) {}
  async decide(_input: BrainInput): Promise<Decision> {
    return structuredClone(this.decision);
  }
}
