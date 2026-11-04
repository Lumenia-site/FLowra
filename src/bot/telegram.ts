import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { NodeData, NodeKind } from '../shared/types'
import { buildTelegramPayload } from './handlers/telegramNodes'
import { validateMediaFile } from './media'
import { abortableDelay, renderData } from './variables'

export class TelegramError extends Error {
  readonly code: number
  readonly retryAfter: number
  readonly method: string
  constructor(method: string, code: number, description: string, retryAfter = 0) {
    const prefix = code === 401 ? 'Неверный токен бота. Проверьте его в BotFather.' : code === 409 ? 'Бот уже запущен в другом приложении или использует webhook. Остановите другой экземпляр.' : code === 403 ? 'Пользователь заблокировал бота или доступ к чату запрещён.' : `Telegram: ${description}`
    super(prefix)
    this.name = 'TelegramError'
    this.code = code
    this.method = method
    this.retryAfter = retryAfter
  }
}

interface ClientOptions { minInterval?: number; chatInterval?: number; retries?: number }

export class TelegramClient {
  private nextRequest = 0
  private nextChatRequest = new Map<string, number>()
  private options: Required<ClientOptions>
  constructor(private token: string, private assetsRoot: string, private fetchImpl: typeof fetch = fetch, options: ClientOptions = {}) {
    this.options = { minInterval: 60, chatInterval: 1050, retries: 4, ...options }
  }

  redact(message: string): string {
    return message.split(this.token).join('[токен скрыт]').replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[токен скрыт]')
  }

  private async pace(method: string, payload: Record<string, any>, signal?: AbortSignal): Promise<void> {
    if (!/^(send|edit|deleteMessage|copy|forward)/.test(method)) return
    const now = Date.now()
    const chat = String(payload.chat_id ?? '')
    const waitUntil = Math.max(now, this.nextRequest, this.nextChatRequest.get(chat) ?? 0)
    this.nextRequest = waitUntil + this.options.minInterval
    if (chat) this.nextChatRequest.set(chat, waitUntil + this.options.chatInterval)
    if (this.nextChatRequest.size > 10000) for (const [id, time] of this.nextChatRequest) if (time < now) this.nextChatRequest.delete(id)
    await abortableDelay(waitUntil - now, signal)
  }

  private async upload(source: string, field: string, form: FormData, key: string): Promise<string> {
    if (!/^assets\/[a-zA-Z0-9._-]+$/.test(source)) throw new Error('Некорректный путь к файлу. Выберите файл через панель свойств.')
    const root = await realpath(resolve(this.assetsRoot, 'assets'))
    let absolute: string
    try { absolute = await realpath(resolve(this.assetsRoot, source)) } catch { throw new Error(`Файл ${basename(source)} не найден в assets проекта.`) }
    const inside = relative(root, absolute)
    if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new Error('Файл находится за пределами assets проекта.')
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error('Выбранный путь не является файлом.')
    const kind = `send${field[0].toUpperCase()}${field.slice(1)}`
    validateMediaFile(kind, source, info.size)
    const bytes = await readFile(absolute)
    form.set(key, new Blob([new Uint8Array(bytes)]), basename(source))
    return `attach://${key}`
  }

  private async requestBody(payload: Record<string, any>): Promise<{ body: BodyInit; headers?: Record<string, string> }> {
    const data = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null))
    const form = new FormData()
    let hasFiles = false
    for (const field of ['photo', 'video', 'audio', 'voice', 'document']) {
      const source = data[field]
      if (typeof source !== 'string') continue
      if (source.startsWith('assets/')) { data[field] = await this.upload(source, field, form, field); hasFiles = true }
      else if (isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('../')) throw new Error('Абсолютные пути не поддерживаются. Добавьте файл в assets проекта.')
    }
    if (Array.isArray(data.media)) {
      data.media = await Promise.all(data.media.map(async (item: any, index: number) => {
        if (!String(item.media).startsWith('assets/')) {
          if (isAbsolute(String(item.media)) || /^[A-Za-z]:[\\/]/.test(String(item.media))) throw new Error('Альбом содержит абсолютный путь к файлу.')
          return item
        }
        hasFiles = true
        return { ...item, media: await this.upload(item.media, item.type, form, `media_${index}`) }
      }))
    }
    if (!hasFiles) return { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }
    for (const [key, value] of Object.entries(data)) if (!form.has(key)) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    return { body: form }
  }

  async call(method: string, payload: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
    if (!/^[a-zA-Z][a-zA-Z0-9]+$/.test(method)) throw new Error('Некорректный метод Telegram API.')
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      await this.pace(method, payload, signal)
      const request = await this.requestBody(payload)
      let response: Response
      try {
        response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', ...request, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) })
      } catch {
        signal?.throwIfAborted()
        if (attempt < this.options.retries) { await abortableDelay(500 * 2 ** attempt, signal); continue }
        throw new Error('Не удалось соединиться с Telegram. Проверьте подключение к интернету.')
      }
      let result: any
      try { result = await response.json() } catch {
        if (response.status >= 500 && attempt < this.options.retries) { await abortableDelay(500 * 2 ** attempt, signal); continue }
        throw new Error('Telegram вернул некорректный ответ. Повторите попытку позже.')
      }
      if (result.ok) return result.result
      const code = Number(result.error_code || response.status)
      const retryAfter = Number(result.parameters?.retry_after || 0)
      if ((code === 429 || code >= 500) && attempt < this.options.retries) {
        await abortableDelay(code === 429 ? Math.max(retryAfter, 1) * 1000 : 500 * 2 ** attempt, signal)
        continue
      }
      throw new TelegramError(method, code, this.redact(String(result.description || 'Неизвестная ошибка')), retryAfter)
    }
  }

  async sendNode(type: NodeKind, data: NodeData, context: Record<string, any>, chatId: number, signal?: AbortSignal): Promise<any> {
    const action = buildTelegramPayload(type, renderData(data, context), context, chatId)
    return this.call(action.method, action.payload, signal)
  }
}
