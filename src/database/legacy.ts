import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'

const tables = ['schema_migrations', 'projects', 'settings', 'users', 'user_variables', 'user_sessions', 'interactions', 'broadcasts', 'broadcast_recipients', 'assets']

export function migrateLegacy(db: DatabaseSync, filename: string) {
  const columns = db.prepare('PRAGMA table_info(projects)').all().map(column => column.name)
  if (!columns.includes('bot_username') || columns.includes('username')) return
  const backup = `${filename}.before-v1-${Date.now()}.bak`
  db.prepare('VACUUM INTO ?').run(backup)
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of tables) if (existing.has(table)) db.exec(`ALTER TABLE "${table}" RENAME TO "legacy_${table}"`)
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'legacy_%' AND sql IS NOT NULL").all()) db.exec(`DROP INDEX "${String(row.name).replaceAll('"', '""')}"`)
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    for (const migration of migrations) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.version, new Date().toISOString())
    }
    db.exec(`INSERT INTO projects(id,name,token,username,workflow,status,created_at,updated_at)
      SELECT id,name,NULL,bot_username,workflow,'stopped',created_at,updated_at FROM legacy_projects`)
    if (existing.has('settings')) db.exec('INSERT INTO settings(key,value) SELECT key,value FROM legacy_settings')
    if (existing.has('users')) db.exec(`INSERT INTO users(id,project_id,telegram_user_id,chat_id,username,first_name,last_name,language_code,first_started_at,last_activity_at,message_count,current_node,blocked)
      SELECT id,project_id,CAST(telegram_user_id AS INTEGER),CAST(chat_id AS INTEGER),username,COALESCE(first_name,''),last_name,language_code,first_started_at,last_activity_at,message_count,current_node,blocked FROM legacy_users`)
    if (existing.has('user_sessions')) db.exec(`UPDATE users SET current_node=COALESCE(current_node,(SELECT pending_node_id FROM legacy_user_sessions WHERE user_id=users.id))`)
    if (existing.has('user_variables')) db.exec('INSERT INTO user_variables(user_id,key,value,updated_at) SELECT user_id,key,value,updated_at FROM legacy_user_variables')
    if (existing.has('assets')) db.exec('INSERT INTO assets(id,project_id,path,name,mime,size) SELECT id,project_id,relative_path,original_name,mime_type,size FROM legacy_assets')
    if (existing.has('interactions')) db.exec("INSERT INTO interactions(id,user_id,kind,created_at) SELECT id,user_id,direction || ':' || event_type,created_at FROM legacy_interactions WHERE user_id IS NOT NULL")
    if (existing.has('broadcasts')) {
      for (const row of db.prepare('SELECT * FROM legacy_broadcasts').all()) {
        const content = JSON.parse(String(row.content))
        const kinds: Record<string, string> = { text: 'sendMessage', photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' }
        content.type ??= kinds[String(row.type)] ?? String(row.type)
        const status = ['completed', 'cancelled'].includes(String(row.status)) ? String(row.status) : 'interrupted'
        db.prepare('INSERT INTO broadcasts(id,project_id,content,filters,status,total,sent,failed,created_at,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.project_id, JSON.stringify(content), row.filters, status, row.total, row.sent, row.failed, row.created_at, row.started_at, row.completed_at)
      }
    }
    if (existing.has('broadcast_recipients')) db.exec('INSERT INTO broadcast_recipients(broadcast_id,user_id,status,error,sent_at) SELECT broadcast_id,user_id,status,error,sent_at FROM legacy_broadcast_recipients')
    for (const table of [...tables].reverse()) if (existing.has(table)) db.exec(`DROP TABLE "legacy_${table}"`)
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('legacy_import', JSON.stringify({ backup, importedAt: new Date().toISOString(), reenterToken: true }))
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
