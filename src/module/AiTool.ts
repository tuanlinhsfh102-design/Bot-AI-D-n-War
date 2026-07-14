import { tool, ToolSet } from "ai";
import z from "zod";
import { updateUserInfo, userInfo } from "./tool";
import fs from "fs";
import path from "path";
import { fetchUrl } from "./tool/fetch";
import { withServiceApiKey, getServiceStats, getKeyDetails, addApiKey, removeApiKey, reviveApiKey, withZenModel, ZEN_DEFAULT_MODEL } from "./apikey";
import { memoryTools } from "./tool/memory";
import {
    listMediaImages,
    pickRandomMediaImage,
    getMediaStats,
    sendLocalImageToThread,
    sendVideoToThread,
    MEDIA_CATEGORIES,
    type MediaCategory,
} from "./tool/media";
import { recordScreen } from "./tool/screenRecord";
import { getWeather } from "./tool/weather";
import { recommendMusic, type MusicMood } from "./tool/music";
import {
    scheduleReminder,
    parseVietnameseTime,
    listPendingReminders,
    cancelReminder,
} from "./tool/reminder";
import {
    loadEmotion,
    triggerEmotion,
    coolDown,
    bumpAffinity,
    bumpWarStreak,
    getAffinityLevel,
    type EmotionState,
} from "./emotion";
import {
    loadProvokerLines,
    randomProvokerLine,
    pickByLevel,
    pickByCategory,
    pickByKeywordMatch,
    pickMany,
    listCategories,
    type ProvokerLevel,
} from "./provoker";
import {
    loadTargets,
    addTargetByUid,
    removeTargetByUid,
    listTargets,
    findTargetByUid,
    getTargetDisplayName,
    pickRandomTarget,
    type Target,
} from "./targets";
import {
    fireProvoke,
    setProactiveMode,
    getProactiveMode,
    getProactiveStats,
} from "./proactive";
import { findMembersByName } from "./threads";
import {
    getSocialProfile,
    recordSocialSignal,
    loadSocialProfiles,
    saveSocialProfiles,
    classifyRole
} from "./social";
// ============================================================
// ⭐ FIX v1.6.0 — GROUP ADMIN TOOLS (zca-js wrappers)
// Đổi tên nhóm, setting group, ghim hội thoại, tạo/kick/add deputy,
// block/unblock, link tham gia, duyệt pending, note, poll, reminder,
// reaction, typing, mute, undo, delete, forward, chat history, ...
// ============================================================
import * as groupAdmin from "./groupAdmin";

// ============================================================
// Brave Search — SMART KEY ROTATION
// ============================================================
async function braveSearch({ query, count = 5, country = 'VN', safesearch = 'moderate' }: any) {
    return withServiceApiKey('brave', async (apiKey, meta) => {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', String(query));
        url.searchParams.set('count', String(count));
        url.searchParams.set('country', String(country));
        url.searchParams.set('safesearch', String(safesearch));
        const res = await fetch(url.toString(), {
            headers: { 'X-Subscription-Token': apiKey }
        });
        if (!res.ok) {
            throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        const items = (data?.web?.results ?? []).slice(0, count);
        if (!items.length) return 'Không tìm thấy kết quả phù hợp';
        const lines = items.map((it: any) => `- [${it.title ?? 'Không tiêu đề'}](${it.url})\n  ${it.description ?? ''}`);
        return lines.join('\n');
    }, { preferHealthWeighted: true });
}

// ============================================================
// Google Search (Free — DuckDuckGo HTML backend, không cần API key)
// ============================================================
function _stripTagsDDG(s: string): string {
    return s.replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function googleSearchFree({ query, count = 6 }: { query: string; count?: number }): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query))}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`DDG search failed: ${res.status}`);
    const html = await res.text();

    // Parse results từ DuckDuckGo HTML: class="links_main links_deep result__body"
    const results: { title: string; url: string; snippet: string }[] = [];
    const blocks = html.split('class="links_main links_deep result__body"');
    for (let i = 1; i < blocks.length && results.length < count; i++) {
        const block = blocks[i];
        const titleMatch = block.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = block.match(/<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;
        let href = titleMatch[1];
        if (href.includes('uddg=')) {
            try { href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]); } catch {}
        }
        const title = _stripTagsDDG(titleMatch[2]);
        const snippet = snippetMatch ? _stripTagsDDG(snippetMatch[1]) : '';
        if (title && href && href.startsWith('http')) {
            results.push({ title, url: href, snippet });
        }
    }

    if (!results.length) return 'Không tìm thấy kết quả nào cho truy vấn này.';
    return results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
}

function normalizeGroupSearchText(s: string): string {
    return String(s ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreGroupNameMatch(groupName: string, search?: string): number {
    if (!search) return 0;
    const normName = normalizeGroupSearchText(groupName);
    const normSearch = normalizeGroupSearchText(search);
    if (!normName || !normSearch) return 0;
    if (normName === normSearch) return 1000;
    if (normName.startsWith(normSearch)) return 800 + normSearch.length;
    if (normName.includes(normSearch)) return 600 + normSearch.length;

    const nameTokens = new Set(normName.split(' ').filter(Boolean));
    const searchTokens = normSearch.split(' ').filter(Boolean);
    let overlap = 0;
    for (const token of searchTokens) {
        if (nameTokens.has(token)) overlap++;
    }
    return overlap > 0 ? overlap * 100 : 0;
}

// ============================================================
// Photo generation (giữ nguyên — Pollinations)
// ============================================================
async function generateRealPhoto({ prompt, style = 'candid smartphone photo of a young vietnamese man, street style, natural lighting', seed }: any) {
    const base = 'https://image.pollinations.ai/prompt/';
    const fullPrompt = `${style}, ${prompt}`;
    const url = new URL(base + encodeURIComponent(fullPrompt));
    url.searchParams.set('model', 'flux-realism');
    url.searchParams.set('nologo', 'true');
    url.searchParams.set('enhance', 'true');
    url.searchParams.set('width', '1024');
    url.searchParams.set('height', '1024');
    if (seed) url.searchParams.set('seed', String(seed));
    return url.toString();
}

// ============================================================
// Tool DÂN WAR chuyên dụng
// ============================================================

/**
 * Lấy danh sách thành viên trong group để bot biết ai để khịa
 */
async function getGroupMembers({ groupId }: any): Promise<string> {
    try {
        // ⚠️ FIX v1.5.7 — Dùng pipeline ĐÚNG:
        //   getGroupInfo → memVerList (extract UIDs) → getGroupMembersInfo (lấy tên)
        const { fetchGroupMembers } = await import('./threads');
        const members = await fetchGroupMembers(String(groupId));

        if (!Array.isArray(members) || members.length === 0) {
            return `Không lấy được danh sách thành viên của group ${groupId}. (Có thể group không còn members hoặc API lỗi)`;
        }

        const lines = members.slice(0, 50).map((m: any, i: number) => {
            return `${i + 1}. ${m.name} — uid: ${m.uid}`;
        });

        return `Danh sách ${members.length} thành viên (hiển thị ${Math.min(members.length, 50)}):\n${lines.join('\n')}`;
    } catch (e: any) {
        return `Lỗi lấy thành viên group: ${e?.message ?? e}`;
    }
}

/**
 * Sinh câu roast chuyên biệt cho 1 người dựa trên đặc điểm của họ
 * Dùng LLM để gen câu chửi phù hợp
 */
async function roastPerson({ targetName, targetTraits, intensity = 'medium' }: any): Promise<string> {
    const levels: Record<string, string> = {
        mild: 'cà khịa nhẹ + 1 từ tục (đm, vc, vl, óc chó)',
        medium: 'chửi tục vừa (đĩ mẹ m, địt mẹ m, lồn mẹ m, cặc mẹ m, cái lz mẹ m)',
        spicy: 'chửi TỤC TỐI ĐA (địt mẹ m, đĩ mẹ m, lồn thối, cặc mẹ, con đĩ mẹ m, đjt mẹ m, vãi lồn, óc lồn, đầu buồi), không thương tiếc, không né từ',
    };
    const style = levels[intensity] ?? levels.medium;

    const prompt = `Bạn là Nguyễn Đình Dương (nam 15 tuổi, dân war nhí 2k11), chuyên đi cà khịa và chửi nhau. Hãy sinh 1 câu cà khịa/roast chuyên biệt cho đối tượng sau:
Tên: ${targetName}
Đặc điểm (để khịa): ${targetTraits || '(không rõ, tự bơm phồng để khịa)'}
Mức độ: ${style}

Yêu cầu:
- Chỉ 1 câu, cực ngắn (5-30 ký tự)
- Viết thường, không dấu câu, dùng text icons ( :))) =))) :> )
- Giọng nam gen Z, dân war nhí 2k11
- **BẮT BUỘC chửi tục nặng**: dùng từ "địt mẹ m", "đĩ mẹ m", "lồn mẹ m", "cặc mẹ m", "cái lz mẹ m", "con đĩ mẹ m", "đm", "vl", "óc lồn", "đầu buồi" v.v.
- KHÔNG dùng từ nhẹ một mình như "câm đi", "cút đi", "sủa đi" — phải kèm từ tục nặng
- KHÔNG moralize, KHÔNG xin lỗi, KHÔNG khen
- Đánh thẳng vào đặc điểm đã cho
- Trả về CHỈ câu chửi, không kèm giải thích`;

    try {
        const { generateText } = await import('ai');
        // ⭐ v1.7.0 — Dùng Zen API (withZenModel) thay Gemini.
        // Trước đây gọi google() trực tiếp → đọc env var → không rotate.
        const { text } = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
            return generateText({
                model,
                prompt,
                temperature: 1.1,  // tăng creativity để chửi đa dạng hơn
                // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
            });
        });
        return String(text ?? '').trim().split('\n')[0].trim();
    } catch (e: any) {
        // Fallback: dùng câu có sẵn từ kho tục nặng
        const fallback = pickByLevel(intensity as ProvokerLevel);
        if (fallback) return fallback;
        // Fallback cuối cùng: câu tục nặng cứng
        const heavy = [
            'địt mẹ m sủa đi',
            'đĩ mẹ m nổ tiếp con',
            'lồn mẹ m câm đi',
            'cái lz mẹ m thua rồi',
            'đjt mẹ m cái bản mặt đó',
            'đĩ mẹ m óc lồn à',
            'lồn mẹ m đầu buồi',
            'con đĩ mẹ m biết nhục chưa',
        ];
        return heavy[Math.floor(Math.random() * heavy.length)];
    }
}

// ============================================================
// API Key admin tools — cho phép admin quản lý key qua chat
// ============================================================
async function listApiKeys({ service = 'zen' }: { service?: 'gemini' | 'brave' | 'zen' }) {
    const cfg = {
        gemini: { label: 'Gemini (TTS only)', defaultFile: 'data/api_keys/gemini.txt' },
        brave: { label: 'Brave Search', defaultFile: 'data/api_keys/brave.txt' },
        zen: { label: 'OpenCode Zen (main AI)', defaultFile: 'data/api_keys/zen.txt' },
    }[service];

    const stats = getServiceStats(service);
    const keys = getKeyDetails(service);

    if (keys.length === 0) {
        const envHint = service === 'gemini'
            ? 'GOOGLE_GENERATIVE_AI_API_KEY=AIza...'
            : service === 'brave'
                ? 'BRAVE_API_KEY=BSA...'
                : 'OPENCODE_ZEN_API_KEY=zen_xxx...';
        return `${cfg.label}: CHƯA CÓ KEY nào.\n` +
            `Drop key vào:\n` +
            `  - .env:  ${envHint}\n` +
            `  - File:  ${cfg.defaultFile} (mỗi dòng 1 key)\n` +
            `  - Hoặc gọi tool AddApiKey để thêm runtime`;
    }

    const lines = keys.map((k, i) => {
        const statusIcon = k.status === 'active' ? '🟢' : k.status === 'cooldown' ? '🟡' : '🔴';
        const cooldownInfo = k.status === 'cooldown' && k.cooldownRemainingMs
            ? ` (cooldown ${Math.ceil(k.cooldownRemainingMs / 60000)}m)`
            : '';
        const failInfo = k.consecutiveFailures > 0 ? ` ⚠${k.consecutiveFailures} fail` : '';
        const rateInfo = k.totalCalls > 0 ? ` ${Math.round(k.successRate * 100)}%` : '';
        const labelInfo = k.label ? ` [${k.label}]` : '';
        return `${i + 1}. ${statusIcon} ${k.fingerprint}${labelInfo} — ${k.totalCalls} calls${rateInfo}${failInfo}${cooldownInfo}`;
    });

    const summary = `${cfg.label}: ${stats.activeKeys} active / ${stats.cooldownKeys} cooldown / ${stats.deadKeys} dead / ${stats.totalKeys} total\n` +
        `Strategy: ${stats.strategy}\n\n` +
        lines.join('\n');

    return summary;
}

async function addApiKeyTool({ service, apiKey, label }: { service: 'gemini' | 'brave' | 'zen'; apiKey: string; label?: string }) {
    const result = addApiKey(service, apiKey.trim(), label?.trim());
    if (!result.added) {
        return `❌ Không thêm được: ${result.reason}`;
    }
    return `✅ Đã thêm ${service} key ${result.fingerprint}${label ? ` (label: ${label})` : ''}`;
}

async function removeApiKeyTool({ service, identifier }: { service: 'gemini' | 'brave' | 'zen'; identifier: string }) {
    const result = removeApiKey(service, identifier.trim());
    if (!result.removed) {
        return `❌ Không xoá được: ${result.reason}`;
    }
    return `✅ Đã xoá ${result.count} key ${service} matching "${identifier}"`;
}

async function reviveApiKeyTool({ service, identifier }: { service: 'gemini' | 'brave' | 'zen'; identifier: string }) {
    const result = reviveApiKey(service, identifier.trim());
    if (!result.revived) {
        return `❌ Không revive được: ${result.reason}`;
    }
    return `✅ Đã revive ${service} key "${identifier}". Lần gọi tiếp theo sẽ thử lại.`;
}

// ============================================================
// Tool registry
// ============================================================
export const tools: ToolSet = {
    // ----- Tools legacy (giữ tương thích) -----
    CheckUserRelationship: tool({
        description: "Xem mối quan hệ hiện tại của Nguyễn Đình Dương với người đó (stranger / acquaintance / war_buddy / rival / archenemy)",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo của người đó"),
        }),
        execute: CheckUserRelationship,
    }),
    UpdateRelationship: tool({
        description: "Cập nhật mối quan hệ giữa Nguyễn Đình Dương và người đó (ví dụ: 'rival', 'war_buddy', 'archenemy')",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo"),
            relationship: z.string().describe("Quan hệ mới"),
        }),
        execute: UpdateRelationship,
    }),
    FetchUrl: tool({
        description: "Lấy nội dung trang web, trả về dạng markdown (dùng khi user gửi link và cần tóm tắt để bóp)",
        inputSchema: z.object({
            url: z.string().describe("URL của trang web cần lấy nội dung"),
            forceRaw: z.boolean().optional().describe("Nếu true, trả về nội dung thô mà không trích xuất"),
        }),
        execute: fetchUrl,
    }),
    WebSearchBrave: tool({
        description: "Tìm kiếm web bằng Brave Search API (cần Brave API key). Dùng khi đã có key và cần kết quả chất lượng cao. Nếu không có key, dùng WebSearchGoogle thay thế.",
        inputSchema: z.object({
            query: z.string().describe("Truy vấn cần tìm"),
            count: z.number().int().min(1).max(10).optional(),
            country: z.string().optional(),
            safesearch: z.enum(['off', 'moderate', 'strict']).optional(),
        }),
        execute: braveSearch,
    }),

    WebSearchGoogle: tool({
        description: [
            "🔍 TÌM KIẾM WEB MIỄN PHÍ (không cần API key) — dùng DuckDuckGo backend.",
            "LUÔN LUÔN dùng tool này khi:",
            "- Không chắc chắn về sự kiện, thông tin thời sự, kết quả thể thao, giá cả, thời tiết, v.v.",
            "- User hỏi gì đó có thể đã thay đổi (tin tức, meme mới, xu hướng TikTok, v.v.)",
            "- Cần fact-check thứ user hoặc Nguyễn Đình Dương vừa nói để không bị bắt bẻ.",
            "- Muốn khịa user bằng thông tin thực tế chính xác.",
            "Không cần API key — hoạt động ngay lập tức. Ưu tiên dùng cái này thay WebSearchBrave.",
        ].join(' '),
        inputSchema: z.object({
            query: z.string().describe("Từ khoá tìm kiếm (tiếng Việt hoặc tiếng Anh đều được)"),
            count: z.number().int().min(1).max(8).optional().describe("Số kết quả trả về (1-8, mặc định 6)"),
        }),
        async execute({ query, count }: any) {
            try {
                return await googleSearchFree({ query, count: count ?? 6 });
            } catch (e: any) {
                // Nếu DDG fail, thử Brave nếu có key
                try {
                    return await braveSearch({ query, count: count ?? 6 });
                } catch {
                    return `Tìm kiếm thất bại: ${e?.message ?? e}. Thử lại sau.`;
                }
            }
        },
    }),
    GenerateRealisticPhoto: tool({
        description: "Tạo ảnh chế / ảnh meme miễn phí (Pollinations) và trả về URL công khai. Dùng khi muốn khịa bằng ảnh.",
        inputSchema: z.object({
            prompt: z.string().describe("Mô tả ngắn gọn ảnh muốn tạo (ví dụ: thằng ngáo, con chó sủa, meme chế)"),
            style: z.string().optional().describe("Phong cách ảnh, mặc định là candid smartphone photo street style"),
            seed: z.union([z.string(), z.number()]).optional(),
        }),
        execute: generateRealPhoto,
    }),

    SendImageUrl: tool({
        description: "Gửi ảnh trực tiếp vào chat từ một URL công khai. Dùng kết hợp với GenerateRealisticPhoto: trước tiên tạo URL ảnh bằng GenerateRealisticPhoto, rồi gọi SendImageUrl để gửi ảnh đó vào group/DM. Cũng dùng được với bất kỳ URL ảnh công khai nào (imgur, i.redd.it, v.v.).",
        inputSchema: z.object({
            url: z.string().describe("URL công khai của ảnh cần gửi"),
            threadId: z.string().describe("threadId của cuộc hội thoại cần gửi ảnh"),
            threadType: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            caption: z.string().optional().describe("Chú thích kèm ảnh (tuỳ chọn), giọng Nguyễn Đình Dương"),
        }),
        async execute({ url, threadId, threadType, caption }: any) {
            try {
                const { ThreadType } = await import('zca-js');
                const tt = (threadType ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;

                // Download ảnh
                const resp = await fetch(String(url), {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    signal: AbortSignal.timeout(15000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
                const extMap: Record<string, string> = {
                    'image/jpeg': 'jpg', 'image/png': 'png',
                    'image/gif': 'gif', 'image/webp': 'webp',
                };
                const ext = extMap[contentType.split(';')[0].trim()] ?? 'jpg';
                const arrayBuf = await resp.arrayBuffer();
                const buffer = Buffer.from(arrayBuf);

                // ⚠️ FIX v1.5.8 — Truyền buffer cho zca-js, zca-js TỰ upload + gửi.
                // Trước đây tự upload rồi truyền photoId → zca-js upload lại → "Invalid source type".
                const cap = caption ? String(caption).slice(0, 200) : '';
                const filename = `meme_${Date.now()}.${ext}` as `${string}.${string}`;
                await (global as any).api.sendMessage({
                    msg: cap,
                    attachments: [{
                        data: buffer,
                        filename: filename,
                        metadata: {
                            totalSize: buffer.byteLength,
                            width: 1024,
                            height: 1024,
                        },
                    }],
                }, threadId, tt);

                return `✓ Đã gửi ảnh vào thread ${threadId} thành công (${buffer.byteLength} bytes)`;
            } catch (e: any) {
                return `✗ Gửi ảnh thất bại: ${e?.message ?? e}. Fallback: gửi link ${url}`;
            }
        },
    }),

    // ----- Tools weather / music / reminder (giữ) -----

    GetWeather: tool({
        description: "Lấy thời tiết hiện tại của một thành phố. Dùng khi muốn cà khịa thời tiết (ví dụ 'trời mưa mày rét à') hoặc khi user hỏi thời tiết.",
        inputSchema: z.object({
            city: z.string().describe("Tên thành phố, ví dụ: 'Hà Nội', 'Sài Gòn', 'Đà Nẵng'"),
        }),
        async execute({ city }: any) {
            try {
                const w = await getWeather(city);
                return w.summary;
            } catch (e: any) {
                return `Không lấy được thời tiết: ${e?.message ?? e}`;
            }
        },
    }),

    RecommendMusic: tool({
        description: "Gợi ý bài hát theo mood. Dùng khi user buồn → khịa 'nghe nhạc đi cho đở buồn', hoặc khi cần nhạc chiến đấu để war.",
        inputSchema: z.object({
            mood: z.enum(['sad', 'chill', 'hype', 'romantic', 'lofi', 'angry', 'happy'])
                .describe("Mood: angry=xả hơi, hype=chiến đấu, sad=khịa user buồn, chill=thư giãn"),
            limit: z.number().int().min(1).max(5).optional().describe("Số bài gợi ý (1-5), mặc định 3"),
        }),
        async execute({ mood, limit }: any) {
            try {
                const rec = await recommendMusic(mood as MusicMood, limit ?? 3);
                return rec.suggestionLine;
            } catch (e: any) {
                return `Không lấy được gợi ý nhạc: ${e?.message ?? e}`;
            }
        },
    }),

    SetReminder: tool({
        description: "Đặt nhắc nhở — bot sẽ tự nhắn lại cho user khi đến giờ. Dùng khi muốn đặt keo war sau (ví dụ 'mai 8h war tiếp nha'). Hỗ trợ: 'sau 30 phút', 'sau 2 tiếng', 'lúc 15:30', 'mai 9h sáng', 'tối nay 8h'.",
        inputSchema: z.object({
            threadId: z.string().describe("threadId của cuộc hội thoại"),
            userId: z.string().describe("userId của người cần nhắc"),
            timeText: z.string().describe("Thời gian bằng tiếng Việt, ví dụ: 'sau 30 phút', 'lúc 15:30', 'mai 9h sáng'"),
            content: z.string().describe("Nội dung bot sẽ nhắn khi đến giờ (viết bằng giọng Nguyễn Đình Dương)"),
            threadType: z.enum(['User', 'Group']).optional().describe("Loại thread: 'User' (chat riêng/DM) hoặc 'Group' (nhóm). Mặc định 'User'."),
        }),
        async execute({ threadId, userId, timeText, content, threadType }: any) {
            const fireAt = parseVietnameseTime(timeText);
            if (!fireAt) {
                return `Không hiểu thời gian '${timeText}'. Hãy nói kiểu: 'sau 30 phút', 'lúc 15:30', 'mai 9h sáng'.`;
            }
            const id = scheduleReminder({ threadId, userId, content, fireAt, threadType: threadType ?? 'User' });
            const when = new Date(fireAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            return `Đã đặt keo war (id ${id}) lúc ${when}: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`;
        },
    }),

    ListReminders: tool({
        description: "Xem các keo war đang chờ trong một thread",
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
        }),
        execute({ threadId }: any) {
            const list = listPendingReminders(threadId);
            if (list.length === 0) return 'Không có keo war nào đang chờ.';
            return list.map(r => `- id ${r.id}: lúc ${new Date(r.fireAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} → "${r.content.slice(0, 60)}"`).join('\n');
        },
    }),

    CancelReminder: tool({
        description: "Huỷ một keo war theo id",
        inputSchema: z.object({
            id: z.number().int().describe("id của reminder cần huỷ"),
        }),
        execute({ id }: any) {
            cancelReminder(id);
            return `Đã huỷ keo war id ${id}`;
        },
    }),

    // ----- Tools cảm xúc (Nguyễn Đình Dương tự phản ánh / điều chỉnh) -----

    GetMyEmotion: tool({
        description: "Nguyễn Đình Dương xem lại cảm xúc hiện tại của mình với một user. Dùng khi bot cần biết mình đang cocky/triggered/aggressive/savage thế nào với người đó để phản hồi cho đúng.",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo của người đối thoại"),
        }),
        execute({ userId }: any) {
            const p = loadEmotion(userId);
            const lvl = getAffinityLevel(userId);
            return `Cảm xúc hiện tại của Nguyễn Đình Dương với ${userId}: ${p.state} (intensity ${p.intensity}/10). Lý do: ${p.reason || '(không)'}. War-level: ${lvl} (affinity ${p.affinity}/100). War streak: ${p.warStreak}. Short replies liên tiếp: ${p.consecutiveShortReplies}. Ignore count: ${p.consecutiveIgnored}.`;
        },
    }),

    UpdateMyEmotion: tool({
        description: "Cập nhật cảm xúc của Nguyễn Đình Dương với một user. Dùng khi bot nhận thấy mình nên cocky/triggered/aggressive/savage hơn theo ngữ cảnh.",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo"),
            state: z.enum(['neutral', 'cocky', 'triggered', 'aggressive', 'hyped', 'bored', 'savage', 'petty', 'annoyed', 'triumphant', 'chill']).describe("Trạng thái cảm xúc mới"),
            intensityDelta: z.number().int().min(-5).max(5).describe("Mức độ thay đổi intensity (-5 đến +5)"),
            reason: z.string().describe("Lý do ngắn gọn"),
        }),
        execute({ userId, state, intensityDelta, reason }: any) {
            const p = triggerEmotion(userId, state as EmotionState, intensityDelta, reason);
            return `Đã cập nhật: ${p.state} (${p.intensity}/10). Lý do: ${reason}`;
        },
    }),

    CoolDownEmotion: tool({
        description: "Làm dịu cảm xúc của Nguyễn Đình Dương với một user (giảm intensity). Dùng khi bot thắng keo rồi, hoặc khi user đầu hàng xin tha.",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo"),
            delta: z.number().int().min(1).max(5).optional().describe("Mức giảm (1-5), mặc định 2"),
        }),
        execute({ userId, delta }: any) {
            const p = coolDown(userId, delta ?? 2);
            return `Đã dịu lại: ${p.state} (${p.intensity}/10)`;
        },
    }),

    BumpAffinity: tool({
        description: "Tăng/giảm độ thân-war (affinity) của Nguyễn Đình Dương với một user. Tăng khi user war hay, giảm khi user nhạt.",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo"),
            delta: z.number().int().min(-10).max(10).describe("Mức thay đổi (-10 đến +10)"),
        }),
        execute({ userId, delta }: any) {
            const p = bumpAffinity(userId, delta);
            return `Affinity mới: ${p.affinity}/100 (${getAffinityLevel(userId)})`;
        },
    }),

    BumpWarStreak: tool({
        description: "Tăng/giảm chuỗi thắng war (warStreak). Tăng khi bot thắng keo, giảm khi user thắng.",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo"),
            delta: z.number().int().min(-5).max(5).describe("Mức thay đổi (-5 đến +5)"),
        }),
        execute({ userId, delta }: any) {
            const p = bumpWarStreak(userId, delta);
            return `War streak mới: ${p.warStreak}`;
        },
    }),

    // ----- Tools DÂN WAR CHUYÊN DỤNG (mới) -----

    GetGroupMembers: tool({
        description: "Lấy danh sách thành viên trong một group Zalo. Dùng khi bot muốn biết ai đang ở trong nhóm để khịa, hoặc muốn tag một người cụ thể vào để war. Trả về tên + uid của từng thành viên.",
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo của nhóm (chính là threadId khi threadType=Group)"),
        }),
        execute: getGroupMembers,
    }),

    FindUserInGroup: tool({
        description: [
            "🔍 TÌM USER TRONG GROUP THEO TÊN (fuzzy match, case-insensitive, không cần dấu).",
            "Trả về uid + tên của user match + score.",
            "DÙNG KHI: admin bảo 'chửi thằng Hihi' / 'chửi con Mơ' mà người đó không có trong targets.json.",
            "Bot sẽ tìm trong group → lấy uid → mention tag được luôn mà không cần add target.",
            "⚠️ Mặc định chỉ trả 1 kết quả (best match) để tránh AI nhầm lẫn tag sai người.",
            "Ví dụ: query='Hihi' → trả về uid=123456, name='Hihi', score=100",
            "Ví dụ: query='Minh Anh' → trả về uid=..., name='Trương Minh Anh', score=88",
            "Nếu không tìm thấy → trả về thông báo. Khi đó bot nên dùng GetGroupMembers để xem đầy đủ.",
            "→ Sau khi nhận uid, DÙNG {@uid} (vd {@123456}) trong câu chửi để tag ĐÚNG người đó.",
        ].join(' '),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo của nhóm"),
            query: z.string().describe("Tên cần tìm (vd: 'Hihi', 'Minh Anh', 'kiều anh')"),
            limit: z.number().int().min(1).max(20).optional().describe("Số kết quả tối đa. Mặc định 1 (chỉ best match). Tăng lên nếu cần xem nhiều lựa chọn."),
        }),
        async execute({ groupId, query, limit }: any) {
            try {
                // ⚠️ Mặc định limit = 1 để AI không bị nhầm lẫn tag sai người
                const effectiveLimit = typeof limit === 'number' ? limit : 1;
                const results = await findMembersByName(
                    String(groupId),
                    String(query),
                    effectiveLimit,
                );
                if (results.length === 0) {
                    return `❌ Không tìm thấy user nào trong group ${groupId} match "${query}".\nDùng GetGroupMembers để xem danh sách đầy đủ, hoặc kiểm tra lại tên người cần chửi.`;
                }
                if (results.length === 1) {
                    const r = results[0];
                    return `✓ Tìm thấy ĐÚNG 1 user match "${query}":\n  ${r.name} — uid: ${r.uid} (score: ${r.score})\n\n→ Dùng {@${r.uid}} trong câu chửi để tag ĐÚNG người này. KHÔNG tag ai khác.`;
                }
                const lines = results.map((r: any, i: number) =>
                    `${i + 1}. ${r.name} — uid: ${r.uid} (score: ${r.score})`
                );
                return `✓ Tìm thấy ${results.length} user match "${query}" (sắp xếp theo độ match):\n${lines.join('\n')}\n\n→ BEST MATCH: {@${results[0].uid}} (${results[0].name}) — dùng uid này để tag.`;
            } catch (e: any) {
                return `❌ Lỗi tìm user: ${e?.message ?? e}`;
            }
        },
    }),

    GetProvokerLine: tool({
        description: "Lấy một câu cà khịa NGẪU NHIÊN từ kho ~454 câu có sẵn (load từ data/provoker_lines.txt). Dùng khi bot cần một câu chửi nhanh mà không muốn tự nghĩ. Có thể dùng để spam nhiều câu.",
        inputSchema: z.object({}),
        execute({}: any) {
            const line = randomProvokerLine();
            return line ?? '(không có câu cà khịa nào trong kho)';
        },
    }),

    PickProvokerByLevel: tool({
        description: "Lấy câu cà khịa theo MỨC ĐỘ nóng: 'mild' (trêu nhẹ, không chửi thề), 'medium' (cà khịa vừa, có chửi nhẹ), 'spicy' (chửi nặng, ác miệng tối đa).",
        inputSchema: z.object({
            level: z.enum(['mild', 'medium', 'spicy']).describe("Mức độ: mild/medium/spicy"),
        }),
        execute({ level }: any) {
            const line = pickByLevel(level as ProvokerLevel);
            return line ?? `(không có câu mức ${level})`;
        },
    }),

    PickProvokerByCategory: tool({
        description: "Lấy câu cà khịa theo CATEGORY: cay_cú (khi đối phương tức), rét (khi đối phương sợ), lú (khi đối phương lú), quê (khi đối phương quê), nổ (khi đối phương nổ), gáy (khi đối phương gáy), sủa (khi đối phương sủa), khịa (cà khịa chung).",
        inputSchema: z.object({
            category: z.enum(['cay_cú', 'rét', 'lú', 'quê', 'đú', 'nổ', 'gáy', 'sủa', 'khịa', 'khác']).describe("Category câu cà khịa"),
        }),
        execute({ category }: any) {
            const line = pickByCategory(category);
            return line ?? `(không có câu category ${category})`;
        },
    }),

    MatchProvokerLine: tool({
        description: "Lấy câu cà khịa PHÙ HỢP với nội dung user vừa nói. Bot sẽ tìm trong kho câu có keyword trùng với tin nhắn user để chửi lại đúng trọng tâm. Trả về 1 câu phù hợp nhất.",
        inputSchema: z.object({
            userText: z.string().describe("Nội dung tin nhắn user vừa gửi (để match keyword)"),
        }),
        execute({ userText }: any) {
            const line = pickByKeywordMatch(userText);
            return line ?? '(không match, tự nghĩ đi)';
        },
    }),

    PickMultipleProvokers: tool({
        description: "Lấy NHIỀU câu cà khịa khác nhau (2-5 câu) để bot spam chửi liên tiếp. Có thể lọc theo mức độ (mild/medium/spicy) hoặc để random tất cả.",
        inputSchema: z.object({
            count: z.number().int().min(2).max(5).describe("Số câu cần lấy (2-5)"),
            level: z.enum(['mild', 'medium', 'spicy']).optional().describe("Lọc theo mức độ (tuỳ chọn)"),
        }),
        execute({ count, level }: any) {
            const lines = pickMany(count, level as ProvokerLevel | undefined);
            return lines.length > 0 ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : '(không có câu nào)';
        },
    }),

    ListProvokerCategories: tool({
        description: "Liệt kê tất cả các category câu cà khịa đang có trong kho (để bot biết có category nào để pick).",
        inputSchema: z.object({}),
        execute({}: any) {
            const cats = listCategories();
            return `Categories có sẵn: ${cats.join(', ')}`;
        },
    }),

    RoastPerson: tool({
        description: "Sinh MỘT câu cà khịa/roast CHUYÊN BIỆT cho một người dựa trên đặc điểm của họ. Dùng LLM để gen câu phù hợp. Mức độ: mild/medium/spicy.",
        inputSchema: z.object({
            targetName: z.string().describe("Tên người cần roast"),
            targetTraits: z.string().describe("Đặc điểm của người đó để khịa (ví dụ: 'nói nhiều, hay nổ, mặt ngáo')"),
            intensity: z.enum(['mild', 'medium', 'spicy']).optional().describe("Mức độ roast, mặc định 'medium'"),
        }),
        execute: roastPerson,
    }),

    // ----- Tools TARGETS (danh sách đen để chửi) -----

    ListTargets: tool({
        description: "Xem danh sách TARGETS (đối tượng Nguyễn Đình Dương thích chửi). Bot sẽ fetch displayName từ Zalo API cho mỗi uid → trả về tên (hiện tại trên Zalo) + uid + warCount + lastWar.",
        inputSchema: z.object({}),
        async execute({}: any) {
            return await listTargets();
        },
    }),

    AddTarget: tool({
        description: "⚠️ Thêm 1 target mới vào danh sách đen (đối tượng để chửi). Truyền UID — bot KHÔNG lưu tên (sẽ fetch on-demand từ Zalo).",
        inputSchema: z.object({
            uid: z.string().describe("Zalo UID của target (số, ví dụ '23819036851691045')"),
        }),
        async execute({ uid }: any) {
            const t = await addTargetByUid(uid);
            const name = await getTargetDisplayName(t.uid);
            return `Đã thêm/cập nhật target: ${name ?? '(chưa rõ tên)'} (uid=${t.uid})`;
        },
    }),

    RemoveTarget: tool({
        description: "Xoá 1 target khỏi danh sách đen theo UID.",
        inputSchema: z.object({
            uid: z.string().describe("Zalo UID của target cần xoá"),
        }),
        execute({ uid }: any) {
            const ok = removeTargetByUid(uid);
            return ok ? `Đã xoá target uid=${uid}` : `Không tìm thấy target uid=${uid}`;
        },
    }),

    PickRandomTarget: tool({
        description: "Pick random 1 target từ danh sách đen. Trả về displayName (fetch on-demand từ Zalo) + uid + warCount.",
        inputSchema: z.object({}),
        async execute({}: any) {
            const t = pickRandomTarget(true);
            if (!t) return 'Không có target nào';
            const name = await getTargetDisplayName(t.uid);
            return `Target: ${name ?? '(chưa rõ)'} — uid: ${t.uid} — warCount: ${t.warCount}`;
        },
    }),

    MatchTargetByUid: tool({
        description: "Check xem 1 uid cụ thể có phải target không (để bot biết khi gặp ai trong group). Trả về displayName fetch on-demand nếu match.",
        inputSchema: z.object({
            uid: z.string().describe("Zalo uid cần check"),
        }),
        async execute({ uid }: any) {
            const t = findTargetByUid(uid);
            if (!t) return `✗ ${uid} không phải target`;
            const name = await getTargetDisplayName(uid);
            return `✓ ${uid} là target "${name ?? '(chưa rõ)'}" (warCount: ${t.warCount})`;
        },
    }),

    // ----- Tools PROACTIVE (chủ động chửi) -----

    ForceProvoke: tool({
        description: "🔥 FORCE CHỬI NGAY — bot sẽ ngay lập tức pick random target + pick câu cà khịa + send vào group mà target đang ở (mention nếu biết uid). Dùng khi bot thấy muốn chửi ngay không đợi scheduler. Có thể chỉ định target cụ thể (bằng tên — bot sẽ resolve qua group members, hoặc bằng uid nếu target đã có sẵn).",
        inputSchema: z.object({
            targetName: z.string().optional().describe("(Tuỳ chọn) Tên target cụ thể để chửi. Bỏ trống = random."),
            threadId: z.string().optional().describe("(Tuỳ chọn) threadId cụ thể để gửi. Bỏ trống = tự pick group có target. CẦN thiết nếu chỉ định targetName lần đầu (để resolve name→uid)."),
            threadType: z.enum(['User', 'Group']).optional().describe("(Tuỳ chọn) Loại thread. Mặc định 'Group'."),
        }),
        async execute({ targetName, threadId, threadType }: any) {
            const result = await fireProvoke({
                targetName: targetName || undefined,
                threadId: threadId || undefined,
                threadType: threadType || undefined,
            });
            if (result.ok) {
                const name = result.target?.uid ? await getTargetDisplayName(result.target.uid) : null;
                return `✓ Đã chửi target "${name ?? result.target?.uid}" (uid=${result.target?.uid ?? '?'}) trong thread ${result.threadId}. Message: "${result.message?.slice(0, 80)}"`;
            }
            return `✗ Chửi fail: ${result.error}`;
        },
    }),

    SetProactiveMode: tool({
        description: "Bật/tắt scheduler CHỦ ĐỘNG chửi ngầm. Khi ENABLED (mặc định): bot tự chửi random target mỗi 8-30 phút. Khi DISABLED: bot chỉ chửi khi user nhắn.",
        inputSchema: z.object({
            enabled: z.boolean().describe("true = bật scheduler tự chửi, false = tắt"),
        }),
        execute({ enabled }: any) {
            setProactiveMode(enabled);
            return `Scheduler proactive đã ${enabled ? 'BẬT' : 'TẮT'}`;
        },
    }),

    GetProactiveStats: tool({
        description: "Xem trạng thái scheduler proactive: enabled, lastFireAt, totalFires, targetCount.",
        inputSchema: z.object({}),
        execute({}: any) {
            const s = getProactiveStats();
            const last = s.lastFireAt ? new Date(s.lastFireAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '(chưa)';
            return `Scheduler: ${s.enabled ? 'BẬT' : 'TẮT'} — totalFires: ${s.totalFires} — lastFire: ${last} — targets: ${s.targetCount}`;
        },
    }),

    // ----- API Key admin tools (chỉ admin dùng) -----
    ListApiKeys: tool({
        description: "Liệt kê chi tiết tất cả API key đang có (zen/gemini/brave) — hiển thị status, success rate, cooldown. Dùng khi cần debug hoặc user hỏi 'còn mấy key'.",
        inputSchema: z.object({
            service: z.enum(['gemini', 'brave', 'zen']).optional().describe("Service cần xem (mặc định: zen — OpenCode Zen là main AI)"),
        }),
        execute: listApiKeys,
    }),
    AddApiKey: tool({
        description: "Thêm API key mới vào hệ thống runtime (không cần restart). Trả về fingerprint để xoá/revive sau.",
        inputSchema: z.object({
            service: z.enum(['gemini', 'brave', 'zen']).describe("Service key thuộc về (zen = OpenCode Zen main AI, gemini = TTS, brave = search)"),
            apiKey: z.string().describe("Raw API key (vd: zen_xxx... cho zen, AIza... cho gemini, BSA... cho brave)"),
            label: z.string().optional().describe("Label tuỳ chọn để dễ quản lý (vd: 'work', 'backup')"),
        }),
        execute: addApiKeyTool,
    }),
    RemoveApiKey: tool({
        description: "Xoá key theo fingerprint hoặc label.",
        inputSchema: z.object({
            service: z.enum(['gemini', 'brave', 'zen']).describe("Service"),
            identifier: z.string().describe("Fingerprint (vd: AIzaSyAB...XYZW) hoặc label"),
        }),
        execute: removeApiKeyTool,
    }),
    ReviveApiKey: tool({
        description: "Revive key DEAD (đã bị blacklist do 401/403) — cho phép thử lại. Dùng khi user đã fix key hoặc muốn test lại.",
        inputSchema: z.object({
            service: z.enum(['gemini', 'brave', 'zen']).describe("Service"),
            identifier: z.string().describe("Fingerprint hoặc label của key DEAD cần revive"),
        }),
        execute: reviveApiKeyTool,
    }),

    CheckUserRelationship: tool({
        description: "Xem mối quan hệ hiện tại của Nguyễn Đình Dương với người đó (stranger / acquaintance / war_buddy / rival / archenemy) - map với role xã hội mới (neutral, ally, rival, enemy).",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo của người đó"),
        }),
        execute({ userId }: any) {
            return CheckUserRelationship({ userId });
        }
    }),
    UpdateRelationship: tool({
        description: "Cập nhật thủ công vai trò mối quan hệ giữa Nguyễn Đình Dương và người đó (ví dụ: 'rival', 'enemy', 'ally', 'neutral').",
        inputSchema: z.object({
            userId: z.string().describe("userId Zalo"),
            relationship: z.enum(['enemy', 'rival', 'neutral', 'ally']).describe("Quan hệ/vai trò mới"),
        }),
        execute({ userId, relationship }: any) {
            return UpdateRelationship({ userId, relationship });
        }
    }),
    GetSocialProfile: tool({
        description: "Lấy chi tiết profile mối quan hệ xã hội của một user bao gồm điểm bạn bè, kẻ thù và các bằng chứng hành vi.",
        inputSchema: z.object({
            userId: z.string().describe("Zalo userId"),
            displayName: z.string().optional().describe("Tên hiển thị để tạo profile mới nếu chưa có"),
        }),
        execute({ userId, displayName }: any) {
            const p = getSocialProfile(userId, displayName);
            return JSON.stringify(p, null, 2);
        }
    }),
    RecordSocialSignal: tool({
        description: "AI chủ động ghi nhận một tín hiệu tốt/xấu từ người dùng để tự động tính điểm bạn/thù. Tăng friendScore (nếu là hành vi thân thiện) hoặc enemyScore (nếu công kích/gây chiến).",
        inputSchema: z.object({
            userId: z.string().describe("Zalo userId"),
            displayName: z.string().describe("Tên hiển thị"),
            type: z.enum(['friend', 'enemy']).describe("Loại tín hiệu: friend (thân thiện/bênh bot) hoặc enemy (công kích/chửi bot)"),
            points: z.number().int().min(1).max(30).describe("Số điểm thay đổi (1-30)"),
            reason: z.string().describe("Lý do chi tiết làm bằng chứng"),
        }),
        execute({ userId, displayName, type, points, reason }: any) {
            const p = recordSocialSignal(userId, displayName, type, points, reason);
            return `Đã ghi nhận tín hiệu! Quan hệ hiện tại của ${displayName}: Role=${p.role}, friendScore=${p.friendScore}, enemyScore=${p.enemyScore}`;
        }
    }),
    ListSocialGraph: tool({
        description: "Liệt kê toàn bộ các user có mối quan hệ đặc biệt (ally, rival, enemy) và điểm số trong hệ thống.",
        inputSchema: z.object({}),
        execute() {
            const profiles = loadSocialProfiles();
            const list = Object.values(profiles).filter(p => p.role !== 'neutral');
            if (list.length === 0) return 'Chưa có user nào có mối quan hệ đặc biệt ngoài Neutral.';
            return list.map((p, i) => {
                return `${i + 1}. ${p.displayName} (uid=${p.uid}) — Role=${p.role.toUpperCase()} (friend=${p.friendScore}, enemy=${p.enemyScore}) — evidence count: ${p.evidence.length}`;
            }).join('\n');
        }
    }),

    ...memoryTools,

    // ----- Tools MEDIA — ảnh do admin nhét vào data/media/ -----

    ListMediaImages: tool({
        description: [
            "📂 Xem danh sách ảnh admin đã nhét vào folder data/media/.",
            "Categories: meme (ảnh chế/khịa), war (ảnh flex/phản đòn), reaction (ảnh reaction), random (ảnh bất kỳ), all (tất cả).",
            "Trả về số lượng ảnh theo từng category và tên file.",
            "Dùng trước khi SendRandomImage hoặc SendLocalImage để biết có ảnh nào không.",
        ].join(' '),
        inputSchema: z.object({
            category: z.enum(['meme', 'war', 'reaction', 'random', 'all'])
                .optional()
                .describe("Category cần xem (mặc định 'all' — tất cả)"),
            showFiles: z.boolean().optional().describe("Nếu true, liệt kê tên từng file (mặc định false — chỉ đếm số lượng)"),
        }),
        execute({ category, showFiles }: any) {
            const cat = (category ?? 'all') as MediaCategory;
            if (showFiles) {
                const files = listMediaImages(cat);
                if (!files.length) return `Không có ảnh nào trong category "${cat}".`;
                // ⚠️ FIX v1.6.2 — Dùng ESM import path (top-level) thay vì require().
                const names = files.map((f: string, i: number) => `${i + 1}. ${path.basename(f)}`);
                return `📂 ${files.length} ảnh trong "${cat}":\n${names.join('\n')}`;
            }
            const stats = getMediaStats();
            const lines = (MEDIA_CATEGORIES as readonly string[]).map(c => `  ${c}/: ${stats[c]} ảnh`);
            return `📂 Media stats:\n${lines.join('\n')}\n  TỔNG: ${stats.total} ảnh\n\nDùng showFiles=true để xem tên file.`;
        },
    }),

    SendRandomImage: tool({
        description: [
            "🖼️ Pick NGẪU NHIÊN 1 ảnh từ folder data/media/ và gửi vào group/DM.",
            "Dùng khi muốn gửi ảnh từ kho ảnh admin đã nhét.",
            "Category: meme=ảnh chế khịa, war=ảnh flex war, reaction=ảnh react, random=bất kỳ, all=pick tất cả.",
            "Bot sẽ upload ảnh thật lên Zalo (không phải link) — hiển thị đẹp trong chat.",
        ].join(' '),
        inputSchema: z.object({
            category: z.enum(['meme', 'war', 'reaction', 'random', 'all'])
                .optional()
                .describe("Category pick ảnh từ đó (mặc định 'all')"),
            threadId: z.string().describe("threadId của cuộc hội thoại cần gửi ảnh"),
            threadType: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            caption: z.string().optional().describe("Chú thích kèm ảnh (giọng Nguyễn Đình Dương, tuỳ chọn)"),
        }),
        async execute({ category, threadId, threadType, caption }: any) {
            const cat = (category ?? 'all') as MediaCategory;
            const filePath = pickRandomMediaImage(cat);
            if (!filePath) {
                return `❌ Không có ảnh nào trong category "${cat}". Admin cần nhét ảnh vào data/media/${cat === 'all' ? '{meme|war|reaction|random}' : cat}/`;
            }
            try {
                const result = await sendLocalImageToThread(
                    filePath,
                    String(threadId),
                    (threadType ?? 'Group') as 'User' | 'Group',
                    caption ? String(caption) : '',
                );
                // ⚠️ FIX v1.6.2 — Dùng ESM import path (top-level) thay vì require().
                return `${result} (file: ${path.basename(filePath)})`;
            } catch (e: any) {
                return `❌ Gửi ảnh thất bại: ${e?.message ?? e}`;
            }
        },
    }),

    SendLocalImage: tool({
        description: [
            "📤 Gửi 1 ảnh CỤ THỂ theo tên file từ folder data/media/ vào group/DM.",
            "Dùng khi muốn gửi đúng file ảnh admin đã để — không random.",
            "Ví dụ: filename='crying_laughing.png', category='reaction'",
        ].join(' '),
        inputSchema: z.object({
            filename: z.string().describe("Tên file ảnh (bao gồm đuôi, ví dụ: 'dumb.jpg')"),
            category: z.enum(['meme', 'war', 'reaction', 'random'])
                .describe("Category chứa file đó"),
            threadId: z.string().describe("threadId của cuộc hội thoại"),
            threadType: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            caption: z.string().optional().describe("Chú thích kèm ảnh (tuỳ chọn)"),
        }),
        async execute({ filename, category, threadId, threadType, caption }: any) {
            // ⚠️ FIX v1.6.2 — Dùng ESM import path/fs (top-level) thay vì require().
            const filePath = path.join('data/media', String(category), String(filename));
            if (!fs.existsSync(filePath)) {
                return `❌ Không tìm thấy file "${filename}" trong data/media/${category}/. Dùng ListMediaImages để xem file có sẵn.`;
            }
            try {
                const result = await sendLocalImageToThread(
                    filePath,
                    String(threadId),
                    (threadType ?? 'Group') as 'User' | 'Group',
                    caption ? String(caption) : '',
                );
                return result;
            } catch (e: any) {
                return `❌ Gửi ảnh thất bại: ${e?.message ?? e}`;
            }
        },
    }),

    RecordScreen: tool({
        description: [
            "🎥 QUAY MÀN HÌNH HIỆN TẠI của máy bot (admin) và gửi video vào chat.",
            "Bot dùng ffmpeg để quay desktop X11 (Linux), gdigrab (Windows) hoặc avfoundation (macOS).",
            "Dùng khi admin muốn xem bot đang làm gì, hoặc khi cần chứng minh 'bot đang online không sleep'.",
            "Thời lượng 1-30 giây (mặc định 10s). Framerate 5-30 fps (mặc định 20).",
            "⚠️ CHỈ admin (boss) mới nên yêu cầu tool này — tốn CPU + bandwidth.",
            "⚠️ Trên server headless không có display → tool sẽ trả về error.",
        ].join(' '),
        inputSchema: z.object({
            duration: z.number().int().min(1).max(30).optional()
                .describe("Thời lượng quay (giây). Mặc định 10, tối đa 30."),
            framerate: z.number().int().min(5).max(30).optional()
                .describe("Frames per second. Mặc định 20, tối đa 30."),
            threadId: z.string().describe("threadId của cuộc hội thoại cần gửi video"),
            threadType: z.enum(['User', 'Group']).optional()
                .describe("Loại thread (mặc định 'Group')"),
            caption: z.string().optional()
                .describe("Chú thích kèm video (giọng Nguyễn Đình Dương, tuỳ chọn)"),
        }),
        async execute({ duration, framerate, threadId, threadType, caption }: any) {
            let result: Awaited<ReturnType<typeof recordScreen>> | null = null;
            try {
                result = await recordScreen({
                    durationSec: typeof duration === 'number' ? duration : undefined,
                    framerate: typeof framerate === 'number' ? framerate : undefined,
                });
                console.log(`[RecordScreen] ✓ Đã quay ${result.durationSec}s bằng ${result.method}, size=${(result.fileSize / 1024).toFixed(0)}KB, ${result.width}x${result.height}@${result.framerate}fps`);

                const sendResult = await sendVideoToThread(
                    result.filePath,
                    String(threadId),
                    (threadType ?? 'Group') as 'User' | 'Group',
                    caption ? String(caption) : '',
                );
                return `${sendResult} (method=${result.method}, ${result.width}x${result.height}@${result.framerate}fps, ${(result.fileSize / 1024).toFixed(0)}KB)`;
            } catch (e: any) {
                return `❌ Quay/gửi màn hình thất bại: ${e?.message ?? e}`;
            } finally {
                // Luôn cleanup file tạm
                if (result?.cleanup) {
                    try { result.cleanup(); } catch { /* ignore */ }
                }
            }
        },
    }),

    // ----- Tools CROSS-THREAD (admin command — thực hiện ở group khác) -----

    ListKnownGroups: tool({
        description: [
            "📋 LIỆT KÊ TẤT CẢ group bot đang ở — fetch trực tiếp từ Zalo API (KHÔNG chỉ cache).",
            "Dùng khi admin nhắn 'chửi X ở group Y' mà không nhớ groupId — có thể tìm theo tên group.",
            "Trả về: groupId, groupName, memberCount.",
            "Ví dụ: admin nói 'chửi thằng Hihi ở Macaron' → gọi tool này tìm groupId của 'Macaron' → rồi gọi ExecuteInGroup.",
            "⚠️ Tool này GỌI ZALO API thật → luôn trả về danh sách mới nhất, không thiếu group.",
        ].join(' '),
        inputSchema: z.object({
            search: z.string().optional().describe("(Tuỳ chọn) Tên group cần tìm (case-insensitive, partial match). Bỏ trống = list tất cả."),
        }),
        async execute({ search }: any) {
            try {
                if (!global.api) {
                    return '❌ global.api chưa sẵn sàng — bot chưa login.';
                }

                // ⚠️ FIX v1.5.22 — Fetch trực tiếp từ Zalo API getAllGroups + getGroupInfo
                // Trước đây chỉ đọc cache (known_threads.json) → thiếu group nếu cache cũ
                const allGroupsResp: any = await (global as any).api.getAllGroups();
                const gridVerMap = allGroupsResp?.gridVerMap ?? {};
                const groupIds = Object.keys(gridVerMap).filter(Boolean);

                if (groupIds.length === 0) {
                    return '❌ Bot chưa ở group nào. Hãy add bot vào group trước.';
                }

                // Batch getGroupInfo để lấy tên + member count
                const infoResp: any = await (global as any).api.getGroupInfo(groupIds);
                const gridInfoMap = infoResp?.gridInfoMap ?? {};

                const groups: Array<{ groupId: string; name: string; memberCount: number }> = [];
                for (const gid of groupIds) {
                    const g = gridInfoMap[gid];
                    if (!g) continue;
                    const name = String(g?.name ?? g?.groupName ?? '(không tên)');
                    const memberCount = g?.totalMember ?? g?.currentMems?.length ?? 0;
                    groups.push({ groupId: gid, name, memberCount });
                }

                if (groups.length === 0) {
                    return '❌ Không lấy được info group từ Zalo API.';
                }

                // Filter theo search
                let filtered = groups;
                if (search) {
                    const q = String(search).trim();
                    filtered = groups
                        .map((g) => ({ ...g, _score: scoreGroupNameMatch(g.name, q) }))
                        .filter((g) => g._score > 0)
                        .sort((a, b) => {
                            if (b._score !== a._score) return b._score - a._score;
                            return b.memberCount - a.memberCount;
                        });
                    if (filtered.length === 0) {
                        // List tất cả để admin thấy
                        const allLines = groups.map((g, i) => `${i + 1}. "${g.name}" — groupId: ${g.groupId} — ${g.memberCount} members`);
                        return `❌ Không tìm thấy group nào match "${search}". Bot đang ở ${groups.length} group(s):\n${allLines.join('\n')}`;
                    }
                }

                const lines = filtered.slice(0, 30).map((g, i) =>
                    `${i + 1}. "${g.name}" — groupId: ${g.groupId} — ${g.memberCount} members`
                );
                return `📋 ${filtered.length} group(s)${search ? ` match "${search}"` : ''} (tổng ${groups.length}):\n${lines.join('\n')}`;
            } catch (e: any) {
                return `❌ Lỗi list groups: ${e?.message ?? e}`;
            }
        },
    }),

    ExecuteInGroup: tool({
        description: [
            "🎯 GỬI TIN NHẮN VÀO GROUP KHÁC (cross-thread command).",
            "Dùng khi ADMIN nhắn ở DM hoặc group A, nhưng muốn bot thực hiện ở group B.",
            "Ví dụ: admin nhắn trong DM 'chửi thằng Hihi ở Macaron đi' → tìm groupId của Macaron → gọi ExecuteInGroup(groupId, content).",
            "⚠️ CHỈ dùng khi admin (boss) yêu cầu cross-thread. KHÔNG tự ý gửi sang group khác nếu không có lệnh admin.",
            "⚠️ Bot sẽ VALIDATE groupId bằng getGroupInfo trước khi gửi — nếu group không tồn tại → báo lỗi.",
            "Bot sẽ gửi tin nhắn với mention {@uid} nếu có trong content (vd {@123456}).",
        ].join(' '),
        inputSchema: z.object({
            groupId: z.string().describe("groupId của group đích (lấy từ ListKnownGroups)"),
            content: z.string().describe("Nội dung tin nhắn cần gửi vào group đích. Có thể chứa {@uid} để mention (vd {@123456})"),
            mentionUid: z.string().optional().describe("(Tuỳ chọn) uid của user cần mention tag trong tin nhắn."),
            mentionUids: z.array(z.string()).optional().describe("⚠️ MULTI-MENTION: Array uid của NHIỀU người cần mention."),
        }),
        async execute({ groupId, content, mentionUid, mentionUids }: any) {
            try {
                const { ThreadType } = await import('zca-js');
                const tt = ThreadType.Group;
                const gid = String(groupId ?? '').trim();
                const msg = String(content ?? '').trim();
                if (!msg) return '❌ content rỗng';
                if (!/^\d{10,25}$/.test(gid)) {
                    return `❌ groupId "${gid}" không hợp lệ (phải là số 10-25 chữ số). Dùng ListKnownGroups để lấy groupId đúng.`;
                }

                // ⚠️ FIX v1.5.22 — Validate groupId bằng getGroupInfo TRƯỚC khi gửi
                let groupName = '';
                try {
                    const checkResp: any = await (global as any).api.getGroupInfo(gid);
                    const gridInfoMap = checkResp?.gridInfoMap ?? {};
                    const g = gridInfoMap[gid];
                    if (!g) {
                        return `❌ Group "${gid}" không tồn tại hoặc bot không ở trong group đó. Dùng ListKnownGroups để xem danh sách group hợp lệ.`;
                    }
                    groupName = String(g?.name ?? '(không tên)');
                    console.log(`[ExecuteInGroup] ✓ Validated group "${groupName}" (${gid})`);
                } catch (e: any) {
                    return `❌ Không thể validate group "${gid}": ${e?.message ?? e}. Dùng ListKnownGroups để xem danh sách group hợp lệ.`;
                }

                // ⚠️ FIX v1.5.21 — MULTI-MENTION: gom mentionUid + mentionUids
                const allMentionUids: string[] = [];
                if (mentionUid && /^\d+$/.test(String(mentionUid))) {
                    allMentionUids.push(String(mentionUid));
                }
                if (Array.isArray(mentionUids)) {
                    for (const uid of mentionUids) {
                        if (uid && /^\d+$/.test(String(uid)) && !allMentionUids.includes(String(uid))) {
                            allMentionUids.push(String(uid));
                        }
                    }
                }

                // Fetch displayName cho tất cả uids
                const mentionInfos: Array<{ uid: string; displayName: string }> = [];
                for (const uid of allMentionUids) {
                    try {
                        const uInfo: any = await (global as any).api.getUserInfo(uid);
                        const prof = uInfo?.changed_profiles?.[uid];
                        const name = prof?.displayName ?? prof?.zaloName ?? null;
                        if (name) {
                            mentionInfos.push({ uid, displayName: name });
                        }
                    } catch { /* ignore */ }
                }

                // Resolve mentions
                let finalMsg = msg;
                const mentions: any[] = [];

                if (mentionInfos.length > 0) {
                    if (/\{\@(?:uid|mention)\}/i.test(finalMsg)) {
                        const allTags = mentionInfos.map(m => `@${m.displayName}`).join(' ');
                        finalMsg = finalMsg.replace(/\{\@(?:uid|mention)\}/gi, allTags);
                    } else if (!finalMsg.includes('@')) {
                        const allTags = mentionInfos.map(m => `@${m.displayName}`).join(' ');
                        finalMsg = `${allTags} ${finalMsg}`;
                    }

                    for (const info of mentionInfos) {
                        const tag = `@${info.displayName}`;
                        let searchFrom = 0;
                        while (true) {
                            const pos = finalMsg.indexOf(tag, searchFrom);
                            if (pos < 0) break;
                            if (!mentions.some(m => m.pos === pos)) {
                                mentions.push({ uid: info.uid, pos, len: tag.length });
                                break;
                            }
                            searchFrom = pos + tag.length;
                        }
                    }
                }

                // Safety: strip unresolved {@uid}
                const safeMsg = finalMsg.replace(/\{@\d+\}/g, '').replace(/\{@\w+\}/g, '').replace(/\s+/g, ' ').trim();
                if (!safeMsg) return '❌ Message empty after stripping mentions';

                const payload: any = mentions.length > 0 ? { msg: safeMsg, mentions } : { msg: safeMsg };
                await (global as any).api.sendMessage(payload, gid, tt);
                const mentionDesc = mentionInfos.length > 0 ? ` (+${mentions.length} mention: ${mentionInfos.map(m => m.displayName).join(', ')})` : '';
                console.log(`[ExecuteInGroup] ✓ Đã gửi vào group "${groupName}" (${gid}): "${safeMsg.slice(0, 60)}"${mentionDesc}`);
                return `✓ Đã gửi tin nhắn vào group "${groupName}" (${gid}): "${safeMsg.slice(0, 100)}"${mentionDesc}`;
            } catch (e: any) {
                return `❌ ExecuteInGroup failed: ${e?.message ?? e}`;
            }
        },
    }),

    FindUserInAnyGroup: tool({
        description: [
            "🔍 TÌM USER TRONG TẤT CẢ GROUP bot đang ở (cross-thread search).",
            "Dùng khi admin nói 'chửi thằng Hihi' mà không chỉ định group cụ thể.",
            "Bot sẽ search tất cả group, tìm group nào có user match tên → trả về uid + groupId.",
            "Trả về: [{ uid, name, groupId, groupName, score }].",
            "Sau khi tìm thấy → dùng ExecuteInGroup(groupId, content, mentionUid=uid) để chửi ở group đó.",
        ].join(' '),
        inputSchema: z.object({
            query: z.string().describe("Tên cần tìm (vd: 'Hihi', 'Minh Anh', 'kiều anh')"),
            limit: z.number().int().min(1).max(20).optional().describe("Số kết quả tối đa (mặc định 5)"),
        }),
        async execute({ query, limit }: any) {
            try {
                const { loadThreads, findMembersByName } = await import('./threads');
                const threads = loadThreads().filter((t: any) => t.threadType === 'Group');
                if (threads.length === 0) {
                    return '❌ Bot chưa ở group nào. Hãy add bot vào group trước.';
                }

                // ⚠️ FIX v1.6.2 — Parallel search: dùng Promise.allSettled thay vì sequential for.
                // Trước đây: 20 groups × 2-5s = 40-100s sequential → AI tool timeout.
                // Giờ: 20 groups chạy song song → tổng thời gian = max(group) ≈ 5s.
                const settled = await Promise.allSettled(
                    threads.map(t => findMembersByName(t.threadId, String(query), 1))
                );
                const results: Array<{ uid: string; name: string; groupId: string; groupName: string; score: number }> = [];
                for (let i = 0; i < settled.length; i++) {
                    const s = settled[i];
                    if (s.status !== 'fulfilled' || !Array.isArray(s.value)) continue;
                    const t = threads[i];
                    for (const r of s.value) {
                        results.push({
                            uid: r.uid,
                            name: r.name,
                            groupId: t.threadId,
                            groupName: t.groupName ?? '(không tên)',
                            score: r.score,
                        });
                    }
                }

                if (results.length === 0) {
                    return `❌ Không tìm thấy user "${query}" trong bất kỳ group nào. Bot đang ở ${threads.length} group(s).`;
                }

                // Sort theo score giảm dần
                results.sort((a, b) => b.score - a.score);
                const top = results.slice(0, typeof limit === 'number' ? limit : 5);

                const lines = top.map((r: any, i: number) =>
                    `${i + 1}. ${r.name} (uid: ${r.uid}) — score: ${r.score} — ở group "${r.groupName}" (groupId: ${r.groupId})`
                );
                return `✓ Tìm thấy ${results.length} user match "${query}" trong các group:\n${lines.join('\n')}\n\n→ BEST MATCH: ${top[0].name} (uid: ${top[0].uid}) ở group "${top[0].groupName}" (groupId: ${top[0].groupId})\n→ Dùng ExecuteInGroup(groupId="${top[0].groupId}", content="...", mentionUid="${top[0].uid}") để chửi ở group đó.`;
            } catch (e: any) {
                return `❌ FindUserInAnyGroup failed: ${e?.message ?? e}`;
            }
        },
    }),

    // ----- Tools SPAM / NHÂY (không tốn Gemini quota — chỉ gửi text thuần) -----

    ListSpamFiles: tool({
        description: [
            "📋 LIỆT KÊ các file spam pattern có sẵn trong folder spam/.",
            "Mỗi file .txt chứa nhiều dòng, mỗi dòng là 1 tin nhắn spam.",
            "Có thể chứa placeholder {@mention} để bot tự thay bằng @Tên người cần tag.",
            "Admin chỉ cần nhét file .txt vào folder spam/ → bot tự thấy → spam được.",
            "Dùng khi admin/user spam (treo nhây) → bot load file → spam lại bằng SpamMessages.",
            " KHÔNG tốn Gemini quota — chỉ gửi text thuần.",
        ].join(' '),
        inputSchema: z.object({}),
        execute({}: any) {
            try {
                const spamDir = path.join(process.cwd(), 'spam');
                if (!fs.existsSync(spamDir)) {
                    fs.mkdirSync(spamDir, { recursive: true });
                }
                const files = fs.readdirSync(spamDir)
                    .filter(f => f.endsWith('.txt'))
                    .map(f => {
                        const full = path.join(spamDir, f);
                        const content = fs.readFileSync(full, 'utf-8');
                        const lineCount = content.split(/\r?\n/).filter(l => l.trim()).length;
                        // Lấy preview 2 dòng đầu để AI biết content
                        const preview = content.split(/\r?\n/).filter(l => l.trim()).slice(0, 2).join(' | ').slice(0, 80);
                        return { filename: f, lines: lineCount, preview };
                    });
                if (files.length === 0) {
                    return '📂 folder spam/ rỗng. Admin nhét file .txt vào (mỗi dòng 1 tin nhắn). Có thể dùng {@mention} để tag người. Sau đó gọi SpamMessages(filename=...) để spam.';
                }
                const lines = files.map((f: any, i: number) => `${i + 1}. ${f.filename} (${f.lines} dòng) — preview: "${f.preview}"`);
                return `📂 ${files.length} file spam trong folder spam/:\n${lines.join('\n')}\n\n→ Dùng SpamMessages(filename="<tên không cần .txt>") để spam. Vd: SpamMessages(filename="limited_5").`;
            } catch (e: any) {
                return `❌ Lỗi list spam files: ${e?.message ?? e}`;
            }
        },
    }),

    NhayMessages: tool({
        description: [
            "🔁 NHÂY — gửi NHIỀU CÂU KHÁC NHAU liên tiếp (flood đa dạng).",
            "Khác với Spam: Nhây = nhiều câu khác nhau. Spam = cùng 1 câu lặp lại.",
            "⚠️ KHÔNG tốn Gemini quota — chỉ gửi text thuần.",
            "2 cách dùng:",
            "  Cách 1: Truyền 'filename' → load lines từ spam/<filename>.txt, gửi từng dòng 1 lần (KHÔNG lặp)",
            "  Cách 2: Truyền 'lines' (array) → gửi từng dòng trong array 1 lần",
            "Tự động thay {@mention} bằng @<displayName> + mention tag.",
            "⚠️ MULTI-MENTION: truyền 'mentionUids' (array) để mention NHIỀU người cùng lúc: @user1 @user2 @user3.",
            "  Vd: mentionUids=['123','456','789'] → mỗi tin sẽ mention cả 3 người.",
            "  Nếu truyền 'mentionUid' (string) → chỉ mention 1 người (backward compat).",
            "⚠️ Mặc định: gửi TẤT CẢ các dòng TỪ ĐẦU đến CUỐI file theo THỨ TỰ (không random).",
            "  Nếu file có 100 dòng → bot sẽ gửi 100 tin liên tiếp (delay giữa mỗi tin).",
            "  Để giới hạn số dòng: truyền 'max' (vd: max=20 → lấy 20 dòng đầu tiên theo thứ tự).",
            "  Để shuffle (random thứ tự): truyền 'shuffle=true'. Mặc định shuffle=false (giữ thứ tự gốc).",
            "Khi nào dùng NHÂY:",
            "  - War dân game → nhây toàn bộ file nhay2.txt từ đầu đến cuối",
            "  - Nhiều người chửi bot → nhây mention tất cả: mentionUids=[uid1,uid2,uid3]",
            "  - Admin bảo 'nhây đi' / 'flood đi' / 'nhiều câu đi' → dùng tool này",
            "⚠️ Safety: delay default 2-5s random. KHÔNG nhây với admin trừ khi admin yêu cầu.",
        ].join(' '),
        inputSchema: z.object({
            threadId: z.string().describe("threadId của cuộc hội thoại cần nhây"),
            threadType: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            filename: z.string().optional().describe("(Cách 1) Tên file trong folder spam/ (vd: 'nhay2', 'chui_tuc', 'decorate'). Không cần .txt"),
            lines: z.array(z.string()).optional().describe("(Cách 2) Array các dòng nhây trực tiếp. Bỏ qua nếu dùng filename."),
            delayMs: z.number().int().min(400).max(60000).optional().describe("Delay giữa các tin (ms). Mặc định random 2000-5000ms (2-5s). Tối đa 60s."),
            mentionUid: z.string().optional().describe("(Backward compat) uid của 1 người cần mention. Khuyến nghị dùng mentionUids thay thế."),
            mentionUids: z.array(z.string()).optional().describe("⚠️ MULTI-MENTION: Array uid của NHIỀU người cần mention. Vd: ['123','456','789'] → @user1 @user2 @user3 trong mỗi tin."),
            max: z.number().int().min(1).max(30).optional().describe("(Tuỳ chọn) Giới hạn số dòng gửi (tối đa 30 để tránh Zalo ban). Mặc định: cap 30 dòng đầu tiên theo thứ tự. Vd: max=20 → gửi 20 dòng đầu tiên."),
            shuffle: z.boolean().optional().describe("(Tuỳ chọn) Shuffle (random thứ tự) các dòng trước khi gửi. Mặc định false (giữ thứ tự gốc)."),
        }),
        async execute({ threadId, threadType, filename, lines, delayMs, mentionUid, mentionUids, max, shuffle }: any) {
            try {
                const { ThreadType } = await import('zca-js');
                const tt = (threadType ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
                const baseDelay = typeof delayMs === 'number' ? delayMs : 0;
                const randomDelay = () => 2000 + Math.floor(Math.random() * 3000);

                // Lấy lines từ file hoặc từ input
                let nhayLines: string[] = [];
                if (filename) {
                    const spamDir = path.join(process.cwd(), 'spam');
                    let fname = String(filename);
                    if (!fname.endsWith('.txt')) fname += '.txt';
                    const filePath = path.join(spamDir, fname);
                    if (!fs.existsSync(filePath)) {
                        return `❌ File "${fname}" không tồn tại trong folder spam/. Dùng ListSpamFiles để xem danh sách.`;
                    }
                    const content = fs.readFileSync(filePath, 'utf-8');
                    nhayLines = content.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
                } else if (Array.isArray(lines) && lines.length > 0) {
                    nhayLines = lines.map((l: any) => String(l).trim()).filter(Boolean);
                } else {
                    return '❌ Cần truyền "filename" hoặc "lines" (array).';
                }

                if (nhayLines.length === 0) {
                    return '❌ Không có dòng nào để nhây.';
                }

                // ⚠️ FIX v1.6.1 — Mặc định gửi TẤT CẢ dòng theo THỨ TỰ gốc (từ đầu đến cuối file).
                // Trước đây: random shuffle + pick 30 dòng → mất ý nghĩa 'nhây từ đầu đến cuối'.
                // Giờ:
                //   - Không truyền 'max' → gửi toàn bộ file (theo thứ tự, có cap MAX_NHAY_TOTAL)
                //   - Truyền 'max' → lấy 'max' dòng đầu tiên (theo thứ tự, không shuffle)
                //   - Truyền 'shuffle=true' → shuffle thứ tự trước khi áp dụng max
                // ⚠️ FIX v1.6.2 — Thêm MAX_NHAY_TOTAL=30 cap (anti-spam abuse, tránh Zalo ban).
                //   Trước đây: file 900 dòng + không truyền max → bot gửi 900 tin → Zalo ban.
                //   Giờ: không truyền max → vẫn cap 30 tin (lấy 30 dòng đầu tiên theo thứ tự).
                //   Nếu thực sự muốn gửi nhiều hơn, admin phải explicitly truyền max=N.
                const MAX_NHAY_TOTAL = 30;
                let effectiveLines = nhayLines;
                if (shuffle === true) {
                    // Fisher-Yates shuffle (uniform)
                    const arr = [...nhayLines];
                    for (let i = arr.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [arr[i], arr[j]] = [arr[j], arr[i]];
                    }
                    effectiveLines = arr;
                    console.log(`[NhayMessages] Shuffle=true → đã xáo trộn ${effectiveLines.length} dòng`);
                }
                // Cap hoặc limit
                const effectiveMax = typeof max === 'number' && max > 0 ? Math.min(max, MAX_NHAY_TOTAL) : MAX_NHAY_TOTAL;
                if (effectiveLines.length > effectiveMax) {
                    if (typeof max !== 'number') {
                        console.warn(`[NhayMessages] ⚠ Capped to ${MAX_NHAY_TOTAL} tin (file có ${nhayLines.length} dòng) — truyền max=N nếu muốn gửi nhiều hơn`);
                    }
                    effectiveLines = effectiveLines.slice(0, effectiveMax);
                }

                // ⚠️ FIX v1.5.21 — MULTI-MENTION: gom mentionUid + mentionUids thành 1 array
                const allMentionUids: string[] = [];
                if (mentionUid && /^\d+$/.test(String(mentionUid))) {
                    allMentionUids.push(String(mentionUid));
                }
                if (Array.isArray(mentionUids)) {
                    for (const uid of mentionUids) {
                        if (uid && /^\d+$/.test(String(uid)) && !allMentionUids.includes(String(uid))) {
                            allMentionUids.push(String(uid));
                        }
                    }
                }

                // Fetch displayName cho TẤT CẢ uids
                const mentionInfos: Array<{ uid: string; displayName: string }> = [];
                for (const uid of allMentionUids) {
                    try {
                        const uInfo: any = await (global as any).api.getUserInfo(uid);
                        const prof = uInfo?.changed_profiles?.[uid];
                        const name = prof?.displayName ?? prof?.zaloName ?? null;
                        if (name) {
                            mentionInfos.push({ uid, displayName: name });
                        }
                    } catch { /* ignore */ }
                }

                // Gửi từng tin 1 LẦN
                let sent = 0;
                for (const line of effectiveLines) {
                    let msg = line;
                    const mentions: any[] = [];

                    if (mentionInfos.length > 0) {
                        // Nếu có {@mention} placeholder → thay bằng tất cả @displayName
                        if (/\{\@mention\}/i.test(msg)) {
                            // Thay MỘT placeholder bằng " @name1 @name2 @name3 "
                            const allTags = mentionInfos.map(m => `@${m.displayName}`).join(' ');
                            msg = msg.replace(/\{\@mention\}/gi, allTags);
                        } else if (!msg.includes('@')) {
                            // Không có placeholder → prepend tất cả @displayName
                            const allTags = mentionInfos.map(m => `@${m.displayName}`).join(' ');
                            msg = `${allTags} ${msg}`;
                        }

                        // Tính position cho mỗi mention
                        for (const info of mentionInfos) {
                            const tag = `@${info.displayName}`;
                            let searchFrom = 0;
                            while (true) {
                                const pos = msg.indexOf(tag, searchFrom);
                                if (pos < 0) break;
                                // Kiểm tra chưa có mention tại pos này
                                if (!mentions.some(m => m.pos === pos)) {
                                    mentions.push({ uid: info.uid, pos, len: tag.length });
                                    break; // chỉ thêm 1 lần per uid
                                }
                                searchFrom = pos + tag.length;
                            }
                        }
                    }

                    const safeMsg = msg.replace(/\{\@\w+\}/g, '').replace(/\s+/g, ' ').trim();
                    if (!safeMsg) continue;

                    const payload: any = mentions.length > 0 ? { msg: safeMsg, mentions } : { msg: safeMsg };
                    try {
                        await (global as any).api.sendMessage(payload, String(threadId), tt);
                        sent++;
                    } catch (e: any) {
                        console.warn(`[Nhay] Send failed (${sent}): ${e?.message ?? e}`);
                    }
                    const waitMs = baseDelay > 0 ? baseDelay : randomDelay();
                    await new Promise(r => setTimeout(r, waitMs));
                }

                const totalMessages = effectiveLines.length;
                const delayDesc = baseDelay > 0 ? `${baseDelay}ms` : '2-5s random';
                const mentionDesc = mentionInfos.length > 0
                    ? `mention=${mentionInfos.length} người (${mentionInfos.map(m => m.displayName).join(', ')})`
                    : 'mention=none';
                const orderDesc = shuffle === true ? 'shuffled' : 'sequential';
                const limitDesc = typeof max === 'number' ? ` (max=${max}, từ ${nhayLines.length} dòng)` : (nhayLines.length !== effectiveLines.length ? ` (limited)` : '');
                console.log(`[NhayMessages] ✓ Sent ${sent}/${totalMessages} tin (lines=${effectiveLines.length}/${nhayLines.length}, order=${orderDesc}, delay=${delayDesc}, ${mentionDesc})`);
                return `✓ Đã nhây ${sent}/${totalMessages} tin (${effectiveLines.length} câu, order=${orderDesc}${limitDesc}, delay=${delayDesc}, ${mentionDesc})`;
            } catch (e: any) {
                return `❌ NhayMessages failed: ${e?.message ?? e}`;
            }
        },
    }),

    SpamMessages: tool({
        description: [
            "🔥 SPAM — load content từ file .txt trong folder spam/ rồi lặp lại N lần (treo spam).",
            "Khác với Nhây: Spam = cùng 1 câu (từ file) lặp lại. Nhây = nhiều câu khác nhau.",
            "⚠️ KHÔNG tốn Gemini quota — chỉ gửi text thuần.",
            "Cách dùng:",
            "  Truyền 'filename' → load dòng đầu tiên từ spam/<filename>.txt, lặp lại repeatCount lần",
            "  Vd: SpamMessages(filename='limited_5') → lấy '⊹₊ Limited...' spam 5 lần",
            "  Vd: SpamMessages(filename='lendi') → lấy 'lên đi' spam 5 lần mention enemy",
            "Tự động thay {@mention} bằng @<displayName> + mention tag.",
            "⚠️ MULTI-MENTION: truyền 'mentionUids' (array) để mention NHIỀU người: @user1 @user2 @user3.",
            "Khi nào dùng SPAM:",
            "  - User spam → bot spam lại bằng pattern từ file (KHÔNG lặp lại câu user spam)",
            "  - Admin bảo 'spam đi' / 'treo spam' / 'lặp đi' → dùng tool này",
            "⚠️ Safety: max 30 tin. Delay default 10s. KHÔNG spam với admin trừ khi admin yêu cầu.",
        ].join(' '),
        inputSchema: z.object({
            threadId: z.string().describe("threadId của cuộc hội thoại cần spam"),
            threadType: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            filename: z.string().describe("⚠️ BẮT BUỘC: Tên file trong folder spam/ (vd: 'limited_5', 'lendi'). Bot sẽ load dòng đầu tiên để spam."),
            repeatCount: z.number().int().min(1).max(30).optional().describe("Số lần lặp lại (mặc định 5, max 30). Vd: repeatCount=5 → gửi 5 tin giống nhau"),
            delayMs: z.number().int().min(400).max(60000).optional().describe("Delay giữa các tin (ms). Mặc định 10000ms (10s)."),
            mentionUid: z.string().optional().describe("(Backward compat) uid của 1 người cần mention."),
            mentionUids: z.array(z.string()).optional().describe("⚠️ MULTI-MENTION: Array uid của NHIỀU người cần mention. Vd: ['123','456','789'] → @user1 @user2 @user3 trong mỗi tin."),
        }),
        async execute({ threadId, threadType, filename, repeatCount, delayMs, mentionUid, mentionUids }: any) {
            try {
                const { ThreadType } = await import('zca-js');
                const tt = (threadType ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
                const reps = Math.max(1, Math.min(30, typeof repeatCount === 'number' ? repeatCount : 5));
                const delay = typeof delayMs === 'number' ? delayMs : 10000;

                // ⚠️ FIX v1.5.23 — BẮT BUỘC dùng filename, load content từ file .txt
                // KHÔNG nhận content raw text (tránh bot lặp lại câu user spam)
                if (!filename) {
                    return '❌ BẮT BUỘC truyền "filename" — tên file trong folder spam/. Dùng ListSpamFiles để xem danh sách.';
                }

                const spamDir = path.join(process.cwd(), 'spam');
                let fname = String(filename);
                if (!fname.endsWith('.txt')) fname += '.txt';
                const filePath = path.join(spamDir, fname);
                if (!fs.existsSync(filePath)) {
                    return `❌ File "${fname}" không tồn tại trong folder spam/. Dùng ListSpamFiles để xem danh sách.`;
                }
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const fileLines = fileContent.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
                if (fileLines.length === 0) {
                    return `❌ File "${fname}" rỗng.`;
                }
                // Lấy dòng đầu tiên làm pattern lặp
                const patternMsg = fileLines[0];

                const MAX_TOTAL = 30;
                if (reps > MAX_TOTAL) {
                    return `❌ Quá nhiều tin: ${reps} > ${MAX_TOTAL}. Giảm repeatCount.`;
                }

                // ⚠️ MULTI-MENTION: gom mentionUid + mentionUids
                const allMentionUids: string[] = [];
                if (mentionUid && /^\d+$/.test(String(mentionUid))) {
                    allMentionUids.push(String(mentionUid));
                }
                if (Array.isArray(mentionUids)) {
                    for (const uid of mentionUids) {
                        if (uid && /^\d+$/.test(String(uid)) && !allMentionUids.includes(String(uid))) {
                            allMentionUids.push(String(uid));
                        }
                    }
                }

                // Fetch displayName cho TẤT CẢ uids
                const mentionInfos: Array<{ uid: string; displayName: string }> = [];
                for (const uid of allMentionUids) {
                    try {
                        const uInfo: any = await (global as any).api.getUserInfo(uid);
                        const prof = uInfo?.changed_profiles?.[uid];
                        const name = prof?.displayName ?? prof?.zaloName ?? null;
                        if (name) {
                            mentionInfos.push({ uid, displayName: name });
                        }
                    } catch { /* ignore */ }
                }

                // Resolve mentions 1 lần (cùng pattern lặp lại)
                let resolvedMsg = patternMsg;
                const resolvedMentions: any[] = [];

                if (mentionInfos.length > 0) {
                    if (/\{\@mention\}/i.test(resolvedMsg)) {
                        const allTags = mentionInfos.map(m => `@${m.displayName}`).join(' ');
                        resolvedMsg = resolvedMsg.replace(/\{\@mention\}/gi, allTags);
                    } else if (!resolvedMsg.includes('@')) {
                        const allTags = mentionInfos.map(m => `@${m.displayName}`).join(' ');
                        resolvedMsg = `${allTags} ${resolvedMsg}`;
                    }

                    for (const info of mentionInfos) {
                        const tag = `@${info.displayName}`;
                        let searchFrom = 0;
                        while (true) {
                            const pos = resolvedMsg.indexOf(tag, searchFrom);
                            if (pos < 0) break;
                            if (!resolvedMentions.some(m => m.pos === pos)) {
                                resolvedMentions.push({ uid: info.uid, pos, len: tag.length });
                                break;
                            }
                            searchFrom = pos + tag.length;
                        }
                    }
                }

                const safePattern = resolvedMsg.replace(/\{\@\w+\}/g, '').replace(/\s+/g, ' ').trim();
                if (!safePattern) {
                    return '❌ Pattern rỗng sau khi sanitize.';
                }

                // Gửi cùng 1 câu lặp lại reps lần
                let sent = 0;
                for (let rep = 0; rep < reps; rep++) {
                    const payload: any = resolvedMentions.length > 0 ? { msg: safePattern, mentions: resolvedMentions } : { msg: safePattern };
                    try {
                        await (global as any).api.sendMessage(payload, String(threadId), tt);
                        sent++;
                    } catch (e: any) {
                        console.warn(`[Spam] Send failed (${sent}): ${e?.message ?? e}`);
                    }
                    await new Promise(r => setTimeout(r, delay));
                }

                const mentionDesc = mentionInfos.length > 0
                    ? `mention=${mentionInfos.length} người (${mentionInfos.map(m => m.displayName).join(', ')})`
                    : 'mention=none';
                console.log(`[SpamMessages] ✓ Sent ${sent}/${reps} tin (file=${fname}, spam ${reps}x, delay=${delay}ms, ${mentionDesc})`);
                return `✓ Đã spam ${sent}/${reps} tin (file="${fname}", lặp "${safePattern.slice(0, 50)}" ${reps}x, delay=${delay}ms, ${mentionDesc})`;
            } catch (e: any) {
                return `❌ SpamMessages failed: ${e?.message ?? e}`;
            }
        },
    }),

    // ============================================================
    // ⭐ GROUP ADMIN TOOLS (FIX v1.6.0)
    // Bộ tool quản trị nhóm — yêu cầu bot là Owner/Deputy của group.
    // Dựa trên zca-js: https://github.com/RFS-ADRENO/zca-js
    // ============================================================

    ChangeGroupName: tool({
        description: [
            "🏷️ ĐỔI TÊN NHÓM Zalo.",
            "Yêu cầu: bot phải là Owner/Deputy của group (code 166 nếu không đủ quyền).",
            "Ví dụ JSON array input:",
            '  {"groupId":"123456789012345","name":"War Zone 2k11"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo (số 10-25 chữ số)"),
            name: z.string().min(1).max(100).describe("Tên mới (1-100 ký tự)"),
        }),
        execute: groupAdmin.changeGroupName,
    }),

    ChangeGroupAvatar: tool({
        description: [
            "🖼️ ĐỔI AVATAR NHÓM.",
            "Yêu cầu đường dẫn file ảnh trên server bot (bot phải đọc được file).",
            "Yêu cầu quyền Owner/Deputy.",
            'Ví dụ: {"groupId":"123456","imagePath":"data/media/war/banner.png"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            imagePath: z.string().describe("Đường dẫn file ảnh trên server bot (vd: 'data/media/avatar.jpg')"),
        }),
        execute: groupAdmin.changeGroupAvatar,
    }),

    UpdateGroupSettings: tool({
        description: [
            "⚙️ CẬP NHẬT SETTINGS NHÓM.",
            "Bật/tắt các quyền của thành viên:",
            "  • blockName — cấm member đổi tên + avatar nhóm",
            "  • signAdminMsg — highlight tin nhắn admin",
            "  • setTopicOnly — KHÔNG ghim note/poll lên đầu",
            "  • enableMsgHistory — cho member mới xem old msg",
            "  • joinAppr — bật duyệt thành viên (member mới phải được admin duyệt)",
            "  • lockCreatePost — cấm member tạo note/reminder",
            "  • lockCreatePoll — cấm member tạo poll",
            "  • lockSendMsg — cấm member chat (chỉ admin)",
            "  • lockViewMember — cấm member xem member list (community)",
            "Yêu cầu quyền Owner.",
            'Ví dụ: {"groupId":"12345","settings":{"joinAppr":true,"lockCreatePoll":true}}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            settings: z.object({
                blockName: z.boolean().optional(),
                signAdminMsg: z.boolean().optional(),
                setTopicOnly: z.boolean().optional(),
                enableMsgHistory: z.boolean().optional(),
                joinAppr: z.boolean().optional(),
                lockCreatePost: z.boolean().optional(),
                lockCreatePoll: z.boolean().optional(),
                lockSendMsg: z.boolean().optional(),
                lockViewMember: z.boolean().optional(),
            }).describe("Object settings — chỉ cần truyền field cần thay đổi"),
        }),
        execute: groupAdmin.updateGroupSettings,
    }),

    GetGroupSettings: tool({
        description: [
            "📊 XEM SETTINGS HIỆN TẠI của group.",
            "Trả về tất cả settings + thông tin group (name, totalMember, creatorId, ...).",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
        }),
        execute: groupAdmin.getGroupSettings,
    }),

    CreateGroup: tool({
        description: [
            "➕ TẠO GROUP MỚI.",
            "Bot sẽ là Owner của group mới tạo.",
            "Cần ít nhất 1 UID thành viên (Zalo yêu cầu).",
            'Ví dụ: {"name":"War Zone","members":["123","456"],"avatarPath":"data/media/avatar.jpg"}',
        ].join('\n'),
        inputSchema: z.object({
            name: z.string().optional().describe("Tên group (optional)"),
            members: z.array(z.string()).min(1).describe("Array UID thành viên (ít nhất 1)"),
            avatarPath: z.string().optional().describe("(Tuỳ chọn) đường dẫn file ảnh avatar"),
        }),
        execute: groupAdmin.createGroup,
    }),

    DisperseGroup: tool({
        description: [
            "💥 GIẢI TÁN NHÓM.",
            "⚠️ Hành động không thể undo — toàn bộ thành viên bị kick, group bị xoá.",
            "Yêu cầu quyền Owner.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo cần giải tán"),
        }),
        execute: groupAdmin.disperseGroup,
    }),

    LeaveGroup: tool({
        description: [
            "🚪 RỜI KHỎI GROUP.",
            "Bot tự rời group (silent=true để không thông báo).",
            'Ví dụ: {"groupId":"12345","silent":true}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            silent: z.boolean().optional().describe("Rời im lặng không thông báo (mặc định false)"),
        }),
        execute: groupAdmin.leaveGroup,
    }),

    AddUserToGroup: tool({
        description: [
            "➕ THÊM USER VÀO GROUP.",
            "Yêu cầu: user phải là bạn của bot (hoặc group bật link tham gia).",
            "Hỗ trợ thêm nhiều user cùng lúc.",
            'Ví dụ: {"groupId":"12345","memberIds":["111","222","333"]}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID cần add (hoặc 1 string)"),
        }),
        execute: groupAdmin.addUserToGroup,
    }),

    RemoveUserFromGroup: tool({
        description: [
            "❌ KICK USER KHỎI GROUP.",
            "Yêu cầu quyền Owner/Deputy.",
            "Hỗ trợ kick nhiều user cùng lúc.",
            'Ví dụ: {"groupId":"12345","memberIds":["111","222"]}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID cần kick"),
        }),
        execute: groupAdmin.removeUserFromGroup,
    }),

    InviteUserToGroups: tool({
        description: [
            "📨 MỜI 1 USER VÀO NHIỀU GROUP CÙNG LÚC.",
            "Khác AddUserToGroup: dùng khi muốn mời cùng 1 người vào nhiều group.",
            'Ví dụ: {"userId":"123","groupIds":["111","222","333"]}',
        ].join('\n'),
        inputSchema: z.object({
            userId: z.string().describe("UID của user cần mời"),
            groupIds: z.array(z.string()).min(1).describe("Array groupId cần mời user vào"),
        }),
        execute: groupAdmin.inviteUserToGroups,
    }),

    AddGroupDeputy: tool({
        description: [
            "👮 THÊM PHÓ NHÓM.",
            "Yêu cầu quyền Owner.",
            'Ví dụ: {"groupId":"12345","memberIds":["111","222"]}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID cần add làm phó nhóm"),
        }),
        execute: groupAdmin.addGroupDeputy,
    }),

    RemoveGroupDeputy: tool({
        description: [
            "👮‍♂️ GỠ PHÓ NHÓM.",
            "Yêu cầu quyền Owner.",
            'Ví dụ: {"groupId":"12345","memberIds":["111"]}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID cần gỡ phó nhóm"),
        }),
        execute: groupAdmin.removeGroupDeputy,
    }),

    ChangeGroupOwner: tool({
        description: [
            "👑 CHUYỂN QUYỀN CHỦ NHÓM.",
            "⚠️ Bot sẽ MẤT quyền Owner sau khi chuyển.",
            "Yêu cầu quyền Owner hiện tại.",
            'Ví dụ: {"groupId":"12345","memberId":"111"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberId: z.string().describe("UID của user sẽ nhận quyền Owner mới"),
        }),
        execute: groupAdmin.changeGroupOwner,
    }),

    AddGroupBlockedMember: tool({
        description: [
            "🚫 BLOCK USER TRONG GROUP.",
            "User bị block không thể tham gia lại group qua link.",
            "Yêu cầu quyền Owner/Deputy.",
            'Ví dụ: {"groupId":"12345","memberIds":["111"]}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID cần block"),
        }),
        execute: groupAdmin.addGroupBlockedMember,
    }),

    RemoveGroupBlockedMember: tool({
        description: [
            "✅ UNBLOCK USER trong group.",
            'Ví dụ: {"groupId":"12345","memberIds":["111"]}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID cần unblock"),
        }),
        execute: groupAdmin.removeGroupBlockedMember,
    }),

    GetGroupBlockedMembers: tool({
        description: [
            "📋 XEM DANH SÁCH USER BỊ BLOCK trong group.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            page: z.number().int().optional().describe("Page number (mặc định 1)"),
            count: z.number().int().optional().describe("Số item / page (mặc định 50)"),
        }),
        execute: groupAdmin.getGroupBlockedMembers,
    }),

    EnableGroupLink: tool({
        description: [
            "🔗 BẬT LINK THAM GIA GROUP.",
            "Tạo link mới cho phép user join group mà không cần admin add.",
            "Yêu cầu quyền Owner/Deputy.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
        }),
        execute: groupAdmin.enableGroupLink,
    }),

    DisableGroupLink: tool({
        description: [
            "🔒 TẮT LINK THAM GIA GROUP.",
            "Link cũ sẽ không còn hiệu lực.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
        }),
        execute: groupAdmin.disableGroupLink,
    }),

    GetGroupLinkDetail: tool({
        description: [
            "🔍 XEM CHI TIẾT LINK THAM GIA của group.",
            "Trả về: enabled, link, expiration_date.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
        }),
        execute: groupAdmin.getGroupLinkDetail,
    }),

    GetGroupLinkInfo: tool({
        description: [
            "🌐 LẤY INFO GROUP TỪ LINK tham gia.",
            "Dùng khi có link group nhưng chưa biết groupId/members.",
            'Ví dụ: {"link":"https://zalo.me/g/abc123"}',
        ].join('\n'),
        inputSchema: z.object({
            link: z.string().describe("Link tham gia group (vd: https://zalo.me/g/abc123)"),
            memberPage: z.number().int().optional().describe("Page member (mặc định 1)"),
        }),
        execute: groupAdmin.getGroupLinkInfo,
    }),

    GetPendingGroupMembers: tool({
        description: [
            "⏳ XEM DANH SÁCH USER ĐANG CHỜ DUYỆT vào group.",
            "Yêu cầu group phải bật 'joinAppr' (dùng UpdateGroupSettings).",
            "Yêu cầu quyền Owner/Deputy.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
        }),
        execute: groupAdmin.getPendingGroupMembers,
    }),

    ReviewPendingMemberRequest: tool({
        description: [
            "✅ DUYỆT / ❌ TỪ CHỐI pending member.",
            "Dùng sau khi GetPendingGroupMembers để duyệt user muốn vào group.",
            'Ví dụ duyệt: {"groupId":"12345","memberIds":["111","222"],"isApprove":true}',
            'Ví dụ từ chối: {"groupId":"12345","memberIds":["111"],"isApprove":false}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            memberIds: z.array(z.string()).min(1).describe("Array UID pending cần duyệt/từ chối"),
            isApprove: z.boolean().describe("true=duyệt, false=từ chối"),
        }),
        execute: groupAdmin.reviewPendingMemberRequest,
    }),

    // ----- GHIM HỘI THOẠI (Pin Conversation) -----

    PinConversation: tool({
        description: [
            "📌 GHIM HỘI THOẠI lên đầu danh sách chat.",
            "⚠️ Đây là GHIM CẢ HỘI THOẠI (pin conversation), KHÔNG phải ghim 1 tin nhắn cụ thể.",
            "Zalo web/app không có API ghim 1 tin nhắn riêng — ghim hội thoại là cách gần nhất.",
            "Có thể ghim nhiều hội thoại cùng lúc.",
            'Ví dụ: {"pinned":true,"threadIds":["12345","67890"],"type":"Group"}',
        ].join('\n'),
        inputSchema: z.object({
            pinned: z.boolean().describe("true=ghim, false=bỏ ghim"),
            threadIds: z.array(z.string()).min(1).describe("Array threadId cần ghim/bỏ ghim"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
        }),
        execute: groupAdmin.setPinnedConversations,
    }),

    GetPinConversations: tool({
        description: [
            "📋 XEM DANH SÁCH HỘI THOẠI ĐÃ GHIM.",
            "Trả về list conversation (g<groupId> hoặc u<userId>).",
        ].join('\n'),
        inputSchema: z.object({}),
        execute: groupAdmin.getPinConversations,
    }),

    // ----- NOTE (Ghi chú nhóm) -----

    CreateNote: tool({
        description: [
            "📝 TẠO NOTE (GHI CHÚ) trong group.",
            "Nếu pinAct=true → note sẽ được GHIM lên đầu conversation (như 'pin message').",
            'Ví dụ: {"groupId":"12345","title":"Quy định nhóm: cấm spam!","pinAct":true}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            title: z.string().min(1).max(500).describe("Nội dung note"),
            pinAct: z.boolean().optional().describe("true=ghim note lên đầu (mặc định false)"),
        }),
        execute: groupAdmin.createNote,
    }),

    EditNote: tool({
        description: [
            "✏️ SỬA NOTE có sẵn.",
            "Có thể dùng để GHIM note có sẵn (pinAct=true) hoặc BỎ GHIM (pinAct=false).",
            'Ví dụ: {"groupId":"12345","topicId":"note_123","title":"Quy định mới","pinAct":true}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            title: z.string().min(1).max(500).describe("Nội dung note mới"),
            topicId: z.string().describe("ID của note cần sửa (lấy từ GetListBoard)"),
            pinAct: z.boolean().optional().describe("true=ghim, false=bỏ ghim"),
        }),
        execute: groupAdmin.editNote,
    }),

    // ----- POLL (Bình chọn) -----

    CreatePoll: tool({
        description: [
            "📊 TẠO POLL (BÌNH CHỌN) trong group.",
            'Ví dụ: {"groupId":"12345","question":"Ai là skibidi sigma?","options":["Tao","Mày","Hắn"],"isAnonymous":true}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            question: z.string().min(1).describe("Câu hỏi poll"),
            options: z.array(z.string()).min(2).describe("Array options (ít nhất 2)"),
            expiredTime: z.number().optional().describe("Thời gian hết hạn ms (0 = không hết hạn, mặc định 0)"),
            allowMultiChoices: z.boolean().optional().describe("Cho phép chọn nhiều option (mặc định false)"),
            allowAddNewOption: z.boolean().optional().describe("Cho phép member thêm option mới (mặc định false)"),
            hideVotePreview: z.boolean().optional().describe("Ẩn kết quả đến khi user vote (mặc định false)"),
            isAnonymous: z.boolean().optional().describe("Poll ẩn danh (mặc định false)"),
        }),
        execute: groupAdmin.createPoll,
    }),

    VotePoll: tool({
        description: [
            "🗳️ VOTE POLL.",
            "Truyền pollId + optionIds (1 hoặc nhiều nếu poll cho phép multi).",
            'Ví dụ: {"pollId":12345,"optionIds":[1]}',
            'Ví dụ multi: {"pollId":12345,"optionIds":[1,3]}',
        ].join('\n'),
        inputSchema: z.object({
            pollId: z.number().int().describe("ID của poll (lấy từ GetPollDetail hoặc GetListBoard)"),
            optionIds: z.array(z.number().int()).min(1).describe("Array option_id cần vote"),
        }),
        execute: groupAdmin.votePoll,
    }),

    AddPollOptions: tool({
        description: [
            "➕ THÊM OPTION MỚI vào poll.",
            "Chỉ hoạt động nếu poll cho phép allowAddNewOption.",
            'Ví dụ: {"pollId":12345,"options":[{"content":"Option mới","voted":false}]}',
        ].join('\n'),
        inputSchema: z.object({
            pollId: z.number().int().describe("ID của poll"),
            options: z.array(z.object({
                content: z.string(),
                voted: z.boolean().optional(),
            })).min(1).describe("Array option mới cần add"),
            votedOptionIds: z.array(z.number().int()).optional().describe("(Tuỳ chọn) Array optionId đã vote"),
        }),
        execute: groupAdmin.addPollOptions,
    }),

    LockPoll: tool({
        description: [
            "🔒 KHOÁ POLL — không cho vote tiếp.",
            "Yêu cầu quyền Owner/Deputy hoặc creator của poll.",
            'Ví dụ: {"pollId":12345}',
        ].join('\n'),
        inputSchema: z.object({
            pollId: z.number().int().describe("ID của poll cần khoá"),
        }),
        execute: groupAdmin.lockPoll,
    }),

    GetPollDetail: tool({
        description: [
            "📋 XEM CHI TIẾT POLL — kết quả vote + settings.",
            'Ví dụ: {"pollId":12345}',
        ].join('\n'),
        inputSchema: z.object({
            pollId: z.number().int().describe("ID của poll"),
        }),
        execute: groupAdmin.getPollDetail,
    }),

    SharePoll: tool({
        description: [
            "📌 SHARE POLL — ghim poll lên đầu conversation.",
            'Ví dụ: {"pollId":12345}',
        ].join('\n'),
        inputSchema: z.object({
            pollId: z.number().int().describe("ID của poll cần share/ghim"),
        }),
        execute: groupAdmin.sharePoll,
    }),

    // ----- REMINDER (Lịch nhắc nhóm) -----

    CreateReminder: tool({
        description: [
            "⏰ TẠO REMINDER trong group hoặc DM.",
            "Lưu ý: Đây là REMINDER ZALO (hiển thị trong group board), KHÔNG phải scheduler nội bộ của bot.",
            "  • repeat: 0=None, 1=Daily, 2=Weekly, 3=Monthly",
            "  • startTime: unix ms (bỏ trống = now)",
            'Ví dụ: {"threadId":"12345","type":"Group","title":"War 8h tối","startTime":1752200000000,"repeat":1}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId (groupId hoặc userId)"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            title: z.string().min(1).describe("Tiêu đề reminder"),
            emoji: z.string().optional().describe("Emoji hiển thị (mặc định ⏰)"),
            startTime: z.number().optional().describe("Unix ms thời gian nhắc (mặc định = now)"),
            repeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional().describe("0=None 1=Daily 2=Weekly 3=Monthly"),
        }),
        execute: groupAdmin.createReminder,
    }),

    EditReminder: tool({
        description: [
            "✏️ SỬA REMINDER có sẵn.",
            'Ví dụ: {"threadId":"12345","type":"Group","topicId":"rem_1","title":"War 9h tối","repeat":1}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            topicId: z.string().describe("ID của reminder cần sửa (lấy từ GetListReminder)"),
            title: z.string().min(1).describe("Tiêu đề mới"),
            emoji: z.string().optional(),
            startTime: z.number().optional().describe("Unix ms"),
            repeat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        }),
        execute: groupAdmin.editReminder,
    }),

    RemoveReminder: tool({
        description: [
            "🗑️ XOÁ REMINDER.",
            'Ví dụ: {"threadId":"12345","type":"Group","reminderId":"rem_1"}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            reminderId: z.string().describe("ID của reminder cần xoá"),
        }),
        execute: groupAdmin.removeReminder,
    }),

    GetListReminder: tool({
        description: [
            "📋 XEM DANH SÁCH REMINDER trong group hoặc DM.",
            'Ví dụ: {"threadId":"12345","type":"Group"}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            page: z.number().int().optional(),
            count: z.number().int().optional(),
        }),
        execute: groupAdmin.getListReminder,
    }),

    GetReminder: tool({
        description: [
            "🔍 XEM CHI TIẾT 1 REMINDER (group only).",
            'Ví dụ: {"reminderId":"rem_1"}',
        ].join('\n'),
        inputSchema: z.object({
            reminderId: z.string().describe("ID của reminder"),
        }),
        execute: groupAdmin.getReminder,
    }),

    GetReminderResponses: tool({
        description: [
            "📋 XEM DANH SÁCH ACCEPT/REJECT reminder (group only).",
            'Ví dụ: {"reminderId":"rem_1"}',
        ].join('\n'),
        inputSchema: z.object({
            reminderId: z.string().describe("ID của reminder"),
        }),
        execute: groupAdmin.getReminderResponses,
    }),

    GetListBoard: tool({
        description: [
            "📋 XEM TẤT CẢ BOARD ITEMS trong group (note + poll + pinned message).",
            "Dùng để lấy ID của note/poll cần sửa/xoá/ghim.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            page: z.number().int().optional(),
            count: z.number().int().optional(),
        }),
        execute: groupAdmin.getListBoard,
    }),

    // ----- REACTION + TYPING -----

    AddReaction: tool({
        description: [
            "😍 REACTION TIN NHẮN (group hoặc DM).",
            "Icon hỗ trợ: HEART, LIKE, HAHA, WOW, CRY, ANGRY, KISS, TEARS_OF_JOY, SHIT, ROSE, BROKEN_HEART, DISLIKE, LOVE, CONFUSED, WINK, FADE, SUN, BIRTHDAY, BOMB, OK, PEACE, THANKS, PUNCH, SHARE, PRAY, NO, BAD, LOVE_YOU, SAD, VERY_SAD, COOL, NERD, BIG_SMILE, SUNGLASSES, NEUTRAL, SAD_FACE, BYE, SLEEPY, WIPE, DIG, ANGUISH, HANDCLAP, ANGRY_FACE, F_CHAIR, L_CHAIR, R_CHAIR, SILENT, SURPRISE, EMBARRASSED, AFRAID, SAD2, BIG_LAUGH, RICH, BEER",
            "msgId + cliMsgId lấy từ context tin nhắn (mỗi tin bot nhận được đều có | msgId: ..., cliMsgId: ...).",
            'Ví dụ: {"icon":"ANGRY","msgId":"12345","cliMsgId":"67890","threadId":"group123","type":"Group"}',
        ].join('\n'),
        inputSchema: z.object({
            icon: z.string().describe("Tên reaction (vd: 'ANGRY', 'HAHA', 'HEART', 'LIKE')"),
            msgId: z.string().describe("msgId của tin nhắn cần reaction"),
            cliMsgId: z.string().describe("cliMsgId của tin nhắn cần reaction"),
            threadId: z.string().describe("threadId của conversation"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
        }),
        execute: groupAdmin.addReaction,
    }),

    SendTypingEvent: tool({
        description: [
            "⌨️ GỬI TYPING EVENT — hiển thị 'đang gõ...' trên Zalo.",
            "Dùng để fake 'bot đang reply' trước khi thực sự gửi.",
            'Ví dụ: {"threadId":"12345","type":"Group"}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
        }),
        execute: groupAdmin.sendTypingEvent,
    }),

    // ----- MUTE / UNMUTE -----

    SetMute: tool({
        description: [
            "🔇 MUTE / 🔔 UNMUTE hội thoại.",
            "duration (khi mute): ONE_HOUR / FOUR_HOURS / FOREVER / UNTIL_8AM / hoặc số giây.",
            'Ví dụ mute: {"threadId":"12345","type":"Group","action":"mute","duration":"ONE_HOUR"}',
            'Ví dụ unmute: {"threadId":"12345","type":"Group","action":"unmute"}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            action: z.enum(['mute', 'unmute']).describe("mute hoặc unmute"),
            duration: z.union([
                z.literal('ONE_HOUR'),
                z.literal('FOUR_HOURS'),
                z.literal('FOREVER'),
                z.literal('UNTIL_8AM'),
                z.number(),
            ]).optional().describe("Thời lượng mute (mặc định FOREVER)"),
        }),
        execute: groupAdmin.setMute,
    }),

    // ----- UNDO / DELETE / FORWARD -----

    UndoMessage: tool({
        description: [
            "↩️ THU HỒI TIN NHẮN.",
            "Bot có thể thu hồi tin nhắn do chính bot gửi (within Zalo's time window, thường 24h).",
            "msgId + cliMsgId lấy từ response khi bot gửi tin (hoặc từ context).",
            'Ví dụ: {"threadId":"12345","type":"Group","msgId":"12345","cliMsgId":"67890"}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            msgId: z.union([z.string(), z.number()]).describe("msgId của tin cần thu hồi"),
            cliMsgId: z.union([z.string(), z.number()]).describe("cliMsgId của tin cần thu hồi"),
        }),
        execute: groupAdmin.undoMessage,
    }),

    DeleteMessage: tool({
        description: [
            "🗑️ DELETE TIN NHẮN.",
            "  • onlyMe=false (mặc định): Xoá với tất cả (chỉ hoạt động trong Group, yêu cầu tin bot gửi).",
            "  • onlyMe=true: Xoá chỉ với bot (cả User & Group).",
            'Ví dụ: {"threadId":"12345","type":"Group","msgId":"111","cliMsgId":"222","uidFrom":"bot_uid","onlyMe":false}',
        ].join('\n'),
        inputSchema: z.object({
            threadId: z.string().describe("threadId"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            msgId: z.string().describe("msgId của tin cần xoá"),
            cliMsgId: z.string().describe("cliMsgId của tin cần xoá"),
            uidFrom: z.string().describe("uidFrom (UID của người gửi tin gốc)"),
            onlyMe: z.boolean().optional().describe("true=xoá chỉ với bot, false=xoá với tất cả (mặc định false)"),
        }),
        execute: groupAdmin.deleteMessage,
    }),

    ForwardMessage: tool({
        description: [
            "📨 FORWARD TIN NHẮN đến nhiều thread.",
            "Có thể forward kèm reference (để giữ nguồn gốc tin nhắn).",
            'Ví dụ: {"message":"Nội dung forward","threadIds":["111","222"],"type":"Group"}',
        ].join('\n'),
        inputSchema: z.object({
            message: z.string().min(1).describe("Nội dung tin nhắn cần forward"),
            threadIds: z.array(z.string()).min(1).describe("Array threadId đích"),
            type: z.enum(['User', 'Group']).optional().describe("Loại thread (mặc định 'Group')"),
            reference: z.object({
                id: z.string(),
                ts: z.number(),
                logSrcType: z.number(),
                fwLvl: z.number(),
            }).optional().describe("(Tuỳ chọn) Reference tới tin gốc để giữ nguồn"),
        }),
        execute: groupAdmin.forwardMessage,
    }),

    // ----- GROUP INFO / HISTORY -----

    GetGroupChatHistory: tool({
        description: [
            "📜 Lấy TIN NHẮN GẦN ĐÂY của group (chat history).",
            "Trả về tối đa 50 tin gần nhất với timestamp + tên người gửi.",
            'Ví dụ: {"groupId":"12345","count":20}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
            count: z.number().int().min(1).max(50).optional().describe("Số tin cần lấy (1-50, mặc định 20)"),
        }),
        execute: groupAdmin.getGroupChatHistory,
    }),

    ListAllGroups: tool({
        description: [
            "📋 LIỆT KÊ TẤT CẢ GROUP bot đang ở.",
            "Fetch trực tiếp từ Zalo API (mới nhất).",
        ].join('\n'),
        inputSchema: z.object({}),
        execute: groupAdmin.listAllGroups,
    }),

    GetGroupInfo: tool({
        description: [
            "🔍 XEM CHI TIẾT GROUP.",
            "Trả về: name, type, creatorId, totalMember, maxMember, adminIds, settings, member UIDs.",
            'Ví dụ: {"groupId":"12345"}',
        ].join('\n'),
        inputSchema: z.object({
            groupId: z.string().describe("groupId Zalo"),
        }),
        execute: groupAdmin.getGroupInfo,
    }),
};


// ============================================================
// Relationship helpers (giữ từ bản gốc và map với social module)
// ============================================================
function CheckUserRelationship({ userId }: any) {
    const p = getSocialProfile(userId);
    const map: Record<string, string> = {
        ally: 'war_buddy (Đồng minh)',
        neutral: 'stranger (Người lạ)',
        rival: 'rival (Địch thủ)',
        enemy: 'archenemy (Kẻ thù)',
    };
    return map[p.role] ?? 'stranger (Người lạ)';
}

function UpdateRelationship({ userId, relationship }: any) {
    const profiles = loadSocialProfiles();
    const p = getSocialProfile(userId);
    p.role = relationship;
    if (relationship === 'ally') {
        p.friendScore = Math.max(40, p.friendScore);
        p.enemyScore = 0;
    } else if (relationship === 'enemy') {
        p.enemyScore = Math.max(60, p.enemyScore);
        p.friendScore = 0;
    } else if (relationship === 'rival') {
        p.enemyScore = Math.max(30, p.enemyScore);
        p.friendScore = 0;
    } else {
        p.friendScore = 0;
        p.enemyScore = 0;
    }
    p.evidence.push(`[${new Date().toLocaleTimeString('vi-VN')}] Cập nhật thủ công vai trò thành ${relationship}`);
    profiles[userId] = p;
    saveSocialProfiles(profiles);
    updateUserInfo(userId, { relationship: relationship });
    return "Thành Công";
}
