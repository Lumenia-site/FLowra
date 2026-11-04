import type { DatabaseSync } from 'node:sqlite'

export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT, username TEXT,
        workflow TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'stopped',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        telegram_user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, username TEXT,
        first_name TEXT NOT NULL DEFAULT '', last_name TEXT, language_code TEXT,
        first_started_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0, current_node TEXT, blocked INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, telegram_user_id)
      );
      CREATE INDEX users_project_activity ON users(project_id, last_activity_at);
      CREATE INDEX users_project_language ON users(project_id, language_code);
      CREATE TABLE user_variables (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );
      CREATE TABLE broadcasts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL, filters TEXT NOT NULL, status TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
      );
      CREATE TABLE broadcast_recipients (
        broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT, sent_at TEXT,
        PRIMARY KEY(broadcast_id, user_id)
      );
      CREATE INDEX broadcasts_project ON broadcasts(project_id, created_at);
      CREATE INDEX recipients_status ON broadcast_recipients(broadcast_id, status);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE assets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        UNIQUE(project_id, path)
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX logs_project ON logs(project_id, id);
      CREATE TABLE interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX interactions_user ON interactions(user_id, id);
    `,
  },
]

export function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  for (const migration of migrations) {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
