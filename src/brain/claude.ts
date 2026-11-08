import { BRAIN_TIMEOUT_MS } from "../config.ts";
import { buildPrompt, SYSTEM_PROMPT } from "./prompt.ts";
import { DECISION_SCHEMA, validateDecision } from "./schema.ts";
import { BrainError, type Brain, type BrainInput, type Decision } from "./types.ts";

export type Runner = (args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnRunner: Runner = async (args, stdin, timeoutMs) => {
  const proc = Bun.spawn(args, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

// Estrae la decisione dall'output di `claude -p --output-format json`.
export function parseClaudeOutput(stdout: string): Decision {
  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    throw new BrainError(`output di claude non è JSON valido (forse troncato): ${(e as Error).message}`);
  }
  if (envelope?.is_error) throw new BrainError(`claude ha risposto con un errore: ${String(envelope.result ?? envelope.subtype).slice(0, 200)}`);
  if (envelope?.structured_output !== undefined) return validateDecision(envelope.structured_output);
  const text = typeof envelope?.result === "string" ? envelope.result : stdout;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new BrainError("nessun oggetto JSON nella risposta di claude");
  try {
    return validateDecision(JSON.parse(m[0]));
  } catch (e) {
    if (e instanceof BrainError) throw e;
    throw new BrainError(`JSON della decisione non valido (forse troncato): ${(e as Error).message}`);
  }
}

// Claude Code headless: niente strumenti, niente sessioni salvate, risposta a schema fisso.
export class ClaudeBrain implements Brain {
  readonly name = "claude -p";
  constructor(private runner: Runner = spawnRunner) {}

  async decide(input: BrainInput): Promise<Decision> {
    const args = [
      "claude",
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(DECISION_SCHEMA),
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt", SYSTEM_PROMPT,
    ];
    let res;
    try {
      res = await this.runner(args, buildPrompt(input), BRAIN_TIMEOUT_MS);
    } catch (e) {
      throw new BrainError(`impossibile lanciare claude: ${(e as Error).message}`);
    }
    if (res.code !== 0 && !res.stdout.trim()) throw new BrainError(`claude è uscito con codice ${res.code}: ${res.stderr.slice(0, 200)}`);
    return parseClaudeOutput(res.stdout);
  }
}
