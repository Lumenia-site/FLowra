import { safeStorage } from 'electron'

export function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное хранилище ключей недоступно. Разблокируйте связку ключей и повторите попытку.')
  return safeStorage.encryptString(token).toString('base64')
}

export function decryptToken(value: string | null): string {
  if (!value) throw new Error('Добавьте Telegram Bot Token в настройках бота.')
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { throw new Error('Не удалось расшифровать токен. Добавьте его заново в настройках бота.') }
}

export function redactSecrets(message: string): string { return message.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '[токен скрыт]') }
