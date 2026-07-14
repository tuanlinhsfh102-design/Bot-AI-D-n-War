/**
 * autoResponder.ts — Wrapper gọi SpamMessages/NhayMessages từ spamDetector.
 *
 * Tách riêng để spamDetector không depend trực tiếp vào AiTool.ts (tránh circular import).
 * spamDetector gọi hàm trong file này, file này import tools từ AiTool.ts.
 */
import { tools } from './AiTool';

  
  /**
 * Spam — load content từ file .txt trong folder spam/ rồi lặp lại N lần.
 * ⚠️ FIX v1.5.23 — Bắt buộc dùng filename, KHÔNG nhận content raw text.
 */
export async function spamMessages(opts: {
    threadId: string;
    threadType: 'User' | 'Group';
    filename: string;  // ⚠️ BẮT BUỘC — tên file trong folder spam/
    repeatCount?: number;
    delayMs?: number;
    mentionUid?: string;
    mentionUids?: string[];
    allSenderIds?: string[];  // TẤT CẢ userIds trong batch để mention tất cả người chửi cùng lúc
}): Promise<string> {
    return tools.SpamMessages.execute({
        threadId: opts.threadId,
        threadType: opts.threadType,
        filename: opts.filename,
        repeatCount: opts.repeatCount,
        delayMs: opts.delayMs,
        mentionUid: opts.mentionUid,
        mentionUids: opts.mentionUids,
        allSenderIds: opts.allSenderIds,  // 🔥 CHIA SẺ ĐIỂM MỚI: Mention TẤT CẢ người chửi
    } as any, {} as any);
}

/**
 * Nhây — gửi nhiều câu khác nhau từ file.
 */
export async function nhayMessages(opts: {
    threadId: string;
    threadType: 'User' | 'Group';
    filename: string;
    delayMs?: number;
    mentionUid?: string;
    mentionUids?: string[];
    allSenderIds?: string[];  // TẤT CẢ userIds trong batch để mention tất cả người chửi cùng lúc
    max?: number;
    shuffle?: boolean;
}): Promise<string> {
    return tools.NhayMessages.execute({
        threadId: opts.threadId,
        threadType: opts.threadType,
        filename: opts.filename,
        delayMs: opts.delayMs,
        mentionUid: opts.mentionUid,
        mentionUids: opts.mentionUids,
        allSenderIds: opts.allSenderIds,  // 🔥 CHIA SẺ ĐIỂM MỚI: Mention TẤT CẢ người chửi
        max: opts.max,
        shuffle: opts.shuffle,
    } as any, {} as any);
}
