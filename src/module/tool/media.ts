/**
 * media.ts — Quản lý ảnh do admin nhét vào data/media/
 *
 * Cấu trúc folder:
 *   data/media/meme/      — ảnh meme/chế để khịa
 *   data/media/war/       — ảnh flex/war để phản đòn
 *   data/media/reaction/  — ảnh reaction
 *   data/media/random/    — ảnh bất kỳ
 *
 * Admin nhét ảnh vào folder, bot pick random bằng các tool bên dưới.
 */
import fs from 'fs';
import path from 'path';

// ============================================================
// Config
// ============================================================
export const MEDIA_ROOT = path.resolve('data/media');
export const MEDIA_CATEGORIES = ['meme', 'war', 'reaction', 'random'] as const;
export type MediaCategory = typeof MEDIA_CATEGORIES[number] | 'all';

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// ============================================================
// Helpers
// ============================================================
function isImageFile(name: string): boolean {
    return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
}

/**
 * Lấy danh sách đường dẫn tuyệt đối của tất cả ảnh trong một folder.
 */
function listImagesInDir(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    try {
        return fs.readdirSync(dir)
            .filter(f => isImageFile(f))
            .map(f => path.join(dir, f));
    } catch {
        return [];
    }
}

// ============================================================
// Public API
// ============================================================

/**
 * Lấy danh sách ảnh theo category (hoặc tất cả).
 */
export function listMediaImages(category: MediaCategory = 'all'): string[] {
    if (category === 'all') {
        return MEDIA_CATEGORIES.flatMap(cat => listImagesInDir(path.join(MEDIA_ROOT, cat)));
    }
    return listImagesInDir(path.join(MEDIA_ROOT, category));
}

/**
 * Pick 1 ảnh ngẫu nhiên từ category.
 * Trả về đường dẫn tuyệt đối hoặc null nếu không có ảnh.
 */
export function pickRandomMediaImage(category: MediaCategory = 'all'): string | null {
    const images = listMediaImages(category);
    if (!images.length) return null;
    return images[Math.floor(Math.random() * images.length)];
}

/**
 * Đếm tổng số ảnh theo từng category.
 */
export function getMediaStats(): Record<string, number> & { total: number } {
    const stats: Record<string, number> & { total: number } = { total: 0 };
    for (const cat of MEDIA_CATEGORIES) {
        const count = listImagesInDir(path.join(MEDIA_ROOT, cat)).length;
        stats[cat] = count;
        stats.total += count;
    }
    return stats;
}

/**
 * Đọc file ảnh thành Buffer (dùng để upload lên Zalo).
 */
export function readImageBuffer(filePath: string): { buffer: Buffer; ext: string; filename: string } {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    const filename = path.basename(filePath);
    return { buffer, ext, filename };
}

/**
 * Upload và gửi ảnh từ file local vào Zalo thread.
 * Cần global.api đã được set trước khi gọi.
 *
 * ⚠️ FIX v1.5.8 — Dùng zca-js API ĐÚNG:
 *   Truyền { data, filename, metadata } vào attachments, zca-js TỰ upload.
 *   Trước đây tự upload rồi truyền photoId → zca-js upload lại → "Invalid source type".
 */
export async function sendLocalImageToThread(
    filePath: string,
    threadId: string,
    threadType: 'User' | 'Group' = 'Group',
    caption: string = '',
): Promise<string> {
    const { buffer, ext, filename } = readImageBuffer(filePath);
    const { ThreadType } = await import('zca-js');
    const tt = threadType === 'Group' ? ThreadType.Group : ThreadType.User;

    const cap = caption ? String(caption).slice(0, 200) : '';

    // Truyền buffer + filename cho zca-js, zca-js TỰ upload + gửi
    await (global as any).api.sendMessage({
        msg: cap,
        attachments: [{
            data: buffer,
            filename: filename as `${string}.${string}`,
            metadata: {
                totalSize: buffer.byteLength,
                width: 1024,
                height: 1024,
            },
        }],
    }, threadId, tt);

    return `✓ Đã gửi ảnh "${filename}" vào thread ${threadId}`;
}

/**
 * Upload và gửi VIDEO từ file local vào Zalo thread.
 *
 * ⚠️ FIX v1.5.8 — Dùng zca-js API ĐÚNG:
 *   Truyền { data, filename, metadata } vào attachments, zca-js TỰ upload + gửi.
 *   Trước đây tự upload rồi truyền fileId → zca-js upload lại → "Invalid source type".
 *
 * @param filePath  Đường dẫn tuyệt đối tới file video (mp4)
 * @param threadId  threadId của cuộc hội thoại
 * @param threadType 'User' (DM) hoặc 'Group'
 * @param caption   Chú thích kèm video (tuỳ chọn)
 */
export async function sendVideoToThread(
    filePath: string,
    threadId: string,
    threadType: 'User' | 'Group' = 'Group',
    caption: string = '',
): Promise<string> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File video không tồn tại: ${filePath}`);
    }
    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const { ThreadType } = await import('zca-js');
    const tt = threadType === 'Group' ? ThreadType.Group : ThreadType.User;

    const cap = caption ? String(caption).slice(0, 200) : '';

    // Truyền buffer + filename cho zca-js, zca-js TỰ upload + gửi
    await (global as any).api.sendMessage({
        msg: cap,
        attachments: [{
            data: buffer,
            filename: filename as `${string}.${string}`,
            metadata: {
                totalSize: buffer.byteLength,
                width: 1280,
                height: 720,
            },
        }],
    }, threadId, tt);

    return `✓ Đã gửi video "${filename}" (${(buffer.byteLength / 1024).toFixed(0)}KB) vào thread ${threadId}`;
}
