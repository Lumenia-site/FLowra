const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])

export function readPath(values: Record<string, any>, path: string): any {
  const keys = path.trim().replace(/^variable\./, '').split('.')
  let current: any = values
  for (const key of keys) {
    if (forbiddenKeys.has(key) || current == null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

export function interpolate(value: unknown, context: Record<string, any>): string {
  return String(value ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => {
    const result = readPath(context, path)
    return result == null ? '' : typeof result === 'object' ? JSON.stringify(result) : String(result)
  })
}

export function renderData<T>(value: T, context: Record<string, any>): T {
  if (typeof value === 'string') return interpolate(value, context) as T
  if (Array.isArray(value)) return value.map(item => renderData(item, context)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKeys.has(key)).map(([key, item]) => [key, renderData(item, context)])) as T
  return value
}

export function parseValue(value: unknown): any {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

export function compare(left: any, operator: string, right: any): boolean {
  const normalized = operator.toLowerCase().replaceAll(' ', '_')
  if (normalized === 'exists') return left !== undefined && left !== null && left !== ''
  if (normalized === 'contains') return String(left ?? '').includes(String(right ?? ''))
  if (normalized === 'not_equals' || normalized === 'not_equal' || normalized === 'neq' || normalized === '!=') return String(left ?? '') !== String(right ?? '')
  if (['greater', 'gt', '>'].includes(normalized)) return Number(left) > Number(right)
  if (['less', 'lt', '<'].includes(normalized)) return Number(left) < Number(right)
  if (['greater_or_equal', 'gte', '>='].includes(normalized)) return Number(left) >= Number(right)
  if (['less_or_equal', 'lte', '<='].includes(normalized)) return Number(left) <= Number(right)
  return String(left ?? '') === String(right ?? '')
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Выполнение остановлено.'))
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.max(0, ms))
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Выполнение остановлено.')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function variableName(value: unknown): string {
  const name = String(value ?? '').trim().replace(/^variable\./, '')
  if (!name || name.length > 128 || forbiddenKeys.has(name) || ['user', 'chat', 'message', 'callback', 'last_message_id'].includes(name)) throw new Error('Укажите имя переменной: оно не должно совпадать со встроенными полями.')
  return name
}
