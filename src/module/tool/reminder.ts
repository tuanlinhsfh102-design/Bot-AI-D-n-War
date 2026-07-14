/**
 * reminder.ts — SetReminder tool
 * Bot có thể tự đặt nhắc nhở và tự gửi tin nhắn khi đến giờ.
 *
 * - Lưu reminder vào SQLite (data/reminders.db) để không mất khi restart
 * - Một interval 30s quét các reminder đến hạn, gọi callback
 * - Hỗ trợ "nhắc tao X sau Y phút/giờ" hoặc "nhắc lúc HH:mm"
 *
 * Usage:
 *   const rid = await scheduleReminder({ threadId, userId, content, fireAt, threadType });
 *   // interval bên dưới tự fire
 */
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';

/**
 * ThreadType cho reminder. zca-js chỉ có 2 loại:
 *   - 'User'  = chat riêng (Direct Message)
 *   - 'Group' = chat nhóm
 * 'DirectMessage' KHÔNG tồn tại trong zca-js enum — phải dùng 'User'.
 */
export type ReminderThreadType = 'User' | 'Group';

export interface Reminder {
    id?: number;
    threadId: string;
    userId: string;
    content: string;       // nội dung bot sẽ nhắn khi đến giờ
    fireAt: number;        // unix ms
    threadType: ReminderThreadType;
    createdAt: number;
    fired: number;         // 0/1
}

// ============================================================
// Storage
// ============================================================
const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'reminders.db');

let db: Database | null = null;

function getDb(): Database {
    if (db) return db;
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath, { create: true });
    db.run(`
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            content TEXT NOT NULL,
            fire_at INTEGER NOT NULL,
            thread_type TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            fired INTEGER NOT NULL DEFAULT 0
        );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_fire_at ON reminders(fire_at);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_fired ON reminders(fired);`);
    return db;
}

export function scheduleReminder(opts: {
    threadId: string;
    userId: string;
    content: string;
    fireAt: number;       // unix ms
    threadType?: ReminderThreadType;
}): number {
    const db = getDb();
    const threadType: ReminderThreadType = opts.threadType ?? 'User';
    const now = Date.now();
    db.run(
        `INSERT INTO reminders (thread_id, user_id, content, fire_at, thread_type, created_at, fired)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [opts.threadId, opts.userId, opts.content, opts.fireAt, threadType, now],
    );
    const row = db.query('SELECT last_insert_rowid() as id').get() as any;
    return Number(row?.id ?? 0);
}

export function cancelReminder(id: number): boolean {
    const db = getDb();
    db.run('UPDATE reminders SET fired = 1 WHERE id = ?', [id]);
    return true;
}

export function listPendingReminders(threadId?: string): Reminder[] {
    const db = getDb();
    const sql = threadId
        ? 'SELECT * FROM reminders WHERE fired = 0 AND thread_id = ? ORDER BY fire_at ASC'
        : 'SELECT * FROM reminders WHERE fired = 0 ORDER BY fire_at ASC';
    const stmt = db.query(sql);
    const rows = (threadId ? stmt.all(threadId) : stmt.all()) as any[];
    return rows.map(rowToReminder);
}

function rowToReminder(r: any): Reminder {
    return {
        id: r.id,
        threadId: r.thread_id,
        userId: r.user_id,
        content: r.content,
        fireAt: r.fire_at,
        threadType: (r.thread_type === 'Group' ? 'Group' : 'User') as ReminderThreadType,
        createdAt: r.created_at,
        fired: r.fired,
    };
}

// ============================================================
// Scheduler loop — gọi callback khi reminder đến giờ
// ============================================================
type FireCallback = (reminder: Reminder) => Promise<void> | void;

let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;
let fireCallback: FireCallback | null = null;
const POLL_INTERVAL_MS = 30 * 1000; // 30s

export function startReminderScheduler(cb: FireCallback): void {
    if (schedulerStarted) {
        fireCallback = cb;
        return;
    }
    schedulerStarted = true;
    fireCallback = cb;

    const tick = async () => {
        try {
            const now = Date.now();
            const db = getDb();
            const stmt = db.query('SELECT * FROM reminders WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at ASC LIMIT 50');
            const due = stmt.all(now) as any[];
            for (const row of due) {
                const rem = rowToReminder(row);
                db.run('UPDATE reminders SET fired = 1 WHERE id = ?', [rem.id]);
                if (fireCallback) {
                    try {
                        await fireCallback(rem);
                    } catch (e) {
                        console.warn('[Reminder] fire callback failed:', e);
                    }
                }
            }
        } catch (e) {
            console.warn('[Reminder] scheduler tick error:', e);
        } finally {
            schedulerTimer = setTimeout(tick, POLL_INTERVAL_MS);
        }
    };
    void tick();
}

export function stopReminderScheduler(): void {
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = null;
    schedulerStarted = false;
    fireCallback = null;
}

// ============================================================
// Parsing helpers — parse natural language time
// ============================================================
/**
 * Parse các cụm từ thời gian tiếng Việt:
 *   "sau 30 phút" / "30 phút nữa" / "30 phut nua"  → now + 30*60_000
 *   "sau 2 tiếng" / "2 tiếng nữa" / "2 gio nua"    → now + 2*3_600_000
 *   "lúc 15:30" / "15h30"                           → hôm nay 15:30 (hoặc ngày mai nếu đã qua)
 *   "mai 9h sáng" / "mai 9h"                         → ngày mai 09:00
 *   "8h tối nay" / "8h chieu"                        → hôm nay 20:00
 *   "sau N ngày" / "N ngay nua"                      → now + N*86_400_000
 * Trả về unix ms hoặc null nếu không parse được.
 */
export function parseVietnameseTime(text: string, now: number = Date.now()): number | null {
    const t = text.toLowerCase().trim();

    // ⚠️ FIX v1.5.8 — \b không hoạt động với unicode tiếng Việt (vd "giờ", "phút").
    // Dùng (?:\s|$|nữa|nua) thay cho \b.
    // "sau N phút" hoặc "N phút nữa"
    let m = t.match(/(?:sau\s+)?(\d+)\s*(phút|phut|p)(?:\s+nữa|\s+nua|\s|$)/);
    if (m) return now + Number(m[1]) * 60_000;

    // "sau N tiếng/giờ/h" hoặc "N tiếng nữa"
    m = t.match(/(?:sau\s+)?(\d+)\s*(tiếng|tieng|giờ|gio|h)(?:\s+nữa|\s+nua|\s|$)/);
    if (m) return now + Number(m[1]) * 3_600_000;

    // "sau N ngày" hoặc "N ngày nữa"
    m = t.match(/(?:sau\s+)?(\d+)\s*(ngày|ngay)(?:\s+nữa|\s+nua|\s|$)/);
    if (m) return now + Number(m[1]) * 86_400_000;

    // "mai [lúc] HH:mm" hoặc "mai HHh"
    if (/\bmai\b/.test(t)) {
        const tm = t.match(/(\d{1,2})[:h]+(\d{0,2})/);
        if (tm) {
            const h = Number(tm[1]);
            const min = tm[2] ? Number(tm[2]) : 0;
            const d = new Date(now);
            d.setDate(d.getDate() + 1);
            d.setHours(h, min, 0, 0);
            return d.getTime();
        }
        // "mai" không có giờ → mai 9h sáng
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d.getTime();
    }

    // "lúc HH:mm" hoặc "HHh"
    const tm = t.match(/(?:lúc|luc)?\s*(\d{1,2})[:h]+(\d{0,2})/);
    if (tm) {
        let h = Number(tm[1]);
        const min = tm[2] ? Number(tm[2]) : 0;
        const eveningMatch = t.match(/(tối|toi|chiều|chieu|pm)\b/);
        const morningMatch = t.match(/(sáng|sang|morning|am)\b/);
        if (eveningMatch && h < 12) h += 12;
        if (morningMatch && h > 12) h -= 12;
        const d = new Date(now);
        d.setHours(h, min, 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        return d.getTime();
    }

    return null;
}
