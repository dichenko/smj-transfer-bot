export function redactSensitive(value, telegramToken) {
  let text = String(value);
  if (telegramToken) text = text.replaceAll(telegramToken, '[redacted]');
  return text.replace(/(\/var\/lib\/telegram-bot-api\/)[^\s/'"]+/g, '$1[redacted]');
}
