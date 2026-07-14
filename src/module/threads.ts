/**
 * threads.ts — Track các thread (group + DM) mà bot đã từng chat
 *
 * Nguyễn Đình Dương là dân war chủ động → cần biết group nào để gửi chửi ngẫu nhiên.
 * Khi bot nhận tin từ group → add thread + cache member UIDs.
 * Scheduler proactive sẽ pick random recent thread để fire chửi.
 *
 * ⚠️ FIX v1.5.0 — Sync group list từ Zalo API khi startup
 * Trước đây known_threads chỉ chứa group nơi bot ĐÃ nhận tin nhắn.
 * Nếu bot ở 5 group nhưng chỉ 1 group có activity → proactive scheduler
 * chỉ fire vào 1 group đó. User thấy "bot chỉ chửi ở 1 group, bơ mấy group kia".
 *
 * Giờ: syncAllGroupsFromZalo() được gọi khi login thành công → fetch tất cả
 * group bot đang là member → add vào known_threads.json. Proactive scheduler
 * sẽ fire đều giữa các group.
 *
 * Data file: data/known_threads.json
 */
import fs from 'fs';
import path from 'path';

export interface KnownThread {
    threadId: string;
    threadType: 'User' | 'Group';
    lastActiveAt: number;       // unix ms
    memberUids?: string[];      // cache members (Group only)
    memberNames?: Record<string, string>;  // uid → displayName (Group only)
    groupName?: string;         // cache tên nhóm
}

const DATA_FILE = path.join(process.cwd(), 'data', 'known_threads.json');
const RECENT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;  // 7 ngày

// ============================================================
// ⚠️ FIX v1.5.19 — Thread ID validation
// Zalo threadId (cả group và user) đều là số nguyên dài (15-20 chữ số).
// Các giá trị như "group_abc", "user_xyz", "test_123" là fake/test data
// → bot không thể gửi tin nhắn → gây lỗi "nhắn IB cho user không tồn tại".
// ============================================================

/**
 * Validate threadId có phải là Zalo threadId hợp lệ không.
 * - Phải là string hoặc number
 * - Nếu string: phải match /^\d{10,25}$/ (10-25 chữ số)
 * - Nếu number: phải > 0 và < Number.MAX_SAFE_INTEGER
 */
export function isValidThreadId(threadId: any): boolean {
    if (!threadId) return false;
    if (typeof threadId === 'number') {
        return threadId > 0 && Number.isFinite(threadId);
    }
    if (typeof threadId === 'string') {
        const trimmed = threadId.trim();
        if (!trimmed) return false;
        // Zalo threadId: 10-25 chữ số (uid thường 16-20, groupId 16-19)
        return /^\d{10,25}$/.test(trimmed);
    }
    return false;
}

/**
 * Sanitize threadId — trả về string hợp lệ hoặc null nếu không hợp lệ.
 */
export function sanitizeThreadId(threadId: any): string | null {
    if (isValidThreadId(threadId)) {
        return String(threadId).trim();
    }
    return null;
}

// ============================================================
// Storage
// ============================================================
function ensureFile(): void {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
    }
}

export function loadThreads(): KnownThread[] {
    try {
        ensureFile();
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        // ⚠️ FIX v1.5.19 — Filter out invalid threadId (fake test data, non-numeric)
        // Tránh bot gửi IB cho thread không tồn tại (vd "group_abc", "user_xyz")
        return arr.filter((t: any) => isValidThreadId(t?.threadId));
    } catch {
        return [];
    }
}

export function saveThreads(threads: KnownThread[]): void {
    try {
        ensureFile();
        fs.writeFileSync(DATA_FILE, JSON.stringify(threads, null, 2));
    } catch (e) {
        console.warn('[Threads] save failed:', e);
    }
}

/**
 * Xoá 1 thread hoàn toàn khỏi known_threads.json.
 * Dùng khi fire báo "Nhóm này không tồn tại" (group bị xoá/xả).
 */
export function removeKnownThread(threadId: string): boolean {
    if (!isValidThreadId(threadId)) return false;
    const threads = loadThreads();
    const next = threads.filter((t) => t.threadId !== String(threadId));
    if (next.length === threads.length) return false; // không có → nothing to remove
    saveThreads(next);
    console.log(`[Threads] ✓ Removed dead thread ${threadId} from known_threads.json`);
    return true;
}

// ============================================================
// Mutations
// ============================================================

export function addKnownThread(
    threadId: string,
    threadType: 'User' | 'Group',
    options: { memberUids?: string[]; memberNames?: Record<string, string>; groupName?: string } = {},
): void {
    // ⚠️ FIX v1.5.19 — Validate threadId trước khi add để tránh fake/test data
    const validId = sanitizeThreadId(threadId);
    if (!validId) {
        console.warn(`[Threads] ⚠ Skip addKnownThread: threadId "${threadId}" không hợp lệ (phải là số 10-25 chữ số)`);
        return;
    }
    const threads = loadThreads();
    let t = threads.find((x) => x.threadId === validId);
    if (!t) {
        t = {
            threadId: validId,
            threadType,
            lastActiveAt: Date.now(),
        };
        threads.push(t);
    }
    t.threadType = threadType;
    t.lastActiveAt = Date.now();
    if (options.memberUids) t.memberUids = options.memberUids;
    if (options.memberNames) t.memberNames = options.memberNames;
    if (options.groupName) t.groupName = options.groupName;
    saveThreads(threads);
}

/**
 * Lấy danh sách thread active gần đây (trong RECENT_THRESHOLD_MS).
 */
export function getRecentThreads(maxAgeMs: number = RECENT_THRESHOLD_MS): KnownThread[] {
    const now = Date.now();
    return loadThreads().filter((t) => now - t.lastActiveAt < maxAgeMs);
}

/**
 * Pick random recent thread. preferGroup=true → ưu tiên group (vì chửi targets trong group vui hơn).
 */
export function pickRandomRecentThread(preferGroup: boolean = true): KnownThread | null {
    const recent = getRecentThreads();
    if (recent.length === 0) return null;

    if (preferGroup) {
        const groups = recent.filter((t) => t.threadType === 'Group');
        if (groups.length > 0) {
            return groups[Math.floor(Math.random() * groups.length)];
        }
    }
    return recent[Math.floor(Math.random() * recent.length)];
}

/**
 * Tìm các thread có chứa 1 uid cụ thể (để mention target trong group target đang ở).
 */
export function findThreadsWithUid(uid: string): KnownThread[] {
    if (!uid) return [];
    return loadThreads().filter((t) => {
        if (t.threadType !== 'Group') return false;
        return (t.memberUids ?? []).includes(uid);
    });
}

/**
 * Pick random group có target uid đang ở.
 */
export function pickRandomThreadWithUid(uid: string): KnownThread | null {
    const threads = findThreadsWithUid(uid);
    if (threads.length === 0) return null;
    return threads[Math.floor(Math.random() * threads.length)];
}

/**
 * Drop 1 (hoặc nhiều) uid ra khỏi member cache của thread.
 * Dùng khi nhận group_event LEAVE / REMOVE_MEMBER để cache không "outdated".
 *
 * Trả về true nếu có thay đổi, false nếu không có gì để drop.
 */
export function removeMembersFromThread(threadId: string, uids: string | string[]): boolean {
    if (!threadId) return false;
    const arr = Array.isArray(uids) ? uids : [uids];
    const filtered = arr.filter(Boolean);
    if (filtered.length === 0) return false;

    const threads = loadThreads();
    const t = threads.find((x) => x.threadId === threadId);
    if (!t) return false;

    let changed = false;
    if (t.memberUids && t.memberUids.length > 0) {
        const before = t.memberUids.length;
        t.memberUids = t.memberUids.filter((u) => !filtered.includes(u));
        if (t.memberUids.length !== before) changed = true;
    }
    if (t.memberNames) {
        for (const u of filtered) {
            if (u in t.memberNames) {
                delete t.memberNames[u];
                changed = true;
            }
        }
    }

    if (changed) {
        saveThreads(threads);
        console.log(`[Threads] ✓ Dropped ${filtered.length} uid(s) khỏi thread ${threadId} — còn ${t.memberUids?.length ?? 0} members`);
    }
    return changed;
}

/**
 * THÊM uid(s) vào memberUids cache của thread.
 * Dùng khi có member mới join group (GroupEventType.JOIN) để bot cache ngay uid.
 *
 * @param threadId  threadId của group
 * @param uids      uid(s) cần add
 * @param names     (optional) map uid → displayName để cache luôn tên
 * @returns true nếu có thay đổi (đã add mới), false nếu uid đã có sẵn hoặc thread không tồn tại
 */
export function addMembersToThread(
    threadId: string,
    uids: string | string[],
    names?: Record<string, string>,
): boolean {
    if (!threadId) return false;
    const arr = Array.isArray(uids) ? uids : [uids];
    const filtered = arr.filter(Boolean);
    if (filtered.length === 0) return false;

    const threads = loadThreads();
    let t = threads.find((x) => x.threadId === threadId);
    if (!t) {
        // Thread chưa có trong cache → tạo mới
        t = {
            threadId,
            threadType: 'Group',
            lastActiveAt: Date.now(),
            memberUids: [],
            memberNames: {},
        };
        threads.push(t);
    }

    let added = 0;
    if (!t.memberUids) t.memberUids = [];
    if (!t.memberNames) t.memberNames = {};
    for (const uid of filtered) {
        if (!t.memberUids.includes(uid)) {
            t.memberUids.push(uid);
            added++;
        }
        if (names && names[uid]) {
            t.memberNames[uid] = names[uid];
        }
    }

    if (added > 0) {
        saveThreads(threads);
        console.log(`[Threads] ✓ Added ${added} new uid(s) vào thread ${threadId} — total ${t.memberUids.length} members`);
    }
    return added > 0;
}

/**
 * Fetch danh sách members của group từ Zalo API.
 *
 * ⚠️ FIX v1.5.7 — Pipeline ĐÚNG theo zca-js:
 *   1. getGroupInfo(groupId) → resp.gridInfoMap[groupId].memVerList = ["<uid>_<ver>", ...]
 *      (currentMems và memberIds THƯỜNG RỖNG — không dùng được!)
 *   2. Extract UIDs từ memVerList bằng split('_')[0]
 *   3. getGroupMembersInfo(uids) → resp.profiles = { [uid]: { displayName, zaloName, avatar, ... } }
 *
 * Trả về array of { uid, name }. Cache kết quả vào known_threads.json.
 */
export async function fetchGroupMembers(
    threadId: string,
): Promise<Array<{ uid: string; name: string }>> {
    if (!threadId || !global.api) return [];

    try {
        // 1. getGroupInfo → lấy memVerList
        const resp: any = await (global.api as any).getGroupInfo(threadId);
        const gridInfoMap = resp?.gridInfoMap ?? resp?.data?.gridInfoMap ?? {};
        const g: any = gridInfoMap[threadId] ?? gridInfoMap[Object.keys(gridInfoMap)[0]] ?? {};

        // 2. Extract UIDs từ memVerList (format: "<uid>_<version>")
        const memVerList: string[] = Array.isArray(g?.memVerList) ? g.memVerList : [];
        const uids: string[] = memVerList
            .map((s) => String(s).split('_')[0])
            .filter((uid) => uid && /^\d+$/.test(uid));

        if (uids.length === 0) {
            // Fallback: thử currentMems (có thể có trong 1 số case)
            const currentMems: any[] = Array.isArray(g?.currentMems) ? g.currentMems : [];
            for (const m of currentMems) {
                const uid = String(m?.id ?? '');
                if (uid) uids.push(uid);
            }
        }

        if (uids.length === 0) return [];

        // 3. getGroupMembersInfo → lấy displayName, zaloName
        const profilesResp: any = await (global.api as any).getGroupMembersInfo(uids);
        const profiles = profilesResp?.profiles ?? {};
        const members: Array<{ uid: string; name: string }> = [];
        for (const uid of uids) {
            const p = profiles[uid];
            const name = String(p?.displayName ?? p?.zaloName ?? '');
            members.push({ uid, name: name || uid });
        }

        // 4. Cache vào known_threads
        if (members.length > 0) {
            const namesMap: Record<string, string> = {};
            for (const m of members) {
                if (m.name && m.name !== m.uid) namesMap[m.uid] = m.name;
            }
            addMembersToThread(threadId, uids, namesMap);
        }

        return members;
    } catch (e: any) {
        console.warn(`[Threads] fetchGroupMembers failed: ${e?.message ?? e}`);
        return [];
    }
}

/**
 * Tìm user trong group theo tên (fuzzy match, case-insensitive, no-accent).
 * Trả về danh sách { uid, name, score } sắp xếp theo độ match giảm dần.
 *
 * Dùng khi admin nói "chửi thằng Hihi" mà "Hihi" không có trong targets.json —
 * bot có thể tìm trong group để lấy uid rồi mention.
 *
 * @param threadId  groupId
 * @param query     tên cần tìm
 * @param limit     số kết quả tối đa (mặc định 5)
 */
export async function findMembersByName(
    threadId: string,
    query: string,
    limit: number = 5,
): Promise<Array<{ uid: string; name: string; score: number }>> {
    if (!threadId || !query) return [];

    // 1. Thử từ cache local trước (nhanh, không tốn API call)
    const threads = loadThreads();
    const t = threads.find((x) => x.threadId === threadId);
    const cachedUids = t?.memberUids ?? [];
    const cachedNames = t?.memberNames ?? {};

    let candidates: Array<{ uid: string; name: string }> = [];
    let needFetch = false;
    if (cachedUids.length > 0) {
        for (const uid of cachedUids) {
            const name = cachedNames[uid];
            if (name) {
                candidates.push({ uid, name });
            } else {
                needFetch = true;  // có uid nhưng thiếu tên → cần fetch
            }
        }
    }
    if (candidates.length === 0 || needFetch) {
        // 2. Fetch từ Zalo API (pipeline memVerList + getGroupMembersInfo)
        const fetched = await fetchGroupMembers(threadId);
        if (fetched.length > 0) {
            // Merge: ưu tiên fetched (có tên mới nhất)
            const fetchedUids = new Set(fetched.map(f => f.uid));
            candidates = fetched;
            // Thêm cached UIDs không có trong fetched (vd: member đã rời group)
            for (const c of cachedUids) {
                if (!fetchedUids.has(c) && cachedNames[c]) {
                    candidates.push({ uid: c, name: cachedNames[c] });
                }
            }
        }
    }

    // 3. Fuzzy match: normalize cả query và tên, tính score
    const normQuery = normalizeForMatch(query);
    if (!normQuery) return [];

    const scored: Array<{ uid: string; name: string; score: number }> = [];
    for (const c of candidates) {
        const normName = normalizeForMatch(c.name);
        if (!normName) continue;

        let score = 0;
        if (normName === normQuery) {
            score = 100;  // exact match
        } else if (normName.includes(normQuery)) {
            score = 80 + normQuery.length;  // query nằm trong tên
        } else if (normQuery.includes(normName)) {
            score = 60 + normName.length;  // tên nằm trong query
        } else {
            // Token overlap: query "minh anh" vs name "Trương Minh Anh" → match
            // ⚠️ FIX v1.5.6: Yêu cầu overlap >= 2 tokens để tránh match nhầm 1 từ chung
            const qTokens = new Set(normQuery.split(/\s+/).filter(t => t.length >= 3));
            const nTokens = new Set(normName.split(/\s+/).filter(t => t.length >= 3));
            let overlap = 0;
            for (const tok of qTokens) {
                if (nTokens.has(tok)) overlap++;
            }
            if (overlap >= 2) {
                score = 30 + overlap * 10;
            }
        }
        if (score > 0) {
            scored.push({ uid: c.uid, name: c.name, score });
        }
    }

    // 4. Sort theo score giảm dần, lấy top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit));
}

/**
 * Normalize string để compare: lowercase + bỏ dấu tiếng Việt + bỏ ký tự đặc biệt.
 */
function normalizeForMatch(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================================
// ⚠️ FIX v1.5.0 — Sync group list từ Zalo API
// ============================================================

/**
 * Sync TẤT CẢ group mà bot đang là member vào known_threads.json.
 *
 * Trước đây bot chỉ biết group nào nó ĐÃ nhận tin nhắn. Nếu user add bot vào 5 group
 * nhưng chỉ 1 group có activity → scheduler proactive chỉ fire vào 1 group đó,
 * gây cảm giác "bot chỉ chửi ở 1 group, bơ mấy group còn lại".
 *
 * Hàm này gọi api.getAllGroups() để fetch danh sách group ID, rồi với mỗi group
 * gọi api.getGroupInfo() để lấy tên + members. Cache vào known_threads.json.
 *
 * @returns Số group mới được add (chưa có trong cache trước đó).
 */
export async function syncAllGroupsFromZalo(): Promise<{ added: number; refreshed: number; total: number }> {
    if (!global.api) {
        console.warn('[Threads] syncAllGroupsFromZalo: global.api chưa sẵn sàng — skip');
        return { added: 0, refreshed: 0, total: 0 };
    }

    let groupIds: string[] = [];
    try {
        // api.getAllGroups() trả về { gridVerMap: { [groupId]: version } }
        const resp: any = await (global.api as any).getAllGroups();
        const gridVerMap = resp?.gridVerMap ?? resp?.data?.gridVerMap ?? {};
        groupIds = Object.keys(gridVerMap).filter(Boolean);
    } catch (e: any) {
        console.warn(`[Threads] getAllGroups failed: ${e?.message ?? e} — skip sync`);
        return { added: 0, refreshed: 0, total: 0 };
    }

    if (groupIds.length === 0) {
        console.log('[Threads] Không có group nào từ getAllGroups() — skip sync');
        return { added: 0, refreshed: 0, total: 0 };
    }

    console.log(`[Threads] Syncing ${groupIds.length} group(s) từ Zalo API...`);

    const threads = loadThreads();
    let added = 0;
    let refreshed = 0;

    // Batch getGroupInfo: zca-js cho phép truyền array groupId
    // Nhưng để tránh timeout với nhiều group, xử lý chunk 10 group/lần
    const CHUNK_SIZE = 10;
    for (let i = 0; i < groupIds.length; i += CHUNK_SIZE) {
        const chunk = groupIds.slice(i, i + CHUNK_SIZE);
        try {
            const info: any = await (global.api as any).getGroupInfo(chunk);
            const gridInfoMap = info?.gridInfoMap ?? info?.data?.gridInfoMap ?? {};

            for (const gid of chunk) {
                const g: any = gridInfoMap[gid];
                if (!g) continue;

                const groupName: string = String(g?.name ?? g?.groupName ?? '');
                // ⚠️ FIX v1.5.7 — Extract UIDs từ memVerList (format: "<uid>_<version>")
                // currentMems và memberIds THƯỜNG RỖNG → không dùng được!
                const memberIds: string[] = Array.isArray(g?.memVerList)
                    ? g.memVerList.map((s: string) => String(s).split('_')[0]).filter((uid: string) => /^\d+$/.test(uid))
                    : Array.isArray(g?.memberIds)
                        ? g.memberIds.map(String)
                        : [];

                let t = threads.find((x) => x.threadId === gid);
                if (!t) {
                    t = {
                        threadId: gid,
                        threadType: 'Group',
                        lastActiveAt: Date.now(),
                    };
                    threads.push(t);
                    added++;
                } else {
                    refreshed++;
                }
                t.threadType = 'Group';
                if (!t.lastActiveAt) t.lastActiveAt = Date.now();
                if (groupName) t.groupName = groupName;
                if (memberIds.length > 0) {
                    t.memberUids = memberIds;
                    if (!t.memberNames) t.memberNames = {};
                }
            }
        } catch (e: any) {
            console.warn(`[Threads] getGroupInfo chunk failed (offset ${i}): ${e?.message ?? e}`);
        }
    }

    saveThreads(threads);
    console.log(`[Threads] ✓ Sync xong: ${added} mới, ${refreshed} refresh, tổng ${threads.length} thread(s)`);

    return { added, refreshed, total: threads.length };
}

/**
 * Lấy danh sách TẤT CẢ group đã biết (kể cả group chưa có activity gần đây).
 * Dùng cho scheduler proactive để fire đều giữa các group.
 */
export function getAllKnownGroups(): KnownThread[] {
    return loadThreads().filter((t) => t.threadType === 'Group');
}

/**
 * Pick random group từ TẤT CẢ group đã biết (không lọc theo lastActiveAt).
 *
 * ⚠️ FIX v1.5.0 — Trước đây pickRandomRecentThread chỉ lấy group có activity
 * trong 7 ngày → nếu bot mới add vào group nhưng chưa chat, group đó không được pick.
 * Giờ: pick từ toàn bộ known group, để bot có thể chủ động "xưng presence" ở group mới.
 *
 * @param excludeThreadIds Danh sách threadId để exclude (tránh spam 1 group liên tục)
 */
export function pickRandomKnownGroup(excludeThreadIds: string[] = []): KnownThread | null {
    const groups = getAllKnownGroups().filter((g) => !excludeThreadIds.includes(g.threadId));
    if (groups.length === 0) {
        // Fallback: không exclude
        const all = getAllKnownGroups();
        return all.length > 0 ? all[Math.floor(Math.random() * all.length)] : null;
    }
    return groups[Math.floor(Math.random() * groups.length)];
}
