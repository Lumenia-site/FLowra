import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { FlowraDatabase } from '../src/database/database'
import { AssetService } from '../src/main/assets'

test('миграции сохраняют проекты, пользователей, ввод и переменные после повторного открытия', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowra-db-'))
  const filename = path.join(root, 'test.sqlite')
  let database = new FlowraDatabase(filename)
  try {
    const project = database.createProject('Тест', 'encrypted-token', 'test_bot')
    const workflow = project.workflow
    workflow.nodes[1].data.text = 'Привет, {{name}}'
    database.saveWorkflow(project.id, workflow)
    const first = database.upsertUser(project.id, { id: 123, first_name: 'Анна', username: 'anna', language_code: 'ru' }, 123)
    const second = database.upsertUser(project.id, { id: 123, first_name: 'Анна', username: 'anna', language_code: 'ru' }, 123)
    assert.equal(first.id, second.id)
    database.setVariable(first.id, 'name', 'Анна')
    database.setVariable(first.id, 'location', { latitude: 41.3, longitude: 69.2 })
    database.setCurrentNode(first.id, 'waiting')
    database.setStatus(project.id, 'running')
    database.setSetting('offset', 12)
    database.close()
    database = new FlowraDatabase(filename)
    assert.equal(database.db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()?.n, 2)
    assert.equal(database.getProject(project.id).workflow.nodes[1].data.text, 'Привет, {{name}}')
    assert.deepEqual(database.getVariables(first.id), { location: { latitude: 41.3, longitude: 69.2 }, name: 'Анна' })
    assert.equal(database.getCurrentNode(first.id), 'waiting')
    assert.equal(database.listUsers(project.id)[0].messageCount, 2)
    assert.equal(database.getSetting('offset', 0), 12)
    assert.equal('token' in database.getProject(project.id), false)
    database.recover()
    assert.equal(database.getProject(project.id).status, 'stopped')
    database.deleteProject(project.id)
    assert.equal(database.db.prepare('SELECT COUNT(*) n FROM users').get()?.n, 0)
    assert.equal(database.db.prepare('SELECT COUNT(*) n FROM user_variables').get()?.n, 0)
  } finally { database.close(); await rm(root, { recursive: true, force: true }) }
})

test('сегменты используют SQLite, очередь фиксирует аудиторию и частичные ошибки', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowra-segment-'))
  const database = new FlowraDatabase(path.join(root, 'test.sqlite'))
  try {
    const project = database.createProject('Тест', null, null)
    const anna = database.upsertUser(project.id, { id: 1, first_name: 'Анна', username: 'anna', language_code: 'ru' }, 1)
    const oleg = database.upsertUser(project.id, { id: 2, first_name: 'Олег', language_code: 'en' }, 2)
    database.setVariable(anna.id, 'city', 'Ташкент')
    database.setVariable(oleg.id, 'city', 'Москва')
    assert.equal(database.listUsers(project.id, { languageCode: 'ru' }).length, 1)
    assert.equal(database.listUsers(project.id, { username: 'missing' })[0].id, oleg.id)
    assert.equal(database.listUsers(project.id, { variable: 'city', operator: 'contains', value: 'шкен' })[0].id, anna.id)
    assert.equal(database.listUsers(project.id, { variable: 'city', operator: 'equals', value: "' OR 1=1 --" }).length, 0)
    assert.equal(database.listUsers(project.id, { variable: "city' OR 1=1 --", operator: 'exists' }).length, 0)
    const broadcast = database.createBroadcast(project.id, { type: 'sendMessage', text: 'Тест' }, {})
    assert.equal(broadcast.total, 2)
    database.broadcastStatus(broadcast.id, 'running')
    database.recipientResult(broadcast.id, anna.id)
    database.recipientResult(broadcast.id, oleg.id, 'Forbidden: bot was blocked')
    database.markBlocked(oleg.id)
    database.broadcastStatus(broadcast.id, 'completed')
    assert.equal(database.getBroadcast(broadcast.id).sent, 1)
    assert.equal(database.getBroadcast(broadcast.id).failed, 1)
    assert.equal(database.pendingRecipients(broadcast.id).length, 0)
    const next = database.createBroadcast(project.id, { type: 'sendMessage', text: 'Ещё' }, {})
    assert.equal(next.total, 1)
    database.recover()
    assert.equal(database.getBroadcast(next.id).status, 'interrupted')
    assert.throws(() => database.setUserVariables(project.id, anna.id, { valid: 1, constructor: 2 }), /Недопустимое/)
    assert.equal(database.getVariables(anna.id).city, 'Ташкент')
  } finally { database.close(); await rm(root, { recursive: true, force: true }) }
})

test('файлы копируются, одинаковые имена безопасны, используемые файлы не удаляются', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowra-assets-'))
  const database = new FlowraDatabase(path.join(root, 'test.sqlite'))
  try {
    const project = database.createProject('Медиа', null, null)
    const service = new AssetService(database, path.join(root, 'projects'))
    const input = path.join(root, 'photo.png')
    await writeFile(input, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQkcAAAAASUVORK5CYII=', 'base64'))
    const first = await service.importFile(project.id, 'sendPhoto', input)
    const second = await service.importFile(project.id, 'sendPhoto', input)
    assert.notEqual(first.path, second.path)
    assert.match(first.path, /^assets\/[a-f0-9-]+\.png$/)
    assert.match(first.preview!, /^data:image\/png;base64,/)
    project.workflow.nodes.push({ id: 'photo', type: 'sendPhoto', position: { x: 0, y: 0 }, data: { media: first.path } })
    database.saveWorkflow(project.id, project.workflow)
    assert.equal((await service.list(project.id)).filter(a => a.unused).length, 1)
    assert.equal(await service.cleanup(project.id), 1)
    await access(path.join(service.projectRoot(project.id), first.path))
    await assert.rejects(access(path.join(service.projectRoot(project.id), second.path)))
    await assert.rejects(service.importFile(project.id, 'sendVideo', input), /Неподходящий формат/)
    await assert.rejects(service.importFile('../outside', 'sendPhoto', input), /не найден/)
  } finally { database.close(); await rm(root, { recursive: true, force: true }) }
})
