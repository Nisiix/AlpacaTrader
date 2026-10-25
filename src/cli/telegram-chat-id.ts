// bun run telegram-chat-id: dopo aver scritto /start al bot, stampa il chat id da mettere in secrets.ts. Non stampa il token.
import { loadSecrets } from "../deps.ts";

const s = await loadSecrets(true);
if (!s?.telegramBotToken) {
  console.error("manca telegramBotToken in secrets.ts");
  process.exit(2);
}
try {
  const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  const data: any = await res.json();
  const chats = new Map<string, string>();
  for (const u of data.result ?? []) {
    const c = u.message?.chat ?? u.my_chat_member?.chat;
    if (c) chats.set(String(c.id), c.username ?? c.title ?? c.first_name ?? "");
  }
  if (chats.size === 0) console.log("Nessun messaggio trovato: scrivi /start al bot e riprova.");
  for (const [id, name] of chats) console.log(`chat id ${id} (${name})`);
} catch (e) {
  console.error(`Telegram non raggiungibile: ${(e as Error).name}`);
  process.exit(2);
}
