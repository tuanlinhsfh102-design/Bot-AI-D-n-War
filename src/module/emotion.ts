/**
 * emotion.ts — Hệ thống cảm xúc cho Bot Nguyễn Đình Dương
 *
 * Persona Nguyễn Đình Dương: thích gây sự, va chạm, cục tính, cà khịa, sẵn sàng chửi nhau.
 * - 11 trạng thái cảm xúc (neutral/cocky/triggered/aggressive/hyped/bored/savage/petty/annoyed/triumphant/chill)
 * - intensity 0-10 (0 = bình tĩnh, 10 = sắp nổ)
 * - Decay tự động theo thời gian (mỗi 15 phút giảm 1 intensity — bot dễ nổi hotter)
 * - Trigger tracking: lưu lý do, người gây ra, thời điểm
 * - Per-user state (mỗi user bot có trạng thái cảm xúc riêng khi chat)
 * - Auto trigger rules: khi bị insult → triggered, khi user nổ → savage, khi user sợ → cocky...
 * - Voice mapping: mỗi cảm xúc → giọng Gemini TTS phù hợp
 *
 * Khác biệt so với Trap Girl:
 * - Trạng thái đa số là "nóng" (triggered/aggressive/savage) thay vì "lạnh" (sulky/lonely)
 * - Decay nhanh hơn (15 phút vs 30 phút)
 * - Affinity dùng để track "độ thù" hoặc "độ dể war" với từng user
 * - Auto-bump affinity khi user đối đầu (càng war càng thân war)
 */
import fs from 'fs';
import path from 'path';

// ============================================================
// Types
// ============================================================
export type EmotionState =
    | 'neutral'     // bình tĩnh, chưa cục
    | 'cocky'       // kiêu ngạo, tự tin, bá đạo
    | 'triggered'   // bị chọc nổi đóa, sắp gây sự
    | 'aggressive'  // hung hăng, sắp chửi
    | 'hyped'       // phấn khích, vui vì có war
    | 'bored'       // chán, thấy đối phương nhạt
    | 'savage'      // ác miệng, cắn không trượt
    | 'petty'       // cục cằn, nhỏ mọn, soi mói
    | 'annoyed'     // khó chịu nhẹ
    | 'triumphant'  // hả hê, thắng keo
    | 'chill';      // mát mẻ, tạm nghỉ (sau khi thắng)

export const ALL_EMOTIONS: EmotionState[] = [
    'neutral', 'cocky', 'triggered', 'aggressive',
    'hyped', 'bored', 'savage', 'petty',
    'annoyed', 'triumphant', 'chill',
];

export interface EmotionTrigger {
    state: EmotionState;
    intensity: number;          // 0-10
    reason: string;
    triggeredBy: string;        // userId gây ra
    triggeredAt: number;        // unix ms
}

export interface EmotionProfile {
    state: EmotionState;
    intensity: number;          // 0-10
    reason: string;
    lastTriggerAt: number;      // unix ms — để tính decay
    lastInteraction: number;    // unix ms — lần cuối user chat
    consecutiveShortReplies: number;  // đếm số tin cộc liên tiếp (bot thấy user nhát)
    consecutiveIgnored: number;       // số lần bot khịa mà user im
    history: EmotionTrigger[];        // 20 trigger gần nhất
    // Bo本场比赛: cumulative war-affinity với user (càng cao càng hay war)
    affinity: number;                 // 0-100 (war score với user này)
    warStreak: number;                // số keo war thắng liên tiếp
}

const DEFAULT_PROFILE: EmotionProfile = {
    state: 'chill',  // mặc định bình thường, không tự gây sự
    intensity: 1,
    reason: 'Khởi đầu mặc định — bình thường, chưa có lý do để war',
    lastTriggerAt: 0,
    lastInteraction: 0,
    consecutiveShortReplies: 0,
    consecutiveIgnored: 0,
    history: [],
    affinity: 20,  // mặc định: lạ nhưng sẵn sàng war
    warStreak: 0,
};

// ============================================================
// Storage (per-user JSON)
// ============================================================
function emotionFilePath(userId: string): string {
    return path.join(process.cwd(), 'data', 'user', userId, 'emotion.json');
}

function ensureFile(userId: string): void {
    const file = emotionFilePath(userId);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(DEFAULT_PROFILE, null, 2));
    }
}

export function loadEmotion(userId: string): EmotionProfile {
    try {
        const file = emotionFilePath(userId);
        if (!fs.existsSync(file)) return { ...DEFAULT_PROFILE };
        const raw = fs.readFileSync(file, 'utf-8');
        const obj = JSON.parse(raw);
        return {
            ...DEFAULT_PROFILE,
            ...obj,
            history: Array.isArray(obj?.history) ? obj.history.slice(-20) : [],
        };
    } catch {
        return { ...DEFAULT_PROFILE };
    }
}

export function saveEmotion(userId: string, profile: EmotionProfile): void {
    try {
        ensureFile(userId);
        fs.writeFileSync(emotionFilePath(userId), JSON.stringify(profile, null, 2));
    } catch (e) {
        console.warn('[Emotion] save failed:', e);
    }
}

// ============================================================
// Decay: mỗi 15 phút intensity giảm 1 (bot dễ nổi hotter nên decay nhanh)
// ============================================================
const DECAY_INTERVAL_MS = 15 * 60 * 1000; // 15 phút
const NEUTRAL_THRESHOLD = 1;

export function applyDecay(profile: EmotionProfile, now: number = Date.now()): EmotionProfile {
    if (profile.state === 'neutral' || profile.intensity <= 0) {
        return { ...profile, intensity: 0, state: profile.intensity <= 0 ? 'neutral' : profile.state };
    }
    const elapsed = now - profile.lastTriggerAt;
    const steps = Math.floor(elapsed / DECAY_INTERVAL_MS);
    if (steps <= 0) return profile;
    const newIntensity = Math.max(0, profile.intensity - steps);
    if (newIntensity <= NEUTRAL_THRESHOLD) {
        return {
            ...profile,
            state: 'chill',
            intensity: 1,
            reason: 'Decay xong, quay lại bình thường',
            lastTriggerAt: now,
        };
    }
    return { ...profile, intensity: newIntensity, lastTriggerAt: now };
}

// ============================================================
// Trigger API
// ============================================================
export function triggerEmotion(
    userId: string,
    state: EmotionState,
    intensityDelta: number,
    reason: string,
    triggeredBy: string = userId,
): EmotionProfile {
    let profile = loadEmotion(userId);
    profile = applyDecay(profile);

    // Cộng dồn intensity (nếu cùng trạng thái) hoặc set mới
    let newIntensity: number;
    if (profile.state === state) {
        newIntensity = Math.min(10, profile.intensity + intensityDelta);
    } else {
        // Chuyển trạng thái: giữ lại 30% intensity cũ để chuyển tiếp tự nhiên
        const carry = Math.floor(profile.intensity * 0.3);
        newIntensity = Math.min(10, Math.max(intensityDelta, carry));
    }

    const trigger: EmotionTrigger = {
        state,
        intensity: newIntensity,
        reason,
        triggeredBy,
        triggeredAt: Date.now(),
    };

    profile.state = state;
    profile.intensity = newIntensity;
    profile.reason = reason;
    profile.lastTriggerAt = Date.now();
    profile.history.push(trigger);
    if (profile.history.length > 20) profile.history = profile.history.slice(-20);

    saveEmotion(userId, profile);
    return profile;
}

export function coolDown(userId: string, delta: number = 2): EmotionProfile {
    let profile = loadEmotion(userId);
    profile = applyDecay(profile);
    profile.intensity = Math.max(0, profile.intensity - delta);
    if (profile.intensity <= NEUTRAL_THRESHOLD) {
        profile.state = 'chill';
        profile.reason = 'Cool down, quay lại bình thường';
    }
    saveEmotion(userId, profile);
    return profile;
}

// ============================================================
// Affinity (độ thân-war) — ảnh hưởng cách bot nói
// ============================================================
export function bumpAffinity(userId: string, delta: number): EmotionProfile {
    let profile = loadEmotion(userId);
    profile.affinity = Math.max(0, Math.min(100, profile.affinity + delta));
    saveEmotion(userId, profile);
    return profile;
}

export function bumpWarStreak(userId: string, delta: number): EmotionProfile {
    let profile = loadEmotion(userId);
    profile.warStreak = Math.max(0, profile.warStreak + delta);
    saveEmotion(userId, profile);
    return profile;
}

export function getAffinityLevel(userId: string): 'stranger' | 'acquaintance' | 'war_buddy' | 'rival' | 'archenemy' {
    const p = loadEmotion(userId);
    if (p.affinity >= 80) return 'archenemy';     // thù truyền kiếp
    if (p.affinity >= 60) return 'rival';         // kẻ thù không đội trời chung
    if (p.affinity >= 40) return 'war_buddy';     // anh em war thường xuyên
    if (p.affinity >= 20) return 'acquaintance';  // quen qua vài keo
    return 'stranger';                            // mới gặp
}

export interface EmotionAnalysisResult {
    detectedState?: EmotionState;
    intensityDelta: number;
    reason: string;
    matchedRule?: string;
}

export function analyzeIncomingMessage(
    _text: string,
    userId: string,
    context: { now?: number; threadType?: 'User' | 'Group' } = {},
): EmotionAnalysisResult {
    const now = context.now ?? Date.now();
    const profile = loadEmotion(userId);
    profile.lastInteraction = now;
    saveEmotion(userId, profile);
    return { intensityDelta: 0, reason: 'Nhận diện để model tự xử lý trong prompt', matchedRule: 'prompt_only' };
}

/**
 * Phát hiện "bị ignore" — gọi khi bot vừa khịa mà user im lặng lâu.
 */
export function markIgnored(userId: string, questionText: string): EmotionProfile | null {
    let p = loadEmotion(userId);
    const elapsedSinceLastInteraction = Date.now() - p.lastInteraction;
    if (elapsedSinceLastInteraction < 10 * 60 * 1000) return null;

    p.consecutiveIgnored += 1;
    const trigger = triggerEmotion(
        userId,
        'savage',
        Math.min(8, 2 + p.consecutiveIgnored),
        `Bot khịa mà bị ignore ${p.consecutiveIgnored} lần (câu: "${questionText.slice(0, 40)}...")`,
        userId,
    );
    return trigger;
}

// ============================================================
// Voice mapping — mỗi cảm xúc map sang voice Gemini TTS
// Nguyễn Đình Dương nên dùng voice nam + hơi gắt
// ============================================================
export const EMOTION_VOICE_MAP: Record<EmotionState, string> = {
    neutral:    'Orus',      // nam nhẹ, bình tĩnh
    cocky:      'Charon',    // nam trầm, tự tin, bá đạo
    triggered:  'Fenrir',    // nam gắt, năng lượng
    aggressive: 'Fenrir',    // nam gắt, lớn
    hyped:      'Puck',      // nam cao, phấn khích
    bored:      'Aoede',     // nam chậm, chán
    savage:     'Charon',    // nam ác, sắc
    petty:      'Puck',      // nam nhí, soi
    annoyed:    'Charon',    // nam khó chịu
    triumphant: 'Charon',    // nam hả hê, bá
    chill:      'Orus',      // nam bình tĩnh, mát
};

export function getVoiceForEmotion(state: EmotionState): string {
    return EMOTION_VOICE_MAP[state] || 'Orus';
}

// ============================================================
// Render — chuỗi mô tả cảm xúc để inject vào system prompt
// ============================================================
export function renderEmotionContext(userId: string): string {
    const p = applyDecay(loadEmotion(userId));
    const affinity = getAffinityLevel(userId);
    const lines: string[] = [];
    lines.push(`Cảm xúc hiện tại của Nguyễn Đình Dương với ${userId}: ${p.state} (intensity ${p.intensity}/10)`);
    if (p.reason) lines.push(`Lý do: ${p.reason}`);
    lines.push(`War-level: ${affinity} (affinity ${p.affinity}/100) — warStreak ${p.warStreak}`);
    if (p.consecutiveShortReplies > 0) lines.push(`Đối phương vừa cộc ${p.consecutiveShortReplies} lần liên tiếp`);
    if (p.consecutiveIgnored > 0) lines.push(`Đối phương đã ignore bot ${p.consecutiveIgnored} lần gần đây`);

    // Hướng dẫn cách nói theo cảm xúc
    const guidance = EMOTION_BEHAVIOR_GUIDE[p.state];
    if (guidance) lines.push(`Cách phản hồi: ${guidance}`);

    return lines.join('\n');
}

export const EMOTION_BEHAVIOR_GUIDE: Record<EmotionState, string> = {
    neutral:    'Bình tĩnh, sẵn sàng cà khịa bất cứ lúc nào',
    cocky:      'Kiêu ngạo, bá đạo, tự tin thái quá, hay "bố", "tao", "ai dám", "lên đi"',
    triggered:  'Nổi đóa, cộc lốc, sẵn sàng chửi, dùng "con đĩ", "đĩ mẹ m", "sủa đi", "câm đi"',
    aggressive: 'Hung hăng, chửi trực tiếp, lớn giọng, "bố đấm", "lên keo", "war đi"',
    hyped:      'Phấn khích vì có war, nhiều tin, sticker haha, "vãi", "đỉnh", "lên đi ông"',
    bored:      'Chán, thấy nhạt, "nhạt vãi", "cứt", "thôi", "ko có gì war", sticker thở dài',
    savage:     'Ác miệng, cắn không trượt, soi kỹ, "mày", "con đó", "đĩ", bóp không thương tiếc',
    petty:      'Cục cằn, soi mói từng chữ, "ơ kìa", "mày nói cái gì", "lặp lại coi"',
    annoyed:    'Khó chịu nhẹ, cộc, "hừ", "ờ", "xàm", "loz", không push',
    triumphant: 'Hả hê, "thua chưa", "rét chưa", "quê chưa", "xong rồi", sticker haha',
    chill:      'Mát mẻ, tạm nghỉ, "ok done", "thôi war đủ rồi", "mai war tiếp"',
};
