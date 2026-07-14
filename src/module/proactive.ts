/**
 * proactive.ts — Scheduler CHỦ ĐỘNG chửi (Nguyễn Đình Dương là dân war thật sự, không bị động)
 *
 * Bot sẽ tự động nhắn chửi các targets theo interval random:
 *   - Mỗi 8-30 phút fire 1 lần
 *   - Pick random target (ưu tiên target có uid để mention)
 *   - Pick random provoker line
 *   - Send vào group mà target đang ở (nếu biết uid)
 *   - Hoặc send vào random recent group (chỉ nhắc tên)
 *
 * Có thể enable/disable qua SetProactiveMode.
 * Có thể fire ngay lập tức qua ForceProvoke.
 *
 * Data: data/proactive_state.json (enabled flag + lastFireAt)
 */
import fs from 'fs';
import path from 'path';
import { ThreadType } from 'zca-js';
import { generateText } from 'ai';
import { withGoogleModel, withZenModel, ZEN_DEFAULT_MODEL } from './apikey';
import {
    loadTargets,
    pickRandomTarget,
    bumpWarCountByUid,
    addTargetByUid,
    getTargetDisplayName,
    getTargetDisplayNames,
    type Target,
} from './targets';
import {
    pickRandomRecentThread,
    pickRandomThreadWithUid,
    pickRandomKnownGroup,
    addKnownThread,
    removeKnownThread,
} from './threads';
// HUMAN-LIKE: dùng helpers từ human.ts (typing indicator + record bot message)
// Reference: https://github.com/RFS-ADRENO/zca-js + https://tdung.gitbook.io/zca-js
import { startTypingIndicator, recordBotMessage, sleep } from './human';
import {
    randomProvokerLine,
    pickByLevel,
    pickByCategory,
    type ProvokerLevel,
} from './provoker';

// ============================================================
// State
// ============================================================
interface ProactiveState {
    enabled: boolean;
    lastFireAt: number;
    totalFires: number;
    /**
     * ⚠️ FIX v1.5.0 — Track recent fire history để tránh spam 1 group liên tục.
     * Mỗi phần tử = threadId. Cập nhất khi fireProvoke thành công.
     * Dùng cho exclude list khi pick thread mới.
     */
    recentThreadIds?: string[];
    /**
     * ⚠️ FIX v1.5.7 — Target lock: khi admin chỉ định chửi 1 target cụ thể,
     * scheduler skip fire random target khác trong thời gian lock.
     * Tránh tình huống admin bảo "chửi Hihi" nhưng scheduler tự chửi Mơ.
     */
    lockedTargetName?: string;
    lockedUntil?: number;  // unix ms — sau thời điểm này lock hết hạn
    /**
     * ⚠️ FIX v1.7.2 — Pause until: khi admin đang DM bot, scheduler tạm dừng
     * để tránh "bot không rep t mà vẫn dùng tool".
     * Sau thời điểm này, scheduler tự resume.
     */
    pausedUntil?: number;  // unix ms
}

const STATE_FILE = path.join(process.cwd(), 'data', 'proactive_state.json');
const RECENT_HISTORY_SIZE = 3;  // exclude 3 thread gần nhất → fire đều hơn
const TARGET_LOCK_DURATION_MS = 5 * 60 * 1000;  // 5 phút — lock target khi admin chỉ định

function loadState(): ProactiveState {
    try {
        if (!fs.existsSync(STATE_FILE)) return { enabled: true, lastFireAt: 0, totalFires: 0 };
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        return { enabled: true, lastFireAt: 0, totalFires: 0, ...JSON.parse(raw) };
    } catch {
        return { enabled: true, lastFireAt: 0, totalFires: 0 };
    }
}

function saveState(s: ProactiveState): void {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    } catch (e) {
        console.warn('[Proactive] save state failed:', e);
    }
}

// ============================================================
// Config
// ============================================================
const MIN_INTERVAL_MS = 8 * 60 * 1000;    // 8 phút
const MAX_INTERVAL_MS = 30 * 60 * 1000;   // 30 phút

let schedulerTimer: NodeJS.Timeout | null = null;

// ============================================================
// Mention resolver (local — tránh circular import với ai.ts)
// ============================================================

// Cache membership verify (threadId → Set<uid>) để tránh hammer getGroupInfo
const MEMBERSHIP_TTL_MS = 60_000;
const membershipCache = new Map<string, { ts: number; uids: Set<string> }>();

/**
 * Kiểm tra target uid còn là member của thread không.
 * Trả về true nếu còn, false nếu rời (kể cả thread private thì mặc định true cũng fail-open).
 * Fail-open (return true) nếu getGroupInfo lỗi — tránh block scheduler.
 */
async function isTargetStillInThread(threadId: string, targetUid: string): Promise<boolean> {
    if (!threadId || !targetUid) return false;

    const now = Date.now();
    const cached = membershipCache.get(threadId);
    if (cached && now - cached.ts < MEMBERSHIP_TTL_MS) {
        return cached.uids.has(targetUid);
    }

    try {
        const info: any = await global.api.getGroupInfo(threadId);
        const groupData =
            info?.gridInfoMap?.[threadId] ??
            info?.gridInfoMap?.[String(threadId)] ??
            null;
        // ⚠️ FIX v1.5.7 — memVerList format: ["<uid>_<version>", ...] → extract uid bằng split('_')[0]
        // currentMems/memberIds thường rỗng → không dùng được!
        const memVerList: string[] = Array.isArray(groupData?.memVerList) ? groupData.memVerList : [];
        const memberIds: string[] = Array.isArray(groupData?.memberIds) && groupData.memberIds.length > 0
            ? groupData.memberIds
            : memVerList.map((s: string) => String(s).split('_')[0]).filter((uid: string) => /^\d+$/.test(uid));
        const set = new Set(memberIds.map(String));
        membershipCache.set(threadId, { ts: now, uids: set });
        return set.has(targetUid);
    } catch (e: any) {
        console.warn(`[Proactive] getGroupInfo failed cho thread=${threadId}: ${e?.message ?? e}`);
        // Fail-open: không chặn scheduler
        return true;
    }
}

/**
 * Helper fetch displayName dùng cho resolveMentions.
 */
async function fetchDisplayNameForResolve(uid: string): Promise<string | null> {
    return await fetchDisplayName(uid);
}

/**
 * Lấy set UID được phép mention trong 1 thread (whitelist) — chống "tag xàm".
 * - Group: chỉ trả member UIDs đã cache cho thread đó (từ known_threads.json).
 *   Nếu chưa cache → fail-open (trả null = không whitelist).
 * - DM: chỉ trả về [threadId] (chỉ được tag người đang chat với bot).
 */
function getAllowedMentionUidsLocal(threadId: string, threadType: 'User' | 'Group'): Set<string> | null {
    if (threadType === 'User') {
        return threadId ? new Set([threadId]) : null;
    }
    try {
        const threadsPath = path.join(process.cwd(), 'data', 'known_threads.json');
        if (!fs.existsSync(threadsPath)) return null;
        const raw = fs.readFileSync(threadsPath, 'utf-8');
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return null;
        const t = arr.find((x: any) => x && x.threadId === threadId);
        if (!t) return null;
        const memberUids: string[] = Array.isArray(t.memberUids) ? t.memberUids : [];
        if (memberUids.length === 0) return null;
        return new Set(memberUids.map(String));
    } catch {
        return null;
    }
}

/**
 * Resolve {@uid} mentions trong text.
 *
 * ⚠️ FIX TAG XÀM: thêm whitelist check.
 *   - Chỉ tag UID có trong whitelist của thread hiện tại.
 *   - Nếu UID không trong whitelist → strip mention, vẫn in "@Tên" như text thường (không gửi notification).
 */
async function resolveMentions(
    text: string,
    threadId?: string,
    threadType: 'User' | 'Group' = 'Group',
): Promise<{ text: string; mentions: any[] }> {
    const regex = /\{@(\d+)\}/g;
    let out = '';
    let last = 0;
    const mentions: any[] = [];

    // Build whitelist cho thread hiện tại
    const allowSet = (threadId && threadType) ? getAllowedMentionUidsLocal(threadId, threadType) : null;

    for (let m; (m = regex.exec(text)); ) {
        const uid = String(m[1]);
        const before = text.slice(last, m.index);
        out += before;

        // ⚠️ WHITELIST CHECK: nếu có allowSet và uid không trong set → KHÔNG tag.
        const isAllowed = !allowSet || allowSet.has(uid);
        if (!isAllowed) {
            console.warn(`[Proactive] ⚠ UID ${uid} KHÔNG trong whitelist của thread ${threadId} — strip mention (chống tag xàm)`);
            // Thử lấy displayName để in dạng text thường
            let displayName: string | null = null;
            try {
                const user = await global.api.getUserInfo(uid);
                const prof = (user as any)?.changed_profiles?.[uid];
                const name = prof?.displayName;
                if (name && typeof name === 'string' && name.trim().length > 0) {
                    displayName = name.trim();
                }
            } catch { /* ignore */ }
            if (displayName) {
                out += `@${displayName}`;
            }
            last = m.index + m[0].length;
            continue;
        }

        // ⚠️ CRITICAL: Lấy displayName từ Zalo. Nếu fail (rate limit, network, cache miss)
        // → KHÔNG fallback thành uid (sẽ lộ "@123456789" → lộ bot).
        // Thay vào đó: skip mention, chỉ gửi text thường (không tag).
        let displayName: string | null = null;
        try {
            const user = await global.api.getUserInfo(uid);
            const prof = (user as any)?.changed_profiles?.[uid];
            const name = prof?.displayName;
            if (name && typeof name === 'string' && name.trim().length > 0) {
                displayName = name.trim();
            }
        } catch (e: any) {
            console.warn(`[Proactive] getUserInfo failed for uid=${uid}: ${e?.message ?? e}`);
        }

        if (!displayName) {
            // Skip mention — gửi text không tag, tránh lộ uid
            console.warn(`[Proactive] Skip mention cho uid=${uid} (không lấy được displayName) — tránh lộ uid`);
            last = m.index + m[0].length;
            continue;
        }

        const replacement = `@${displayName}`;
        const pos = out.length;
        out += replacement;
        // zca-js yêu cầu key `pos` và `len` (không phải offset/length) — xem Mention type trong sendMessage.d.ts
        mentions.push({ uid, pos, len: replacement.length });
        last = m.index + m[0].length;
    }
    out += text.slice(last);
    // Clean up: nếu mentions rỗng, strip any leftover {@uid} patterns (defensive)
    if (mentions.length === 0) {
        out = out.replace(/\{@\d+\}/g, '').replace(/\s+/g, ' ').trim();
    }
    return { text: out, mentions };
}

// ============================================================
// Sanitize (giống ai.ts nhưng đơn giản hơn — chỉ strip dấu câu)
// ============================================================
/**
 * Normalize icon paren — đảm bảo >= 3 close/open paren.
 * (Xem chi tiết ở ai.ts — logic giống nhau)
 */
function normalizeIconParens(icon: string): string {
    let m;
    if ((m = icon.match(/^:(\)+)$/))) {
        const n = Math.max(3, m[1].length);
        return ':' + ')'.repeat(n);
    }
    if ((m = icon.match(/^=(\)+)$/))) {
        const n = Math.max(3, m[1].length);
        return '=' + ')'.repeat(n);
    }
    if ((m = icon.match(/^:(\(+)$/))) {
        const n = Math.max(3, m[1].length);
        return ':' + '('.repeat(n);
    }
    if ((m = icon.match(/^=(\(+)$/))) {
        const n = Math.max(3, m[1].length);
        return '=' + '('.repeat(n);
    }
    return icon;
}

function sanitize(text: string): string {
    if (!text) return text;
    // Protect {@uid}
    const mentions: string[] = [];
    let working = text.replace(/\{@(\d+)\}/g, (m) => {
        const i = mentions.length;
        mentions.push(m);
        return `__M${i}M__`;
    });
    // Protect text icons
    const icons: string[] = [];
    working = working.replace(/(:'\)+|:'\(+|:'>|:_\(|:_\)|:\^\)|:D+|:P+|:3|:v|:o|:x|:s|:\$|:\||:\\|:\/|:>|:<|:\)+|:\(+|=\)+|=\(+|;-?\)+|;-?\(+|-_-|\^[\^_]*\^|<3|=D|=P|=3|=o|=x|=s|=\$|=\||=\\|=\/|=>|=<)/gi, (m) => {
        const i = icons.length;
        icons.push(m);
        return `__I${i}I__`;
    });
    // Strip structural punctuation
    working = working.replace(/[.,?!;:()\[\]{}"'`<>*&^%$#~|\\/]/g, '');
    working = working.replace(/\s[–—-]\s/g, ' ');
    working = working.replace(/…/g, '');
    working = working.replace(/\s+/g, ' ').trim();
    // Restore mentions ở vị trí cũ
    mentions.forEach((m, i) => { working = working.replace(`__M${i}M__`, m); });
    // Normalize icons + dồn về cuối câu (KHÔNG restore ở vị trí cũ)
    const normalizedIcons = icons.map(normalizeIconParens);
    for (let i = 0; i < icons.length; i++) {
        working = working.split(`__I${i}I__`).join('');
    }
    working = working.replace(/\s+/g, ' ').trim();
    if (normalizedIcons.length > 0) {
        working += ' ' + normalizedIcons.join(' ');
    }
    return working;
}

// ============================================================
// Compose message
// ============================================================

/**
 * Lấy "last word" của tên — dùng làm gốc cho biệt danh tục.
 * VD: "Tri Thanh" → "Thanh", "Nguyễn Văn A" → "A", "Mỹ Huyền" → "Huyền",
 *     "khôi nguyên" → "nguyên", "Đặng Bảo Vy" → "Vy".
 *
 * Nếu tên 1 từ → trả về cả tên. Nếu rỗng → "con đĩ" (mặc định).
 */
function getNicknameRoot(displayName: string): string {
    const cleaned = (displayName ?? '').trim();
    if (!cleaned) return 'con đĩ';
    // Lower + normalize để so khớp ổn định
    const parts = cleaned.split(/\s+/);
    const last = parts[parts.length - 1];
    if (!last) return cleaned;
    // Capitalize first letter, giữ phần còn lại lowercase
    return last.charAt(0).toUpperCase() + last.slice(1);
}

/**
 * Danh sách dirty suffix — ghép với nicknameRoot để ra biệt danh tục.
 * VD root="Thành" → "Thành cặc", "Thành lz", "Thành lồn", "Thành đĩ"...
 */
const DIRTY_SUFFIXES = [
    'cặc', 'lz', 'lồn', 'đĩ', 'óc chó', 'ngu', 'lú',
    'cứt', 'buồi', 'vãi', 'đú', 'phèn', 'quê', 'dâm',
    'mẹ m', 'đầu đĩ', 'đầu buồi', 'câm mồm', 'sủa đi',
    'chó', 'ngu học', 'mất dạy',
];

/**
 * Sinh danh sách biệt danh tục từ displayName.
 * VD: getDirtyNicknames("Tri Thanh") → ["Thành cặc", "Thành lz", "Thành lồn", ...]
 */
function getDirtyNicknames(displayName: string): string[] {
    const root = getNicknameRoot(displayName);
    return DIRTY_SUFFIXES.map((s) => `${root} ${s}`);
}

/**
 * Sinh 1 câu chửi ngẫu nhiên cho target.
 * `targetName` được fetch on-demand qua `getTargetDisplayName(uid)`.
 * ⚠️ FIX v1.5.28-treonhay — Dùng biệt danh tục từ tên (VD "Tri Thanh" → "Thành cặc") thay vì tên thật.
 */
function composeProvokerLine(targetName: string): string {
    const nicknames = getDirtyNicknames(targetName);
    const nickname = nicknames[Math.floor(Math.random() * nicknames.length)];

    const allLines = [
        randomProvokerLine(),
        pickByLevel('medium'),
        pickByLevel('spicy'),
        pickByCategory('cay_cú'),
        pickByCategory('rét'),
        pickByCategory('nổ'),
        pickByCategory('gáy'),
    ].filter(Boolean) as string[];

    // Fallback tục nặng nếu kho rỗng hoặc nhẹ tay — DÙNG BIỆT DANH TỤC
    const heavyFallbacks = [
        `địt mẹ m lên đi ${nickname}`,
        `đĩ mẹ m sủa tiếp đi con`,
        `lồn mẹ m vẫn còn thở à`,
        `cái lz mẹ m war đi ${nickname}`,
        `đjt mẹ m cái bản mặt đó`,
        `${nickname} óc lồn à`,
        `đĩ mẹ m biết nhục chưa ${nickname}`,
        `con đĩ mẹ m im rồi hả`,
    ];
    const line = allLines.length > 0
        ? allLines[Math.floor(Math.random() * allLines.length)]
        : heavyFallbacks[Math.floor(Math.random() * heavyFallbacks.length)];

    // 30% khả năng mention bằng biệt danh tục
    const mentionNickname = Math.random() < 0.3;
    if (mentionNickname && !line.toLowerCase().includes(nickname.toLowerCase())) {
        return `${nickname} ${line}`;
    }
    return line;
}

/**
 * Sinh câu chửi/cà khịa ngẫu nhiên cực độc đáo sử dụng Gemini AI.
 * `targetName` được fetch on-demand qua `getTargetDisplayName(uid)`.
 * Sẽ fall back về composeProvokerLine nếu có lỗi xảy ra hoặc chưa config key.
 */
async function generateProvokerLineWithAI(target: Target, targetName: string): Promise<string | null> {
    // ⚠️ FIX v1.5.28-treonhay — Sinh sẵn list biệt danh tục từ tên để ép AI dùng.
    // VD: "Tri Thanh" → ["Thành cặc", "Thành lz", "Thành lồn", "Thành đĩ", ...]
    // AI phải gọi target bằng 1 trong các biệt danh này, KHÔNG dùng tên thật.
    const nicknames = getDirtyNicknames(targetName);
    const nicknameSample = nicknames.slice(0, 12).map(n => `"${n}"`).join(', ');

    const prompt = `Bạn là Nguyễn Đình Dương (nam, 15 tuổi, sinh 01/01/2011, Gen Z Sài Gòn). Bạn là dân war cộc tính, ác miệng, thích gây sự, cà khịa đối phương. CHỬI TỤC NẶNG BẮT BUỘC.
Hãy tự suy nghĩ ra một câu chửi/cà khịa cực kỳ độc đáo, đa dạng phong phú, cộc lốc và ngắn gọn để chủ động khêu khích kẻ thù.

TÊN THẬT CỦA KẺ THÙ (KHÔNG ĐƯỢC GỌI TÊN NÀY TRONG CÂU): "${targetName}"

BIỆT DANH TỤC ĐƯỢC PHÉP DÙNG (lấy từ tên thật trên — chọn 1 hoặc tự chế thêm):
${nicknameSample}
HOẶC tự chế thêm biến thể tục khác (cùng pattern: "<lastword> + <từ tục>").

YÊU CẦU:
1. TỰ SUY NGHĨ ra câu chửi độc đáo, đa dạng. KHÔNG nhai đi nhai lại các câu cũ hay dùng một khuôn mẫu quen thuộc.
2. **BẮT BUỘC CHỬI TỤC NẶNG** — mỗi câu PHẢI có ít nhất 1 từ tục nặng:
   - NẶNG: địt mẹ m, đjt mẹ m, đĩ mẹ m, lồn mẹ m, cặc mẹ m, cái lz mẹ m, con đĩ mẹ m, vãi lồn, óc lồn, đầu buồi, đầu đĩ
   - TRUNG BÌNH: đm, đmm, vl, vc, đĩ, lồn, cặc, lz, cứt, buồi
   - **KHÔNG dùng từ nhẹ một mình như "câm đi", "cút đi", "sủa đi" — phải kèm từ tục nặng**
3. **BẮT BUỘC GỌI KẺ THÙ BẰNG BIỆT DANH TỤC** — tuyệt đối KHÔNG ghi tên thật "${targetName}" trong câu.
4. Câu chửi phải ngắn gọn, cộc lốc, không dài dòng lê thê (dưới 15 từ).
5. KHÔNG dùng các dấu câu structural như chấm (.), phẩy (,), chấm than (!), hỏi chấm (?).
6. Có thể dùng các text icon Gen Z ở cuối câu như :))) =))) :> :< T_T.
7. Trả về trực tiếp câu chửi, KHÔNG kèm giải thích, KHÔNG bọc trong dấu ngoặc kép hay markdown.

VÍ DỤ OUTPUT ĐÚNG (cho tên "Tri Thanh"):
- "Thành cặc lên đây sủa đi"
- "Thanh lồn war đi con"
- "Đĩ mẹ m thằng Thành đĩ ơi sủa cái gì"

Số lần đã chửi kẻ thù này trước đây: ${target.warCount}`;

    try {
        const { text } = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
            return generateText({
                model,
                prompt,
                temperature: 1.3, // Tăng temperature để sinh câu đa dạng, sáng tạo hơn
                // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
            });
        });
        return text ? text.trim() : null;
    } catch (e) {
        console.warn('[Proactive AI] Lỗi generate câu chửi:', e);
        return null;
    }
}

/**
 * Resolve uid → displayName từ Zalo API, robust với nhiều format key.
 * Trả về null nếu fail.
 */
async function fetchDisplayName(uid: string): Promise<string | null> {
    if (!uid) return null;
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
        return name || null;
    } catch { return null; }
}

/**
 * Thay thế displayName / biệt danh tục của target trong câu chửi bằng tag mention {@uid},
 * tránh việc vừa có tag vừa có tên thật trùng lặp (ví dụ: "@Mỹ Huyền Mỹ Huyền...").
 * Nếu câu chửi không chứa tên/biệt danh của target → prepend tag vào đầu câu.
 *
 * ⚠️ FIX v1.5.28-treonhay — Dùng cả tên thật + biệt danh tục để tìm vị trí replace.
 * VD target="Tri Thanh": nếu câu có "Thành cặc", "Thành lz", "Tri Thanh", "thanh" → đều replace.
 * (Trước đây có `target.aliases` để bắt nhiều biến thể tên — giờ thay bằng auto-gen biệt danh tục.)
 */
function applyTagToInsult(rawLine: string, target: Target, targetName: string): string {
    if (!target.uid) return rawLine;

    let line = rawLine;
    const isWordChar = (c: string) => /[a-zA-Z0-9_À-ỹ]/.test(c);

    // Gom tất cả term cần replace: tên thật + biệt danh tục
    const nicknames = getDirtyNicknames(targetName);
    const terms: string[] = [];
    // Tên thật (full + từng word)
    const nameWords = targetName.trim().split(/\s+/).filter(w => w.length >= 2);
    terms.push(...nameWords);
    // Biệt danh tục (chỉ lấy full nickname, ví dụ "Thành cặc" — tránh match "Thành" đơn lẻ bị trùng)
    terms.push(...nicknames);

    const lowerLine = line.toLowerCase();
    // Sắp xếp term dài trước (tránh "Thành" match trước "Thành cặc")
    const sortedTerms = [...new Set(terms)]
        .filter(t => t && t.length >= 2)
        .sort((a, b) => b.length - a.length);

    for (const term of sortedTerms) {
        const lowerTerm = term.toLowerCase();
        const idx = lowerLine.indexOf(lowerTerm);
        if (idx === -1) continue;
        const charBefore = idx > 0 ? line[idx - 1] : '';
        const charAfter = idx + term.length < line.length ? line[idx + term.length] : '';
        if (!isWordChar(charBefore) && !isWordChar(charAfter)) {
            line = line.slice(0, idx) + `{@${target.uid}}` + line.slice(idx + term.length);
            return line;
        }
    }

    return `{@${target.uid}} ${line}`;
}

// ============================================================
// Fire!
// ============================================================

interface FireOptions {
    targetName?: string;   // chỉ định target cụ thể (optional)
    threadId?: string;     // chỉ định thread (optional)
    threadType?: 'User' | 'Group';
}

export interface FireResult {
    ok: boolean;
    target?: Target;
    threadId?: string;
    message?: string;
    error?: string;
}

export async function fireProvoke(opts: FireOptions = {}): Promise<FireResult> {
    // 1. Pick target
    let target: Target | null;
    if (opts.targetName) {
        // ⚠️ FIX v1.5.7 — Lock target: khi admin chỉ định target cụ thể,
        // scheduler sẽ skip fire random target khác trong 5 phút để tránh "chửi nhầm người".
        const st = loadState();
        st.lockedTargetName = opts.targetName;
        st.lockedUntil = Date.now() + TARGET_LOCK_DURATION_MS;
        saveState(st);
        console.log(`[Proactive] 🔒 Locked target name="${opts.targetName}" for ${TARGET_LOCK_DURATION_MS / 60000} phút — scheduler sẽ skip random fire`);

        // ⚠️ FIX v1.5.28-treonhay — Tìm target theo name cần resolve name→uid trước.
        // Flow: search trong targets hiện có (bằng cách so sánh displayName fetch từ Zalo)
        //       → nếu chưa có, search group members để lấy uid → addTargetByUid.
        target = await findTargetByName(opts.targetName);
        if (!target) {
            // Auto-add: search group members để resolve name→uid
            console.log(`[Proactive] ⚠ Target name "${opts.targetName}" chưa có trong targets.json — đang resolve name→uid...`);
            try {
                let resolvedUid: string | null = null;
                if (opts.threadId) {
                    try {
                        const { findMembersByName } = await import('./threads');
                        const found = await findMembersByName(opts.threadId, opts.targetName, 1);
                        if (found.length > 0 && found[0].score >= 60) {
                            resolvedUid = found[0].uid;
                            console.log(`[Proactive] ✓ Resolved "${opts.targetName}" → uid=${resolvedUid} từ group ${opts.threadId}`);
                        } else {
                            console.log(`[Proactive] ⚠ Không tìm thấy uid match "${opts.targetName}" trong group ${opts.threadId} (best score: ${found[0]?.score ?? 0})`);
                        }
                    } catch (e: any) {
                        console.warn(`[Proactive] findMembersByName failed: ${e?.message ?? e}`);
                    }
                }

                if (!resolvedUid) {
                    return {
                        ok: false,
                        error: `Không resolve được uid cho "${opts.targetName}". Cần cung cấp threadId hợp lệ (group có chứa user này) hoặc thêm target bằng uid trước.`,
                    };
                }

                target = await addTargetByUid(resolvedUid);
                if (opts.threadId) {
                    const { updateTargetLastSeen } = await import('./targets');
                    updateTargetLastSeen(resolvedUid, opts.threadId);
                    target.lastSeenInThread = opts.threadId;
                }
            } catch (e: any) {
                return { ok: false, error: `Không thêm được target "${opts.targetName}": ${e?.message ?? e}` };
            }
        }
    } else {
        target = pickRandomTarget(true);
        if (!target) {
            return { ok: false, error: 'Không có target nào để chửi' };
        }
    }

    // 2. Pick thread
    let threadId: string | undefined = opts.threadId;
    let threadType: 'User' | 'Group' = opts.threadType ?? 'Group';

    if (!threadId) {
        // ⚠️ FIX v1.5.0 — Fair thread selection để bot chửi đều giữa các group.
        //
        // Trước đây: nếu target có uid → pickRandomThreadWithUid → luôn trả về
        // cùng 1 group (vì known_threads chỉ có 1 group có target uid). Kết quả:
        // bot chỉ chửi ở 1 group, bơ mấy group khác.
        //
        // Giờ: 3-tier selection với exclude list (recentThreadIds từ state):
        //   1) Group có target uid ( KHÔNG trong exclude) → mention được target
        //   2) Random known group (KHÔNG trong exclude) → fire generic provoker
        //   3) Fallback: random recent thread (cho DM)
        const st = loadState();
        const exclude = Array.isArray(st.recentThreadIds) ? st.recentThreadIds.slice(-RECENT_HISTORY_SIZE) : [];

        // Tier 1: group có target uid (chưa fire gần đây)
        if (target.uid) {
            const t = pickRandomThreadWithUid(target.uid);
            if (t && !exclude.includes(t.threadId)) {
                threadId = t.threadId;
                threadType = t.threadType;
            }
        }

        // Tier 2: random known group (chưa fire gần đây)
        if (!threadId) {
            const t = pickRandomKnownGroup(exclude);
            if (t) {
                threadId = t.threadId;
                threadType = t.threadType;
            }
        }

        // Tier 3: nếu vẫn chưa có → fallback không exclude (better than nothing)
        if (!threadId && target.uid) {
            const t = pickRandomThreadWithUid(target.uid);
            if (t) {
                threadId = t.threadId;
                threadType = t.threadType;
            }
        }
        if (!threadId) {
            const t = pickRandomKnownGroup();
            if (t) {
                threadId = t.threadId;
                threadType = t.threadType;
            }
        }

        // Tier 4: random recent thread (DM hoặc group cũ)
        if (!threadId) {
            const t = pickRandomRecentThread(true);
            if (t) {
                threadId = t.threadId;
                threadType = t.threadType;
            }
        }
    }

    if (!threadId) {
        return { ok: false, error: 'Không có thread nào gần đây để gửi chửi', target };
    }

    // ⚠️ FIX v1.5.19 — Validate threadId trước khi gửi
    // Tránh bot gửi IB cho threadId không hợp lệ (fake test data, group_abc, user_xyz...)
    try {
        const { isValidThreadId } = await import('./threads');
        if (!isValidThreadId(threadId)) {
            console.warn(`[Proactive] ⚠ threadId "${threadId}" không hợp lệ — skip fire (tránh nhắn IB sai)`);
            return { ok: false, error: `threadId "${threadId}" không hợp lệ (không phải số Zalo)`, target };
        }
    } catch { /* ignore import error */ }

    // 3. Compose message
    // ⚠️ FIX v1.5.28-treonhay — Fetch displayName on-demand (không lưu tên trong target).
    const targetName = (target.uid ? await getTargetDisplayName(target.uid) : null) ?? target.uid ?? 'unknown';
    let rawLine: string | null = null;
    try {
        console.log(`[Proactive] Đang sinh câu chửi bằng AI cho target "${targetName}" (uid=${target.uid})...`);
        rawLine = await generateProvokerLineWithAI(target, targetName);
    } catch (e) {
        console.warn(`[Proactive] AI generate failed, fallback to static line:`, e);
    }

    if (!rawLine) {
        rawLine = composeProvokerLine(targetName);
    } else {
        console.log(`[Proactive] AI generated insult: "${rawLine}"`);
    }

    let content: string;
    if (target.uid) {
        // Pre-fire check: target còn là member của thread không?
        // Tránh "mention lộ" khi target đã rời group (cache hoặc thực tế)
        let useUidMention = true;
        if (threadType === 'Group' && threadId) {
            const stillIn = await isTargetStillInThread(threadId, target.uid);
            if (!stillIn) {
                console.log(`[Proactive] ⚠ Target "${targetName}" (uid=${target.uid}) đã rời thread ${threadId} — bỏ uid mention, fallback name-only`);
                useUidMention = false;
            }
        }
        if (useUidMention) {
            content = applyTagToInsult(rawLine, target, targetName);
        } else {
            content = rawLine;
        }
    } else {
        content = rawLine;
    }

    const sanitized = sanitize(content);
    if (!sanitized) {
        return { ok: false, error: 'Content rỗng sau sanitize', target };
    }

    // 4. Send — typing indicator + delay giống người thật.
    // HUMAN-LIKE: Dùng helper từ human.ts (startTypingIndicator) — refresh typing
    // ở các mốc 3-4s, 7-8s, 11-12s nếu delay dài. Trước đây send ngay lập tức
    // → recipient thấy tin nhắn "tự nhiên xuất hiện" → lộ bot.
    try {
        const { text: msg, mentions } = await resolveMentions(sanitized, threadId, threadType);

        // ⚠️ SAFETY GUARD: strip unresolved {@uid} tránh lộ uid
        const safeMsg = msg.replace(/\{@\d+\}/g, '').replace(/\s+/g, ' ').trim();
        if (safeMsg !== msg) {
            console.warn(`[Proactive] Stripped unresolved {@uid} from message before send`);
        }
        if (!safeMsg) {
            return { ok: false, error: 'Message empty after stripping {@uid}', target };
        }

        const zaloThreadType = threadType === 'Group' ? ThreadType.Group : ThreadType.User;
        const payload: any = mentions.length > 0 ? { msg: safeMsg, mentions } : { msg: safeMsg };

        // Typing delay: 2-5s để mimic "đang gõ" — dài hơn first-message bình thường
        // vì đây là proactive message (bot tự mở chat, cần thời gian "suy nghĩ" câu chửi).
        const typingMs = 2000 + Math.floor(Math.random() * 3000);
        startTypingIndicator(global.api, threadId, zaloThreadType, typingMs);
        await sleep(typingMs);

        await global.api.sendMessage(payload, threadId, zaloThreadType);
        // HUMAN-LIKE: Record bot message timing để adaptive pace
        recordBotMessage(threadId);
        console.log(`[Proactive] ✓ Fired chửi target="${targetName}" uid=${target.uid ?? '(không)'} thread=${threadId} type=${threadType} msg="${safeMsg.slice(0, 60)}" typingMs=${typingMs}`);

        // 5. Bump war count + update state (theo uid)
        if (target.uid) bumpWarCountByUid(target.uid);
        const st = loadState();
        st.lastFireAt = Date.now();
        st.totalFires += 1;
        // ⚠️ FIX v1.5.0 — Track recent fire history để tránh spam 1 group liên tục.
        if (!Array.isArray(st.recentThreadIds)) st.recentThreadIds = [];
        st.recentThreadIds.push(threadId);
        if (st.recentThreadIds.length > RECENT_HISTORY_SIZE * 2) {
            st.recentThreadIds = st.recentThreadIds.slice(-RECENT_HISTORY_SIZE * 2);
        }
        saveState(st);

        return { ok: true, target, threadId, message: msg };
    } catch (e: any) {
        const msg = String(e?.message ?? e ?? '');
        console.error('[Proactive] fire failed:', e);
        // ⚠️ FIX: thread không còn tồn tại (group bị xoá/xả) → remove khỏi known_threads
        // để scheduler không retry vô tận vào group chết.
        if (/không tồn tại|not (found|exist)|does not exist|nhóm này|group.*(not|không)/i.test(msg)) {
            console.warn(`[Proactive] ⚠ Thread ${threadId} không còn tồn tại → remove khỏi known_threads`);
            try { removeKnownThread(threadId); } catch {}
        }
        return { ok: false, error: msg, target };
    }
}

/**
 * ⚠️ FIX v1.5.28-treonhay — Helper resolve name→target bằng cách fetch displayName
 * cho từng target rồi so khớp. Chỉ dùng trong flow admin chỉ định target bằng tên.
 */
async function findTargetByName(name: string): Promise<Target | null> {
    const targets = loadTargets();
    if (targets.length === 0) return null;
    const normQuery = name.toLowerCase().trim();
    if (!normQuery) return null;
    // ⚠️ FIX v1.6.2 — Bulk fetch displayName song song (trước đây sequential → 10 targets × 1-3s = 10-30s).
    const namesMap = await getTargetDisplayNames(targets.map(t => t.uid));
    // So khớp: query phải là 1 phần displayName (contains, ≥2 ký tự)
    for (const t of targets) {
        const dispName = namesMap.get(t.uid);
        if (!dispName) continue;
        const normDisp = dispName.toLowerCase().trim();
        if (normDisp === normQuery) return t;
        if (normQuery.length >= 3 && normDisp.includes(normQuery)) return t;
        if (normDisp.length >= 3 && normQuery.includes(normDisp)) return t;
    }
    return null;
}

// ============================================================
// Scheduler
// ============================================================
export function startProactiveScheduler(): void {
    console.log(`[Proactive] Scheduler started — interval ${MIN_INTERVAL_MS / 60000}-${MAX_INTERVAL_MS / 60000} phút`);
    scheduleNext();
}

export function stopProactiveScheduler(): void {
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
        console.log('[Proactive] Scheduler stopped');
    }
}

function scheduleNext(): void {
    const delay = MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
    const mins = Math.round(delay / 60000);
    console.log(`[Proactive] Next fire in ~${mins} phút`);
    schedulerTimer = setTimeout(async () => {
        const st = loadState();
        if (st.enabled) {
            // ⚠️ FIX v1.7.2 — Check pause FIRST. Khi admin đang DM → skip fire.
            const now = Date.now();
            if (st.pausedUntil && now < st.pausedUntil) {
                const remainingMin = Math.round((st.pausedUntil - now) / 60000);
                console.log(`[Proactive] ⏸ PAUSED — admin đang chat (còn ${remainingMin} phút) — SKIP fire để tập trung rep admin`);
            } else {
                // Pause hết hạn → clear
                if (st.pausedUntil) {
                    st.pausedUntil = undefined;
                    saveState(st);
                }
                // ⚠️ FIX v1.5.7 — Kiểm tra target lock trước khi fire random.
                // Nếu admin vừa chỉ định chửi 1 target cụ thể (trong 5 phút) → SKIP random fire
                // để tránh tình huống admin bảo "chửi Hihi" nhưng scheduler tự chửi Mơ.
                if (st.lockedTargetName && st.lockedUntil && now < st.lockedUntil) {
                    const remainingMs = st.lockedUntil - now;
                    console.log(`[Proactive] 🔒 Target "${st.lockedTargetName}" đang bị lock (còn ${Math.round(remainingMs / 1000)}s) — SKIP random fire để tránh chửi nhầm người`);
                } else {
                    // Lock hết hạn → clear
                    if (st.lockedTargetName) {
                        st.lockedTargetName = undefined;
                        st.lockedUntil = undefined;
                        saveState(st);
                    }
                    try {
                        const result = await fireProvoke();
                        if (!result.ok) {
                            console.warn(`[Proactive] Fire skipped: ${result.error}`);
                        }
                    } catch (e) {
                        console.error('[Proactive] Fire error:', e);
                    }
                }
            }
        } else {
            console.log('[Proactive] Disabled — skip fire');
        }
        scheduleNext();
    }, delay);
}

/**
 * ⚠️ FIX v1.7.2 — Pause scheduler khi admin đang DM bot.
 *
 * Vấn đề: Khi admin DM bot ("vào box X chửi thằng Y"), bot xử lý chậm (debounce + AI call)
 * và proactive scheduler cứ fire random → admin thấy "bot không rep t mà vẫn dùng tool".
 *
 * Giải pháp: Khi admin DM, gọi pauseForMinutes(10) → scheduler skip fire trong 10 phút.
 * Bot tập trung xử lý lệnh admin. Sau 10 phút không có DM mới → scheduler tự resume.
 *
 * @param minutes Số phút pause (default 10)
 */
export function pauseForMinutes(minutes: number = 10): void {
    const st = loadState();
    const newPausedUntil = Date.now() + minutes * 60 * 1000;
    // Chỉ extend nếu newPausedUntil > pausedUntil hiện tại (tránh reset về nhỏ hơn)
    if (!st.pausedUntil || newPausedUntil > st.pausedUntil) {
        st.pausedUntil = newPausedUntil;
        saveState(st);
        console.log(`[Proactive] ⏸ Paused for ${minutes} phút (tới ${new Date(newPausedUntil).toLocaleString('vi-VN')}) — tập trung rep admin`);
    }
}

/**
 * Resume scheduler ngay lập tức (dùng khi admin nói "ok continue" hoặc "tiếp tục chửi đi").
 */
export function resumeNow(): void {
    const st = loadState();
    if (st.pausedUntil) {
        st.pausedUntil = undefined;
        saveState(st);
        console.log('[Proactive] ▶ Resumed — scheduler sẽ fire ở lần tiếp theo');
    }
}

/**
 * Check scheduler có đang pause không.
 */
export function isPaused(): boolean {
    const st = loadState();
    if (!st.pausedUntil) return false;
    if (Date.now() >= st.pausedUntil) {
        // Hết hạn → clear
        st.pausedUntil = undefined;
        saveState(st);
        return false;
    }
    return true;
}

/**
 * Public API: Lock target thủ công (dùng khi AI detect admin chỉ định target qua chat,
 * không nhất thiết phải gọi ForceProvoke).
 */
export function lockTarget(targetName: string, durationMs: number = TARGET_LOCK_DURATION_MS): void {
    const st = loadState();
    st.lockedTargetName = targetName;
    st.lockedUntil = Date.now() + durationMs;
    saveState(st);
    console.log(`[Proactive] 🔒 Manual lock target "${targetName}" for ${durationMs / 60000} phút`);
}

export function clearTargetLock(): void {
    const st = loadState();
    st.lockedTargetName = undefined;
    st.lockedUntil = undefined;
    saveState(st);
    console.log('[Proactive] 🔓 Target lock cleared');
}

export function getTargetLock(): { targetName?: string; lockedUntil?: number; remainingMs?: number } {
    const st = loadState();
    if (!st.lockedTargetName || !st.lockedUntil) return {};
    const now = Date.now();
    if (now >= st.lockedUntil) return {};
    return {
        targetName: st.lockedTargetName,
        lockedUntil: st.lockedUntil,
        remainingMs: st.lockedUntil - now,
    };
}

// ============================================================
// Mode control
// ============================================================
export function setProactiveMode(enabled: boolean): boolean {
    const st = loadState();
    st.enabled = enabled;
    saveState(st);
    console.log(`[Proactive] Mode set: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return enabled;
}

export function getProactiveMode(): boolean {
    return loadState().enabled;
}

export function getProactiveStats(): { enabled: boolean; lastFireAt: number; totalFires: number; targetCount: number } {
    const st = loadState();
    const targets = loadTargets();
    return {
        enabled: st.enabled,
        lastFireAt: st.lastFireAt,
        totalFires: st.totalFires,
        targetCount: targets.length,
    };
}
