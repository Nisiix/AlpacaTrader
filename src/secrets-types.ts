export interface Secrets {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  // Facoltativo: bearer token dell'API di X (developer.x.com) per il sentiment dei titoli; vuoto = X non consultato.
  xBearerToken?: string;
}
