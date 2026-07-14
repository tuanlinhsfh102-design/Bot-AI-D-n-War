import fs from 'fs';
import path from 'path';
import type { Message } from 'zca-js';
import { Database } from 'bun:sqlite';

const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'messages.db');

function ensureDbDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

let db: Database | null = null;

function hasColumn(database: Database, tableName: string, columnName: string): boolean {
  const rows = database.query(`PRAGMA table_info(${tableName});`).all() as Array<{ name?: string }>;
  return rows.some((row) => row?.name === columnName);
}

function ensureColumn(database: Database, tableName: string, columnName: string, definition: string): void {
  if (!hasColumn(database, tableName, columnName)) {
    database.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

function getDb(): Database {
  if (db) return db;
  ensureDbDir();
  db = new Database(dbPath, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      thread_type TEXT,
      is_self INTEGER,
      content TEXT,
      derived_text TEXT,
      msg_id TEXT,
      cli_msg_id TEXT,
      reply_cli_msg_id TEXT,
      quote_json TEXT,
      payload_json TEXT,
      created_at INTEGER
    );
  `);
  ensureColumn(db, 'messages', 'content', 'TEXT');
  ensureColumn(db, 'messages', 'derived_text', 'TEXT');
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_short_id ON messages(short_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);`);
  return db;
}

function generateShortId(): string {
  return Math.floor(1000000 + Math.random() * 9000000).toString();
}

export function saveIncomingMessage(message: Message, derivedText?: string): string {
  const database = getDb();
  const now = Date.now();
  // Extract fields safely
  const threadId = message.threadId;
  const threadType = String(message.type);
  const isSelf = message.isSelf ? 1 : 0;
  const content = typeof message.data?.content === 'string' ? message.data.content : '';
  const msgId = (message as any)?.data?.msgId ?? null;
  const cliMsgId = (message as any)?.data?.cliMsgId ?? null;
  const replyCliMsgId = (message as any)?.data?.quote?.cliMsgId ?? null;
  const quoteJson = (message as any)?.data?.quote ? JSON.stringify((message as any).data.quote) : null;
  const payloadJson = JSON.stringify(message);

  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    const shortId = generateShortId();
    try {
      database.run(
        `INSERT INTO messages (short_id, thread_id, thread_type, is_self, content, derived_text, msg_id, cli_msg_id, reply_cli_msg_id, quote_json, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shortId,
          threadId,
          threadType,
          isSelf,
          content,
          derivedText ?? null,
          msgId,
          cliMsgId,
          replyCliMsgId,
          quoteJson,
          payloadJson,
          now,
        ],
      );
      return shortId;
    } catch (e: any) {
      // Retry on unique constraint violation
      const msg = String(e?.message || e);
      if (!/UNIQUE constraint failed: messages\.short_id/i.test(msg)) {
        throw e;
      }
      // else generate a new short id and retry
    }
  }
  // Fallback with timestamp-based id (still 7 digits by modulo), last resort
  const fallback = (Math.floor(now % 9000000) + 1000000).toString();
  database.run(
    `INSERT OR IGNORE INTO messages (short_id, thread_id, thread_type, is_self, content, derived_text, msg_id, cli_msg_id, reply_cli_msg_id, quote_json, payload_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    fallback,
    threadId,
    threadType,
    isSelf,
    content,
    derivedText ?? null,
    msgId,
    cliMsgId,
    replyCliMsgId,
    quoteJson,
    payloadJson,
    now,
  );
  return fallback;
}

export function getMessageByShortId(shortId: string): { payload: any | null; quote: any | null } | null {
  const database = getDb();
  const stmt = database.query(
    `SELECT quote_json, payload_json FROM messages WHERE short_id = ?1`
  );
  const row = stmt.get(shortId) as any;
  if (!row) return null;
  const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  const quote = row.quote_json ? JSON.parse(row.quote_json) : null;
  return { payload, quote };
}
