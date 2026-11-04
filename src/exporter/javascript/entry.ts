import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BotRuntime } from '../../bot/runtime'
import type { RuntimeStore, RuntimeUser } from '../../bot/types'
import { TelegramClient } from '../../bot/telegram'
import { validateWorkflow } from '../../shared/workflow'

class StandaloneStore implements RuntimeStore {
  private database: DatabaseSync

  constructor(filename: string) {
    this.database = new DatabaseSync(filename)
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        telegram_user_id INTEGER UNIQUE NOT NULL,
        chat_id INTEGER NOT NULL,
        profile TEXT NOT NULL,
        first_started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        current_node TEXT
      );
      CREATE TABLE IF NOT EXISTS user_variables (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
    `)
  }

  async upsertUser(from: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }, chatId: number): Promise<RuntimeUser> {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO users (telegram_user_id,chat_id,profile,first_started_at,last_activity_at,message_count) VALUES (?,?,?,?,?,1)
      ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id,profile=excluded.profile,last_activity_at=excluded.last_activity_at,message_count=message_count+1
    `).run(from.id, chatId, JSON.stringify(from), now, now)
    const row = this.database.prepare('SELECT id,telegram_user_id,chat_id FROM users WHERE telegram_user_id=?').get(from.id)!
    return { id: Number(row.id), telegramUserId: Number(row.telegram_user_id), chatId: Number(row.chat_id) }
  }

  async getVariables(userId: number): Promise<Record<string, any>> {
    return Object.fromEntries(this.database.prepare('SELECT key,value FROM user_variables WHERE user_id=?').all(userId).map(row => [String(row.key), JSON.parse(String(row.value))]))
  }

  async setVariable(userId: number, key: string, value: any): Promise<void> {
    this.database.prepare('INSERT INTO user_variables (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(userId, key, JSON.stringify(value ?? null))
  }

  async getCurrentNode(userId: number): Promise<string | null> {
    const row = this.database.prepare('SELECT current_node FROM users WHERE id=?').get(userId)
    return row?.current_node ? String(row.current_node) : null
  }

  async setCurrentNode(userId: number, nodeId: string | null): Promise<void> {
    this.database.prepare('UPDATE users SET current_node=? WHERE id=?').run(nodeId, userId)
  }

  async getOffset(): Promise<number> {
    const row = this.database.prepare("SELECT value FROM settings WHERE key='offset'").get()
    return row ? Number(row.value) : 0
  }

  async setOffset(offset: number): Promise<void> {
    this.database.prepare("INSERT INTO settings (key,value) VALUES ('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(offset))
  }

  close() { this.database.close() }
}

async function main() {
  const root = __dirname
  if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'))
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Укажите TELEGRAM_BOT_TOKEN в .env. Токен можно получить у @BotFather.')
  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    const text = message.replaceAll(token, '[скрыто]')
    const writer = level === 'error' ? console.error : console.log
    writer(`${new Date().toISOString()} ${text}`)
  }
  const workflow = JSON.parse(readFileSync(resolve(root, 'workflow.json'), 'utf8'))
  validateWorkflow(workflow)
  const store = new StandaloneStore(resolve(root, 'bot.db'))
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  process.on('SIGTERM', () => controller.abort())
  try {
    const telegram = new TelegramClient(token, root)
    const me = await telegram.call('getMe', {}, controller.signal)
    log('info', `Бот @${me.username} запущен. Ctrl+C — остановить.`)
    const runtime = new BotRuntime({ workflow, telegram, store, log, signal: controller.signal })
    await runtime.poll(controller.signal)
  } finally {
    store.close()
  }
}

main().catch(error => {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? ''
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Не удалось запустить бота: ${token ? message.replaceAll(token, '[скрыто]') : message}`)
  process.exitCode = 1
})
