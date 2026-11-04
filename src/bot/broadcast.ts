import type { FlowraDatabase } from '../database/database'
import type { AppEvent } from '../shared/types'
import type { TelegramClient } from './telegram'
import { abortableDelay } from './variables'

type BroadcastDatabase = Pick<FlowraDatabase, 'getBroadcast' | 'broadcastStatus' | 'pendingRecipients' | 'getVariables' | 'recipientResult' | 'markBlocked'>

export interface BroadcastOptions {
  database: BroadcastDatabase
  telegram: Pick<TelegramClient, 'sendNode' | 'redact'>
  projectId: string
  id: string
  signal: AbortSignal
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  emit: (event: AppEvent) => void
  intervalMs?: number
}

export class BroadcastQueue {
  private tasks = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private tail = Promise.resolve()

  constructor(private run: (id: string, signal: AbortSignal) => Promise<void>, private onError: (error: unknown) => void) {}

  enqueue(id: string): Promise<void> {
    const existing = this.tasks.get(id)
    if (existing) return existing.promise
    const controller = new AbortController()
    const promise = this.tail.then(() => this.run(id, controller.signal)).catch(error => this.onError(error)).finally(() => { this.tasks.delete(id) })
    this.tasks.set(id, { controller, promise })
    this.tail = promise
    return promise
  }

  cancel(id: string) { this.tasks.get(id)?.controller.abort() }
  stop() { for (const task of this.tasks.values()) task.controller.abort() }
}

export async function runBroadcast({ database, telegram, projectId, id, signal, log, emit, intervalMs = 1000 }: BroadcastOptions): Promise<void> {
  const publish = () => emit({ type: 'broadcast', projectId, data: database.getBroadcast(id) })
  const campaign = database.getBroadcast(id)
  if (campaign.projectId !== projectId) throw new Error('Рассылка принадлежит другому проекту.')
  if (!['queued', 'running'].includes(campaign.status)) { publish(); return }
  const cancelled = () => signal.aborted || database.getBroadcast(id).status === 'cancelled'
  if (cancelled()) { database.broadcastStatus(id, 'cancelled'); publish(); return }
  database.broadcastStatus(id, 'running')
  publish()
  try {
    const recipients = database.pendingRecipients(id)
    for (let index = 0; index < recipients.length; index++) {
      if (cancelled()) break
      const row = recipients[index]
      const userId = Number(row.id)
      try {
        const variables = database.getVariables(userId)
        const context = { ...variables, user: { id: row.telegram_user_id, first_name: row.first_name, last_name: row.last_name, username: row.username }, chat: { id: row.chat_id } }
        await telegram.sendNode(campaign.content.type, campaign.content, context, Number(row.chat_id), signal)
        database.recipientResult(id, userId)
      } catch (error: any) {
        if (cancelled()) break
        const message = telegram.redact(error instanceof Error ? error.message : String(error))
        if (error?.code === 403 || error?.errorCode === 403 || /blocked|deactivated|forbidden/i.test(message)) database.markBlocked(userId)
        database.recipientResult(id, userId, message)
        log('warn', `Рассылка: не удалось отправить пользователю ${row.telegram_user_id}: ${message}`)
      }
      publish()
      if (index < recipients.length - 1 && !cancelled()) await abortableDelay(intervalMs, signal)
    }
    database.broadcastStatus(id, cancelled() ? 'cancelled' : 'completed')
    log('info', cancelled() ? 'Рассылка отменена.' : 'Рассылка завершена.')
  } catch (error) {
    database.broadcastStatus(id, cancelled() ? 'cancelled' : 'interrupted')
    if (!cancelled()) log('error', `Рассылка прервана: ${telegram.redact(error instanceof Error ? error.message : String(error))}`)
  } finally { publish() }
}
