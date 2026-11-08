import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TELEGRAM_TIMEOUT_MS } from "./config.ts";

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface Notifier {
  readonly name: string;
  send(text: string): Promise<SendResult>;
}

// Divide un testo in parti da al massimo `max` caratteri, tagliando a fine riga quando si può (al massimo 5 parti).
export function dividiMessaggio(text: string, max = 4000): string[] {
  const parti: string[] = [];
  let resto = text;
  while (resto.length > max && parti.length < 4) {
    let taglio = resto.lastIndexOf("\n", max);
    if (taglio < max / 2) taglio = max;
    parti.push(resto.slice(0, taglio));
    resto = resto.slice(taglio).replace(/^\n/, "");
  }
  parti.push(resto.length > max ? `${resto.slice(0, max - 20)}\n… (continua in dashboard)` : resto);
  return parti.filter((x) => x.length > 0);
}

// Non lancia mai: se Telegram non risponde il motore va avanti e l'errore finisce nel log.
export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  constructor(
    private token: string,
    private chatId: string,
  ) {}

  async send(text: string): Promise<SendResult> {
    try {
      // Telegram accetta al massimo 4096 caratteri per messaggio: un riepilogo lungo parte in più messaggi.
      for (const parte of dividiMessaggio(text)) {
        const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text: parte, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `Telegram ${res.status}: ${(await res.text()).slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) {
      // Non includere l'URL: contiene il token.
      return { ok: false, error: `Telegram non raggiungibile: ${(e as Error).name}` };
    }
  }
}

// Usato con --fake o quando il bot non è ancora configurato: i messaggi finiscono in un file.
export class FileNotifier implements Notifier {
  readonly name = "file";
  constructor(readonly file: string) {}
  async send(text: string): Promise<SendResult> {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `----- ${new Date().toISOString()}\n${text}\n`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
