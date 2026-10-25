import { PAPER_TRADING_URL } from "./config.ts";
import type { Secrets } from "./secrets-types.ts";

const ENDPOINT_ENV_VARS = ["APCA_API_BASE_URL", "ALPACA_BASE_URL", "ALPACA_ENDPOINT", "ALPACA_API_URL", "APCA_ENDPOINT"];

export class LiveEndpointError extends Error {}

function isPaper(url: string): boolean {
  try {
    return new URL(url).host === new URL(PAPER_TRADING_URL).host;
  } catch {
    return false;
  }
}

// Rifiuta di partire se qualcuno prova a puntare al conto vero. Non stampa mai i valori.
export function assertPaperOnly(env: Record<string, string | undefined>, secrets?: Secrets): void {
  for (const name of ENDPOINT_ENV_VARS) {
    const v = env[name];
    if (v && !isPaper(v)) throw new LiveEndpointError(`la variabile ${name} punta a un endpoint diverso dal paper: mi rifiuto di partire`);
  }
  if (!secrets) return;
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && /alpaca\.markets/i.test(v) && !isPaper(v)) {
      throw new LiveEndpointError(`il campo ${k} di secrets.ts contiene un endpoint diverso dal paper: mi rifiuto di partire`);
    }
  }
  // Le chiavi live di Alpaca iniziano con AK, quelle paper con PK.
  if (secrets.alpacaKeyId.startsWith("AK")) {
    throw new LiveEndpointError("la chiave in secrets.ts sembra una chiave live (inizia con AK): mi rifiuto di partire");
  }
}

export function assertPaperUrl(url: string): void {
  if (url !== PAPER_TRADING_URL) throw new LiveEndpointError("endpoint di trading diverso dal paper: mi rifiuto di partire");
}
