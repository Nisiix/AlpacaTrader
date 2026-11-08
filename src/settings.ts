import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAPER_TRADING_URL } from "./config.ts";
import type { Secrets } from "./secrets-types.ts";

// Le impostazioni dalla dashboard: lettura mascherata (mai le chiavi in chiaro), prova delle chiavi, scrittura di
// secrets.ts. Il motore legge le chiavi all'avvio: dopo un salvataggio va riavviato. Solo chiavi paper (PK...).
export interface MaskedSettings {
  alpacaKeyId: string; // mascherata: "PKZL…MFJ" oppure ""
  alpacaSecretKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  xBearerToken: string;
  file: boolean; // secrets.ts esiste
}

const mask = (v: string) => (v ? (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-3)}` : "•".repeat(v.length)) : "");

export function readSecretsFile(root: string): Partial<Secrets> {
  const p = join(root, "secrets.ts");
  if (!existsSync(p)) return {};
  const src = readFileSync(p, "utf8");
  const get = (k: keyof Secrets) => src.match(new RegExp(`${k}:\\s*"([^"]*)"`))?.[1] ?? "";
  return { alpacaKeyId: get("alpacaKeyId"), alpacaSecretKey: get("alpacaSecretKey"), telegramBotToken: get("telegramBotToken"), telegramChatId: get("telegramChatId"), xBearerToken: get("xBearerToken") };
}

export function maskedSettings(root: string): MaskedSettings {
  const s = readSecretsFile(root);
  return { alpacaKeyId: mask(s.alpacaKeyId ?? ""), alpacaSecretKey: mask(s.alpacaSecretKey ?? ""), telegramBotToken: mask(s.telegramBotToken ?? ""), telegramChatId: s.telegramChatId ?? "", xBearerToken: mask(s.xBearerToken ?? ""), file: existsSync(join(root, "secrets.ts")) };
}

// Scrive secrets.ts: i campi vuoti nella richiesta lasciano il valore già presente (così si può cambiare solo Telegram).
export function writeSecretsFile(root: string, incoming: Partial<Secrets>): { ok: true; cambiati: string[] } | { ok: false; errore: string } {
  const cur = readSecretsFile(root);
  const next: Secrets = {
    alpacaKeyId: (incoming.alpacaKeyId ?? "").trim() || cur.alpacaKeyId || "",
    alpacaSecretKey: (incoming.alpacaSecretKey ?? "").trim() || cur.alpacaSecretKey || "",
    telegramBotToken: (incoming.telegramBotToken ?? "").trim() || cur.telegramBotToken || "",
    telegramChatId: (incoming.telegramChatId ?? "").trim() || cur.telegramChatId || "",
    xBearerToken: incoming.xBearerToken === "-" ? "" : (incoming.xBearerToken ?? "").trim() || cur.xBearerToken || "",
  };
  if (next.alpacaKeyId && !/^PK[A-Z0-9]+$/i.test(next.alpacaKeyId)) return { ok: false, errore: "la key id di Alpaca deve essere una chiave PAPER (inizia con PK)" };
  if (next.telegramBotToken && !/^\d+:[A-Za-z0-9_-]+$/.test(next.telegramBotToken)) return { ok: false, errore: "il token Telegram ha la forma 123456789:AAAA…" };
  if (next.telegramChatId && !/^-?\d+$/.test(next.telegramChatId)) return { ok: false, errore: "il chat id Telegram è un numero" };
  const cambiati = (Object.keys(next) as (keyof Secrets)[]).filter((k) => (cur[k] ?? "") !== next[k]);
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const body = `// Scritto dalla dashboard (Impostazioni). Usa SOLO chiavi paper (iniziano con PK). L'endpoint non si configura: è scritto nel codice.
import type { Secrets } from "./src/secrets-types.ts";

export const secrets: Secrets = {
  alpacaKeyId: "${esc(next.alpacaKeyId)}",
  alpacaSecretKey: "${esc(next.alpacaSecretKey)}",
  telegramBotToken: "${esc(next.telegramBotToken)}",
  telegramChatId: "${esc(next.telegramChatId)}",
  xBearerToken: "${esc(next.xBearerToken ?? "")}",
};
`;
  writeFileSync(join(root, "secrets.ts"), body);
  return { ok: true, cambiati };
}

// Prova delle chiavi: Alpaca (conto paper) e Telegram (getMe e, con il chat id, un messaggio di prova).
export async function testSettings(root: string, incoming: Partial<Secrets>, timeoutMs = 10_000): Promise<{ alpaca: string; telegram: string; chatId?: string }> {
  const cur = readSecretsFile(root);
  const k = (incoming.alpacaKeyId ?? "").trim() || cur.alpacaKeyId || "";
  const s = (incoming.alpacaSecretKey ?? "").trim() || cur.alpacaSecretKey || "";
  const tok = (incoming.telegramBotToken ?? "").trim() || cur.telegramBotToken || "";
  const chat = (incoming.telegramChatId ?? "").trim() || cur.telegramChatId || "";
  let alpaca = "non impostato";
  if (k && s) {
    try {
      const r = await fetch(`${PAPER_TRADING_URL}/v2/account`, { headers: { "APCA-API-KEY-ID": k, "APCA-API-SECRET-KEY": s }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const a = (await r.json()) as { status?: string; equity?: string; cash?: string };
        alpaca = `ok: conto ${a.status ?? "?"}, patrimonio ${Number(a.equity ?? 0).toFixed(2)} $, liquidità ${Number(a.cash ?? 0).toFixed(2)} $`;
      } else alpaca = `rifiutate: Alpaca ${r.status}${r.status === 401 || r.status === 403 ? " (chiave o secret sbagliati, o non del conto paper)" : ""}`;
    } catch (e) {
      alpaca = `non raggiungibile: ${(e as Error).message}`;
    }
  }
  let telegram = "non impostato";
  let chatId: string | undefined;
  if (tok) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`, { signal: AbortSignal.timeout(timeoutMs) });
      const d = (await r.json()) as { ok?: boolean; result?: { username?: string } };
      if (!d.ok) telegram = "token rifiutato da Telegram";
      else {
        telegram = `ok: bot @${d.result?.username ?? "?"}`;
        if (!chat) {
          const u = await fetch(`https://api.telegram.org/bot${tok}/getUpdates`, { signal: AbortSignal.timeout(timeoutMs) });
          const du = (await u.json()) as { result?: { message?: { chat?: { id?: number } }; my_chat_member?: { chat?: { id?: number } } }[] };
          const ids = [...new Set((du.result ?? []).map((x) => x.message?.chat?.id ?? x.my_chat_member?.chat?.id).filter((x): x is number => typeof x === "number"))];
          if (ids.length === 1) chatId = String(ids[0]);
          telegram += ids.length === 1 ? `, chat id trovato: ${ids[0]}` : ids.length ? `, più chat trovate: ${ids.join(", ")}` : ", nessuna chat: scrivi /start al bot e riprova";
        } else {
          const m = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: "✅ Agenti Alpaca: prova dalle impostazioni riuscita." }), signal: AbortSignal.timeout(timeoutMs) });
          telegram += m.ok ? ", messaggio di prova inviato" : `, messaggio non inviato (chat id ${chat} rifiutato)`;
        }
      }
    } catch (e) {
      telegram = `non raggiungibile: ${(e as Error).message}`;
    }
  }
  return { alpaca, telegram, chatId };
}
