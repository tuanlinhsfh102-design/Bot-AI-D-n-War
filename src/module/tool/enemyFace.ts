/**
 * enemyFace.ts — Nhận dạng khuôn mặt (kẻ thù vs bạn bè/admin) qua Gemini Vision
 *
 * Admin nhét:
 *   - Ảnh kẻ thù vào: data/enemies/
 *   - Ảnh của admin/bạn bè (người vô tội cần bảo vệ) vào: data/friends/
 *
 * Khi bot nhận ảnh trong chat → gọi identifyFaceInImage() để kiểm tra.
 * Trả về:
 *   'ENEMY'  → khuôn mặt thuộc về kẻ thù
 *   'FRIEND' → khuôn mặt thuộc về admin hoặc bạn bè admin (người vô tội)
 *   'NONE'   → không khớp ai / không có khuôn mặt
 */
import fs from 'fs';
import path from 'path';
// ⭐ v1.7.0 — Switch sang OpenCode Zen API.
import { withZenModel, ZEN_DEFAULT_MODEL } from '../apikey';
import { generateText } from 'ai';

// ============================================================
// Config
// ============================================================
export const ENEMIES_ROOT = path.resolve('data/enemies');
export const FRIENDS_ROOT = path.resolve('data/friends');
const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_REFS_PER_TYPE = 8;

// ============================================================
// Helpers
// ============================================================
function isImageFile(name: string) {
    return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
}

/**
 * Load ảnh reference từ thư mục chỉ định
 */
function loadRefsFromDir(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    try {
        return fs.readdirSync(dir)
            .filter(f => isImageFile(f))
            .map(f => path.join(dir, f))
            .slice(0, MAX_REFS_PER_TYPE);
    } catch {
        return [];
    }
}

export function loadEnemyRefs(): string[] {
    return loadRefsFromDir(ENEMIES_ROOT);
}

export function loadFriendRefs(): string[] {
    return loadRefsFromDir(FRIENDS_ROOT);
}

/**
 * So sánh ảnh nhận được với ảnh tham chiếu trong cả data/enemies/ và data/friends/
 * Trả về 'ENEMY' | 'FRIEND' | 'NONE'
 */
export async function identifyFaceInImage(receivedImageUrl: string): Promise<'ENEMY' | 'FRIEND' | 'NONE'> {
    const enemyRefs = loadEnemyRefs();
    const friendRefs = loadFriendRefs();

    if (enemyRefs.length === 0 && friendRefs.length === 0) {
        return 'NONE'; // Không có dữ liệu đối chiếu
    }

    type ContentPart =
        | { type: 'text'; text: string }
        | { type: 'file'; data: string | Buffer; mediaType: string };

    const parts: ContentPart[] = [];

    // --- Ảnh cần kiểm tra ---
    parts.push({ type: 'text', text: '=== ẢNH CẦN KIỂM TRA (IMAGE_TO_CHECK) ===' });
    if (/^https?:\/\//i.test(receivedImageUrl)) {
        parts.push({ type: 'file', data: receivedImageUrl, mediaType: 'image/*' });
    } else {
        const abs = path.isAbsolute(receivedImageUrl)
            ? receivedImageUrl
            : path.join(process.cwd(), receivedImageUrl);
        if (!fs.existsSync(abs)) return 'NONE';
        const buf = fs.readFileSync(abs);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg',
            png: 'image/png', webp: 'image/webp',
        };
        parts.push({ type: 'file', data: buf, mediaType: mime[ext] ?? 'image/jpeg' });
    }

    // --- Thêm ảnh reference KẺ THÙ (LABEL: ENEMY) ---
    if (enemyRefs.length > 0) {
        parts.push({ type: 'text', text: '=== ẢNH THAM CHIẾU KẺ THÙ (LABEL: ENEMY) ===' });
        for (const refPath of enemyRefs) {
            try {
                const buf = fs.readFileSync(refPath);
                const ext = path.extname(refPath).slice(1).toLowerCase();
                const mime: Record<string, string> = {
                    jpg: 'image/jpeg', jpeg: 'image/jpeg',
                    png: 'image/png', webp: 'image/webp',
                };
                parts.push({ type: 'file', data: buf, mediaType: mime[ext] ?? 'image/jpeg' });
            } catch { }
        }
    }

    // --- Thêm ảnh reference BẠN BÈ/ADMIN (LABEL: FRIEND) ---
    if (friendRefs.length > 0) {
        parts.push({ type: 'text', text: '=== ẢNH THAM CHIẾU BẠN BÈ / ADMIN (LABEL: FRIEND) ===' });
        for (const refPath of friendRefs) {
            try {
                const buf = fs.readFileSync(refPath);
                const ext = path.extname(refPath).slice(1).toLowerCase();
                const mime: Record<string, string> = {
                    jpg: 'image/jpeg', jpeg: 'image/jpeg',
                    png: 'image/png', webp: 'image/webp',
                };
                parts.push({ type: 'file', data: buf, mediaType: mime[ext] ?? 'image/jpeg' });
            } catch { }
        }
    }

    // --- Prompt yêu cầu đối chiếu ---
    parts.push({
        type: 'text',
        text: `Nhiệm vụ: Đối chiếu khuôn mặt người nổi bật nhất trong ẢNH CẦN KIỂM TRA (IMAGE_TO_CHECK) với các nhóm ảnh tham chiếu.

Quy tắc đối chiếu:
- Nhóm ảnh tham chiếu có 2 nhãn: "ENEMY" (kẻ thù) và "FRIEND" (bạn bè/admin).
- Chỉ so sánh cấu trúc khuôn mặt, bỏ qua biểu cảm, trang phục, góc nghiêng, kính mắt, màu tóc, bộ lọc hình ảnh.
- Nếu khuôn mặt trong IMAGE_TO_CHECK trùng khớp với bất kỳ ảnh nào trong nhóm "ENEMY" → trả lời ENEMY.
- Nếu khuôn mặt trong IMAGE_TO_CHECK trùng khớp với bất kỳ ảnh nào trong nhóm "FRIEND" → trả lời FRIEND.
- Nếu không trùng khớp với bên nào, hoặc ảnh không có mặt người → trả lời NONE.
- Độ chính xác yêu cầu ≥ 75%.

Trả lời bằng ĐÚNG 1 từ duy nhất:
ENEMY
FRIEND
NONE`,
    });

    try {
        const result = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
            return generateText({
                model,
                messages: [{ role: 'user', content: parts as any }],
                // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
            });
        });

        const answer = String((result as any).text ?? '').trim().toUpperCase();
        console.log(`[EnemyFace] Zen face-check answer: "${answer}"`);
        if (answer.includes('ENEMY')) return 'ENEMY';
        if (answer.includes('FRIEND')) return 'FRIEND';
        return 'NONE';
    } catch (e: any) {
        console.warn(`[EnemyFace] Face check failed: ${e?.message ?? e}`);
        return 'NONE';
    }
}
