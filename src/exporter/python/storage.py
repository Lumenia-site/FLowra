import json
import sqlite3
import threading
from datetime import datetime, timezone


class Store:
    def __init__(self, filename):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(filename, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
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
        ''')

    def upsert_user(self, profile, chat_id):
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            self.db.execute('''
                INSERT INTO users (telegram_user_id, chat_id, profile, first_started_at, last_activity_at, message_count)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(telegram_user_id) DO UPDATE SET
                    chat_id=excluded.chat_id, profile=excluded.profile,
                    last_activity_at=excluded.last_activity_at, message_count=message_count+1
            ''', (profile['id'], chat_id, json.dumps(profile, ensure_ascii=False), now, now))
            self.db.commit()
            return self.db.execute('SELECT * FROM users WHERE telegram_user_id=?', (profile['id'],)).fetchone()

    def variables(self, user_id):
        with self.lock:
            return {row['key']: json.loads(row['value']) for row in self.db.execute('SELECT key, value FROM user_variables WHERE user_id=?', (user_id,))}

    def set_variable(self, user_id, key, value):
        with self.lock:
            self.db.execute('INSERT INTO user_variables (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value', (user_id, key, json.dumps(value, ensure_ascii=False)))
            self.db.commit()

    def current_node(self, user_id):
        with self.lock:
            return self.db.execute('SELECT current_node FROM users WHERE id=?', (user_id,)).fetchone()[0]

    def set_current_node(self, user_id, node_id):
        with self.lock:
            self.db.execute('UPDATE users SET current_node=? WHERE id=?', (node_id, user_id))
            self.db.commit()

    def get_offset(self):
        with self.lock:
            row = self.db.execute("SELECT value FROM settings WHERE key='offset'").fetchone()
            return int(row[0]) if row else 0

    def set_offset(self, value):
        with self.lock:
            self.db.execute("INSERT INTO settings (key,value) VALUES ('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(value),))
            self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()
