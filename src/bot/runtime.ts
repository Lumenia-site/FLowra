import type { FlowEdge, FlowNode, Workflow } from '../shared/types'
import { validateWorkflow } from '../shared/workflow'
import { getVariable, inputValue, setVariable } from './handlers/dataNodes'
import { httpRequest } from './handlers/httpNode'
import { TelegramError } from './telegram'
import type { ExecutionContext, RuntimeOptions, RuntimeStore, TelegramUser } from './types'
import { abortableDelay, compare, interpolate, readPath, renderData, variableName } from './variables'

export type { RuntimeStore, RuntimeUser, RuntimeOptions } from './types'

const telegramNodeTypes = new Set(['sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument', 'sendLocation', 'sendContact', 'sendPoll', 'sendQuiz', 'sendMediaGroup', 'editMessage', 'deleteMessage', 'inlineKeyboard', 'replyKeyboard', 'urlButton'])

export class BotRuntime {
  private workflow: Workflow
  private nodes: Map<string, FlowNode>
  private outgoing = new Map<string, FlowEdge[]>()
  private log: NonNullable<RuntimeOptions['log']>
  private store: RuntimeStore

  constructor(private options: RuntimeOptions) {
    validateWorkflow(options.workflow)
    this.workflow = options.workflow
    this.nodes = new Map(this.workflow.nodes.map(node => [node.id, node]))
    for (const edge of this.workflow.edges) this.outgoing.set(edge.source, [...(this.outgoing.get(edge.source) ?? []), edge])
    this.log = options.log ?? (() => undefined)
    this.store = options.store
  }

  private successors(nodeId: string): string[] { return (this.outgoing.get(nodeId) ?? []).map(edge => edge.target) }

  private variableValue(node: FlowNode, values: Record<string, any>): any {
    const variable = String(node.data.variable ?? node.data.name ?? '')
    return variable.includes('{{') ? interpolate(variable, values) : readPath(values, variable)
  }

  private async execute(starts: string[], context: ExecutionContext): Promise<void> {
    const queue = [...starts]
    let steps = 0
    while (queue.length) {
      context.signal?.throwIfAborted()
      if (++steps > 500) throw new Error('Сценарий остановлен: превышено 500 переходов за одно событие. Проверьте циклические связи.')
      const nodeId = queue.shift()!
      const node = this.nodes.get(nodeId)
      if (!node) throw new Error(`Блок ${nodeId} не найден. Сохраните сценарий и перезапустите бота.`)
      const data = renderData(node.data, context.values)
      this.log('info', `Блок: ${node.data.label || node.type}`)
      let next = this.successors(node.id)
      if (telegramNodeTypes.has(node.type)) {
        const result = await this.options.telegram.sendNode(node.type, node.data, context.values, context.chatId, context.signal)
        const last = Array.isArray(result) ? result.at(-1) : result
        if (last?.message_id && node.type !== 'deleteMessage') {
          context.values.last_message_id = last.message_id
          await this.store.setVariable(context.userId, '_last_message_id', last.message_id)
        }
      } else if (node.type === 'input') {
        variableName(data.variable || data.name || 'answer')
        if (data.prompt) await this.options.telegram.sendNode('sendMessage', { text: node.data.prompt, parseMode: data.parseMode }, context.values, context.chatId, context.signal)
        await this.store.setCurrentNode(context.userId, node.id)
        return
      } else if (node.type === 'variable' || node.type === 'setVariable') await setVariable(data, context, this.store)
      else if (node.type === 'getVariable') await getVariable(data, context, this.store)
      else if (node.type === 'condition') {
        const result = compare(this.variableValue(node, context.values), data.operator || 'equals', data.value)
        next = (this.outgoing.get(node.id) ?? []).filter(edge => String(edge.sourceHandle).toLowerCase() === String(result)).map(edge => edge.target)
      } else if (node.type === 'switch') {
        const value = this.variableValue(node, context.values)
        const cases: any[] = Array.isArray(data.cases) ? data.cases : []
        const index = cases.findIndex(item => compare(value, 'equals', item.value))
        const handles = index < 0 ? ['default', 'else'] : [String(cases[index].handle ?? cases[index].label ?? index)]
        next = (this.outgoing.get(node.id) ?? []).filter(edge => handles.includes(String(edge.sourceHandle))).map(edge => edge.target)
      } else if (node.type === 'random') {
        const edges = this.outgoing.get(node.id) ?? []
        next = edges.length ? [edges[Math.floor(Math.random() * edges.length)].target] : []
      } else if (node.type === 'delay') {
        const seconds = Number(data.seconds ?? 1)
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('Задержка должна быть от 0 до 86400 секунд.')
        await abortableDelay(seconds * 1000, context.signal)
      } else if (node.type === 'http') await httpRequest(data, context, this.store)
      queue.unshift(...next)
    }
  }

  async processUpdate(update: any): Promise<void> {
    const callback = update.callback_query
    const message = update.message || callback?.message
    const from: TelegramUser | undefined = callback?.from || message?.from
    const chatId = message?.chat?.id || callback?.from?.id
    if (!from || !Number.isSafeInteger(chatId)) return
    const signal = this.options.signal
    const user = await this.store.upsertUser(from, chatId)
    const variables = await this.store.getVariables(user.id)
    const values: Record<string, any> = { ...variables, user: from, chat: message?.chat || { id: chatId }, message: message || {}, callback: callback || {}, last_message_id: callback?.message?.message_id || variables._last_message_id || null }
    const context: ExecutionContext = { userId: user.id, chatId, values, signal }
    if (callback) {
      await this.options.telegram.call('answerCallbackQuery', { callback_query_id: callback.id }, signal)
      const data = String(callback.data ?? '')
      if (data.startsWith('__flowra:')) {
        const target = data.slice('__flowra:'.length)
        if (!this.nodes.has(target)) throw new Error('Кнопка ссылается на удалённый блок. Обновите сценарий.')
        await this.store.setCurrentNode(user.id, null)
        await this.execute([target], context)
        return
      }
      const triggers = this.workflow.nodes.filter(node => node.type === 'callback' && String(node.data.callbackData ?? node.data.data ?? node.data.value ?? '') === data)
      if (triggers.length) await this.store.setCurrentNode(user.id, null)
      await this.execute(triggers.map(node => node.id), context)
      return
    }
    const text = String(message.text ?? '')
    const command = text.split(/\s/)[0].split('@')[0].toLowerCase()
    const commands = this.workflow.nodes.filter(node => (node.type === 'start' && command === '/start') || (node.type === 'command' && command === String(node.data.command ?? '').split('@')[0].toLowerCase()))
    if (commands.length) {
      await this.store.setCurrentNode(user.id, null)
      await this.execute(commands.map(node => node.id), context)
      return
    }
    const waitingId = await this.store.getCurrentNode(user.id)
    const waiting = waitingId ? this.nodes.get(waitingId) : undefined
    if (waiting?.type === 'input') {
      const input = inputValue(waiting.data, message)
      if (!input.valid) { await this.options.telegram.sendNode('sendMessage', { text: input.error }, values, chatId, signal); return }
      const name = variableName(waiting.data.variable || waiting.data.name || 'answer')
      await this.store.setVariable(user.id, name, input.value)
      values[name] = input.value
      await this.store.setCurrentNode(user.id, null)
      await this.execute(this.successors(waiting.id), context)
      return
    }
    if (waitingId) await this.store.setCurrentNode(user.id, null)
    const triggers = this.workflow.nodes.filter(node => node.type === 'message' && (!node.data.text || text.includes(String(node.data.text))))
    await this.execute(triggers.map(node => node.id), context)
  }

  async poll(signal: AbortSignal): Promise<void> {
    const stop = new AbortController()
    const executionSignal = AbortSignal.any([signal, stop.signal, ...(this.options.signal ? [this.options.signal] : [])])
    this.options.signal = executionSignal
    const info = await this.options.telegram.call('getWebhookInfo', {}, signal)
    if (info?.url) throw new Error('У бота настроен webhook. Удалите его методом deleteWebhook Telegram Bot API перед локальным запуском.')
    let offset = await this.store.getOffset?.() ?? 0
    const pending = new Set<Promise<void>>()
    const active = new Set<Promise<void>>()
    const userTails = new Map<string, Promise<void>>()
    const enqueue = (update: any) => {
      const key = String(update.callback_query?.from?.id ?? update.message?.from?.id ?? update.update_id)
      const previous = userTails.get(key) ?? Promise.resolve()
      const task = previous.then(async () => {
        while (active.size >= 16 && !executionSignal.aborted) await Promise.race(active)
        if (executionSignal.aborted) return
        const execution = this.processUpdate(update).catch(error => {
          if (!executionSignal.aborted) this.log('error', this.options.telegram.redact(error instanceof Error ? error.message : String(error)))
        })
        active.add(execution)
        try { await execution } finally { active.delete(execution) }
      }).finally(() => {
        pending.delete(task)
        if (userTails.get(key) === task) userTails.delete(key)
      })
      pending.add(task)
      userTails.set(key, task)
    }
    this.log('info', 'Бот запущен. Ожидаю сообщения Telegram.')
    try {
      while (!signal.aborted) {
        let updates: any[]
        try { updates = await this.options.telegram.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, signal) } catch (error) {
          if (signal.aborted) return
          if (error instanceof TelegramError && [401, 409].includes(error.code)) throw error
          this.log('error', this.options.telegram.redact(error instanceof Error ? error.message : String(error)))
          await abortableDelay(3000, signal)
          continue
        }
        for (const update of updates) {
          while (pending.size >= 100 && !signal.aborted) await Promise.race(pending)
          if (signal.aborted) return
          enqueue(update)
          offset = update.update_id + 1
          await this.store.setOffset?.(offset)
        }
      }
    } finally {
      stop.abort(new Error('Бот остановлен.'))
      await Promise.allSettled(pending)
    }
  }
}
