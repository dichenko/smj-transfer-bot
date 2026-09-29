import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required.`);
  return value;
}

function optionalInteger(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function optionalId(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be a numeric ID.`);
  return value;
}

function optionalString(name) {
  const value = process.env[name]?.trim();
  return value || null;
}

function identifierSet(name) {
  const raw = process.env[name]?.trim() ?? '';
  if (!raw) return new Set();

  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !/^-?\d+$/.test(value))) {
    throw new Error(`${name} must be a comma-separated list of numeric IDs.`);
  }
  return new Set(values);
}

function webhookSecret(name) {
  const value = required(name);
  if (!/^[A-Za-z0-9_-]{5,256}$/.test(value)) {
    throw new Error(`${name} must contain 5-256 letters, numbers, _ or -.`);
  }
  return value;
}

export const config = Object.freeze({
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  telegramApiRoot: optionalString('TELEGRAM_API_ROOT'),
  telegramSourceChatId: optionalId('TELEGRAM_SOURCE_CHAT_ID'),
  maxToken: required('MAX_BOT_TOKEN'),
  maxTargetChatId: optionalId('MAX_TARGET_CHAT_ID'),
  maxWebhookUrl: required('MAX_WEBHOOK_URL'),
  maxWebhookSecret: webhookSecret('MAX_WEBHOOK_SECRET'),
  telegramAllowedUserIds: identifierSet('TELEGRAM_ALLOWED_USER_IDS'),
  maxAllowedUserIds: identifierSet('MAX_ALLOWED_USER_IDS'),
  adminTelegramUserIds: identifierSet('ADMIN_TELEGRAM_USER_IDS'),
  adminWebUrl: optionalString('ADMIN_WEB_URL'),
  adminPort: optionalInteger('ADMIN_PORT') ?? 3700,
  databasePath: optionalString('DATABASE_PATH') ?? './data/bridge.sqlite',
  appPort: optionalInteger('APP_PORT') ?? 3600,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logFile: optionalString('LOG_FILE') ?? '/app/logs/bridge.log.txt'
});
