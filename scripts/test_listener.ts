/**
 * test_listener.ts — Script debug MINIMAL để test zca-js listener có nhận msg không
 *
 * Chạy: bun run scripts/test_listener.ts
 *
 * Script này:
 * 1. Login bằng cookie (đã có sẵn)
 * 2. Start listener
 * 3. Log TẤT CẢ events: connected, message, closed, error
 * 4. KHÔNG có AI, KHÔNG có emotion, KHÔNG có scheduler — chỉ listener thuần
 *
 * Mục đích: xác định xem listener có hoạt động không, nếu không thì vấn đề ở đâu.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Zalo, ThreadType, type Message } from "zca-js";

async function main() {
    console.log('=== Test Listener MINIMAL ===\n');

    if (!fs.existsSync('./credentials.json')) {
        console.error('❌ Không có credentials.json. Chạy bot chính trước để login + save credentials.');
        process.exit(1);
    }

    const creds = JSON.parse(fs.readFileSync('./credentials.json', 'utf-8'));
    console.log(`[Test] Found credentials, uid=${creds.uid ?? '?'}`);

    const zalo = new Zalo({
        // Bật selfListen để debug được cả tin nhắn do chính tài khoản bot gửi.
        selfListen: true,
    });
    console.log('[Test] Logging in with cookie...');
    const api = await zalo.login({
        imei: creds.imei,
        cookie: creds.cookie,
        userAgent: creds.userAgent,
    });
    console.log('[Test] ✓ Login OK');

    let msgCount = 0;

    // Đăng ký TẤT CẢ events có thể
    api.listener.on("message", (message: Message) => {
        msgCount += 1;
        console.log(`\n[Test] 📨 MSG #${msgCount} ==============================`);
        console.log(`  type: ${message.type}`);
        console.log(`  threadId: ${message.threadId}`);
        console.log(`  isSelf: ${message.isSelf}`);
        console.log(`  content type: ${typeof message.data.content}`);
        console.log(`  content preview: ${JSON.stringify(message.data.content).slice(0, 100)}`);
        console.log(`  uidFrom: ${(message.data as any).uidFrom ?? '?'}`);
        console.log(`  msgId: ${message.data.msgId}`);
        console.log(`=================================================\n`);
    });

    api.listener.onConnected(() => {
        console.log('[Test] ✓ Listener CONNECTED');
        console.log('[Test] Hãy nhắn tin vào box để test...\n');
    });

    api.listener.onClosed(() => {
        console.log('[Test] ✗ Listener CLOSED');
    });

    api.listener.onError((err: any) => {
        console.error('[Test] Listener ERROR:', err?.message ?? err);
    });

    // Bất kỳ event nào khác? Try common event names
    const tryEvents = ['event', 'raw', 'data', 'disconnect', 'reconnect', 'end'];
    for (const ev of tryEvents) {
        try {
            (api.listener as any).on(ev, (...args: any[]) => {
                console.log(`[Test] 📡 Event "${ev}":`, args.length, 'args');
            });
        } catch {}
    }

    console.log('[Test] Starting listener...');
    api.listener.start();

    // Heartbeat
    setInterval(() => {
        console.log(`[Test] Heartbeat: msgCount=${msgCount}, time=${new Date().toLocaleTimeString('vi-VN')}`);
    }, 30 * 1000);

    // Hold process
    console.log('[Test] Bot đang chạy. Ctrl+C để thoát.\n');
}

main().catch((e) => {
    console.error('[Test] Fatal:', e);
    process.exit(1);
});
