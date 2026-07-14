/**
 * seen.ts — Helper gửi "đã xem" (seen event) cho Zalo.
 *
 * zca-js sendSeenEvent signature (theo gitbook + source code RFS-ADRENO/zca-js):
 *   sendSeenEvent(messages, type?)
 *   - messages: SendSeenEventMessageParams | SendSeenEventMessageParams[]
 *   - type: ThreadType.User (default) hoặc ThreadType.Group
 *
 * SendSeenEventMessageParams = {
 *   msgId, cliMsgId, uidFrom, idTo, msgType, st, at, cmd, ts
 * }
 *
 * Quan trọng: tất cả các field này đều có trong message.data từ listener.
 *   - DM (User):   threadId = uidFrom (người gửi)
 *   - Group:       threadId = idTo (groupId)
 *
 * HUMAN-LIKE BEHAVIOR:
 *   - KHÔNG gửi seen ngay lập tức — mimic người thật đang bận
 *   - 60% seen nhanh (0.5-3s), 25% seen chậm (3-10s), 15% seen rất chậm (10-90s)
 *   - Time-of-day: đêm seen chậm hơn (buồn ngủ, không nhìn điện thoại)
 *   - Xem human.ts/calcSeenDelay để biết chi tiết
 */
import { ThreadType, type Message } from 'zca-js';
import { calcSeenDelay, sleep } from './human';

export type ThreadKind = 'User' | 'Group';

/**
 * Extract SendSeenEventMessageParams từ zca-js Message.
 * Trả về null nếu thiếu field nào.
 */
function extractSeenParams(message: Message): any | null {
    const d: any = message?.data;
    if (!d) return null;
    if (!d.msgId || !d.cliMsgId || !d.uidFrom || !d.idTo || !d.msgType) return null;
    return {
        msgId: String(d.msgId),
        cliMsgId: String(d.cliMsgId),
        uidFrom: String(d.uidFrom),
        idTo: String(d.idTo),
        msgType: String(d.msgType),
        st: Number(d.st ?? 0),
        at: Number(d.at ?? 0),
        cmd: Number(d.cmd ?? 0),
        ts: d.ts ?? Date.now(),
    };
}

/**
 * Gửi seen event cho một message, với HUMAN-LIKE DELAY.
 * Tự động chọn ThreadType.User (DM) hoặc ThreadType.Group.
 *
 * @param message Message object từ listener
 * @param threadKind 'User' (DM) hoặc 'Group'
 * @returns true nếu gửi thành công, false nếu fail
 */
export async function sendSeenForMessage(
    message: Message,
    threadKind: ThreadKind = 'User',
): Promise<boolean> {
    try {
        const params = extractSeenParams(message);
        if (!params) {
            console.warn('[Seen] Cannot extract message params — skip seen event');
            return false;
        }
        const zaloType = threadKind === 'Group' ? ThreadType.Group : ThreadType.User;

        // HUMAN-LIKE: random delay trước khi seen
        const delayMs = calcSeenDelay();
        if (delayMs > 500) {
            await sleep(delayMs);
        }

        await global.api.sendSeenEvent(params, zaloType);
        return true;
    } catch (e: any) {
        console.warn('[Seen] sendSeenEvent failed:', e?.message ?? e);
        return false;
    }
}

/**
 * Gửi seen ngay lập tức (không delay) — cho trường hợp cần seen nhanh
 * như khi bot reply xong thì seen đã được set rồi.
 */
export async function sendSeenForMessageImmediate(
    message: Message,
    threadKind: ThreadKind = 'User',
): Promise<boolean> {
    try {
        const params = extractSeenParams(message);
        if (!params) return false;
        const zaloType = threadKind === 'Group' ? ThreadType.Group : ThreadType.User;
        await global.api.sendSeenEvent(params, zaloType);
        return true;
    } catch (e: any) {
        console.warn('[Seen] immediate sendSeenEvent failed:', e?.message ?? e);
        return false;
    }
}

/**
 * Gửi seen cho nhiều message cùng lúc (batch).
 * zca-js cho phép 1-50 messages per call.
 * Note: batch KHÔNG có human delay — chỉ dùng khi cần sync state.
 */
export async function sendSeenForMessages(
    messages: Message[],
    threadKind: ThreadKind = 'User',
): Promise<boolean> {
    if (!messages || messages.length === 0) return false;
    try {
        const paramsList: any[] = [];
        for (const m of messages) {
            const p = extractSeenParams(m);
            if (p) paramsList.push(p);
        }
        if (paramsList.length === 0) {
            console.warn('[Seen] No valid message params — skip batch seen');
            return false;
        }
        const zaloType = threadKind === 'Group' ? ThreadType.Group : ThreadType.User;
        // zca-js giới hạn 50 messages/call
        const chunks: any[][] = [];
        for (let i = 0; i < paramsList.length; i += 50) {
            chunks.push(paramsList.slice(i, i + 50));
        }
        for (const chunk of chunks) {
            await global.api.sendSeenEvent(chunk, zaloType);
        }
        return true;
    } catch (e: any) {
        console.warn('[Seen] batch sendSeenEvent failed:', e?.message ?? e);
        return false;
    }
}
