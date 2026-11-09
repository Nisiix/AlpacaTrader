export interface Secrets {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  // Facoltativo: bearer token dell'API di X (developer.x.com) per il sentiment dei titoli; vuoto = X non consultato.
  xBearerToken?: string;
  // Chiavi del conto REALE di Alpaca (iniziano con AK): solo conservate. Il motore opera sempre sul conto paper con
  // alpacaKeyId/alpacaSecretKey; queste non le usa nessuna parte del codice di trading.
  alpacaLiveKeyId?: string;
  alpacaLiveSecretKey?: string;
}
