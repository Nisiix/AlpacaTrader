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

// Non lancia mai: se Telegram non risponde la sveglia va avanti e l'errore finisce nel log.
export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  constructor(
    private token: string,
    private chatId: string,
  ) {}

  async send(text: string): Promise<SendResult> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `Telegram ${res.status}: ${(await res.text()).slice(0, 200)}` };
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
