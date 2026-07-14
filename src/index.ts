import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { API, Credentials, ThreadType, Zalo, Message, LoginQRCallbackEventType, GroupEventType, type GroupEvent } from "zca-js";
import qrTerminal from "qrcode-terminal";
import { MessageQueue } from "./module/queue";
import { saveIncomingMessage } from "./module/storage";
import { aiImageToText, aiVideoToText } from "./module/tool";
import { startReminderScheduler, type Reminder } from "./module/tool/reminder";
import {
    loadCredentials,
    saveCredentials,
    cookieJarToArray,
    isCredentialsStale,
    getCookieFreshness,
    type ZaloCredentials,
} from "./module/credentials";
import { validateEnv, ensureEnvFile } from "./module/env";
import { sendSeenForMessage } from "./module/seen";
import { addKnownThread, removeMembersFromThread, syncAllGroupsFromZalo } from "./module/threads";
import { updateTargetLastSeen, clearTargetLastSeen, matchUserToTarget, loadTargets, findTargetByUid, getTargetDisplayNames } from "./module/targets";
import { startProactiveScheduler } from "./module/proactive";
import { startKeystoreServer, stopKeystoreServer } from "./module/keystore_server";
import { initApiKeySystem } from "./module/apikey";

// ============================================================
// 0. Validate env TRƯỚC KHI làm gì khác
// ============================================================
// Đảm bảo dotenv đã load xong rồi mới validate
// (dotenv/config chạy ở dòng 1, đồng bộ)
ensureEnvFile();
validateEnv();

// Khởi động Keystore Web UI ngay sau khi env OK (trước login Zalo để có thể paste key khi cần)
startKeystoreServer();

// ⚠️ Khởi tạo hệ thống API key (load key từ .env + data/api_keys/zen.txt vào runtime map)
// NẾU KHÔNG GỌI: zen map rỗng → withServiceApiKey ném "Chưa có API key cho OpenCode Zen"
initApiKeySystem();

// Add a global type declaration for 'api'
declare global {
    // eslint-disable-next-line no-var
    var api: API;
}

// ============================================================
// Thread type helpers
// ============================================================
export type ThreadKind = 'User' | 'Group';

function kindToThreadType(kind: ThreadKind): ThreadType {
    return kind === 'Group' ? ThreadType.Group : ThreadType.User;
}

// ============================================================
// 1. Login Zalo — chiến lược: thử cookie → fallback QR
// ============================================================
const zalo = new Zalo({
    // zca-js mặc định selfListen=false nên tin do chính nick bot gửi sẽ không emit ra listener.
    // Bật lên để console vẫn thấy self-message khi debug, nhưng pipeline bên dưới vẫn skip isSelf.
    selfListen: true,
});
let api: API;

/**
 * Thử đăng nhập bằng credentials đã lưu. Trả về API nếu thành công, null nếu thất bại.
 * Bắt TẤT CẢ lỗi có thể xảy ra (TypeError zpw_enk null, ZaloApiError, network, ...).
 *
 * UA được đọc TỪ credentials.json (ghi lúc login QR), KHÔNG hardcoded.
 * Nếu env ZALO_USER_AGENT được set, nó override credentials UA.
 */
async function tryLoginWithCookie(): Promise<API | null> {
    const creds = loadCredentials();
    if (!creds) {
        console.log('[Login] Không có credentials.json — cần quét QR.');
        return null;
    }
    if (isCredentialsStale(creds, 30)) {
        console.log('[Login] credentials.json đã quá 30 ngày — có thể hết hạn. Sẽ thử, fallback QR nếu fail.');
    }

    // Check cookie freshness — warn if session expired
    const freshness = getCookieFreshness(creds);
    if (freshness === 'expired') {
        console.warn('[Login] ⚠ Cookie session đã hết hạn (>1 giờ). Login sẽ likely fail → fallback QR.');
    } else if (freshness === 'warning') {
        console.warn('[Login] ⚠ Cookie session sắp hết hạn (>50 phút). Nên backup cookie.');
    }

    // Determine UA: env override > credentials UA
    const envUA = process.env.ZALO_USER_AGENT;
    const ua = envUA || creds.userAgent;
    console.log(`[Login] Đang thử đăng nhập bằng cookie đã lưu:`);
    console.log(`  uid=${creds.uid ?? '?'}`);
    console.log(`  savedAt=${creds.savedAt ? new Date(creds.savedAt).toLocaleString('vi-VN') : '?'}`);
    console.log(`  UA: ${ua.slice(0, 80)}...`);

    try {
        const credentials: Credentials = {
            imei: creds.imei,
            cookie: creds.cookie as any,
            userAgent: ua,
        };
        const api = await zalo.login(credentials);
        const ctx = api.getContext();
        const uid = (ctx as any)?.uid ?? creds.uid ?? '(unknown)';
        console.log(`[Login] ✓ Đăng nhập thành công bằng cookie! uid=${uid}`);
        return api;
    } catch (e: any) {
        // Lỗi phổ biến: "TypeError: null is not an object (evaluating 'loginData.data.zpw_enk')"
        // → Cookie hết hạn hoặc không hợp lệ
        console.warn(`[Login] ✗ Đăng nhập bằng cookie thất bại: ${e?.message ?? e}`);
        console.warn('[Login] → Sẽ fallback sang quét QR.');
        // Backup credentials cũ ra file .bak để debug
        try {
            const bakPath = 'credentials.json.bak';
            if (fs.existsSync('credentials.json')) {
                fs.copyFileSync('credentials.json', bakPath);
                console.log(`[Login] Đã backup credentials cũ → ${bakPath}`);
            }
        } catch { }
        return null;
    }
}

/**
 * In QR code trực tiếp trong terminal để user không cần mở file.
 * Dùng qrcode-terminal để render ASCII QR từ chuỗi code.
 */
function printQrToTerminal(code: string): void {
    try {
        console.log('\n┌─────────────────────────────────────────────┐');
        console.log('│       QUÉT QR BẰNG APP ZALO TRÊN ĐIỆN THOẠI     │');
        console.log('│       Zalo → Tab Cá Nhân → Quét Mã             │');
        console.log('└─────────────────────────────────────────────┘\n');
        qrTerminal.generate(code, { small: true }, (qrStr: string) => {
            console.log(qrStr);
        });
        console.log('Hoặc mở file ./qr.png để xem QR lớn hơn.\n');
    } catch (e) {
        console.log('[Login] Không thể in QR trong terminal, xem ./qr.png thay thế.');
    }
}

/**
 * Tự động mở file qr.png bằng app mặc định của hệ điều hành.
 * Windows: start, macOS: open, Linux: xdg-open
 */
function openQrFile(qrPath: string): void {
    try {
        const absPath = path.resolve(qrPath);
        const platform = os.platform();
        let cmd: string;
        if (platform === 'win32') {
            cmd = `start "" "${absPath}"`;
        } else if (platform === 'darwin') {
            cmd = `open "${absPath}"`;
        } else {
            cmd = `xdg-open "${absPath}"`;
        }
        exec(cmd, () => { });  // ignore errors
    } catch { }
}

/**
 * Đăng nhập bằng QR code với auto-retry khi hết hạn.
 *
 * Chiến lược:
 * - Khi callback QRCodeExpired → gọi actions.retry() để tự sinh QR mới
 * - Đếm số lần retry, max 5 lần (5 × 100s = ~8 phút tổng)
 * - Khi QRCodeGenerated → in QR ASCII trong terminal + lưu file + auto-open
 * - Khi GotLoginInfo → capture credentials → saveCredentials()
 *
 * @param maxRetries Số lần tối đa QR được retry khi hết hạn (mặc định 5)
 */
async function loginWithQR(maxRetries: number = 5): Promise<API> {
    console.log('[Login] === QR LOGIN MODE ===');
    console.log('[Login] Quét QR bằng app Zalo trên điện thoại:');
    console.log('[Login]   1. Mở app Zalo');
    console.log('[Login]   2. Tab Cá Nhân (icon người)');
    console.log('[Login]   3. Menu (icon 3 dấu chấm hoặc vuốt phải)');
    console.log('[Login]   4. "Quét Mã" → hướng camera vào QR\n');

    let capturedCreds: ZaloCredentials | null = null;
    let retryCount = 0;
    let lastQrCode: string | null = null;

    const api = await zalo.loginQR(
        {
            qrPath: './qr.png',
            userAgent: process.env.ZALO_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            language: 'vi',
        },
        (event: any) => {
            switch (event?.type) {
                case LoginQRCallbackEventType.QRCodeGenerated: {
                    retryCount = 0;  // reset khi QR mới được sinh (sau retry thành công)
                    const code = event?.data?.code;
                    const imageB64 = event?.data?.image;
                    console.log('[Login] ✓ QR code đã được sinh ra');

                    // Lưu file QR
                    if (event?.actions?.saveToFile) {
                        event.actions.saveToFile('./qr.png').then(() => {
                            // Auto-open file sau khi lưu
                            openQrFile('./qr.png');
                        }).catch((e: any) => {
                            console.warn('[Login] Lưu qr.png thất bại:', e?.message ?? e);
                        });
                    } else if (imageB64) {
                        // Fallback: tự lưu nếu actions.saveToFile không có
                        try {
                            fs.writeFileSync('./qr.png', Buffer.from(imageB64, 'base64'));
                            openQrFile('./qr.png');
                        } catch { }
                    }

                    // In QR ASCII trong terminal
                    if (code) {
                        lastQrCode = code;
                        printQrToTerminal(code);
                    }
                    break;
                }
                case LoginQRCallbackEventType.QRCodeScanned: {
                    console.log(`\n[Login] ✓ ĐÃ QUÉT! Chờ xác nhận trên điện thoại.`);
                    console.log(`[Login]   Tài khoản: ${event?.data?.display_name ?? '(không rõ)'}`);
                    console.log('[Login]   Nhấn "Đồng Ý" trên app Zalo để tiếp tục...\n');
                    break;
                }
                case LoginQRCallbackEventType.QRCodeExpired: {
                    retryCount++;
                    if (retryCount > maxRetries) {
                        console.error(`\n[Login] ✗ QR đã hết hạn ${retryCount - 1} lần liên tiếp (tối đa ${maxRetries}).`);
                        console.error('[Login] Thoát. Vui lòng chạy lại script khi sẵn sàng.');
                        if (event?.actions?.abort) event.actions.abort();
                        else process.exit(1);
                        return;
                    }
                    console.warn(`\n[Login] ⚠ QR hết hạn (lần ${retryCount}/${maxRetries}). Đang tự sinh QR mới...`);
                    console.warn('[Login]   Hãy quét nhanh hơn trong lần này nhé!\n');
                    // Gọi retry để zca-js tự regenerate QR — không cần làm gì khác
                    if (event?.actions?.retry) {
                        event.actions.retry();
                    } else {
                        console.error('[Login] Không có actions.retry — thoát.');
                        process.exit(1);
                    }
                    break;
                }
                case LoginQRCallbackEventType.QRCodeDeclined: {
                    console.warn('\n[Login] ✗ Quét bị từ chối trên điện thoại.');
                    console.warn('[Login] Đang sinh QR mới để thử lại...');
                    if (event?.actions?.retry) {
                        event.actions.retry();
                    } else {
                        process.exit(1);
                    }
                    break;
                }
                case LoginQRCallbackEventType.GotLoginInfo: {
                    console.log('\n[Login] ✓ Đã nhận login info từ Zalo. Đang lưu credentials...');
                    try {
                        const data = event?.data;
                        if (data?.cookie && data?.imei && data?.userAgent) {
                            const cookieArr = Array.isArray(data.cookie)
                                ? data.cookie
                                : cookieJarToArray(data.cookie);
                            capturedCreds = {
                                imei: data.imei,
                                userAgent: data.userAgent,
                                cookie: cookieArr,
                            };
                            saveCredentials(capturedCreds);
                            console.log('[Login] ✓ Đã lưu credentials.json — lần sau sẽ không cần quét QR nữa!');
                        }
                    } catch (e) {
                        console.warn('[Login] Capture credentials failed:', e);
                    }
                    break;
                }
                default:
                    console.log('[Login] Event:', event?.type);
            }
        },
    );

    // Fallback: nếu callback GotLoginInfo không trigger, thử lấy từ context
    if (!capturedCreds) {
        try {
            const ctx = api.getContext();
            const cookieArr = cookieJarToArray(ctx.cookie);
            if (cookieArr.length > 0 && ctx.imei && ctx.userAgent) {
                const uid = (ctx as any)?.uid;
                capturedCreds = {
                    imei: ctx.imei,
                    userAgent: ctx.userAgent,
                    cookie: cookieArr,
                    uid: uid ? String(uid) : undefined,
                };
                saveCredentials(capturedCreds);
                console.log('[Login] ✓ Đã lưu credentials.json (từ context fallback)');
            } else {
                console.warn('[Login] ⚠ Không lấy được cookie — sẽ phải quét QR lại lần sau.');
            }
        } catch (e) {
            console.warn('[Login] Fallback capture failed:', e);
        }
    }

    return api;
}

// ============================================================
// Thực thi login flow
// ============================================================
console.log('=== Zalo Bot Nguyễn Đình Dương ===');
console.log(`Thời gian: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n`);

const MAX_LOGIN_ATTEMPTS = 3;
let loginAttempt = 0;
let loginSuccess = false;

while (loginAttempt < MAX_LOGIN_ATTEMPTS && !loginSuccess) {
    loginAttempt++;
    try {
        // Bước 1: Thử login bằng cookie đã lưu
        if (loginAttempt === 1) {
            api = await tryLoginWithCookie();
            if (api) {
                loginSuccess = true;
                break;
            }
            // Cookie fail hoặc không có → continue sang QR
        } else {
            console.log(`\n[Login] === Thử lại lần ${loginAttempt}/${MAX_LOGIN_ATTEMPTS} ===`);
        }

        // Bước 2: Login bằng QR (với retry nội bộ cho QR expired)
        api = await loginWithQR();
        loginSuccess = true;
    } catch (e: any) {
        const errMsg = String(e?.message ?? e);
        console.error(`\n[Login] ✗ Lỗi đăng nhập (lần ${loginAttempt}/${MAX_LOGIN_ATTEMPTS}): ${errMsg}`);

        // Phân loại lỗi
        if (/Can't login|Can't get account info|Cannot get session/i.test(errMsg)) {
            // Lỗi phổ biến: server Zalo trả userInfo.data.logged = false sau khi quét
            // Thường do session chưa ổn định hoặc rate limit → retry sau delay
            console.warn('[Login] → Nguyên nhân: session Zalo chưa ổn định sau khi quét QR.');
            console.warn('[Login] → Sẽ thử lại sau 3 giây...\n');
            await new Promise(r => setTimeout(r, 3000));
        } else if (/QRCode login declined|LoginQRDeclined/i.test(errMsg)) {
            console.warn('[Login] → User đã từ chối trên điện thoại. Thoát.');
            process.exit(1);
        } else if (/Unable to login with QRCode/i.test(errMsg)) {
            console.warn('[Login] → QR không hợp lệ. Sẽ sinh QR mới.');
        } else {
            console.warn('[Login] → Lỗi không xác định. Thử lại sau 3 giây...');
            await new Promise(r => setTimeout(r, 3000));
        }

        if (loginAttempt >= MAX_LOGIN_ATTEMPTS) {
            console.error('\n[Login] ✗ Đã thử quá số lần tối đa. Thoát.');
            console.error('[Login] Có thể thử:');
            console.error('  1. Xoá credentials.json: rm credentials.json');
            console.error('  2. Chạy lại: bun run start');
            console.error('  3. Nếu vẫn fail: chờ 5-10 phút rồi thử (rate limit Zalo)');
            process.exit(1);
        }
    }
}

if (!api || !loginSuccess) {
    console.error('[Login] Không thể đăng nhập. Thoát.');
    process.exit(1);
}

const { listener } = api;
global.api = api;

// Log thông tin user đã đăng nhập
try {
    const ctx = api.getContext();
    const uid = (ctx as any)?.uid;
    if (uid) {
        console.log(`[Login] Bot đang chạy với uid=${uid}`);
        // Cập nhật uid vào credentials nếu thiếu
        const creds = loadCredentials();
        if (creds && !creds.uid) {
            saveCredentials({ ...creds, uid: String(uid) });
        }
    }
} catch { }

// ============================================================
// 2. Message queue
// ============================================================
const queue = new MessageQueue();

// ============================================================
// 3. Reminder scheduler
// ============================================================
startReminderScheduler(async (reminder: Reminder) => {
    try {
        console.log(`[Reminder] Firing id=${reminder.id} thread=${reminder.threadId} type=${reminder.threadType} content="${reminder.content.slice(0, 50)}..."`);
        const threadType = kindToThreadType(reminder.threadType);
        // HUMAN-LIKE: Dùng helper từ human.ts — typing indicator + adaptive delay.
        // Trước đây chỉ delay 0.8-2s mà không có typing → recipient thấy tin nhắn
        // "tự nhiên xuất hiện" → lộ bot. Giờ mimic: mở chat → typing 2-5s → gửi.
        const typingMs = 2000 + Math.random() * 3000;
        startTypingIndicatorHuman(global.api, reminder.threadId, threadType, typingMs);
        await sleep(typingMs);
        await global.api.sendMessage({ msg: reminder.content }, reminder.threadId, threadType);
        // HUMAN-LIKE: Record bot message timing
        recordBotMessage(reminder.threadId);
    } catch (e) {
        console.error('[Reminder] fire failed:', e);
    }
});

// ============================================================
// 4. Per-thread message batching (Group + User/DM)
// ============================================================
// HUMAN-LIKE: KHÔNG dùng fixed DEBOUNCE_MS — dùng calcDebounce() per-thread.
// Real humans có lúc reply trong 2s, có lúc 15s — bot phải mimic được điều đó.
// Xem human.ts/calcDebounce để biết logic (adaptive pace + time-of-day + random).
import { calcDebounce, recordUserMessage, getCurrentSlotName, startTypingIndicator as startTypingIndicatorHuman, recordBotMessage, sleep } from "./module/human";
type PendingEntry = {
    timer?: NodeJS.Timeout;
    buffer: string[];
    lastShortId?: string;
    threadType: ThreadKind;
    senderId?: string;
    allSenderIds?: string[];
    firstMsgAt?: number;  // ⚠️ timestamp tin đầu tiên trong batch — để force process
    isAdmin?: boolean;    // ⭐ tin nhắn từ admin → bot vâng lời tuyệt đối
};
const pendingBatches = new Map<string, PendingEntry>();

async function processIncomingMessage(message: Message, threadType: ThreadKind) {
    const threadId = message.threadId;
    // ⚠️ FIX v1.5.19 — KHÔNG fallback senderId = threadId khi uidFrom thiếu!
    // Trước đây: nếu message.data.uidFrom rỗng → senderId = threadId (groupId)
    // → bot dùng groupId làm uid để gửi IB → nhắn vào group # thay vì IB user
    // Giờ: nếu uidFrom thiếu → senderId = undefined (bot sẽ không reply IB sai)
    const senderId = threadType === 'Group'
        ? String((message.data as any).uidFrom ?? '')
        : threadId;
    let text = message.data.content as string;

    // HUMAN-LIKE: Record user message timing để calcDebounce adaptive pace.
    // Phải record TRƯỚC khi gọi calcDebounce ở dưới.
    recordUserMessage(threadId);

    // Gửi "đã xem" (seen) — KHÔNG NGAY LẬP TỨC, có random delay (mimic "đang bận")
    // Xem seen.ts/sendSeenForMessage + human.ts/calcSeenDelay để biết logic.
    void sendSeenForMessage(message, threadType).then((ok) => {
        if (ok) console.log(`[Seen] ✓ Đã seen msgId=${message.data.msgId} thread=${threadId}`);
    });

    // ============================================================
    // Track thread + match targets (để scheduler proactive có thể chửi)
    // ============================================================
    addKnownThread(threadId, threadType);

    // Match sender với targets — nếu là target → cache uid để mention sau
    if (threadType === 'Group' && senderId) {
        try {
            const userInfo = await global.api.getUserInfo(senderId);
            const prof = (userInfo as any)?.changed_profiles?.[senderId];
            const displayName = prof?.displayName ?? '';
            if (displayName) {
                const matched = matchUserToTarget(displayName, senderId, threadId);
                if (matched) {
                    // ⚠️ FIX v1.5.28-treonhay — Không còn target.name, chỉ log uid + displayName.
                    console.log(`[Targets] ⚡ Sender "${displayName}" là target uid=${matched.uid}`);
                }
            }
        } catch (e) {
            // Silent fail — không critical
        }

        // Async: fetch all group members để cache uid cho các targets khác
        // (chỉ làm 1 lần khi thread mới xuất hiện, không spam API)
        void (async () => {
            try {
                // ⚠️ FIX v1.5.7 — Dùng pipeline ĐÚNG:
                //   getGroupInfo → memVerList (extract VDs) → getGroupMembersInfo (lấy tên)
                const { fetchGroupMembers } = await import("./module/threads");
                const members = await fetchGroupMembers(threadId);
                if (members.length > 0) {
                    // Update lastSeenInThread cho targets trong group (không còn match theo tên)
                    for (const m of members) {
                        if (m.name && m.name !== m.uid) {
                            matchUserToTarget(m.name, m.uid, threadId);
                        }
                    }
                    // Lấy group name để cache
                    let groupName = '';
                    try {
                        const gi: any = await global.api.getGroupInfo(threadId);
                        const g = gi?.gridInfoMap?.[threadId];
                        groupName = String(g?.name ?? g?.groupName ?? '');
                    } catch { /* ignore */ }
                    const memberUids = members.map(m => m.uid);
                    const memberNames: Record<string, string> = {};
                    for (const m of members) {
                        if (m.name && m.name !== m.uid) memberNames[m.uid] = m.name;
                    }
                    addKnownThread(threadId, threadType, { memberUids, memberNames, groupName });
                    console.log(`[Threads] ✓ Cached ${memberUids.length} members for group ${groupName || threadId}`);
                }
            } catch (e) {
                // Silent fail
            }
        })();
    }

    let entry = pendingBatches.get(threadId);
    if (!entry) {
        entry = {
            buffer: [],
            threadType,
            senderId,
            allSenderIds: senderId ? [senderId] : [],
            firstMsgAt: Date.now(),
            isAdmin: (message as any).__isAdmin === true ? true : false,
        };
        pendingBatches.set(threadId, entry);
    } else {
        entry.senderId = senderId;
        if (senderId) {
            if (!Array.isArray(entry.allSenderIds)) entry.allSenderIds = [];
            if (!entry.allSenderIds.includes(senderId)) {
                entry.allSenderIds.push(senderId);
            }
        }
        // ⭐ Nếu 1 tin trong batch là admin → cả batch là admin
        if ((message as any).__isAdmin) entry.isAdmin = true;
    }

    if (message.data.quote) {
        text = `Trả lời "${message.data.quote.msg}" nhắn bởi ${message.data.quote.fromD}
            với "${text}" | msgId: ${message.data.msgId}, cliMsgId: ${message.data.cliMsgId}, replyCliMsgId: ${message.data.quote.cliMsgId}`;
    } else {
        text = `${text} | msgId: ${message.data.msgId}, cliMsgId: ${message.data.cliMsgId}`;
    }

    const urls = String(message.data.content).match(/https?:\/\/\S+/g) ?? [];
    const mediaNotes: string[] = [];
    for (const u of urls) {
        const lower = u.toLowerCase();
        try {
            if (/\.(jpg|jpeg|png|gif|webp|bmp|tiff|heic|heif)(\?|#|$)/.test(lower)) {
                const desc = await aiImageToText(u);
                mediaNotes.push(`Ảnh: ${desc}`);
            } else if (/\.(mp4|webm|mkv|mov|avi|mpeg|mpg|m4v)(\?|#|$)/.test(lower)) {
                const sum = await aiVideoToText(u);
                mediaNotes.push(`Video: ${sum}`);
            }
        } catch (e) {
            console.warn('[Media] summarize failed:', e);
        }
    }
    if (mediaNotes.length) {
        text += `\n[Media] ${mediaNotes.join(' | ')}`;
    }

    try {
        const shortId = saveIncomingMessage(message, text);
        entry.lastShortId = shortId;
        console.log(`[Storage] Saved shortId=${shortId} thread=${threadId} type=${threadType}`);
    } catch (e) {
        console.error('[Storage] Failed:', e);
    }

    entry.buffer.push(text);
    console.log(`Buffered [${threadType}] ${threadId}:`, text.slice(0, 100));

    // ============================================================
    // ⚠️ SPAM/WAR DETECTION — record để AI TỰ nhận biết từ context
    // ============================================================
    // KHÔNG auto-trigger bypass AI. Chỉ record message → AI đọc context
    // → AI tự detect spam/war → AI tự gọi SpamMessages/NhayMessages.
    try {
        const { recordMessage } = await import('./module/spamDetector');
        const cleanContent = String(message.data.content ?? text ?? '').split(' | msgId')[0].trim();
        recordMessage(threadId, senderId, cleanContent);
    } catch (e: any) {
        console.warn('[SpamDetector] Error:', e?.message ?? e);
    }

    // HUMAN-LIKE: Random debounce per-thread thay vì fixed 5s.
    // - User spam (gap<2s): 4-8s để gom hết
    // - User chat chậm (gap>30s): 2-4s
    // - Bình thường: 3-6s
    // - 10% khả năng "đang bận": +10-35s
    // - Time-of-day multiplier (đêm chậm hơn)
    // - Cap 60s
    //
    // ⚠️ FIX v1.5.27 — FORCE PROCESS khi user spam liên tục.
    // Trước đây: mỗi tin mới reset timer → nếu user spam mỗi 2s, timer 4-8s
    // không bao giờ fire → bot KHÔNG BAO GIỜ rep.
    // Giờ: nếu buffer >= 5 tin HOẶC đã đợi > 15s → FORCE process ngay.
    const MAX_BUFFER_BEFORE_FORCE = 5;     // 5 tin → force
    const MAX_WAIT_BEFORE_FORCE_MS = 15_000; // 15s → force

    if (entry.timer) clearTimeout(entry.timer);

    const currentBufferSize = entry.buffer.length;
    const firstMsgAt = entry.firstMsgAt ?? Date.now();
    const waitedMs = Date.now() - firstMsgAt;
    const shouldForce = currentBufferSize >= MAX_BUFFER_BEFORE_FORCE || waitedMs >= MAX_WAIT_BEFORE_FORCE_MS;

    if (shouldForce) {
        console.log(`[Batch] ⚡ FORCE process thread=${threadId} (buffer=${currentBufferSize}, waited=${(waitedMs/1000).toFixed(1)}s)`);
        const batch = pendingBatches.get(threadId);
        if (batch) {
            const toSend = batch.buffer.splice(0, batch.buffer.length);
            const latestShortId = batch.lastShortId;
            const tt = batch.threadType;
            const sd = batch.senderId;
            const allSenderIds = Array.isArray(batch.allSenderIds) ? batch.allSenderIds : undefined;
            pendingBatches.delete(threadId);
            queue.enqueue(threadId, toSend, latestShortId, tt, sd, allSenderIds, batch.isAdmin);
        }
        return;
    }

    const debounceMs = calcDebounce(threadId);
    console.log(`[Batch] thread=${threadId} debounce=${(debounceMs/1000).toFixed(1)}s slot=${getCurrentSlotName()} buffer=${currentBufferSize}`);
    entry.timer = setTimeout(() => {
        const batch = pendingBatches.get(threadId);
        if (!batch) return;
        const toSend = batch.buffer.splice(0, batch.buffer.length);
        const latestShortId = batch.lastShortId;
        const tt = batch.threadType;
        const sd = batch.senderId;
        const allSenderIds = Array.isArray(batch.allSenderIds) ? batch.allSenderIds : undefined;
        pendingBatches.delete(threadId);
        queue.enqueue(threadId, toSend, latestShortId, tt, sd, allSenderIds, entry.isAdmin);
    }, debounceMs);
}

// ============================================================
// 5. Listener — có auto-reconnect + debug log đầy đủ
// ============================================================
let listenerStarted = false;
let lastMessageReceivedAt = 0;
let connectedAt = 0;
let noMessageWarned = false;  // chỉ warn 1 lần khi chưa nhận msg, không spam
let messageReceiveCount = 0;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Per-sender image cooldown — chống spam ảnh để tránh đốt Gemini API
// ⚠️ FIX v1.5.1 — Giảm từ 20s → 10s.
// Trước đây 20s quá cao → nếu user gửi 3 ảnh trong 30s, bot chỉ mô tả ảnh đầu tiên,
// 2 ảnh sau bị skip → bot không hiểu context đầy đủ → reply ngu.
// 10s vẫn đủ chống spam nhưng đỡ skip context quan trọng.
const IMAGE_COOLDOWN_MS = 10_000;
const lastImageAtBySender = new Map<string, number>();

// Per-sender video cooldown — video tốn nhiều token hơn ảnh, cooldown dài hơn
// ⚠️ FIX v1.5.1 — Giảm từ 60s → 30s (cùng lý do như image)
const VIDEO_COOLDOWN_MS = 30_000;
const lastVideoAtBySender = new Map<string, number>();

function startListenerWithReconnect(): void {
    if (listenerStarted) {
        console.log('[Listener] Already started, skip');
        return;
    }
    listenerStarted = true;
    try {
        api.listener.start();
        console.log('[Listener] listener.start() called');
    } catch (e: any) {
        console.error('[Listener] start() failed:', e?.message ?? e);
        listenerStarted = false;
    }
}

api.listener.on("message", async (message: Message) => {
    lastMessageReceivedAt = Date.now();
    messageReceiveCount += 1;

    // Debug log — log TẤT CẢ message nhận được để dễ fix.
    // ⚠️ FIX v1.6.2 — Privacy: mask content trong production (chỉ log type + length).
    // Trước đây: 80 ký tự đầu của MỌI tin (DM + group) được log ra stdout → lộ nội dung riêng tư.
    // Giờ: chỉ log content preview khi DEBUG_LOG=true. Mặc định chỉ log type + length.
    const contentType = typeof message.data.content;
    const DEBUG_LOG = process.env.DEBUG_LOG === 'true';
    const contentPreview = DEBUG_LOG
        ? (contentType === 'string' ? String(message.data.content).slice(0, 80) : `(${contentType})`)
        : (contentType === 'string' ? `[text, ${String(message.data.content).length} chars]` : `(${contentType})`);
    console.log(`[Listener] #${messageReceiveCount} type=${message.type} threadId=${message.threadId} isSelf=${message.isSelf} content="${contentPreview}"`);

    // Filter: skip tin nhắn bot tự gửi
    if (message.isSelf) {
        console.log('[Listener] → Skip (isSelf)');
        return;
    }

    // ⭐ ADMIN CHECK: nếu sender là admin (ADMIN_UID trong .env) → tag tin nhắn để xử lý đặc biệt
    const adminUid = process.env.ADMIN_UID;
    const senderId = String(message.data.uidFrom ?? '');
    const isAdmin = adminUid && (senderId === adminUid || message.threadId === adminUid);
    if (isAdmin) {
        console.log(`[Listener] 🔥 ADMIN từ ${message.data.uidFrom} → bot vâng lời tuyệt đối!`);
        // Admin message: luôn xử lý, luôn reply
        (message as any).__isAdmin = true;
    }

    // Filter: xử lý plain text + quote, đồng thời translate chat.photo → text description
    if (contentType !== 'string') {
        const msgType = String((message.data as any)?.msgType ?? '');
        const attachment = message.data.content as any;

        // ============================================================
        // chat.photo — tải ảnh về mô tả qua Gemini vision rồi feed vào pipeline
        // ============================================================
        if (msgType === 'chat.photo' && attachment && typeof attachment === 'object') {
            const photoUrl: string | undefined =
                (typeof attachment.href === 'string' && attachment.href) ||
                (typeof attachment.thumb === 'string' && attachment.thumb) ||
                undefined;
            // ⚠️ FIX v1.6.2 — Đồng bộ pattern fix v1.5.19: KHÔNG fallback senderId = threadId cho Group.
            // Trước đây: nếu uidFrom thiếu → senderId = threadId (= groupId) → toàn bộ users trong group
            // chia sẻ 1 image cooldown → user B gửi ảnh bị skip vì user A gửi ảnh 5s trước.
            const senderId = String((message.data as any).uidFrom ?? '');

            if (!photoUrl) {
                console.log('[Listener] → Skip (chat.photo without href/thumb)');
                return;
            }

            // Cooldown per-sender — tránh spam nhiều ảnh liên tiếp
            const now = Date.now();
            const lastImageAt = lastImageAtBySender.get(senderId) ?? 0;
            const cooldownLeft = IMAGE_COOLDOWN_MS - (now - lastImageAt);
            if (cooldownLeft > 0) {
                console.log(`[Listener] → Skip (image cooldown ${Math.round(cooldownLeft / 1000)}s còn lại cho sender=${senderId})`);
                return;
            }
            lastImageAtBySender.set(senderId, now);

            console.log(`[Listener] → chat.photo from=${senderId} url=${photoUrl.slice(0, 80)}...`);
            try {
                // Thu thập context nhóm và sender để gửi cho model vision
                let groupName = '';
                let senderName = '';
                if (message.type === ThreadType.Group) {
                    try {
                        const group: any = await api.getGroupInfo(message.threadId);
                        groupName = group?.data?.name ?? group?.name ?? '';
                    } catch {}
                }
                try {
                    const uInfo: any = await api.getUserInfo(senderId);
                    senderName = uInfo?.changed_profiles?.[senderId]?.displayName ?? '';
                } catch {}

                // ⚠️ FIX v1.5.28-treonhay — Truyền uid thay vì name (vì target không lưu name nữa).
                // aiImageToText sẽ tự fetch displayName từ Zalo khi cần.
                const targetUidsForImage = loadTargets().map(t => t.uid);

                const description = await aiImageToText(photoUrl, { groupName, senderName, targetUids: targetUidsForImage });

                // Kiểm tra khuôn mặt trong ảnh với kho ảnh kẻ thù (data/enemies/) và bạn bè (data/friends/)
                let faceTag = '';
                try {
                    const { identifyFaceInImage, loadEnemyRefs, loadFriendRefs } = await import('./module/tool/enemyFace');
                    if (loadEnemyRefs().length > 0 || loadFriendRefs().length > 0) {
                        const faceResult = await identifyFaceInImage(photoUrl);
                        if (faceResult === 'ENEMY') {
                            faceTag = ' [ENEMY:MATCH]';
                        } else if (faceResult === 'FRIEND') {
                            faceTag = ' [FRIEND:MATCH]';
                        } else {
                            faceTag = ' [ENEMY:NONE]';
                        }
                        console.log(`[EnemyFace] → ${faceTag.trim()}`);
                    }
                } catch (fe: any) {
                    console.warn(`[EnemyFace] → Skip (${fe?.message ?? fe})`);
                }

                // Mutate content thành string để phần con lại của pipeline xử lý như text
                (message.data as any).content = `[Người dùng gửi ảnh] ${description}${faceTag}`;
                console.log(`[Listener] → Ảnh đã mô tả (${description.length} chars)${faceTag}`);
            } catch (e: any) {
                console.warn(`[Listener] → Skip (aiImageToText failed: ${e?.message ?? e})`);
                return;
            }
        } else if (msgType === 'chat.video.msg' && attachment && typeof attachment === 'object') {
            // ============================================================
            // chat.video.msg — mô tả video qua Gemini vision rồi feed vào pipeline
            // (giống chat.photo nhưng dùng aiVideoToText)
            // ============================================================
            const videoUrl: string | undefined =
                (typeof attachment.href === 'string' && attachment.href) ||
                undefined;
            const thumbUrl: string | undefined =
                (typeof attachment.thumb === 'string' && attachment.thumb) ||
                undefined;
            // ⚠️ FIX v1.6.2 — Đồng bộ pattern fix v1.5.19 (xem chat.photo ở trên).
            const senderId = String((message.data as any).uidFrom ?? '');

            if (!videoUrl && !thumbUrl) {
                console.log('[Listener] → Skip (chat.video.msg without href/thumb)');
                return;
            }

            // Cooldown per-sender — video tốn nhiều token, cooldown dài hơn ảnh
            const now = Date.now();
            const lastVideoAt = lastVideoAtBySender.get(senderId) ?? 0;
            const cooldownLeft = VIDEO_COOLDOWN_MS - (now - lastVideoAt);
            if (cooldownLeft > 0) {
                console.log(`[Listener] → Skip (video cooldown ${Math.round(cooldownLeft / 1000)}s còn lại cho sender=${senderId})`);
                // Fallback: chỉ thông báo có video, không mô tả (vẫn feed vào pipeline)
                (message.data as any).content = `[Người dùng gửi video]`;
                console.log(`[Listener] → Video cooldown → mapped to text (no description)`);
                // Không return — vẫn xử lý tiếp
            } else {
                lastVideoAtBySender.set(senderId, now);
                console.log(`[Listener] → chat.video.msg from=${senderId} url=${videoUrl?.slice(0, 80) ?? '(no url)'}...`);
                try {
                    let description = '';
                    if (videoUrl) {
                        // Thử mô tả video trước (Gemini hỗ trợ video)
                        try {
                            description = await aiVideoToText(videoUrl);
                            console.log(`[Listener] → Video đã mô tả (${description.length} chars)`);
                        } catch (e: any) {
                            console.warn(`[Listener] → aiVideoToText failed: ${e?.message ?? e}`);
                            // Fallback: thử mô tả thumb (ảnh thumbnail)
                            if (thumbUrl) {
                                try {
                                    description = `(thumbnail) ${await aiImageToText(thumbUrl)}`;
                                    console.log(`[Listener] → Fallback: thumb đã mô tả (${description.length} chars)`);
                                } catch {
                                    description = '';
                                }
                            }
                        }
                    }
                    (message.data as any).content = description
                        ? `[Người dùng gửi video] ${description}`
                        : `[Người dùng gửi video]`;
                } catch (e: any) {
                    console.warn(`[Listener] → Video handler error: ${e?.message ?? e}, fallback to plain text`);
                    (message.data as any).content = `[Người dùng gửi video]`;
                }
            }
        } else if (msgType === 'chat.sticker') {
            // chat.sticker — chuyển thành text để AI biết là sticker, không skip
            (message.data as any).content = '[Người dùng gửi sticker]';
            console.log(`[Listener] → chat.sticker from=${(message.data as any).uidFrom} → mapped to text`);
        } else {
            // Các loại non-string khác (voice / link / file / ...) — chưa hỗ trợ
            console.log(`[Listener] → Skip (msgType=${msgType || 'unknown'}, content=${contentType})`);
            try {
                console.log('[Listener] → Raw message.data:', JSON.stringify(message.data, null, 2).slice(0, 500));
            } catch { }
            return;
        }
    }

    // Empty content — skip
    if (!message.data.content || String(message.data.content).trim().length === 0) {
        console.log('[Listener] → Skip (empty content)');
        return;
    }

    switch (message.type) {
        case ThreadType.User:
            console.log('[Listener] → Processing as User (DM)');
            await processIncomingMessage(message, 'User');
            break;
        case ThreadType.Group:
            console.log('[Listener] → Processing as Group');
            await processIncomingMessage(message, 'Group');
            break;
        default:
            console.warn(`[Listener] Unknown message type: ${message.type}, raw:`, JSON.stringify(message).slice(0, 300));
            // Vẫn thử xử lý như Group nếu type=1 hoặc lớn hơn
            if (message.type === 1 || message.type > 0) {
                console.log('[Listener] → Fallback: try processing as Group');
                await processIncomingMessage(message, 'Group');
            }
            break;
    }
});

// ============================================================
// 6. Group events — sync member cache khi có ai out group, hoặc JOIN group mới
// ============================================================
api.listener.on("group_event", async (event: GroupEvent) => {
    try {
        // TGroupEventBase — cho mọi event type
        const base: any = (event as any).data ?? {};
        const groupId: string = String((event as any).threadId ?? base.groupId ?? '');
        if (!groupId) return;

        // ── Case 1: JOIN / ADD_MEMBER → có người mới vào group → CACHE uid + tên
        // Quan trọng: nếu "Hihi" được tag vào group, bot phải cache ngay uid để
        // sau này khi admin nói "chửi thằng Hihi" → bot biết uid để mention.
        if (
            event.type === GroupEventType.JOIN ||
            (event.type as any) === ('add_member' as any)  // zca-js có thể có ADD_MEMBER
        ) {
            const updates = Array.isArray(base.updateMembers)
                ? base.updateMembers
                : [];
            const newMembers: Array<{ uid: string; name: string }> = [];
            for (const m of updates) {
                const uid = String(m?.id ?? m?.userId ?? m?.uid ?? '');
                const name = String(m?.dName ?? m?.displayName ?? m?.name ?? '');
                if (uid && name) {
                    newMembers.push({ uid, name });
                }
            }

            if (newMembers.length === 0) return;

            console.log(`[GroupEvent] ${event.type} thread=${groupId} groupName="${base.groupName ?? ''}" newMembers=${newMembers.map(m => `${m.name}(${m.uid})`).join(',')}`);

            // 1. Thêm uid vào memberUids cache của thread
            try {
                const { addMembersToThread } = await import("./module/threads");
                addMembersToThread(groupId, newMembers.map(m => m.uid), Object.fromEntries(newMembers.map(m => [m.uid, m.name])));
                console.log(`[GroupEvent] → Đã thêm ${newMembers.length} member mới vào cache thread ${groupId}`);
            } catch (e: any) {
                console.warn(`[GroupEvent] addMembersToThread failed: ${e?.message ?? e}`);
            }

            // 2. Update lastSeenInThread cho targets trong group (không còn match theo tên)
            for (const { uid, name } of newMembers) {
                try {
                    const matched = matchUserToTarget(name, uid, groupId);
                    if (matched) {
                        console.log(`[GroupEvent] ⚡ New member "${name}" là target uid=${matched.uid} — đã update lastSeenInThread`);
                    }
                } catch { /* silent */ }
            }
            return;
        }

        // ── Case 2: LEAVE / REMOVE_MEMBER → có người rời group → drop khỏi cache
        if (
            event.type !== GroupEventType.LEAVE &&
            event.type !== GroupEventType.REMOVE_MEMBER
        ) return;

        const fromSource = base.sourceId ? [String(base.sourceId)] : [];
        const fromUpdates = Array.isArray(base.updateMembers)
            ? base.updateMembers.map((m: any) => String(m?.id ?? '')).filter(Boolean)
            : [];
        const uids = Array.from(new Set([...fromSource, ...fromUpdates]));
        if (uids.length === 0) return;

        console.log(`[GroupEvent] ${event.type} thread=${groupId} groupName="${base.groupName ?? ''}" uids=${uids.join(',')}`);

        // 1. Drop uid khỏi memberUids cache của thread
        const changed = removeMembersFromThread(groupId, uids);

        // 2. Nếu uid nào trùng target → clear lastSeenInThread
        for (const uid of uids) {
            try {
                const t = findTargetByUid(uid);
                if (t && t.lastSeenInThread === groupId) {
                    // ⚠️ FIX v1.5.28-treonhay — Dùng helper clearTargetLastSeen
                    clearTargetLastSeen(uid, groupId);
                    console.log(`[GroupEvent] → Cleared lastSeenInThread cho target uid=${uid}`);
                }
            } catch { }
        }

        if (changed) {
            console.log(`[GroupEvent] → Đã sync cache: drop ${uids.length} uid(s) khỏi memberUids của thread ${groupId}`);
        }
    } catch (e: any) {
        console.warn('[GroupEvent] handler error:', e?.message ?? e);
    }
});

listener.onConnected(() => {
    reconnectAttempts = 0;  // reset counter
    connectedAt = Date.now();  // đánh dấu thời điểm connect để tính grace period
    noMessageWarned = false;  // reset cờ warn khi reconnect lại
    console.log("✓ [Listener] Connected to Zalo as Nguyễn Đình Dương");
    console.log("  → Listening for both User (DM) and Group messages");
    console.log("  → Persona: Nguyễn Đình Dương — thích gây sự, va chạm, cục tính, cà khịa");
    console.log("  ⚠️  QUAN TRỌNG: KHÔNG mở Zalo Web/PC cùng lúc — sẽ làm listener bị Zalo stop silently!");
    console.log("  ⚠️  Nếu bot không rep: đóng Zalo PC/Web, restart bot, đảm bảo chỉ 1 listener chạy.");

    // ============================================================
    // ⚠️ FIX v1.5.0 — Sync TẤT CẢ group bot đang là member
    // Trước đây bot chỉ biết group nơi nó ĐÃ nhận tin nhắn → proactive scheduler
    // chỉ fire vào 1 group. Giờ fetch tất cả group từ Zalo API để scheduler có thể
    // fire đều giữa các group.
    // ============================================================
    void (async () => {
        try {
            const result = await syncAllGroupsFromZalo();
            if (result.added > 0) {
                console.log(`[Threads] ✓ Đã thêm ${result.added} group mới từ Zalo API (tổng ${result.total} thread)`);
                // Match targets với members của các group mới (async, không block)
                void (async () => {
                    try {
                        const { loadThreads } = await import("./module/threads");
                        const threads = loadThreads().filter((t) => t.threadType === 'Group' && t.memberUids?.length);
                        for (const t of threads) {
                            if (!t.memberUids || !t.memberNames) continue;
                            for (const uid of t.memberUids) {
                                const name = t.memberNames[uid];
                                if (name) matchUserToTarget(name, uid, t.threadId);
                            }
                        }
                    } catch (e) {
                        console.warn('[Threads] Match targets với members failed:', e);
                    }
                })();
            }
        } catch (e: any) {
            console.warn(`[Threads] Sync groups từ Zalo API failed: ${e?.message ?? e}`);
        }
    })();

    // ============================================================
    // Proactive scheduler — bot TỰ chửi targets theo interval random
    // ============================================================
    const targets = loadTargets();
    // ⚠️ FIX v1.5.28-treonhay — Chỉ in uid ở log, kèm async fetch displayName để debug.
    console.log(`  → Targets loaded: ${targets.map((t) => t.uid).join(', ')}`);
    console.log(`  → Starting proactive scheduler (bot sẽ TỰ chửi mỗi 8-30 phút)`);
    startProactiveScheduler();
    // Async fetch displayName cho tất cả targets để log (không block boot)
    void (async () => {
        try {
            const uids = targets.map((t) => t.uid);
            const names = await getTargetDisplayNames(uids);
            const summary = targets.map((t) => `${names.get(t.uid) ?? '?'} (${t.uid})`).join(', ');
            console.log(`  → Targets displayNames: ${summary}`);
        } catch { /* ignore */ }
    })();

    // ============================================================
    // Heartbeat monitor — check listener có còn nhận msg không
    // + Queue stats để debug "bot không rep" issue
    // ============================================================
    const NO_MSG_GRACE_MS = 5 * 60 * 1000;  // 5 phút sau connect mới warn
    setInterval(() => {
        const now = Date.now();
        const sinceLastMsg = lastMessageReceivedAt ? Math.round((now - lastMessageReceivedAt) / 60000) : -1;
        const sinceConnect = now - connectedAt;
        const stats = queue.getStats();
        console.log(
            `[Heartbeat] listenerStarted=${listenerStarted} msgCount=${messageReceiveCount} sinceLastMsg=${sinceLastMsg >= 0 ? sinceLastMsg + ' phút' : '(chưa nhận msg)'} | Queue: active=${stats.active}/${stats.maxConcurrency} queued=${stats.queued} peak=${stats.peakConcurrency} processed=${stats.totalProcessed} errors=${stats.totalErrors}`,
        );

        // Chỉ warn 1 lần khi:
        // - Đã connect > 5 phút
        // - Vẫn chưa nhận được tin nhắn nào
        // - Chưa từng warn trước đó
        // - Chưa vượt quá số lần reconnect cho phép
        if (
            !noMessageWarned &&
            messageReceiveCount === 0 &&
            sinceConnect >= NO_MSG_GRACE_MS &&
            reconnectAttempts < MAX_RECONNECT_ATTEMPTS
        ) {
            console.warn(`[Heartbeat] ⚠ Bot đã connect ${Math.round(sinceConnect / 60000)} phút mà chưa nhận được tin nhắn nào. Có thể:`);
            console.warn(`  - Bạn đang mở Zalo Web/PC cùng lúc (đóng Zalo Web/PC đi!)`);
            console.warn(`  - Listener bị Zalo drop silently (restart bot)`);
            console.warn(`  - Tài khoản bị limit`);
            console.warn(`  - Đợi proactive scheduler fire (mỗi 8-30 phút) — nếu không thấy fire thì listener chết`);
            noMessageWarned = true;
        }

        // ⚠️ FIX v1.5.0 — Warn khi queue có nhiều thread đang chờ
        // (trước đây queue serial → stuck, giờ per-thread concurrent nhưng vẫn có thể
        // chờ nếu vượt maxConcurrency)
        if (stats.queued > 0 && stats.active >= stats.maxConcurrency) {
            console.warn(`[Queue] ⚠ Đã đạt max concurrency (${stats.active}/${stats.maxConcurrency}), ${stats.queued} thread đang chờ.`);
        }
    }, 2 * 60 * 1000);  // mỗi 2 phút
});

listener.onClosed(() => {
    console.log("✗ [Listener] Connection closed — sẽ thử reconnect sau 5s");
    listenerStarted = false;
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`[Listener] Đã reconnect ${MAX_RECONNECT_ATTEMPTS} lần fail — thoát.`);
        process.exit(1);
    }
    setTimeout(() => {
        console.log(`[Listener] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
        startListenerWithReconnect();
    }, 5000);
});

listener.onError((error: any) => {
    console.error("[Listener] Error:", error?.message ?? error);
    console.error("[Listener] Stack:", error?.stack ?? '(no stack)');
});

// Start listener
startListenerWithReconnect();
console.log("→ Starting Zalo bot Nguyễn Đình Dương...");
console.log("  ThreadType mapping: User=0 (DM), Group=1");
console.log("  Login flow: try cookie → fallback QR → save credentials.json\n");
console.log("  Persona: Nguyễn Đình Dương — chuyên gây sự, cục tính, hay cà khịa, sẵn sàng chửi nhau");
console.log("  ⚠️  NHỚ: KHÔNG mở Zalo Web/PC cùng lúc với bot!\n");
