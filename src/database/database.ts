import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrate } from './migrations'
import { migrateLegacy } from './legacy'
import { initialWorkflow, validateWorkflow } from '../shared/workflow'
import type { Asset, BotUser, Broadcast, BroadcastContent, LogEntry, Project, ProjectStatus, UserFilter, Workflow } from '../shared/types'

const now = () => new Date().toISOString()

export class FlowraDatabase {
  readonly db: DatabaseSync

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    migrateLegacy(this.db, filename)
    migrate(this.db)
  }

  close() { this.db.close() }

  recover() {
    this.db.exec("UPDATE projects SET status = 'stopped'; UPDATE broadcasts SET status = 'interrupted' WHERE status IN ('queued', 'running')")
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private project(row: any): Project {
    return { id: row.id, name: row.name, username: row.username, status: row.status, userCount: Number(row.user_count ?? 0), createdAt: row.created_at, updatedAt: row.updated_at, hasToken: Boolean(row.token), workflow: JSON.parse(row.workflow) }
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.project_id=p.id) user_count FROM projects p ORDER BY updated_at DESC').all().map(row => this.project(row))
  }

  getProject(id: string): Project {
    const row = this.db.prepare('SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.project_id=p.id) user_count FROM projects p WHERE id=?').get(id)
    if (!row) throw new Error('Проект не найден.')
    return this.project(row)
  }

  createProject(name: string, token: string | null, username: string | null, workflow = initialWorkflow()): Project {
    const id = randomUUID()
    const date = now()
    this.db.prepare('INSERT INTO projects(id,name,token,username,workflow,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, name, token, username, JSON.stringify(workflow), date, date)
    return this.getProject(id)
  }

  getToken(id: string): string | null {
    this.getProject(id)
    return this.db.prepare('SELECT token FROM projects WHERE id=?').get(id)?.token as string | null
  }

  updateProject(id: string, input: { name?: string; token?: string | null; username?: string | null }) {
    const current = this.getProject(id)
    this.db.prepare('UPDATE projects SET name=?,token=?,username=?,updated_at=? WHERE id=?').run(input.name ?? current.name, input.token === undefined ? this.getToken(id) : input.token, input.username === undefined ? current.username : input.username, now(), id)
    return this.getProject(id)
  }

  deleteProject(id: string) { this.getProject(id); this.db.prepare('DELETE FROM projects WHERE id=?').run(id) }
  setStatus(id: string, status: ProjectStatus) { this.db.prepare('UPDATE projects SET status=? WHERE id=?').run(status, id) }

  saveWorkflow(id: string, workflow: Workflow) {
    this.getProject(id)
    validateWorkflow(workflow)
    const clean: Workflow = { version: 1, nodes: workflow.nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges: workflow.edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })) }
    this.db.prepare('UPDATE projects SET workflow=?,updated_at=? WHERE id=?').run(JSON.stringify(clean), now(), id)
  }

  upsertUser(projectId: string, from: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }, chatId: number) {
    const date = now()
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO users(project_id,telegram_user_id,chat_id,username,first_name,last_name,language_code,first_started_at,last_activity_at,message_count)
        VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(project_id,telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id,username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,last_activity_at=excluded.last_activity_at,message_count=users.message_count+1,blocked=0`).run(projectId, from.id, chatId, from.username ?? null, from.first_name ?? '', from.last_name ?? null, from.language_code ?? null, date, date)
      const user = this.db.prepare('SELECT id FROM users WHERE project_id=? AND telegram_user_id=?').get(projectId, from.id)!
      this.db.prepare("INSERT INTO interactions(user_id,kind,created_at) VALUES(?,'update',?)").run(user.id, date)
      return { id: Number(user.id), telegramUserId: from.id, chatId }
    })
  }

  getVariables(userId: number): Record<string, any> {
    return Object.fromEntries(this.db.prepare('SELECT key,value FROM user_variables WHERE user_id=?').all(userId).map(row => [row.key, JSON.parse(row.value as string)]))
  }

  setVariable(userId: number, key: string, value: any) {
    if (!key || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Недопустимое имя переменной.')
    this.db.prepare('INSERT INTO user_variables(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(userId, key, JSON.stringify(value ?? null), now())
  }

  getCurrentNode(userId: number): string | null { return this.db.prepare('SELECT current_node FROM users WHERE id=?').get(userId)?.current_node as string | null }
  setCurrentNode(userId: number, nodeId: string | null) { this.db.prepare('UPDATE users SET current_node=? WHERE id=?').run(nodeId, userId) }

  runtimeStore(projectId: string) {
    return {
      upsertUser: async (from: any, chatId: number) => this.upsertUser(projectId, from, chatId),
      getVariables: async (userId: number) => this.getVariables(userId),
      setVariable: async (userId: number, key: string, value: any) => this.setVariable(userId, key, value),
      getCurrentNode: async (userId: number) => this.getCurrentNode(userId),
      setCurrentNode: async (userId: number, nodeId: string | null) => this.setCurrentNode(userId, nodeId),
      getOffset: async () => this.getSetting<number>(`offset:${projectId}`, 0),
      setOffset: async (offset: number) => this.setSetting(`offset:${projectId}`, offset),
    }
  }

  private filterQuery(projectId: string, filters: UserFilter = {}) {
    const clauses = ['u.project_id=?']
    const values: SQLInputValue[] = [projectId]
    if (filters.search?.trim()) { clauses.push("(CAST(u.telegram_user_id AS TEXT) LIKE ? OR COALESCE(u.username,'') LIKE ? OR u.first_name LIKE ? OR COALESCE(u.last_name,'') LIKE ?)"); values.push(...Array(4).fill(`%${filters.search.trim()}%`)) }
    if (filters.languageCode) { clauses.push('u.language_code=?'); values.push(filters.languageCode) }
    if (filters.activeDays) { clauses.push('u.last_activity_at>=?'); values.push(new Date(Date.now() - Math.max(0, filters.activeDays) * 86400000).toISOString()) }
    if (filters.blocked !== undefined) { clauses.push('u.blocked=?'); values.push(Number(filters.blocked)) }
    if (filters.username === 'exists') clauses.push("u.username IS NOT NULL AND u.username <> ''")
    if (filters.username === 'missing') clauses.push("(u.username IS NULL OR u.username = '')")
    for (const [field, column] of [['firstStartedAfter', 'first_started_at'], ['lastActivityAfter', 'last_activity_at']] as const) {
      if (filters[field]) { clauses.push(`u.${column}>=?`); values.push(filters[field]!) }
    }
    if (filters.variable?.trim()) {
      let sql = 'EXISTS(SELECT 1 FROM user_variables v WHERE v.user_id=u.id AND v.key=?'
      values.push(filters.variable.trim())
      const operator = filters.operator ?? 'equals'
      if (operator === 'equals' || operator === 'notEquals' || operator === 'not equals') { sql += ` AND CAST(json_extract(v.value,'$') AS TEXT)${operator === 'equals' ? '=' : '!='}?`; values.push(filters.value ?? '') }
      if (operator === 'contains') { sql += " AND instr(CAST(json_extract(v.value,'$') AS TEXT),?)>0"; values.push(filters.value ?? '') }
      const numericOperators: Record<string, string> = { greater: '>', less: '<', greaterOrEqual: '>=', lessOrEqual: '<=', 'greater or equal': '>=', 'less or equal': '<=', greaterEqual: '>=', lessEqual: '<=' }
      if (numericOperators[operator]) {
        const numeric = Number(filters.value)
        if (!Number.isFinite(numeric)) throw new Error('Для числового сравнения укажите число.')
        sql += ` AND CAST(json_extract(v.value,'$') AS REAL)${numericOperators[operator]}?`
        values.push(numeric)
      }
      clauses.push(sql + ')')
    }
    return { where: clauses.join(' AND '), values }
  }

  listUsers(projectId: string, filters: UserFilter = {}): BotUser[] {
    const { where, values } = this.filterQuery(projectId, filters)
    const rows = this.db.prepare(`SELECT u.* FROM users u WHERE ${where} ORDER BY last_activity_at DESC`).all(...values)
    return rows.map((row: any) => ({ id: Number(row.id), projectId: row.project_id, telegramUserId: Number(row.telegram_user_id), chatId: Number(row.chat_id), username: row.username, firstName: row.first_name, lastName: row.last_name, languageCode: row.language_code, firstStartedAt: row.first_started_at, lastActivityAt: row.last_activity_at, messageCount: Number(row.message_count), currentNode: row.current_node, blocked: Boolean(row.blocked), variables: this.getVariables(Number(row.id)) }))
  }

  assertUser(projectId: string, userId: number) {
    if (!this.db.prepare('SELECT id FROM users WHERE id=? AND project_id=?').get(userId, projectId)) throw new Error('Пользователь не найден в этом проекте.')
  }

  setUserVariables(projectId: string, userId: number, variables: Record<string, any>) {
    this.assertUser(projectId, userId)
    this.transaction(() => {
      this.db.prepare('DELETE FROM user_variables WHERE user_id=?').run(userId)
      Object.entries(variables).forEach(([key, value]) => this.setVariable(userId, key, value))
    })
  }

  deleteUser(projectId: string, userId: number) { this.assertUser(projectId, userId); this.db.prepare('DELETE FROM users WHERE id=?').run(userId) }
  markBlocked(userId: number) { this.db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(userId) }

  log(projectId: string, level: LogEntry['level'], message: string): LogEntry {
    const date = now()
    const result = this.db.prepare('INSERT INTO logs(project_id,level,message,created_at) VALUES(?,?,?,?)').run(projectId, level, message.slice(0, 6000), date)
    this.db.prepare('DELETE FROM logs WHERE project_id=? AND id NOT IN (SELECT id FROM logs WHERE project_id=? ORDER BY id DESC LIMIT 2000)').run(projectId, projectId)
    return { id: Number(result.lastInsertRowid), projectId, level, message, createdAt: date }
  }

  listLogs(projectId: string): LogEntry[] { return this.db.prepare('SELECT * FROM logs WHERE project_id=? ORDER BY id DESC LIMIT 500').all(projectId).reverse().map((r: any) => ({ id: Number(r.id), projectId, level: r.level, message: r.message, createdAt: r.created_at })) }
  clearLogs(projectId: string) { this.db.prepare('DELETE FROM logs WHERE project_id=?').run(projectId) }
  getSetting<T>(key: string, fallback: T): T { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value as string) : fallback }
  setSetting(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  addAsset(asset: Asset) { this.db.prepare('INSERT INTO assets(id,project_id,path,name,mime,size) VALUES(?,?,?,?,?,?)').run(asset.id, asset.projectId, asset.path, asset.name, asset.mime, asset.size) }
  listAssets(projectId: string): Asset[] { return this.db.prepare('SELECT * FROM assets WHERE project_id=? ORDER BY name').all(projectId).map((r: any) => ({ id: r.id, projectId: r.project_id, path: r.path, name: r.name, mime: r.mime, size: Number(r.size) })) }
  deleteAsset(id: string) { this.db.prepare('DELETE FROM assets WHERE id=?').run(id) }

  createBroadcast(projectId: string, content: BroadcastContent, filters: UserFilter): Broadcast {
    const id = randomUUID()
    const users = this.listUsers(projectId, { ...filters, blocked: false })
    const chatIds = new Set<number>()
    const recipients = users.filter(user => !chatIds.has(user.chatId) && Boolean(chatIds.add(user.chatId)))
    if (!recipients.length) throw new Error('В выбранном сегменте нет получателей.')
    this.transaction(() => {
      this.db.prepare("INSERT INTO broadcasts(id,project_id,content,filters,status,total,created_at) VALUES(?,?,?,?,'queued',?,?)").run(id, projectId, JSON.stringify(content), JSON.stringify(filters), recipients.length, now())
      const insert = this.db.prepare('INSERT INTO broadcast_recipients(broadcast_id,user_id) VALUES(?,?)')
      recipients.forEach(user => insert.run(id, user.id))
    })
    return this.getBroadcast(id)
  }

  getBroadcast(id: string): Broadcast {
    const r: any = this.db.prepare('SELECT * FROM broadcasts WHERE id=?').get(id)
    if (!r) throw new Error('Рассылка не найдена.')
    return { id: r.id, projectId: r.project_id, content: JSON.parse(r.content), filters: JSON.parse(r.filters), status: r.status, total: Number(r.total), sent: Number(r.sent), failed: Number(r.failed), createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at }
  }

  listBroadcasts(projectId: string) { return this.db.prepare('SELECT id FROM broadcasts WHERE project_id=? ORDER BY created_at DESC').all(projectId).map(r => this.getBroadcast(r.id as string)) }
  broadcastStatus(id: string, status: Broadcast['status']) { this.db.prepare('UPDATE broadcasts SET status=?,started_at=COALESCE(started_at,?),completed_at=? WHERE id=?').run(status, now(), ['completed', 'cancelled', 'interrupted'].includes(status) ? now() : null, id) }
  pendingRecipients(id: string) { return this.db.prepare("SELECT u.id,u.telegram_user_id,u.chat_id,u.first_name,u.last_name,u.username FROM broadcast_recipients r JOIN users u ON u.id=r.user_id WHERE r.broadcast_id=? AND r.status='pending'").all(id) }
  recipientResult(id: string, userId: number, error?: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE broadcast_recipients SET status=?,error=?,sent_at=? WHERE broadcast_id=? AND user_id=?').run(error ? 'failed' : 'sent', error ?? null, now(), id, userId)
      this.db.prepare(`UPDATE broadcasts SET sent=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=? AND status='sent'),failed=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=? AND status='failed') WHERE id=?`).run(id, id, id)
    })
  }
}
