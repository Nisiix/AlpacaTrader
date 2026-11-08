// Lancia `claude -p` (usato dal contesto economico per la lettura macro con ricerca web). Un processo per richiesta,
// con un tempo massimo: oltre, il processo si chiude e il contesto lavora con le sole regole sui dati.
export type Runner = (args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnRunner: Runner = async (args, stdin, timeoutMs) => {
  const proc = Bun.spawn(args, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};
