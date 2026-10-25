import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Oscura le chiavi ovunque passino: file di log, console, messaggi.
export class Redactor {
  private secrets: string[];
  constructor(secrets: string[]) {
    this.secrets = secrets.filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  }
  apply(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("***");
    // Token Telegram dentro un URL, nel caso arrivasse da un errore di rete.
    return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot***");
  }
}

export class Logger {
  constructor(
    private file: string,
    private redactor: Redactor,
    private echo = true,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  info(msg: string) {
    this.write("INFO", msg);
  }
  warn(msg: string) {
    this.write("WARN", msg);
  }
  error(msg: string) {
    this.write("ERRORE", msg);
  }

  private write(level: string, msg: string) {
    const line = this.redactor.apply(`${new Date().toISOString()} [${level}] ${msg}`);
    try {
      appendFileSync(this.file, line + "\n");
    } catch {
      // Se il disco non scrive non possiamo farci niente qui: almeno la console.
    }
    if (this.echo) console.log(line);
  }
}
