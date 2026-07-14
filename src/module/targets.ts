/**
 * targets.ts — Quản lý danh sách "targets" (đối tượng bot thích chửi)
 *
 * ⚠️ FIX v1.5.28-treonhay — REFACTOR: chỉ lưu UID, KHÔNG lưu tên.
 *
 * Trước đây:
 *   - Mỗi target lưu cả name + aliases trong targets.json
 *   - Khi user đổi tên trên Zalo → bot không biết, gọi nhầm tên cũ
 *   - Aliases trùng lặp lung tung (Bảo Vy vs Vy dâm vs Vy đú...)
 *   - Phải sync thủ công khi đổi tên
 *
 * Giờ:
 *   - Chỉ lưu UID (primary key)
 *   - Khi cần hiển thị tên → gọi Zalo API `getUserInfo(uid)` on-demand
 *   - Có in-memory cache (TTL 5 phút) để khỏi spam API
 *   - User đổi tên Zalo → bot tự lấy tên mới
 *
 * Data file: data/targets.json
 *
 * Schema mới:
 *   [
 *     {
 *       "uid": "23819036851691045",
 *       "warCount": 1,
 *       "lastChallengedAt": 1783316814619,
 *       "lastSeenInThread": "8072231092820900983",
 *       "addedAt": 1783316811071
 *     },
 *     ...
 *   ]
 */
import fs from 'fs';
import path from 'path';

export interface Target {
    /** Zalo UID — primary key (REQUIRED) */
    uid: string;
    /** Số lần đã chửi target này */
    warCount: number;
    /** Timestamp lần cuối cùng bot chửi target */
    lastChallengedAt?: number;
    /** threadId gần nhất target xuất hiện */
    lastSeenInThread?: string;
    /** Timestamp thêm vào danh sách */
    addedAt: number;
}

const DATA_FILE = path.join(process.cwd(), 'data', 'targets.json');

// ============================================================
// In-memory cache cho displayName (key = uid)
// TTL 5 phút — đủ để batch nhiều lần gọi liên tiếp không spam API
// User đổi tên Zalo → cache tự expire → lấy tên mới.
// ============================================================
const DISPLAY_NAME_TTL_MS = 5 * 60 * 1000;
const displayNameCache = new Map<string, { name: string; ts: number }>();

/**
 * Lấy displayName hiện tại của 1 uid qua Zalo API.
 * Có in-memory cache (TTL 5 phút).
 * Trả về string hoặc null nếu fail.
 *
 * ⚠️ FIX v1.5.28-treonhay-verify — zca-js getUserInfo transform uid → `<uid>_0`
 * trước khi gửi. Response key trong `changed_profiles` không guaranteed nhất quán —
 * có thể là `uid`, `uid_0`, hoặc cả hai. Thử cả 3 key để robust.
 */
export async function getTargetDisplayName(uid: string): Promise<string | null> {
    if (!uid) return null;
    const cached = displayNameCache.get(uid);
    if (cached && Date.now() - cached.ts < DISPLAY_NAME_TTL_MS) {
        return cached.name;
    }
    try {
        const api: any = (global as any).api;
        if (!api?.getUserInfo) return null;
        const uInfo: any = await api.getUserInfo(uid);
        const profiles = uInfo?.changed_profiles ?? {};
        const prof =
            profiles[uid] ??
            profiles[String(uid)] ??
            profiles[`${uid}_0`] ??
            null;
        const name = String(prof?.displayName ?? prof?.zaloName ?? '').trim();
        if (name) {
            displayNameCache.set(uid, { name, ts: Date.now() });
            return name;
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Sync fetch nhiều displayName song song (cho ListTargets).
 * Cache hit trả ngay lập tức, cache miss → gọi API.
 */
export async function getTargetDisplayNames(uids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const misses: string[] = [];
    const now = Date.now();
    for (const uid of uids) {
        const cached = displayNameCache.get(uid);
        if (cached && now - cached.ts < DISPLAY_NAME_TTL_MS) {
            out.set(uid, cached.name);
        } else {
            misses.push(uid);
        }
    }
    // Gọi song song cho misses (dedupe để tránh gọi 2 lần cùng uid)
    const uniqueMisses = Array.from(new Set(misses));
    await Promise.all(uniqueMisses.map(async (uid) => {
        const name = await getTargetDisplayName(uid);
        if (name) out.set(uid, name);
    }));
    return out;
}

/**
 * Xoá cache (debug / force refresh).
 */
export function clearDisplayNameCache(uid?: string): void {
    if (uid) displayNameCache.delete(uid);
    else displayNameCache.clear();
}

// ============================================================
// Storage
// ============================================================
function ensureDataFile(): void {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
    }
}

function normalizeUid(uid: any): string {
    return String(uid ?? '').trim();
}

/**
 * Load targets từ disk. Tự động migrate schema cũ (có name/aliases)
 * → strip name/aliases, chỉ giữ uid.
 */
export function loadTargets(): Target[] {
    try {
        ensureDataFile();
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        // Migrate: filter chỉ giữ field hợp lệ + bỏ entry không có uid
        const migrated: Target[] = [];
        for (const item of arr) {
            const uid = normalizeUid(item?.uid);
            if (!uid) continue;
            migrated.push({
                uid,
                warCount: Number(item?.warCount ?? 0) || 0,
                lastChallengedAt: typeof item?.lastChallengedAt === 'number' ? item.lastChallengedAt : undefined,
                lastSeenInThread: typeof item?.lastSeenInThread === 'string' ? item.lastSeenInThread : undefined,
                addedAt: typeof item?.addedAt === 'number' ? item.addedAt : Date.now(),
            });
        }
        return migrated;
    } catch {
        return [];
    }
}

function saveTargets(targets: Target[]): void {
    try {
        ensureDataFile();
        fs.writeFileSync(DATA_FILE, JSON.stringify(targets, null, 2));
    } catch (e) {
        console.warn('[Targets] save failed:', e);
    }
}

// ============================================================
// Lookup / match
// ============================================================

/**
 * Find target theo UID.
 */
export function findTargetByUid(uid: string): Target | null {
    if (!uid) return null;
    const targets = loadTargets();
    const clean = normalizeUid(uid);
    return targets.find((t) => t.uid === clean) ?? null;
}

/**
 * Pick random target. Nếu preferWithUid=true → mặc định (vì giờ tất cả target
 * đều có uid, param này giữ để tương thích ngược nhưng không còn ý nghĩa).
 */
export function pickRandomTarget(_preferWithUid: boolean = true): Target | null {
    const targets = loadTargets();
    if (targets.length === 0) return null;
    return targets[Math.floor(Math.random() * targets.length)];
}

// ============================================================
// Mutations
// ============================================================

/**
 * Thêm target theo UID. Nếu UID đã tồn tại → return existing (idempotent).
 * Tự động fetch displayName để log (best-effort, không block).
 */
export async function addTargetByUid(uid: string): Promise<Target> {
    const clean = normalizeUid(uid);
    if (!clean) throw new Error('uid rỗng');
    const targets = loadTargets();
    const existing = targets.find((t) => t.uid === clean);
    if (existing) {
        console.log(`[Targets] UID ${clean} đã có trong danh sách (warCount=${existing.warCount})`);
        return existing;
    }
    const t: Target = {
        uid: clean,
        warCount: 0,
        addedAt: Date.now(),
    };
    targets.push(t);
    saveTargets(targets);
    // Best-effort fetch tên để log (không block)
    const name = await getTargetDisplayName(clean);
    console.log(`[Targets] ✓ Đã thêm target uid=${clean}${name ? ` (${name})` : ''}`);
    return t;
}

/**
 * Xoá target theo UID.
 */
export function removeTargetByUid(uid: string): boolean {
    const clean = normalizeUid(uid);
    const targets = loadTargets();
    const idx = targets.findIndex((t) => t.uid === clean);
    if (idx === -1) return false;
    targets.splice(idx, 1);
    saveTargets(targets);
    displayNameCache.delete(clean);
    console.log(`[Targets] ✓ Đã xoá target uid=${clean}`);
    return true;
}

/**
 * Bump warCount cho target theo UID.
 */
export function bumpWarCountByUid(uid: string): Target | null {
    const clean = normalizeUid(uid);
    const targets = loadTargets();
    const t = targets.find((x) => x.uid === clean);
    if (!t) return null;
    t.warCount += 1;
    t.lastChallengedAt = Date.now();
    saveTargets(targets);
    return t;
}

/**
 * Update lastSeenInThread cho target theo UID.
 * Gọi mỗi khi bot thấy user này trong group.
 */
export function updateTargetLastSeen(uid: string, threadId?: string): Target | null {
    const clean = normalizeUid(uid);
    const targets = loadTargets();
    const t = targets.find((x) => x.uid === clean);
    if (!t) return null;
    if (threadId) t.lastSeenInThread = threadId;
    saveTargets(targets);
    return t;
}

/**
 * Clear lastSeenInThread (gọi khi user rời group).
 */
export function clearTargetLastSeen(uid: string, threadId?: string): Target | null {
    const clean = normalizeUid(uid);
    const targets = loadTargets();
    const t = targets.find((x) => x.uid === clean);
    if (!t) return null;
    if (!threadId || t.lastSeenInThread === threadId) {
        t.lastSeenInThread = undefined;
        saveTargets(targets);
    }
    return t;
}

// ============================================================
// List (async — cần fetch displayName)
// ============================================================

/**
 * Trả về danh sách target dạng text (đã fetch displayName).
 */
export async function listTargets(): Promise<string> {
    const targets = loadTargets();
    if (targets.length === 0) return '(chưa có target nào)';
    const uids = targets.map((t) => t.uid);
    const names = await getTargetDisplayNames(uids);
    return targets.map((t, i) => {
        const name = names.get(t.uid) ?? '(chưa rõ tên)';
        const lastStr = t.lastChallengedAt
            ? `lastWar=${new Date(t.lastChallengedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`
            : 'lastWar=(chưa)';
        return `${i + 1}. ${name} — uid=${t.uid} — warCount=${t.warCount} — ${lastStr}`;
    }).join('\n');
}

// ============================================================
// Backward compat shims
// ============================================================
//
// Các function cũ (name-based) được giữ lại dưới dạng shim không-op
// để code cũ không crash. Sẽ xoá hẳn khi refactor xong các caller.
//
// ⚠️ KHÔNG dùng trong code mới — dùng UID-based functions ở trên.

/** @deprecated dùng addTargetByUid */
export function addTarget(_name: string, _aliases: string[] = []): Target {
    throw new Error('addTarget(name, aliases) đã bị xoá — dùng addTargetByUid(uid). Nếu cần resolve name→uid, gọi findUidByDisplayName trước.');
}

/** @deprecated dùng removeTargetByUid */
export function removeTarget(_name: string): boolean {
    throw new Error('removeTarget(name) đã bị xoá — dùng removeTargetByUid(uid).');
}

/** @deprecated dùng findTargetByUid */
export function findTargetByName(_name: string): Target | null {
    return null; // không thể match theo name nữa — luôn trả null
}

/** @deprecated dùng updateTargetLastSeen */
export function matchUserToTarget(_displayName: string, uid: string, threadId?: string): Target | null {
    // Best-effort: cập nhật lastSeenInThread nếu uid là target
    return updateTargetLastSeen(uid, threadId);
}

/** @deprecated dùng bumpWarCountByUid */
export function bumpWarCount(name: string): Target | null {
    // Không biết uid → không thể bump. Caller phải dùng bumpWarCountByUid.
    console.warn(`[Targets] bumpWarCount("${name}") đã deprecated — caller phải truyền uid`);
    return null;
}

/** @deprecated không còn cần — dùng listTargets() (async) */
export function listTargetsSync(): string {
    const targets = loadTargets();
    if (targets.length === 0) return '(chưa có target nào)';
    return targets.map((t, i) => {
        return `${i + 1}. uid=${t.uid} — warCount=${t.warCount}`;
    }).join('\n');
}

/** @deprecated giữ lại để tương thích — không còn ý nghĩa normalize name */
export function normalizeName(s: string): string {
    return (s || '').toLowerCase().trim();
}