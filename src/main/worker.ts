import { FlowraDatabase } from '../database/database'
import { TelegramClient } from '../bot/telegram'
import { BotRuntime } from '../bot/runtime'
import { BroadcastQueue, runBroadcast } from '../bot/broadcast'
import type { AppEvent } from '../shared/types'

const port = (process as any).parentPort
let database: FlowraDatabase
let telegram: TelegramClient
let projectId: string
let polling: AbortController | undefined
const broadcastQueue = new BroadcastQueue((id, signal) => runBroadcast({ database, telegram, projectId, id, signal, log, emit }), error => log('error', error instanceof Error ? error.message : String(error)))

function emit(event: AppEvent) { port.postMessage({ event }) }
function log(level: 'info' | 'error' | 'warn', message: string) {
  const clean = message.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '[токен скрыт]')
  const entry = database.log(projectId, level, clean)
  emit({ type: 'log', projectId, data: entry })
}
function status(value: 'running' | 'stopped' | 'error') { database.setStatus(projectId, value); emit({ type: 'status', projectId, data: value }) }

async function start() {
  if (polling) return
  const controller = new AbortController()
  polling = controller
  try {
    const webhook = await telegram.call('getWebhookInfo', {}, controller.signal)
    if (webhook.url) throw new Error('У бота установлен webhook. Удалите его перед локальным запуском через Telegram Bot API deleteWebhook.')
    await telegram.call('getMe', {}, controller.signal)
    const baseStore = database.runtimeStore(projectId)
    const store = {
      ...baseStore,
      upsertUser: async (from: any, chatId: number) => { const user = await baseStore.upsertUser(from, chatId); emit({ type: 'users', projectId }); return user },
      setVariable: async (userId: number, key: string, value: any) => { await baseStore.setVariable(userId, key, value); emit({ type: 'users', projectId }) },
    }
    const runtime = new BotRuntime({ workflow: database.getProject(projectId).workflow, telegram, store, log, signal: controller.signal })
    status('running')
    log('info', 'Бот запущен. Ожидаю сообщения Telegram.')
    port.postMessage({ started: true })
    await runtime.poll(controller.signal)
    if (!controller.signal.aborted) { status('error'); log('error', 'Получение обновлений неожиданно завершилось.') }
  } catch (error: any) {
    if (!controller.signal.aborted) { status('error'); log('error', error.message); port.postMessage({ startError: error.message }) }
  } finally {
    if (polling === controller) polling = undefined
    if (controller.signal.aborted) { status('stopped'); log('info', 'Бот остановлен.'); port.postMessage({ stopped: true }) }
  }
}

port.on('message', ({ data }: any) => {
  try {
    if (data.type === 'init') {
      projectId = data.projectId
      database = new FlowraDatabase(data.databasePath)
      telegram = new TelegramClient(data.token, data.projectRoot)
      port.postMessage({ ready: true })
    } else if (data.type === 'start') { void start() }
    else if (data.type === 'stop') { if (polling) polling.abort(); else port.postMessage({ stopped: true }) }
    else if (data.type === 'broadcast') {
      void broadcastQueue.enqueue(data.id)
    } else if (data.type === 'cancel') {
      const campaign = database.getBroadcast(data.id)
      if (campaign.projectId === projectId) {
        broadcastQueue.cancel(data.id)
        if (['queued', 'running'].includes(campaign.status)) database.broadcastStatus(data.id, 'cancelled')
        emit({ type: 'broadcast', projectId, data: database.getBroadcast(data.id) })
      }
    }
  } catch (error: any) { port.postMessage({ error: error.message }) }
})
