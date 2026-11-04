import type { NodeData } from '../../shared/types'
import type { ExecutionContext, RuntimeStore } from '../types'
import { parseValue, readPath, variableName } from '../variables'

export async function setVariable(data: NodeData, context: ExecutionContext, store: RuntimeStore): Promise<void> {
  const name = variableName(data.variable ?? data.name)
  const value = parseValue(data.value)
  await store.setVariable(context.userId, name, value ?? null)
  context.values[name] = value
}

export async function getVariable(data: NodeData, context: ExecutionContext, store: RuntimeStore): Promise<void> {
  const name = variableName(data.variable ?? data.name)
  const value = readPath(context.values, name)
  const target = variableName(data.target || name)
  if (target !== name) { await store.setVariable(context.userId, target, value ?? null); context.values[target] = value }
}

export function inputValue(data: NodeData, message: Record<string, any>): { valid: boolean; value?: any; error?: string } {
  const type = data.inputType || 'text'
  if (type === 'contact') return message.contact ? { valid: true, value: message.contact } : { valid: false, error: 'Отправьте контакт с помощью кнопки или вложения.' }
  if (type === 'location') return message.location ? { valid: true, value: { latitude: message.location.latitude, longitude: message.location.longitude } } : { valid: false, error: 'Отправьте геопозицию через меню вложений.' }
  if (type === 'number') {
    const text = String(message.text ?? '').trim().replace(',', '.')
    return text && Number.isFinite(Number(text)) ? { valid: true, value: Number(text) } : { valid: false, error: 'Введите число, например 12 или 3,5.' }
  }
  return typeof message.text === 'string' ? { valid: true, value: message.text } : { valid: false, error: 'Отправьте текстовое сообщение.' }
}
