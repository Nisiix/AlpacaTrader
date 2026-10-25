import { isObject } from "../fsutil.ts";
import { BrainError, type Decision, type ProposedOrder } from "./types.ts";

// Schema passato a `claude -p --json-schema`. Il codice lo rivalida comunque: il modello propone, il codice dispone.
export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["orders", "reasoning", "plan_next"],
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "side", "qty", "why"],
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          qty: { type: "integer", minimum: 1 },
          why: { type: "string" },
        },
      },
    },
    reasoning: { type: "string" },
    plan_next: { type: "string" },
  },
};

// Valida la forma generale. Gli ordini singoli strani passano come proposte: li rifiuta la gabbia con un motivo.
export function validateDecision(v: unknown): Decision {
  if (!isObject(v)) throw new BrainError("la risposta non è un oggetto JSON");
  if (!Array.isArray(v.orders)) throw new BrainError("manca il campo orders");
  if (typeof v.reasoning !== "string") throw new BrainError("manca il campo reasoning");
  if (typeof v.plan_next !== "string") throw new BrainError("manca il campo plan_next");
  const orders: ProposedOrder[] = v.orders.map((o: unknown) => {
    const r = isObject(o) ? o : {};
    return {
      symbol: typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : String(r.symbol ?? "?"),
      side: typeof r.side === "string" ? r.side.trim().toLowerCase() : String(r.side ?? "?"),
      qty: typeof r.qty === "number" ? r.qty : Number.NaN,
      why: typeof r.why === "string" ? r.why : "",
    };
  });
  return { orders, reasoning: v.reasoning, plan_next: v.plan_next };
}
