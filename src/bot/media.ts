import { extname } from 'node:path'

export const mediaRules = {
  sendPhoto: { extensions: ['.jpg', '.jpeg', '.png', '.webp'], maxBytes: 10 * 1024 * 1024 },
  sendVideo: { extensions: ['.mp4', '.mov', '.m4v'], maxBytes: 50 * 1024 * 1024 },
  sendAudio: { extensions: ['.mp3', '.m4a'], maxBytes: 50 * 1024 * 1024 },
  sendVoice: { extensions: ['.ogg', '.oga', '.mp3', '.m4a'], maxBytes: 50 * 1024 * 1024 },
  sendDocument: { extensions: [] as string[], maxBytes: 50 * 1024 * 1024 },
} as const

export function validateMediaFile(kind: string, filename: string, size: number): void {
  const rule = mediaRules[kind as keyof typeof mediaRules]
  if (!rule) throw new Error('Этот блок не поддерживает загрузку файла.')
  if (rule.extensions.length && !(rule.extensions as readonly string[]).includes(extname(filename).toLowerCase())) throw new Error(`Неподходящий формат. Разрешены: ${rule.extensions.join(', ')}.`)
  if (size <= 0) throw new Error('Файл пуст.')
  if (size > rule.maxBytes) throw new Error(`Файл слишком большой. Для этого типа допустимо до ${rule.maxBytes / 1024 / 1024} МБ.`)
}

export function validateHttpUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Укажите полный URL, начинающийся с https:// или http://.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только HTTP и HTTPS без пароля в адресе.')
  return url
}
