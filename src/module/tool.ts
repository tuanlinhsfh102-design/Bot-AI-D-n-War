import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { generateText } from 'ai';
// ⭐ v1.7.0 — Switch sang OpenCode Zen API.
import { withZenModel, withGoogleModel, ZEN_DEFAULT_MODEL } from './apikey';
import { getTargetDisplayNames } from './targets';

/** Resolve target UIDs thành display names để context AI hiểu. */
async function resolveTargetNamesForContext(context?: { targetUids?: string[]; targetNames?: string[] }): Promise<string> {
    const names: string[] = [];
    if (context?.targetUids?.length) {
        const map = await getTargetDisplayNames(context.targetUids);
        for (const uid of context.targetUids) {
            const name = map.get(uid);
            if (name) names.push(name);
        }
    }
    return names.join(', ');
}

export interface userInfo {
    name: string,
    relationship: string,
    gender: string,
    avatarInText: string,
    nam_sinh: string
}

interface AIMessage {
    role: 'user' | 'assistant';
    content: string;
}

export async function aiImageToText(
    url: string,
    context?: { groupName?: string; senderName?: string; targetNames?: string[]; targetUids?: string[] }
): Promise<string> {
    try {
        // Prepare file part: accept both http(s) URLs and local file paths
        let filePart: any;
        if (/^https?:\/\//i.test(url)) {
            // Let the provider download the URL automatically
            filePart = { type: 'file', data: url, mediaType: 'image/*' };
        } else {
            const abs = path.isAbsolute(url) ? url : path.join(process.cwd(), url);
            if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
            const data = fs.readFileSync(abs);
            const ext = path.extname(abs).slice(1).toLowerCase();
            const mimeMap: Record<string, string> = {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                gif: 'image/gif',
                webp: 'image/webp',
                tiff: 'image/tiff',
                tif: 'image/tiff',
                bmp: 'image/bmp',
                heic: 'image/heic',
                heif: 'image/heif',
            };
            const mime = mimeMap[ext] ?? 'image/*';
            filePart = { type: 'file', data, mediaType: mime };
        }

        // Mô tả ảnh + tag phân loại BẮT BUỘC ở cuối.
        // Tag dùng để phát hiện chính xác khi target gửi ảnh người khác để bắt nạt.
        let instruction = `Mô tả bức ảnh này NGÂN GỌN trong 1-2 câu tiếng Việt. Đề cập:
- Nội dung chính (người/vật/meme/screenshot/v.v.)
- Nếu có người: bao nhiêu người, nam/nữ, độ tuổi ước tính, biểu cảm, góc chụp
- Bối cảnh (trong nhà, ngoài trời, chụp màn hình mạng xã hội, ảnh meme, v.v.)

SAU MÔ TẢ, BẮT BUỘC thêm các tag phân loại phù hợp dưới đây vào CUỐI câu trả lời (mỗi tag trên một dòng riêng):
[SELFIE] — nếu ảnh chụp gương mặt/thân người gửi (góc gần, tự chụp, portrait cá nhân)
[ẢNH_NGƯỜI_KHÁC] — nếu ảnh chụp/screenshot/chia sẻ hình ảnh của người KHÁC (không phải người gửi), bao gồm: chụp lén, ảnh lấy từ mạng xã hội, ảnh đại diện người khác, ảnh nhóm mà người gửi không phải chủ thể, ảnh chế/meme về người khác
[KHÔNG_CÓ_NGƯỜI] — nếu ảnh không có người (phong cảnh, vật thể, meme chữ, v.v.)`;

        if (context) {
            instruction += `\n[SCREENSHOT_OF_CURRENT_GROUP] — BẮT BUỘC thêm tag này nếu ảnh là hình chụp màn hình đoạn chat, danh sách thành viên, tin nhắn hoặc giao diện của chính nhóm "${context.groupName || ''}" hiện tại (nhận biết qua tên nhóm ở trên cùng, các tin nhắn chứa tên các thành viên hoặc avatar).
[SCREENSHOT_OF_OTHER_CHAT] — BẮT BUỘC thêm tag này nếu ảnh là hình chụp màn hình một cuộc trò chuyện khác, nhóm khác hoặc ứng dụng khác (không phải nhóm "${context.groupName || ''}").

Bối cảnh nhóm hiện tại (để đối chiếu):
- Tên nhóm hiện tại: "${context.groupName || ''}"
- Người gửi ảnh này: "${context.senderName || ''}"
- Các thành viên/đối tượng liên quan trong cuộc hội thoại: ${(await resolveTargetNamesForContext(context)) || ''}
- Tên của tôi (bot): "Nguyễn Đình Dương"`;
        }

        instruction += `\n\nChỉ trả lời mô tả + các tag phù hợp ở cuối, không thêm bất kỳ lời bình luận hay giải thích nào khác.`;

        let result: any;
        try {
            result = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
                return generateText({
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: instruction },
                                filePart,
                            ],
                        },
                    ],
                    // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
                });
            });
        } catch (zenErr: any) {
            const isQuota = /quota|429|rate.?limit|exhaust|limit exceeded|too many|chưa có api key|no api key|freeusagelimit|api.?key|unauthorized|401|403/i.test(String(zenErr?.message ?? ''));
            if (isQuota) {
                console.warn(`[ImageToText] ⚠️ Zen quota → fallback Gemini: ${String(zenErr?.message ?? zenErr).slice(0, 100)}`);
                result = await withGoogleModel('gemini-3.1-flash-lite', async (model) => {
                    return generateText({
                        model,
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    { type: 'text', text: instruction },
                                    filePart,
                                ],
                            },
                        ],
                    });
                });
            } else {
                throw zenErr;
            }
        }

        const text = (result as any).text ?? '';
        const out = String(text).trim();
        if (!out) throw new Error('No description returned from model');
        return out;
    } catch (err: any) {
        console.error('aiImageToText error:', err?.message ?? err);
        throw err;
    }
}

export async function aiVideoToText(url: string): Promise<string> {
    try {
        let filePart: any;
        if (/^https?:\/\//i.test(url)) {
            filePart = { type: 'file', data: url, mediaType: 'video/*' };
        } else {
            const abs = path.isAbsolute(url) ? url : path.join(process.cwd(), url);
            if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
            const data = fs.readFileSync(abs);
            const ext = path.extname(abs).slice(1).toLowerCase();
            const mimeMap: Record<string, string> = {
                mp4: 'video/mp4',
                webm: 'video/webm',
                mkv: 'video/x-matroska',
                mov: 'video/quicktime',
                avi: 'video/x-msvideo',
                mpeg: 'video/mpeg',
                mpg: 'video/mpeg',
                m4v: 'video/x-m4v'
            };
            const mime = mimeMap[ext] ?? 'video/*';
            filePart = { type: 'file', data, mediaType: mime };
        }
        const instruction = `Tóm tắt ngắn gọn nội dung video (2-3 câu): nêu ý chính, điểm quan trọng, sự kiện chính, và chữ xuất hiện nếu có`;
        let result: any;
        try {
            result = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
                return generateText({
                    model,
                    messages: [
                        { role: 'user', content: [ { type: 'text', text: instruction }, filePart ] }
                    ],
                    // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
                });
            });
        } catch (zenErr: any) {
            const isQuota = /quota|429|rate.?limit|exhaust|limit exceeded|too many|chưa có api key|no api key|freeusagelimit|api.?key|unauthorized|401|403/i.test(String(zenErr?.message ?? ''));
            if (isQuota) {
                console.warn(`[VideoToText] ⚠️ Zen quota → fallback Gemini: ${String(zenErr?.message ?? zenErr).slice(0, 100)}`);
                result = await withGoogleModel('gemini-3.1-flash-lite', async (model) => {
                    return generateText({
                        model,
                        messages: [
                            { role: 'user', content: [ { type: 'text', text: instruction }, filePart ] }
                        ],
                    });
                });
            } else {
                throw zenErr;
            }
        }
        const text = (result as any).text ?? '';
        const out = String(text).trim();
        if (!out) throw new Error('No summary returned from model');
        return out;
    } catch (err: any) {
        console.error('aiVideoToText error:', err?.message ?? err);
        throw err;
    }
}

export async function getUserInfo(userId: string) {
    let userFolderDir = path.join("./data/user", userId);
    if (!fs.existsSync(userFolderDir)) {
        fs.mkdirSync(userFolderDir, { recursive: true });
    }
    let userDir = path.join(userFolderDir, "info.json");
    if (fs.existsSync(userDir)) {
        let rawdata = fs.readFileSync(userDir, 'utf-8');
        let userInfo: userInfo = JSON.parse(rawdata);
        return {
            data: {
                name: userInfo.name,
                relationship: userInfo.relationship,
                gender: userInfo.gender,
                avatarInText: userInfo.avatarInText,
                nam_sinh: userInfo.nam_sinh,
            },
            string: `Tên tài khoản: ${userInfo.name}
userId: ${userId}
Giới tính: ${userInfo.gender}
Quan hệ: ${userInfo.relationship}
Avatar: ${userInfo.avatarInText}
Năm sinh: ${userInfo.nam_sinh}`
        };
    } else {
        const user = await global.api.getUserInfo(userId);
        const data = user.changed_profiles[userId];
        const userInfo: userInfo = {
            name: data.displayName,
            relationship: "Người lạ",
            gender: data.gender == 0 ? "Nam" : "Nữ",
            avatarInText: await aiImageToText(data.avatar),
            nam_sinh: data.sdob,
        }
        updateUserInfo(userId, userInfo);
        return {
            data: {
                name: userInfo.name,
                relationship: userInfo.relationship,
                gender: userInfo.gender,
                avatarInText: userInfo.avatarInText,
                nam_sinh: userInfo.nam_sinh,
            },
            string: `Tên tài khoản: ${userInfo.name}
userId: ${userId}
Giới tính: ${userInfo.gender}
Quan hệ: ${userInfo.relationship}
Avatar: ${userInfo.avatarInText}
Năm sinh: ${userInfo.nam_sinh}`
        }
    }
}

export function updateUserInfo(userId: string, newInfo: Partial<userInfo>) {
    let userFolderDir = path.join("./data/user", userId)
    if (!fs.existsSync(userFolderDir)) {
        fs.mkdirSync(userFolderDir, { recursive: true });
    }
    let userDir = path.join(userFolderDir, "info.json");
    let rawdata = "{}"
    if (fs.existsSync(userDir)) rawdata = fs.readFileSync(userDir, 'utf-8');
    let userInfo = JSON.parse(rawdata);
    userInfo = { ...userInfo, ...newInfo };
    fs.writeFileSync(userDir, JSON.stringify(userInfo, null, 2));
}

export async function getGroupInfo(groupId: string) {
    try {
        const resp: any = await (global as any).api.getGroupInfo(groupId);
        // ⚠️ Cấu trúc thực của zca-js getGroupInfo:
        //   resp.gridInfoMap[groupId] = { name, currentMems[], memberId[], avt, ... }
        // Trước đây code dùng resp?.data?.name — SAI → luôn trả "không có".
        const gridInfoMap = resp?.gridInfoMap ?? resp?.data?.gridInfoMap ?? {};
        const g: any = gridInfoMap[groupId] ?? gridInfoMap[Object.keys(gridInfoMap)[0]] ?? {};
        const name = String(g?.name ?? g?.groupName ?? resp?.data?.name ?? resp?.name ?? groupId);
        const memberCount = Array.isArray(g?.currentMems) ? g.currentMems.length
            : Array.isArray(g?.memberIds) ? g.memberIds.length
            : g?.totalMember ?? resp?.data?.memberCount ?? undefined;
        const avatar = String(g?.avt ?? g?.avatar ?? resp?.data?.avatar ?? resp?.avatar ?? '');
        return {
            data: { name, members: memberCount, avatar, id: groupId },
            string: `Tên nhóm: ${name}
groupId: ${groupId}
Số thành viên: ${memberCount ?? '—'}
Avatar nhóm: ${avatar ? 'Có' : 'Không'}`
        };
    } catch {
        return {
            data: { name: '', members: undefined, avatar: '', id: groupId },
            string: `Tên nhóm: (không có)
groupId: ${groupId}
Số thành viên: —
Avatar nhóm: Không`
        };
    }
}

/**
 * ⚠️ FIX v1.5.17 — Sanitize "Sleiz" references trong text.
 * Bot đã đổi tên từ "Sleiz" → "Nguyễn Đình Dương" nhưng chat history cũ vẫn còn "Sleiz".
 * Khi AI đọc history/memory chứa "Sleiz", nó có thể tự nhận đó là tên mình.
 * Giải pháp: replace "Sleiz" → "Nguyễn Đình Dương" khi load history/memory.
 */
const SLEIZ_REPLACEMENT = 'Nguyễn Đình Dương';
export function sanitizeSleizReferences(text: string): string {
    if (!text || typeof text !== 'string') return text;
    // Replace "Sleiz" (case-insensitive, whole word) → "Nguyễn Đình Dương"
    // Nhưng KHÔNG replace trong context như "Sleiz Edition", "zalo_sleiz_bot" (DB name)
    return text
        .replace(/\bSleiz\b/g, SLEIZ_REPLACEMENT)
        .replace(/\bsleiz\b/g, SLEIZ_REPLACEMENT.toLowerCase());
}

/**
 * Get chat history per-thread.
 * @param threadId Thread ID (DM: userId, Group: groupId)
 * File lưu tại ./data/chat_{threadId}.json (per-thread, không global)
 *
 * ⚠️ FIX v1.5.17 — Sanitize "Sleiz" → "Nguyễn Đình Dương" trong history
 * để AI không tự nhận tên cũ.
 */
export function getChatHistory(threadId: string): AIMessage[] {
    const dir = path.join("./data");
    const file = path.join(dir, `chat_${threadId}.json`);
    if (!fs.existsSync(file)) return [];
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        const chatHistory = JSON.parse(raw);
        if (!Array.isArray(chatHistory)) return [];
        // Sanitize "Sleiz" → "Nguyễn Đình Dương" trong mỗi message
        return chatHistory.map((m: any) => ({
            role: m.role,
            content: sanitizeSleizReferences(String(m.content ?? '')),
        }));
    } catch {
        return [];
    }
}

/**
 * Save chat history per-thread.
 * @param threadId Thread ID
 * @param chatHistory mảng AIMessage để lưu
 */
export function saveChatHistory(threadId: string, chatHistory: any[]) {
    const dir = path.join("./data");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const file = path.join(dir, `chat_${threadId}.json`);
    fs.writeFileSync(file, JSON.stringify(chatHistory, null, 2));
}

// -------- Per-user talk history (actual exchanged messages) --------
export type TalkEntry = {
    role: 'user' | 'assistant';
    content: string;
    type?: 'text' | 'voice' | 'sticker' | 'reaction';
    ts: number; // unix ms
};

type TalkSummaryCache = {
    sourceHash: string;
    summary: string;
    updatedAt: number;
};

// ⚠️ FIX v1.5.1 — Tăng talk history limits để bot nhớ context cá nhân hóa
// Trước đây: 48 entries / 12 recent → bot quên detail cá nhân (sở thích, drama)
// Giờ: 80 entries / 20 recent → nhớ chi tiết hơn, cá nhân hóa reply tốt hơn
const TALK_HISTORY_KEEP_LAST = 80;
const TALK_SUMMARY_KEEP_RECENT = 20;

function getUserDataDir(userId: string): string {
    return path.join('./data/user', userId);
}

function getTalkSummaryPath(userId: string): string {
    return path.join(getUserDataDir(userId), 'talk_summary.json');
}

function trimForSummary(text: string, max = 180): string {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 3)}...`;
}

function hashTalkEntries(entries: TalkEntry[]): string {
    const hash = createHash('sha1');
    for (const entry of entries) {
        hash.update(`${entry.role}|${entry.type ?? 'text'}|${entry.ts}|${entry.content}\n`);
    }
    return hash.digest('hex');
}

function loadTalkSummaryCache(userId: string): TalkSummaryCache | null {
    const file = getTalkSummaryPath(userId);
    if (!fs.existsSync(file)) return null;
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (typeof obj.summary !== 'string' || typeof obj.sourceHash !== 'string') return null;
        return {
            sourceHash: obj.sourceHash,
            summary: obj.summary,
            updatedAt: Number(obj.updatedAt ?? 0),
        };
    } catch {
        return null;
    }
}

function saveTalkSummaryCache(userId: string, cache: TalkSummaryCache): void {
    const dir = getUserDataDir(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getTalkSummaryPath(userId), JSON.stringify(cache, null, 2));
}

function fallbackSummarizeTalkEntries(entries: TalkEntry[]): string {
    if (entries.length === 0) return '';
    const bullets = entries.slice(-6).map((entry) => {
        const who = entry.role === 'user' ? 'Người dùng' : 'Bot';
        return `- ${who}: ${trimForSummary(entry.content, 120)}`;
    });
    return bullets.join('\n');
}

async function summarizeTalkEntriesAI(entries: TalkEntry[]): Promise<string> {
    if (entries.length === 0) return '';
    const convo = entries
        .map((entry, index) => {
            const who = entry.role === 'user' ? 'Người dùng' : 'Bot';
            return `- [${index + 1}] ${who}: ${trimForSummary(entry.content, 220)}`;
        })
        .join('\n');
    try {
        const { text } = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
            return generateText({
                model,
                prompt:
                    `Tóm tắt ngắn gọn bằng tiếng Việt phần hội thoại cũ dưới đây để bot giữ ngữ cảnh mà không cần nhét toàn bộ lịch sử vào prompt. ` +
                    `Giữ lại: thông tin cá nhân đã lộ ra, chủ đề đang dở, mối quan hệ, điều người dùng thích/ghét, các mâu thuẫn còn dang dở. ` +
                    `Trả về tối đa 6 gạch đầu dòng, dưới 700 ký tự, không code block.\n\n` +
                    `Hội thoại:\n${convo}`,
                // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
            });
        });
        const summary = String(text ?? '').trim();
        return summary || fallbackSummarizeTalkEntries(entries);
    } catch (e) {
        console.warn('[TalkSummary] AI summarize failed, using fallback:', e);
        return fallbackSummarizeTalkEntries(entries);
    }
}

export function getTalkHistory(userId: string): TalkEntry[] {
    const dir = getUserDataDir(userId);
    const file = path.join(dir, 'talk.json');
    if (!fs.existsSync(file)) return [];
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function saveTalkHistory(userId: string, history: TalkEntry[]): void {
    const dir = getUserDataDir(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'talk.json');
    fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

export function appendTalkEntries(userId: string, entries: TalkEntry[], keepLast: number = TALK_HISTORY_KEEP_LAST): TalkEntry[] {
    // Giữ file talk.json ngắn để giảm I/O và giảm chi phí summarize mỗi turn.
    // Phần hội thoại cũ hơn sẽ được rút gọn qua buildConversationMemory().
    const current = getTalkHistory(userId);
    current.push(...entries);
    const trimmed = current.length > keepLast ? current.slice(-keepLast) : current;
    saveTalkHistory(userId, trimmed);
    return trimmed;
}

export async function buildConversationMemory(
    userId: string,
    recentKeep: number = TALK_SUMMARY_KEEP_RECENT,
): Promise<{ summary: string; recent: TalkEntry[] }> {
    const history = getTalkHistory(userId);
    if (history.length === 0) {
        return { summary: '', recent: [] };
    }

    const safeRecentKeep = Math.max(1, recentKeep);
    const splitIndex = Math.max(0, history.length - safeRecentKeep);
    const older = history.slice(0, splitIndex);
    const recent = history.slice(splitIndex);

    if (older.length === 0) {
        return { summary: '', recent };
    }

    const sourceHash = hashTalkEntries(older);
    const cached = loadTalkSummaryCache(userId);
    if (cached && cached.sourceHash === sourceHash && cached.summary.trim()) {
        // ⚠️ FIX v1.5.17 — Sanitize "Sleiz" trong cached summary
        return { summary: sanitizeSleizReferences(cached.summary.trim()), recent };
    }

    const summary = await summarizeTalkEntriesAI(older);
    saveTalkSummaryCache(userId, {
        sourceHash,
        summary,
        updatedAt: Date.now(),
    });
    // ⚠️ Sanitize "Sleiz" trong summary mới + recent entries
    return {
        summary: sanitizeSleizReferences(summary),
        recent: recent.map(e => ({ ...e, content: sanitizeSleizReferences(String(e.content ?? '')) })),
    };
}

// Backward-compatible helpers (in case other modules import these names)
export function appendUserRawMessage(userId: string, content: string, type: TalkEntry['type'] = 'text'): void {
    appendTalkEntries(userId, [{ role: 'user', content, type, ts: Date.now() }]);
}

export function appendAssistantRawMessage(userId: string, content: string, type: TalkEntry['type'] = 'text'): void {
    appendTalkEntries(userId, [{ role: 'assistant', content, type, ts: Date.now() }]);
}
