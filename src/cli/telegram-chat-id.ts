// bun run telegram-chat-id [--scrivi]: dopo aver scritto /start al bot, stampa il chat id da mettere in secrets.ts.
// Con --scrivi, se la chat è una sola, lo scrive da solo in secrets.ts (telegramChatId). Non stampa il token.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets, ROOT } from "../deps.ts";

const scrivi = process.argv.includes("--scrivi");
const s = await loadSecrets(true);
if (!s?.telegramBotToken) {
  console.error("manca telegramBotToken in secrets.ts");
  process.exit(2);
}
let chats = new Map<string, string>();
try {
  const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  const data: any = await res.json();
  for (const u of data.result ?? []) {
    const c = u.message?.chat ?? u.my_chat_member?.chat;
    if (c) chats.set(String(c.id), c.username ?? c.title ?? c.first_name ?? "");
  }
} catch (e) {
  console.error(`Telegram non raggiungibile: ${(e as Error).name}`);
  process.exit(2);
}
if (chats.size === 0) {
  console.log("Nessun messaggio trovato: apri Telegram, cerca il bot, scrivi /start e rilancia.");
  process.exit(1);
}
for (const [id, name] of chats) console.log(`chat id ${id} (${name})`);
if (!scrivi) process.exit(0);
if (chats.size > 1) {
  console.log("Più chat trovate: copia quella giusta in secrets.ts (telegramChatId).");
  process.exit(1);
}
const id = [...chats.keys()][0]!;
if (s.telegramChatId && s.telegramChatId !== id) {
  console.log(`secrets.ts ha già telegramChatId ${s.telegramChatId}: non lo cambio.`);
  process.exit(0);
}
const p = join(ROOT, "secrets.ts");
const src = readFileSync(p, "utf8");
const out = src.replace(/telegramChatId:\s*"[^"]*"/, `telegramChatId: "${id}"`);
if (out === src && !s.telegramChatId) {
  console.error("non trovo il campo telegramChatId in secrets.ts");
  process.exit(2);
}
writeFileSync(p, out);
console.log(`Scritto telegramChatId ${id} in secrets.ts.`);
