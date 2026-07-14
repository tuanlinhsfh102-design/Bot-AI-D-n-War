/**
 * spamDetector.ts — Auto-detect user spam/war patterns + trigger bot response.
 *
 * 2 chế độ phát hiện:
 *   1. SPAM DETECTION: User gửi 3+ tin giống nhau (1 câu lặp) trong thời gian ngắn
 *      → Bot tự SpamMessages (lặp cùng câu) đến khi user ngừng
 *   2. WAR DETECTION: User gửi 3+ tin chửi tục liên tiếp (khác câu)
 *      → Bot tự NhayMessages (nhiều câu khác nhau) để nhây chửi
 *
 * Continuous spam: Sau khi bot spam/nhây xong, check lại user có tiếp tục không
 *   - User vẫn spam → bot tiếp tục spam
 *   - User ngừng → bot dừng
 *
 * Data: in-memory Map (không persist — reset khi restart bot)
 */
import { spamMessages, nhayMessages } from './autoResponder';

// ============================================================
// Types
// ============================================================
interface MessageRecord {
    content: string;
    normalizedContent: string;  // lowercase, no accent, no punctuation
    timestamp: number;          // unix ms
}

interface SpamState {
    messages: MessageRecord[];       // recent messages from user (max 20)
    botResponding: boolean;          // bot đang spam/nhây response?
    lastBotResponseAt: number;       // timestamp bot response gần nhất
    responseCount: number;           // số lần bot đã response liên tiếp
}

// ============================================================
// Config
// ============================================================
const SPAM_WINDOW_MS = 30_000;          // 30s — window để detect spam
const SPAM_THRESHOLD = 3;               // 3+ tin giống nhau = spam
const WAR_THRESHOLD = 3;                // 3+ tin chửi tục liên tiếp = war
const SIMILARITY_THRESHOLD = 0.85;      // 85% giống nhau = "giống nhau"
const MAX_MESSAGES_TRACKED = 20;        // track max 20 tin/user/thread
const USER_STOP_THRESHOLD_MS = 15_000;  // user không gửi tin trong 15s = đã ngừng
const SPAM_BATCH_SIZE = 3;              // mỗi batch spam 3 tin rồi check lại
const SPAM_DELAY_MS = 10_000;           // 10s giữa mỗi tin spam
const MAX_SPAM_DURATION_MS = 10 * 60_000; // max 10 phút spam liên tục (safety)

// Từ tục để detect war — ĐÃ NORMALIZE (bỏ dấu) để match với normalizedContent
const WAR_KEYWORDS_RAW = [
    'đĩ', 'địt', 'lồn', 'cặc', 'lz', 'đm', 'đmm', 'vl', 'vc', 'cứt', 'buồi',
    'óc lồn', 'đầu buồi', 'đầu đĩ', 'con đĩ', 'mẹ m', 'mày', 'sủa', 'câm',
    'cút', 'nổ', 'gáy', 'cay', 'rét', 'hèn', 'phèn', 'quê', 'ngu', 'lú',
];
// Normalize keywords (bỏ dấu) để compare với normalizedContent
const WAR_KEYWORDS = WAR_KEYWORDS_RAW.map(kw =>
    kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
);

// ============================================================
// State — in-memory
// ============================================================
const states = new Map<string, SpamState>();  // key = `${threadId}:${senderId}`

function getStateKey(threadId: string, senderId: string): string {
    return `${threadId}:${senderId}`;
}

function getState(threadId: string, senderId: string): SpamState {
    const key = getStateKey(threadId, senderId);
    let state = states.get(key);
    if (!state) {
        state = {
            messages: [],
            botResponding: false,
            lastBotResponseAt: 0,
            responseCount: 0,
        };
        states.set(key, state);
    }
    return state;
}

// ============================================================
// Normalize — để compare 2 câu có "giống nhau" không
// ============================================================
function normalize(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Tính độ giống nhau giữa 2 string (0-1).
 * Dùng Levenshtein distance normalized.
 */
function similarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    // Simple: ratio chars chung
    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    let common = 0;
    for (const w of setA) {
        if (w.length >= 2 && setB.has(w)) common++;
    }
    const union = setA.size + setB.size - common;
    return union > 0 ? common / union : 0;
}

// ============================================================
// Public API: recordMessage
// ============================================================

/**
 * Record mỗi tin user gửi. Gọi từ index.ts khi nhận message.
 * Trả về detection result để caller quyết định có trigger response không.
 */
export function recordMessage(
    threadId: string,
    senderId: string,
    content: string,
): { isSpam: boolean; isWar: boolean; pattern?: string; spamCount: number } {
    const state = getState(threadId, senderId);
    const now = Date.now();
    const normalized = normalize(content);

    // Add message
    state.messages.push({ content, normalizedContent: normalized, timestamp: now });
    // Trim old messages (> SPAM_WINDOW_MS)
    state.messages = state.messages.filter(m => now - m.timestamp < SPAM_WINDOW_MS);
    // Limit max
    if (state.messages.length > MAX_MESSAGES_TRACKED) {
        state.messages = state.messages.slice(-MAX_MESSAGES_TRACKED);
    }

    // Detect spam: 3+ tin giống nhau trong window
    const recentMessages = state.messages.slice(-10);  // check 10 tin gần nhất
    let isSpam = false;
    let pattern: string | undefined;
    let spamCount = 0;

    if (recentMessages.length >= SPAM_THRESHOLD) {
        // Đếm tin giống tin cuối
        const lastMsg = recentMessages[recentMessages.length - 1];
        let similarCount = 0;
        for (const m of recentMessages) {
            if (similarity(m.normalizedContent, lastMsg.normalizedContent) >= SIMILARITY_THRESHOLD) {
                similarCount++;
            }
        }
        if (similarCount >= SPAM_THRESHOLD) {
            isSpam = true;
            pattern = lastMsg.content;
            spamCount = similarCount;
        }
    }

    // Detect war: 3+ tin chửi tục liên tiếp (khác câu)
    let isWar = false;
    if (recentMessages.length >= WAR_THRESHOLD && !isSpam) {
        const lastN = recentMessages.slice(-WAR_THRESHOLD);
        const warCount = lastN.filter(m =>
            WAR_KEYWORDS.some(kw => m.normalizedContent.includes(kw))
        ).length;
        if (warCount >= WAR_THRESHOLD) {
            isWar = true;
        }
    }

    return { isSpam, isWar, pattern, spamCount };
}

// ============================================================
// Public API: shouldRespond — check nếu bot nên auto-respond
// ============================================================

/**
 * Check xem bot có nên auto-respond không.
 * Tránh spam response nếu bot đang respond hoặc vừa respond xong.
 */
export function shouldAutoRespond(threadId: string, senderId: string): boolean {
    const state = getState(threadId, senderId);
    const now = Date.now();
    // Nếu bot đang responding → skip
    if (state.botResponding) return false;
    // Nếu bot vừa respond < 10s trước → skip (tránh spam response)
    if (now - state.lastBotResponseAt < 10_000) return false;
    return true;
}

/**
 * Mark bot đang responding (để tránh trigger nhiều lần cùng lúc).
 */
export function markBotResponding(threadId: string, senderId: string, responding: boolean): void {
    const state = getState(threadId, senderId);
    state.botResponding = responding;
    if (!responding) {
        state.lastBotResponseAt = Date.now();
        state.responseCount++;
    }
}

// ============================================================
// Public API: triggerSpamResponse — bot tự spam lại khi user spam
// ============================================================

/**
 * Trigger bot SpamMessages khi detect user spam 1 câu lặp.
 * Bot sẽ spam LIÊN TỤC đến khi user ngừng spam (15s không gửi tin).
 *
 * ⚠️ FIX v1.5.24 — KHÔNG giới hạn 5 lần. Bot spam đến khi user DỪNG.
 * Safety: max 10 phút (MAX_SPAM_DURATION_MS) để tránh spam vô hạn.
 *
 * @returns true nếu đã trigger, false nếu skip
 */
export async function triggerSpamResponse(
    threadId: string,
    senderId: string,
    userPattern: string,
    threadType: 'User' | 'Group' = 'Group',
    allSenderIds?: string[],
): Promise<boolean> {
    if (!shouldAutoRespond(threadId, senderId)) return false;

    const state = getState(threadId, senderId);
    markBotResponding(threadId, senderId, true);
    state.responseCount = 0;
    state.lastBotResponseAt = Date.now();
    const startTime = Date.now();

    // Chọn file spam pattern
    let spamFilename = 'lendi';
    const lowerPattern = userPattern.toLowerCase();
    if (lowerPattern.includes('limited') || lowerPattern.includes('gọi tên')) {
        spamFilename = 'limited_5';
    }

    console.log(`[SpamDetector] 🤖 Auto-trigger SPAM: user "${senderId}" spam "${userPattern.slice(0, 50)}" → bot spam "${spamFilename}" LIÊN TỤC đến khi user dừng`);

    // ⚠️ Loop liên tục — mỗi batch gửi SPAM_BATCH_SIZE tin, delay 10s/tin
    // Sau mỗi batch, check user có vẫn đang spam không
    // User ngừng 15s → bot dừng
    // Safety: max 10 phút
    while (true) {
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_SPAM_DURATION_MS) {
            console.log(`[SpamDetector] ⚠ Đạt max ${MAX_SPAM_DURATION_MS / 60000} phút → dừng spam`);
            break;
        }

        await spamMessages({
            threadId,
            threadType,
            filename: spamFilename,
            repeatCount: SPAM_BATCH_SIZE,
            delayMs: SPAM_DELAY_MS,
            mentionUids: allSenderIds && allSenderIds.length > 0 ? allSenderIds : [senderId],
        });
        state.responseCount++;

        // Check user có gửi tin trong USER_STOP_THRESHOLD_MS qua không
        const now = Date.now();
        const recentUserMessages = state.messages.filter(m => now - m.timestamp < USER_STOP_THRESHOLD_MS);
        if (recentUserMessages.length === 0) {
            console.log(`[SpamDetector] ✓ User "${senderId}" đã ngừng spam → bot dừng (sau ${state.responseCount} batch, ${(elapsed / 1000).toFixed(0)}s)`);
            break;
        }

        console.log(`[SpamDetector] 🔄 User vẫn spam (${recentUserMessages.length} tin gần) → bot tiếp tục spam batch ${state.responseCount + 1}...`);
    }

    markBotResponding(threadId, senderId, false);
    console.log(`[SpamDetector] ✓ SPAM session kết thúc (user="${senderId}", ${state.responseCount} batch, file="${spamFilename}")`);
    return true;
}

/**
 * Trigger bot NhayMessages khi detect user war chửi tục liên tiếp.
 * Bot sẽ nhây LIÊN TỤC đến khi user ngừng chửi (15s không gửi tin).
 *
 * ⚠️ FIX v1.5.24 — KHÔNG giới hạn 5 lần. Bot nhây đến khi user DỪNG.
 * Safety: max 10 phút (MAX_SPAM_DURATION_MS).
 */
export async function triggerWarResponse(
    threadId: string,
    senderId: string,
    threadType: 'User' | 'Group' = 'Group',
    allSenderIds?: string[],
): Promise<boolean> {
    if (!shouldAutoRespond(threadId, senderId)) return false;

    const state = getState(threadId, senderId);
    markBotResponding(threadId, senderId, true);
    state.responseCount = 0;
    state.lastBotResponseAt = Date.now();
    const startTime = Date.now();

    console.log(`[SpamDetector] 🤖 Auto-trigger WAR (nhây): user "${senderId}" chửi tục → bot nhây chửi LIÊN TỤC đến khi user dừng`);

    // ⚠️ Loop liên tục — mỗi batch nhây từ chui_tuc.txt (5 câu khác nhau)
    // User ngừng 15s → bot dừng
    // Safety: max 10 phút
    while (true) {
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_SPAM_DURATION_MS) {
            console.log(`[SpamDetector] ⚠ Đạt max ${MAX_SPAM_DURATION_MS / 60000} phút → dừng nhây`);
            break;
        }

        // Gửi 1 batch nhây (5 câu chửi tục khác nhau)
        await nhayMessages({
            threadId,
            threadType,
            filename: 'nhay3',
            mentionUids: allSenderIds && allSenderIds.length > 0 ? allSenderIds : [senderId],
        });
        state.responseCount++;

        // Check user có gửi tin trong USER_STOP_THRESHOLD_MS qua không
        const now = Date.now();
        const recentUserMessages = state.messages.filter(m => now - m.timestamp < USER_STOP_THRESHOLD_MS);
        if (recentUserMessages.length === 0) {
            console.log(`[SpamDetector] ✓ User "${senderId}" đã ngừng war → bot dừng (sau ${state.responseCount} batch, ${(elapsed / 1000).toFixed(0)}s)`);
            break;
        }

        console.log(`[SpamDetector] 🔄 User vẫn war (${recentUserMessages.length} tin gần) → bot tiếp tục nhây batch ${state.responseCount + 1}...`);
    }

    markBotResponding(threadId, senderId, false);
    console.log(`[SpamDetector] ✓ WAR session kết thúc (user="${senderId}", ${state.responseCount} batch)`);
    return true;
}

/**
 * Reset state cho 1 user (gọi khi user ngừng hoàn toàn hoặc admin can thiệp).
 */
export function resetState(threadId: string, senderId: string): void {
    const key = getStateKey(threadId, senderId);
    states.delete(key);
}

/**
 * Lấy state hiện tại (cho debug).
 */
export function getStateDebug(threadId: string, senderId: string): any {
    const state = getState(threadId, senderId);
    return {
        messageCount: state.messages.length,
        botResponding: state.botResponding,
        responseCount: state.responseCount,
        lastBotResponseAt: state.lastBotResponseAt,
        recentMessages: state.messages.slice(-5).map(m => ({
            content: m.content.slice(0, 50),
            age: Math.round((Date.now() - m.timestamp) / 1000) + 's ago',
        })),
    };
}
