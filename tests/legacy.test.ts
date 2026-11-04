import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FlowraDatabase } from '../src/database/database'
import { initialWorkflow } from '../src/shared/workflow'

test('старая схема Flowra переносится с резервной копией, пользователями, файлами и переменными', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowra-legacy-'))
  const filename = path.join(root, 'flowra.sqlite')
  const legacy = new DatabaseSync(filename)
  legacy.exec('PRAGMA foreign_keys=OFF')
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1,'initial_schema','2026-10-07');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,token TEXT NOT NULL,bot_username TEXT,workflow TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE users(id INTEGER PRIMARY KEY,project_id TEXT REFERENCES projects(id),telegram_user_id TEXT,chat_id TEXT,username TEXT,first_name TEXT,last_name TEXT,language_code TEXT,first_started_at TEXT,last_activity_at TEXT,message_count INTEGER,current_node TEXT,blocked INTEGER);
    CREATE TABLE user_variables(id INTEGER PRIMARY KEY,project_id TEXT,user_id INTEGER REFERENCES users(id),key TEXT,value TEXT,updated_at TEXT);
    CREATE TABLE user_sessions(user_id INTEGER REFERENCES users(id),pending_node_id TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),relative_path TEXT,original_name TEXT,mime_type TEXT,size INTEGER,created_at TEXT);
    CREATE TABLE interactions(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),direction TEXT,event_type TEXT,created_at TEXT);
    INSERT INTO users VALUES(1,'legacy','123','123','anna','Анна',NULL,'ru','2026-10-07','2026-10-08',3,NULL,0);
    INSERT INTO user_variables VALUES(1,'legacy',1,'name','"Анна"','2026-10-08');
    INSERT INTO user_sessions VALUES(1,'waiting');
    INSERT INTO assets VALUES('photo','legacy','assets/photo.png','Фото.png','image/png',100,'2026-10-07');
    INSERT INTO interactions VALUES(1,1,'in','message','2026-10-08');
    INSERT INTO settings VALUES('app','{"theme":"dark"}','2026-10-07');
  `)
  legacy.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)').run('legacy', 'Старый бот', 'old-secret', 'old_bot', JSON.stringify(initialWorkflow()), 'running', '2026-10-07', '2026-10-08')
  legacy.close()
  const database = new FlowraDatabase(filename)
  try {
    assert.equal(database.getProject('legacy').username, 'old_bot')
    assert.equal(database.getProject('legacy').hasToken, false)
    assert.equal(database.listUsers('legacy')[0].telegramUserId, 123)
    assert.equal(database.getVariables(1).name, 'Анна')
    assert.equal(database.getCurrentNode(1), 'waiting')
    assert.equal(database.listAssets('legacy')[0].path, 'assets/photo.png')
    assert.equal(database.getSetting<any>('app', {}).theme, 'dark')
    assert.equal((await readdir(root)).filter(name => name.endsWith('.bak')).length, 1)
    database.setVariable(1, 'city', 'Ташкент')
    const backup = new DatabaseSync(database.getSetting<any>('legacy_import', {}).backup, { readOnly: true })
    assert.equal(backup.prepare('SELECT COUNT(*) n FROM projects').get()?.n, 1)
    assert.equal(backup.prepare('SELECT COUNT(*) n FROM user_variables').get()?.n, 1)
    backup.close()
  } finally { database.close(); await rm(root, { recursive: true, force: true }) }
})
