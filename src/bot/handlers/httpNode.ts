import type { NodeData } from '../../shared/types'
import type { ExecutionContext, RuntimeStore } from '../types'
import { validateHttpUrl } from '../media'
import { variableName } from '../variables'

function objectField(value: any, label: string): Record<string, any> {
  if (value === undefined || value === null || value === '') return {}
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { throw new Error(`Поле «${label}» должно содержать корректный JSON-объект.`) }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Поле «${label}» должно содержать JSON-объект.`)
  return parsed
}

export async function httpRequest(data: NodeData, context: ExecutionContext, store: RuntimeStore): Promise<void> {
  const url = validateHttpUrl(data.url)
  const method = String(data.method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Неподдерживаемый метод HTTP.')
  for (const [key, value] of Object.entries(objectField(data.query, 'Параметры запроса'))) url.searchParams.set(key, String(value))
  const headers = Object.fromEntries(Object.entries(objectField(data.headers, 'Заголовки')).map(([key, value]) => [key, String(value)]))
  const body = data.body === undefined || data.body === '' || method === 'GET' ? undefined : typeof data.body === 'string' ? data.body : JSON.stringify(data.body)
  if (body && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
  const response = await fetch(url, { method, headers, body, signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
  const text = await response.text()
  if (text.length > 10 * 1024 * 1024) throw new Error('HTTP-ответ превышает 10 МБ.')
  let value: any = text
  try { value = JSON.parse(text) } catch {}
  const target = variableName(data.responseVariable || 'response')
  await store.setVariable(context.userId, target, value)
  context.values[target] = value
  if (!response.ok) throw new Error(`HTTP-запрос вернул статус ${response.status}. Ответ сохранён в ${target}.`)
}
