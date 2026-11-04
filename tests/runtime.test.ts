import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { BotRuntime } from '../src/bot/runtime'
import type { RuntimeStore, RuntimeUser, TelegramUser } from '../src/bot/types'
import { TelegramClient, TelegramError } from '../src/bot/telegram'
import { buildTelegramPayload } from '../src/bot/handlers/telegramNodes'
import { compare, interpolate, variableName } from '../src/bot/variables'
import { validateMediaFile } from '../src/bot/media'
import type { FlowNode, NodeData, NodeKind, Workflow } from '../src/shared/types'

class MemoryStore implements RuntimeStore {
  users = new Map<number, RuntimeUser>()
  variables = new Map<number, Record<string, any>>()
  current = new Map<number, string | null>()
  offset = 0
  async upsertUser(from: TelegramUser, chatId: number) {
    const user = this.users.get(from.id) ?? { id: from.id, telegramUserId: from.id, chatId }
    this.users.set(from.id, user)
    return user
  }
  async getVariables(userId: number) { return { ...this.variables.get(userId) } }
  async setVariable(userId: number, key: string, value: any) { this.variables.set(userId, { ...this.variables.get(userId), [key]: value }) }
  async getCurrentNode(userId: number) { return this.current.get(userId) ?? null }
  async setCurrentNode(userId: number, nodeId: string | null) { this.current.set(userId, nodeId) }
  async getOffset() { return this.offset }
  async setOffset(offset: number) { this.offset = offset }
}

function node(id: string, type: NodeKind, data: NodeData = {}): FlowNode { return { id, type, position: { x: 0, y: 0 }, data } }
function workflow(nodes: FlowNode[], edges: Array<[string, string, string?]>): Workflow { return { version: 1, nodes, edges: edges.map(([source, target, sourceHandle], index) => ({ id: `edge-${index}`, source, target, sourceHandle })) } }
function update(text: string, userId = 7): any { return { update_id: 1, message: { message_id: 3, text, from: { id: userId, first_name: 'Анна', username: 'anna' }, chat: { id: userId } } } }
function transport() {
  const calls: Array<{ method: string; payload: any }> = []
  const fetchImpl = async (input: any, options: any) => {
    const method = String(input).split('/').at(-1)!
    const payload = options.body instanceof FormData ? options.body : JSON.parse(options.body)
    calls.push({ method, payload })
    return Response.json({ ok: true, result: method === 'sendMediaGroup' ? [{ message_id: 100 }, { message_id: 101 }] : { message_id: calls.length + 100 } })
  }
  return { calls, client: (root = '.') => new TelegramClient('12345:test-token', root, fetchImpl as typeof fetch, { minInterval: 0, chatInterval: 0 }) }
}

test('сценарий сохраняет ввод и переменные между экземплярами runtime, разделяет пользователей', async () => {
  const store = new MemoryStore(), api = transport()
  const flow = workflow([node('start', 'start'), node('input', 'input', { prompt: 'Как тебя зовут?', variable: 'name', inputType: 'text' }), node('reply', 'sendMessage', { text: 'Привет, {{name}}! {{user.first_name}} / {{chat.id}}' })], [['start', 'input'], ['input', 'reply']])
  await new BotRuntime({ workflow: flow, telegram: api.client(), store }).processUpdate(update('/start'))
  assert.equal(store.current.get(7), 'input')
  assert.equal(api.calls[0].payload.text, 'Как тебя зовут?')
  await new BotRuntime({ workflow: flow, telegram: api.client(), store }).processUpdate(update('Маша'))
  assert.equal((await store.getVariables(7)).name, 'Маша')
  assert.equal(api.calls.at(-1)?.payload.text, 'Привет, Маша! Анна / 7')
  assert.equal(store.current.get(7), null)
  await new BotRuntime({ workflow: flow, telegram: api.client(), store }).processUpdate(update('/start', 8))
  assert.equal((await store.getVariables(8)).name, undefined)
  assert.equal(store.users.size, 2)
})

test('условия, switch, переменные, числовой ввод и command реально выбирают нужные ветки', async () => {
  const store = new MemoryStore(), api = transport()
  const flow = workflow([
    node('start', 'start'), node('input', 'input', { variable: 'age', inputType: 'number' }),
    node('condition', 'condition', { variable: 'age', operator: 'greater or equal', value: '18' }),
    node('yes', 'setVariable', { variable: 'adult', value: 'true' }), node('no', 'setVariable', { variable: 'adult', value: 'false' }),
    node('switch', 'switch', { variable: 'adult', cases: [{ value: true, label: 'adult' }] }), node('answer', 'sendMessage', { text: 'Совершеннолетний' }),
    node('help', 'command', { command: '/help' }), node('helptext', 'sendMessage', { text: 'Помощь' }),
  ], [['start', 'input'], ['input', 'condition'], ['condition', 'yes', 'true'], ['condition', 'no', 'false'], ['yes', 'switch'], ['switch', 'answer', 'adult'], ['help', 'helptext']])
  const runtime = new BotRuntime({ workflow: flow, telegram: api.client(), store })
  await runtime.processUpdate(update('/start'))
  await runtime.processUpdate(update('не число'))
  assert.equal(store.current.get(7), 'input')
  assert.match(api.calls.at(-1)?.payload.text, /Введите число/)
  await runtime.processUpdate(update('21'))
  assert.equal((await store.getVariables(7)).adult, true)
  assert.equal(api.calls.at(-1)?.payload.text, 'Совершеннолетний')
  await runtime.processUpdate(update('/start'))
  await runtime.processUpdate(update('/help@my_bot'))
  assert.equal(store.current.get(7), null)
  assert.equal(api.calls.at(-1)?.payload.text, 'Помощь')
})

test('callback подтверждается, inline-переход выполняет блок и редактирует последнее сообщение', async () => {
  const store = new MemoryStore(), api = transport()
  const flow = workflow([
    node('start', 'start'), node('message', 'sendMessage', { text: 'Меню' }),
    node('buttons', 'inlineKeyboard', { rows: [[{ text: 'Профиль', action: 'node', value: 'profile' }]] }),
    node('profile', 'sendMessage', { text: 'Профиль {{user.first_name}}' }),
    node('callback', 'callback', { callbackData: 'ok' }), node('edit', 'editMessage', { text: 'Готово' }),
  ], [['start', 'message'], ['message', 'buttons'], ['callback', 'edit']])
  const runtime = new BotRuntime({ workflow: flow, telegram: api.client(), store })
  await runtime.processUpdate(update('/start'))
  assert.equal(api.calls[1].method, 'editMessageReplyMarkup')
  assert.equal(api.calls[1].payload.reply_markup.inline_keyboard[0][0].callback_data, '__flowra:profile')
  await runtime.processUpdate({ callback_query: { id: 'query-1', data: '__flowra:profile', from: { id: 7, first_name: 'Анна' }, message: { message_id: 44, chat: { id: 7 } } } })
  assert.equal(api.calls[2].method, 'answerCallbackQuery')
  assert.equal(api.calls[3].payload.text, 'Профиль Анна')
  await runtime.processUpdate({ callback_query: { id: 'query-2', data: 'ok', from: { id: 7 }, message: { message_id: 55, chat: { id: 7 } } } })
  assert.equal(api.calls.at(-1)?.method, 'editMessageText')
  assert.equal(api.calls.at(-1)?.payload.message_id, 55)
})

test('все Telegram-блоки создают реальные API payload, викторина соответствует Bot API 10.3', () => {
  const examples: Array<[NodeKind, NodeData, string]> = [
    ['sendPhoto', { media: 'image-id' }, 'sendPhoto'], ['sendVideo', { media: 'video-id' }, 'sendVideo'], ['sendAudio', { media: 'audio-id' }, 'sendAudio'],
    ['sendVoice', { media: 'voice-id' }, 'sendVoice'], ['sendDocument', { media: 'doc-id' }, 'sendDocument'],
    ['sendLocation', { latitude: '41.31', longitude: '69.24' }, 'sendLocation'],
    ['sendContact', { phoneNumber: '+998900000000', firstName: 'Анна' }, 'sendContact'],
    ['sendPoll', { question: 'Как дела?', answers: ['Хорошо', 'Отлично'], multiple: true }, 'sendPoll'],
    ['sendQuiz', { question: '2 + 2?', answers: ['3', '4'], correctAnswer: 1 }, 'sendPoll'],
    ['sendMediaGroup', { items: [{ type: 'photo', media: 'photo-id' }, { type: 'video', media: 'video-id', caption: 'Видео' }] }, 'sendMediaGroup'],
    ['deleteMessage', { messageId: '44' }, 'deleteMessage'],
    ['replyKeyboard', { rows: [[{ text: 'Контакт', action: 'contact' }, { text: 'Где я', action: 'location' }]] }, 'sendMessage'],
    ['urlButton', { url: 'https://example.com', buttonText: 'Сайт' }, 'sendMessage'],
  ]
  for (const [kind, data, method] of examples) assert.equal(buildTelegramPayload(kind, data, {}, 7).method, method)
  const quiz = buildTelegramPayload('sendQuiz', { question: '2+2', answers: ['3', '4'], correctAnswer: 1 }, {}, 7).payload
  assert.deepEqual(quiz.correct_option_ids, [1])
  assert.deepEqual(quiz.options, [{ text: '3' }, { text: '4' }])
  assert.throws(() => buildTelegramPayload('sendLocation', { latitude: 200, longitude: 1 }, {}, 7), /координаты/)
  assert.throws(() => buildTelegramPayload('urlButton', { url: 'file:///etc/passwd' }, {}, 7), /HTTP/)
})

test('локальные фото, видео, voice и документы загружаются multipart, альбом одним запросом', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowra-media-'))
  try {
    await mkdir(join(root, 'assets'))
    for (const filename of ['photo.png', 'video.mp4', 'voice.ogg', 'notes.pdf']) await writeFile(join(root, 'assets', filename), 'test-content')
    const api = transport(), client = api.client(root)
    for (const [kind, media] of [['sendPhoto', 'photo.png'], ['sendVideo', 'video.mp4'], ['sendVoice', 'voice.ogg'], ['sendDocument', 'notes.pdf']] as const) await client.sendNode(kind, { media: `assets/${media}` }, {}, 7)
    await client.sendNode('sendMediaGroup', { items: [{ type: 'photo', media: 'assets/photo.png' }, { type: 'video', media: 'assets/video.mp4', caption: 'Альбом' }] }, {}, 7)
    assert.equal(api.calls.length, 5)
    for (const call of api.calls) assert.ok(call.payload instanceof FormData)
    const album = api.calls.at(-1)!
    const media = JSON.parse(album.payload.get('media'))
    assert.equal(media[0].media, 'attach://media_0')
    assert.equal(media[1].caption, 'Альбом')
    assert.ok(album.payload.get('media_0') instanceof Blob)
    await assert.rejects(client.sendNode('sendPhoto', { media: 'assets/../secret.png' }, {}, 7), /путь/)
    await assert.rejects(client.sendNode('sendPhoto', { media: 'assets/missing.png' }, {}, 7), /не найден/)
    assert.throws(() => validateMediaFile('sendPhoto', 'wrong.mp4', 12), /формат/)
    assert.throws(() => validateMediaFile('sendVoice', 'voice.ogg', 60 * 1024 * 1024), /большой/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTTP-блок отправляет запрос и сохраняет JSON-ответ в переменную', async () => {
  let received: any
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = { url: request.url, method: request.method, header: request.headers['x-flowra'], body: Buffer.concat(chunks).toString() }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ city: 'Ташкент' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as any).port
    const store = new MemoryStore(), api = transport()
    const flow = workflow([node('start', 'start'), node('http', 'http', { url: `http://127.0.0.1:${port}/city`, method: 'POST', headers: '{"X-Flowra":"yes"}', query: { name: '{{user.first_name}}' }, body: '{"id":{{user.id}}}', responseVariable: 'result' }), node('answer', 'sendMessage', { text: '{{result.city}}' })], [['start', 'http'], ['http', 'answer']])
    await new BotRuntime({ workflow: flow, telegram: api.client(), store }).processUpdate(update('/start'))
    assert.equal(received.method, 'POST')
    assert.equal(received.header, 'yes')
    assert.equal(received.body, '{"id":7}')
    assert.match(decodeURI(received.url), /Анна/)
    assert.deepEqual((await store.getVariables(7)).result, { city: 'Ташкент' })
    assert.equal(api.calls.at(-1)?.payload.text, 'Ташкент')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('429 использует retry_after, ошибки скрывают токен, остановка прерывает delay', async () => {
  let calls = 0
  const fetchImpl = async () => ++calls === 1 ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 }, description: 'Too many requests' }) : Response.json({ ok: true, result: { message_id: 1 } })
  const client = new TelegramClient('12345:test-token', '.', fetchImpl as typeof fetch, { minInterval: 0, chatInterval: 0 })
  const started = Date.now()
  await client.sendNode('sendMessage', { text: 'Привет' }, {}, 7)
  assert.equal(calls, 2)
  assert.ok(Date.now() - started >= 950)
  const bad = new TelegramClient('12345:super-secret', '.', (async () => Response.json({ ok: false, error_code: 400, description: 'token 12345:super-secret rejected' })) as typeof fetch)
  await assert.rejects(bad.call('getMe'), error => error instanceof TelegramError && !error.message.includes('super-secret'))
  const controller = new AbortController(), store = new MemoryStore()
  const flow = workflow([node('start', 'start'), node('delay', 'delay', { seconds: 30 })], [['start', 'delay']])
  const pending = new BotRuntime({ workflow: flow, telegram: client, store, signal: controller.signal }).processUpdate(update('/start'))
  setTimeout(() => controller.abort(new Error('Остановлено')), 20)
  await assert.rejects(pending, /Остановлено/)
})

test('шаблоны, сравнения и имена переменных не выполняют код и не читают prototype', () => {
  const values = { user: { first_name: 'Анна' }, age: 21, point: { latitude: 41 } }
  assert.equal(interpolate('{{user.first_name}} {{variable.age}} {{point.latitude}}', values), 'Анна 21 41')
  assert.equal(interpolate('{{user.constructor}} {{__proto__.x}}', values), ' ')
  assert.equal(compare(21, 'greater or equal', '18'), true)
  assert.equal(compare('abc', 'contains', 'b'), true)
  assert.throws(() => variableName('__proto__'), /имя/)
  assert.throws(() => variableName('user'), /имя/)
})

test('switch использует идентификатор выбранной ветки без совпадения с индексом другой ветки', async () => {
  const store = new MemoryStore(), api = transport()
  const flow = workflow([node('start', 'start'), node('value', 'setVariable', { name: 'choice', value: '2' }), node('switch', 'switch', { variable: 'choice', cases: [{ value: '1', handle: '1' }, { value: '2', handle: '2' }] }), node('one', 'sendMessage', { text: 'Первая' }), node('two', 'sendMessage', { text: 'Вторая' })], [['start', 'value'], ['value', 'switch'], ['switch', 'one', '1'], ['switch', 'two', '2']])
  await new BotRuntime({ workflow: flow, telegram: api.client(), store }).processUpdate(update('/start'))
  assert.deepEqual(api.calls.map(call => call.payload.text), ['Вторая'])
})

test('long polling выполняет разных пользователей параллельно и сохраняет порядок сообщений одного пользователя', async () => {
  const store = new MemoryStore(), controller = new AbortController()
  const messages: string[] = []
  let polled = false
  const fetchImpl = async (input: any, options: any) => {
    const method = String(input).split('/').at(-1)!
    const payload = JSON.parse(options.body)
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '' } })
    if (method === 'getUpdates' && !polled) {
      polled = true
      const first = update('/slow', 7), second = update('/start', 8), third = update('Катя', 8)
      first.update_id = 1; second.update_id = 2; third.update_id = 3
      return Response.json({ ok: true, result: [first, second, third] })
    }
    if (method === 'getUpdates') return new Promise<Response>((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    if (method === 'sendMessage') {
      messages.push(payload.text)
      if (payload.text === 'Привет, Катя') setTimeout(() => controller.abort(), 10)
    }
    return Response.json({ ok: true, result: { message_id: 22 } })
  }
  const client = new TelegramClient('12345:test-token', '.', fetchImpl as typeof fetch, { minInterval: 0, chatInterval: 0 })
  const flow = workflow([node('slow', 'command', { command: '/slow' }), node('delay', 'delay', { seconds: 30 }), node('never', 'sendMessage', { text: 'Поздно' }), node('start', 'start'), node('input', 'input', { variable: 'name' }), node('reply', 'sendMessage', { text: 'Привет, {{name}}' })], [['slow', 'delay'], ['delay', 'never'], ['start', 'input'], ['input', 'reply']])
  const timeout = setTimeout(() => controller.abort(), 3000)
  try { await new BotRuntime({ workflow: flow, telegram: client, store }).poll(controller.signal) } finally { clearTimeout(timeout) }
  assert.deepEqual(messages, ['Привет, Катя'])
  assert.equal((await store.getVariables(8)).name, 'Катя')
  assert.equal(store.offset, 4)
})
