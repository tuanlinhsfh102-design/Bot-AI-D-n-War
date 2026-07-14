/**
 * human.ts — Centralized human-behavior simulation helpers.
 *
 * Mục tiêu: giúp bot hành xử giống người thật tối đa trên Zalo, không lộ bot.
 *
 * Các hàm trong file này được tham chiếu từ:
 *   - zca-js source: https://github.com/RFS-ADRENO/zca-js
 *   - zca-js docs:   https://tdung.gitbook.io/zca-js
 *
 * Đặc biệt:
 *   - sendTypingEvent signature: sendTypingEvent(threadId, type?, destType?)
 *     Type là ThreadType.User (default) hoặc ThreadType.Group
 *     Indicator tự expire sau ~5s (theo source code zca-js/src/apis/sendTypingEvent.ts)
 *   - sendSeenEvent signature: sendSeenEvent(messages, type?) — type là ThreadType
 *
 * Các lớp behavior:
 *   1. Per-thread pace tracking — adapt với tốc độ chat của đối phương
 *   2. Time-of-day latency — đêm trả lời chậm hơn, ban ngày nhanh hơn
 *   3. Realistic typing pattern — burst typing với pauses
 *   4. Random seen delay — không seen ngay lập tức, mimic "đang bận"
 *   5. Mid-turn pause — đôi khi dừng giữa multi-message turn
 *   6. Random "ignore" — đôi khi không reply (chỉ seen)
 */
import { ThreadType } from 'zca-js';

// ============================================================
// Per-thread pace tracking — adapt với tốc độ chat của user
// ============================================================

interface ThreadPace {
    lastUserMessageAt: number;
    recentUserGaps: number[];  // last 5 gaps (ms) giữa các tin user gửi
    lastBotMessageAt: number;
}

const threadPaces = new Map<string, ThreadPace>();

/**
 * Record rằng user vừa gửi 1 tin nhắn trong thread.
 * Gọi từ listener khi nhận message (không phải từ bot).
 */
export function recordUserMessage(threadId: string): void {
    const now = Date.now();
    const pace = threadPaces.get(threadId) ?? {
        lastUserMessageAt: now,
        recentUserGaps: [],
        lastBotMessageAt: 0,
    };
    if (pace.lastUserMessageAt > 0) {
        const gap = now - pace.lastUserMessageAt;
        if (gap < 10 * 60 * 1000) {  // chỉ track gaps < 10 phút
            pace.recentUserGaps.push(gap);
            if (pace.recentUserGaps.length > 5) pace.recentUserGaps.shift();
        }
    }
    pace.lastUserMessageAt = now;
    threadPaces.set(threadId, pace);
}

/**
 * Record rằng bot vừa gửi 1 tin nhắn trong thread.
 */
export function recordBotMessage(threadId: string): void {
    const pace = threadPaces.get(threadId) ?? {
        lastUserMessageAt: 0,
        recentUserGaps: [],
        lastBotMessageAt: 0,
    };
    pace.lastBotMessageAt = Date.now();
    threadPaces.set(threadId, pace);
}

/**
 * Tính avg gap của user (ms) — dùng để adapt tốc độ reply.
 * Trả về 0 nếu chưa có data.
 */
function getUserAvgGap(threadId: string): number {
    const pace = threadPaces.get(threadId);
    if (!pace || pace.recentUserGaps.length === 0) return 0;
    const sum = pace.recentUserGaps.reduce((a, b) => a + b, 0);
    return Math.floor(sum / pace.recentUserGaps.length);
}

// ============================================================
// Time-of-day helpers
// ============================================================

interface TimeSlot {
    name: string;
    /** Multiplier cho delay — >1 means chậm hơn (đêm), <1 means nhanh hơn (sáng) */
    latencyMultiplier: number;
    /** Tốc độ gõ (chars/sec) — đêm chậm hơn do buồn ngủ */
    typingSpeed: [number, number];  // [min, max] cps
}

function getCurrentTimeSlot(date: Date = new Date()): TimeSlot {
    // ⚠️ FIX v1.6.2 — Dùng Asia/Ho_Chi_Minh thay vì local server time.
    // Trước đây: date.getHours() = local server time (UTC trên VPS cloud) → sai multiplier.
    const hStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit', hour12: false,
    }).format(date);
    let h = parseInt(hStr, 10);
    if (h === 24) h = 0;
    // Khuya (0-5h): buồn ngủ, reply chậm, gõ chậm
    if (h >= 0 && h < 5) return { name: 'khuya', latencyMultiplier: 1.8, typingSpeed: [3, 6] };
    // Sáng sớm (5-8h): vừa thức, hơi chậm
    if (h >= 5 && h < 8) return { name: 'sáng sớm', latencyMultiplier: 1.3, typingSpeed: [4, 7] };
    // Sáng (8-11h): nhanh, năng lượng
    if (h >= 8 && h < 11) return { name: 'sáng', latencyMultiplier: 0.9, typingSpeed: [6, 10] };
    // Trưa (11-14h): bình thường
    if (h >= 11 && h < 14) return { name: 'trưa', latencyMultiplier: 1.0, typingSpeed: [5, 9] };
    // Chiều (14-18h): nhanh, hay khịa
    if (h >= 14 && h < 18) return { name: 'chiều', latencyMultiplier: 0.85, typingSpeed: [6, 10] };
    // Tối (18-22h): bình thường, nhiều năng lượng
    if (h >= 18 && h < 22) return { name: 'tối', latencyMultiplier: 1.0, typingSpeed: [5, 9] };
    // Tối muộn (22-24h): bắt đầu mệt
    return { name: 'tối muộn', latencyMultiplier: 1.4, typingSpeed: [4, 7] };
}

// ============================================================
// Debounce (per-thread batching) — random thay vì fixed
// ============================================================

/**
 * Tính debounce time cho batcher (index.ts).
 *
 * Mô hình:
 *   - Base: 3-6s (đợi user gõ thêm nếu đang spam)
 *   - If user vừa spam (gap < 2s): tăng debounce lên 4-8s để gom hết
 *   - If user chat chậm (gap > 30s): giảm debounce xuống 2-4s
 *   - Time-of-day multiplier
 *   - 10% khả năng "reply chậm" (15-40s) — mimic đang bận
 *
 * @param threadId Thread ID để check pace
 */
export function calcDebounce(threadId: string): number {
    const slot = getCurrentTimeSlot();
    const userGap = getUserAvgGap(threadId);

    let base: number;
    if (userGap > 0 && userGap < 2000) {
        // User đang spam — đợi lâu hơn để gom
        base = 4000 + Math.floor(Math.random() * 4000);  // 4-8s
    } else if (userGap > 30000) {
        // User chat chậm — reply nhanh
        base = 2000 + Math.floor(Math.random() * 2000);  // 2-4s
    } else {
        // Bình thường
        base = 3000 + Math.floor(Math.random() * 3000);  // 3-6s
    }

    let total = Math.floor(base * slot.latencyMultiplier);

    // 10% khả năng "đang bận" — delay dài
    if (Math.random() < 0.10) {
        total += 10000 + Math.floor(Math.random() * 25000);  // +10-35s
    }

    // Cap 60s — không quá dài
    return Math.min(total, 60000);
}

// ============================================================
// Seen delay — không seen ngay lập tức
// ============================================================

/**
 * Tính delay trước khi gửi seen event.
 *
 * Mô hình người thật:
 *   - 60% khả năng seen nhanh (0.5-3s) — vừa mở chat
 *   - 25% khả năng seen trung bình (3-10s) — đang làm việc khác
 *   - 10% khả năng seen chậm (10-30s) — bận, không nhìn điện thoại
 *   - 5%  khả năng seen rất chậm (30-90s) — đi vệ sinh / ăn / tắm
 *
 * @returns Delay ms trước khi gửi seen event
 */
export function calcSeenDelay(): number {
    const r = Math.random();
    const slot = getCurrentTimeSlot();
    let base: number;
    if (r < 0.60) {
        base = 500 + Math.floor(Math.random() * 2500);  // 0.5-3s
    } else if (r < 0.85) {
        base = 3000 + Math.floor(Math.random() * 7000);  // 3-10s
    } else if (r < 0.95) {
        base = 10000 + Math.floor(Math.random() * 20000);  // 10-30s
    } else {
        base = 30000 + Math.floor(Math.random() * 60000);  // 30-90s
    }
    return Math.floor(base * slot.latencyMultiplier);
}

// ============================================================
// Human delay — trước mỗi tin nhắn bot gửi
// ============================================================

/**
 * Tính delay trước khi bot gửi 1 tin nhắn.
 *
 * Mô hình:
 *   - First message in turn: think time (2-5s) + typing time (cps theo time-of-day)
 *   - Burst message: send gap (1-2s) + typing time
 *   - Mid-turn pause: 8% khả năng pause dài (3-8s) giữa 2 burst messages
 *   - Time-of-day multiplier
 *   - Adaptive pace: if user spam, bot reply nhanh hơn (multiplier 0.7)
 *
 * @param content Nội dung sẽ gửi
 * @param isBurst true nếu là message thứ N trong chuỗi sendMessage liên tiếp
 * @param threadId Thread ID để adapt pace (optional)
 * @returns Delay ms
 */
export function calcHumanDelay(
    content: string,
    isBurst: boolean,
    threadId?: string,
): number {
    const len = Math.max(content.length, 1);
    const slot = getCurrentTimeSlot();
    const userGap = threadId ? getUserAvgGap(threadId) : 0;

    // Adaptive pace multiplier
    let paceMultiplier = 1.0;
    if (userGap > 0 && userGap < 2000) {
        // User spam → bot reply nhanh hơn
        paceMultiplier = 0.7;
    } else if (userGap > 30000) {
        // User chậm → bot cũng chậm hơn 1 chút
        paceMultiplier = 1.2;
    }

    if (isBurst) {
        const sendGap = 800 + Math.floor(Math.random() * 700);  // 0.8-1.5s
        const cps = slot.typingSpeed[0] + Math.floor(Math.random() * (slot.typingSpeed[1] - slot.typingSpeed[0]));
        const typingTime = Math.floor((len / cps) * 1000);
        let total = sendGap + typingTime;
        total = Math.max(total, 1500);  // floor 1.5s
        total = Math.min(total, 6000);  // cap 6s

        // 8% khả năng mid-turn pause dài (đang suy nghĩ câu tiếp)
        if (Math.random() < 0.08) {
            total += 3000 + Math.floor(Math.random() * 5000);  // +3-8s
        }

        total = Math.floor(total * slot.latencyMultiplier * paceMultiplier);
        return Math.max(total, 1500);
    }

    // First message in turn
    const thinkTime = 2000 + Math.floor(Math.random() * 2500);  // 2-4.5s
    const cps = slot.typingSpeed[0] + Math.floor(Math.random() * (slot.typingSpeed[1] - slot.typingSpeed[0]));
    const typingTime = Math.floor((len / cps) * 1000);
    let total = thinkTime + typingTime;
    total = Math.min(total, 15000);  // cap 15s
    total = Math.max(total, 2500);   // floor 2.5s

    // 5% khả năng "delay dài" — đang bận
    if (Math.random() < 0.05) {
        total += 3000 + Math.floor(Math.random() * 5000);  // +3-8s
    }

    total = Math.floor(total * slot.latencyMultiplier * paceMultiplier);
    return total;
}

// ============================================================
// Realistic typing indicator pattern
// ============================================================

/**
 * Bật typing indicator theo pattern giống người thật:
 *   - Type 1-3s → stop (đừng refresh) → type tiếp → send
 *
 * Zalo typing expire sau ~5s. Strategy:
 *   - Send typing ngay lập tức
 *   - Refresh ở 3-4s nếu delay > 4s (overlap để không có gap)
 *   - Refresh ở 7-8s nếu delay > 8s
 *   - KHÔNG refresh quá dày — sẽ trông "machine-like"
 *
 * @param api Global api object
 * @param threadId Thread ID
 * @param threadType ThreadType (User hoặc Group)
 * @param durationMs Total delay dự kiến (từ calcHumanDelay)
 */
export function startTypingIndicator(
    api: any,
    threadId: string,
    threadType: ThreadType,
    durationMs: number,
): () => void {
    if (!api?.sendTypingEvent) return () => {};

    const timers: ReturnType<typeof setTimeout>[] = [];

    // Gửi typing ngay lập tức
    api.sendTypingEvent(threadId, threadType).catch((e: any) => {
        console.warn('[Typing] sendTypingEvent failed:', e?.message ?? e);
    });

    // Refresh ở giây 3-4 nếu delay > 4s
    if (durationMs > 4000) {
        const refresh1 = 3000 + Math.floor(Math.random() * 1000);
        timers.push(setTimeout(() => {
            api.sendTypingEvent(threadId, threadType).catch(() => {});
        }, refresh1));
    }
    // Refresh ở giây 7-8 nếu delay > 8s
    if (durationMs > 8000) {
        const refresh2 = 7000 + Math.floor(Math.random() * 1000);
        timers.push(setTimeout(() => {
            api.sendTypingEvent(threadId, threadType).catch(() => {});
        }, refresh2));
    }
    // Refresh ở giây 11-12 nếu delay > 12s
    if (durationMs > 12000) {
        const refresh3 = 11000 + Math.floor(Math.random() * 1000);
        timers.push(setTimeout(() => {
            api.sendTypingEvent(threadId, threadType).catch(() => {});
        }, refresh3));
    }

    // ⚠️ FIX v1.6.2 — Trả về cleanup function để caller có thể clear timers
    // ngay sau khi send (tránh "đang gõ..." hiện tiếp sau khi đã gửi tin).
    return () => {
        for (const t of timers) clearTimeout(t);
    };
}

// ============================================================
// Random "ignore" — đôi khi không reply
// ============================================================

/**
 * Quyết định có reply hay không.
 *
 * Bot KHÔNG phải lúc nào cũng reply — giống người thật:
 *   - 98% khả năng reply (⚠️ FIX v1.5.1: tăng từ 92% → 98%)
 *   - 2%  khả năng KHÔNG reply (chỉ seen) — rất hiếm
 *
 * Điều kiện KHÔNG bao giờ skip:
 *   - User mention bot
 *   - User reply tin nhắn bot
 *   - User nhắn DM (chat riêng)
 *
 * Lý do tăng 92→98: Trước đây 8% skip quá cao → bot thường "bơ" tin nhắn quan trọng,
 * trông như bot bị lỗi hoặc không quan tâm. 2% skip vẫn giữ tính "người thật" nhưng
 * không bỏ lỡ context quan trọng.
 *
 * @param isMentioned True nếu user mention bot
 * @param isReply True nếu user reply tin nhắn bot
 * @param isDM True nếu là chat riêng (không phải group)
 */
export function shouldReply(
    isMentioned: boolean = false,
    isReply: boolean = false,
    isDM: boolean = false,
): boolean {
    if (isMentioned || isReply || isDM) return true;
    return Math.random() < 0.98;
}

// ============================================================
// Sleep helper
// ============================================================
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Export current time slot (for logging/debug)
// ============================================================
export function getCurrentSlotName(): string {
    return getCurrentTimeSlot().name;
}
