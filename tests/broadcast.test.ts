import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowraDatabase } from '../src/database/database'
import { BroadcastQueue, runBroadcast } from '../src/bot/broadcast'
import { TelegramClient } from '../src/bot/telegram'
import type { AppEvent } from '../src/shared/types'

async function fixture(run: (database: FlowraDatabase, projectId: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'flowra-broadcast-'))
  const database = new FlowraDatabase(join(root, 'broadcast.sqlite'))
  try {
    const project = database.createProject('Рассылка', null, null)
    for (let id = 1; id <= 3; id++) {
      const user = database.upsertUser(project.id, { id, first_name: `Имя ${id}`, language_code: 'ru' }, id)
      database.setVariable(user.id, 'city', 'Ташкент')
    }
    await run(database, project.id)
  } finally { database.close(); await rm(root, { recursive: true, force: true }) }
}

test('sender отправляет выбранную аудиторию, сохраняет progress и продолжает после 403 и 429', async () => {
  await fixture(async (database, projectId) => {
    const campaign = database.createBroadcast(projectId, { type: 'sendMessage', text: '{{user.first_name}}, привет из {{variable.city}}' }, { variable: 'city', operator: 'equals', value: 'Ташкент' })
    const attempts = new Map<number, number>(), delivered: string[] = [], events: AppEvent[] = [], logs: string[] = []
    const token = '12345:private-token'
    const fetchImpl = async (_input: any, options: any) => {
      const payload = JSON.parse(options.body), chatId = Number(payload.chat_id)
      attempts.set(chatId, (attempts.get(chatId) ?? 0) + 1)
      if (chatId === 2) return Response.json({ ok: false, error_code: 403, description: `Forbidden ${token}` })
      if (chatId === 3 && attempts.get(chatId) === 1) return Response.json({ ok: false, error_code: 429, description: 'Flood control', parameters: { retry_after: 1 } })
      delivered.push(payload.text)
      return Response.json({ ok: true, result: { message_id: 10 } })
    }
    const telegram = new TelegramClient(token, '.', fetchImpl as typeof fetch, { minInterval: 0, chatInterval: 0 })
    await runBroadcast({ database, telegram, projectId, id: campaign.id, signal: new AbortController().signal, emit: event => events.push(event), log: (_level, text) => logs.push(text), intervalMs: 0 })
    const completed = database.getBroadcast(campaign.id)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.total, 3)
    assert.equal(completed.sent, 2)
    assert.equal(completed.failed, 1)
    assert.equal(database.pendingRecipients(campaign.id).length, 0)
    assert.equal(database.listUsers(projectId, { blocked: true })[0].telegramUserId, 2)
    assert.equal(attempts.get(3), 2)
    assert.deepEqual(delivered.sort(), ['Имя 1, привет из Ташкент', 'Имя 3, привет из Ташкент'])
    assert.ok(events.some(event => event.data.status === 'running' && event.data.sent === 0))
    assert.equal(events.at(-1)?.data.sent, 2)
    assert.ok(logs.every(text => !text.includes(token)))
    const recipient = database.db.prepare("SELECT error FROM broadcast_recipients WHERE broadcast_id=? AND status='failed'").get(campaign.id)
    assert.ok(!String(recipient?.error).includes(token))
    assert.equal(database.createBroadcast(projectId, { type: 'sendMessage', text: 'Следующая' }, {}).total, 2)
  })
})

test('отмена сохраняет уже отправленное и оставляет остальных получателей без попыток', async () => {
  await fixture(async (database, projectId) => {
    const campaign = database.createBroadcast(projectId, { type: 'sendMessage', text: 'Сообщение' }, {})
    const controller = new AbortController()
    let requests = 0
    const telegram = new TelegramClient('12345:test-token', '.', (async () => { requests++; return Response.json({ ok: true, result: { message_id: 10 } }) }) as typeof fetch, { minInterval: 0, chatInterval: 0 })
    await runBroadcast({ database, telegram, projectId, id: campaign.id, signal: controller.signal, emit: event => { if (event.data.sent === 1) controller.abort() }, log: () => undefined, intervalMs: 0 })
    assert.equal(requests, 1)
    assert.equal(database.getBroadcast(campaign.id).status, 'cancelled')
    assert.equal(database.getBroadcast(campaign.id).sent, 1)
    assert.equal(database.getBroadcast(campaign.id).failed, 0)
    assert.equal(database.pendingRecipients(campaign.id).length, 2)
    await runBroadcast({ database, telegram, projectId, id: campaign.id, signal: new AbortController().signal, emit: () => undefined, log: () => undefined, intervalMs: 0 })
    assert.equal(requests, 1)
    assert.equal(database.getBroadcast(campaign.id).status, 'cancelled')
  })
})

test('очередь выполняет кампании последовательно, исключает двойной запуск и отменяет ещё не начатое', async () => {
  await fixture(async (database, projectId) => {
    const first = database.createBroadcast(projectId, { type: 'sendMessage', text: 'Первая' }, { search: '1' })
    const second = database.createBroadcast(projectId, { type: 'sendMessage', text: 'Вторая' }, { search: '1' })
    const third = database.createBroadcast(projectId, { type: 'sendMessage', text: 'Третья' }, { search: '1' })
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const firstEntered = new Promise<void>(resolve => { entered = resolve })
    const sent: string[] = [], errors: unknown[] = []
    const telegram = new TelegramClient('12345:test-token', '.', (async (_input: any, options: any) => {
      const payload = JSON.parse(options.body)
      sent.push(payload.text)
      if (payload.text === 'Первая') { entered(); await gate }
      return Response.json({ ok: true, result: { message_id: 1 } })
    }) as typeof fetch, { minInterval: 0, chatInterval: 0 })
    const queue = new BroadcastQueue((id, signal) => runBroadcast({ database, telegram, projectId, id, signal, log: () => undefined, emit: () => undefined, intervalMs: 0 }), error => errors.push(error))
    const one = queue.enqueue(first.id)
    assert.equal(queue.enqueue(first.id), one)
    const two = queue.enqueue(second.id), three = queue.enqueue(third.id)
    await firstEntered
    assert.deepEqual(sent, ['Первая'])
    queue.cancel(second.id)
    release()
    await Promise.all([one, two, three])
    assert.deepEqual(sent, ['Первая', 'Третья'])
    assert.equal(database.getBroadcast(first.id).status, 'completed')
    assert.equal(database.getBroadcast(second.id).status, 'cancelled')
    assert.equal(database.getBroadcast(third.id).status, 'completed')
    assert.deepEqual(errors, [])
  })
})

test('sender не меняет завершённую кампанию и проверяет принадлежность проекту', async () => {
  await fixture(async (database, projectId) => {
    const campaign = database.createBroadcast(projectId, { type: 'sendMessage', text: 'Тест' }, {})
    let calls = 0
    const telegram = new TelegramClient('12345:test-token', '.', (async () => { calls++; return Response.json({ ok: true, result: {} }) }) as typeof fetch, { minInterval: 0, chatInterval: 0 })
    database.broadcastStatus(campaign.id, 'completed')
    const options = { database, telegram, projectId, id: campaign.id, signal: new AbortController().signal, emit: () => undefined, log: () => undefined }
    await runBroadcast(options)
    assert.equal(database.getBroadcast(campaign.id).status, 'completed')
    assert.equal(calls, 0)
    await assert.rejects(runBroadcast({ ...options, projectId: 'another-project' }), /другому проекту/)
  })
})
