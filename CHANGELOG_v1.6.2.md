# CHANGELOG v1.6.2 — Bug Audit + Critical Fixes

> Audit toàn bộ codebase (~15,000 dòng) + fix **16 issues** từ critical → minor.
> Kiểm tra cross-reference với `zca-js` source API signatures.

---

## 🔴 P0 — Critical Bugs (4 fixes)

### C1. `addReaction` KHÔNG BAO GIỜ hoạt động
**File:** `src/module/ai.ts:1668-1695`

System prompt yêu cầu AI trả `{{msgId}}`/`{{cliMsgId}}` placeholder, nhưng không có code nào replace → `parseInt("{{msgId}}")` = `NaN` → API fail silent.

**Fix:** Resolve `msgId`/`cliMsgId` từ `getMessageByShortId(shortId)` nếu AI để placeholder hoặc giá trị NaN.

```ts
let reactionMsgId = String(action.msgId ?? '');
let reactionCliMsgId = String(action.cliMsgId ?? '');
if (shortId && (!reactionMsgId || reactionMsgId === '{{msgId}}' || isNaN(Number(reactionMsgId)))) {
    const rec = getMessageByShortId(shortId);
    const d = rec?.payload?.data;
    if (d?.msgId) reactionMsgId = String(d.msgId);
    if (d?.cliMsgId) reactionCliMsgId = String(d.cliMsgId);
}
```

---

### C3. `sendTypingEvent` spam trong stream → Zalo rate-limit/ban risk
**File:** `src/module/ai.ts:1051-1059`

Trước đây: mỗi textPart (1-5 chars) = 1 typing event → 40-200 events/giây.

**Fix:** Throttle 1 lần / 3 giây.

```ts
let lastTypingSent = 0;
const TYPING_THROTTLE_MS = 3000;
for await (const textPart of result.textStream) {
    const now = Date.now();
    if (now - lastTypingSent > TYPING_THROTTLE_MS) {
        try { global.api.sendTypingEvent(threadId, zaloThreadType); } catch { }
        lastTypingSent = now;
    }
    out += textPart;
}
```

---

### C4. Timezone bug — `getTimeSlot()` / `hienThiNgayGioVN()` dùng local server time
**File:** `src/module/ai.ts:80-88, 146-147`, `src/module/human.ts:96-104`

Trước đây: `new Date().getHours()` = local server time (UTC trên VPS cloud) → sai mood/delay/typing speed cho khung giờ VN.

**Fix:** Dùng `Intl.DateTimeFormat` với `timeZone: 'Asia/Ho_Chi_Minh'`.

```ts
export function getVietnamHour(date: Date = new Date()): number {
    const hStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit', hour12: false,
    }).format(date);
    let h = parseInt(hStr, 10);
    if (h === 24) h = 0;
    return h;
}
```

Test: UTC `2026-07-09T16:00:00Z` (= VN 23:00) → `getVietnamHour()` returns `23` ✓

---

### C6. `NhayMessages` không có max total cap → spam 900 tin → Zalo ban
**File:** `src/module/AiTool.ts:1425-1454`

Trước đây: file 900 dòng + không truyền `max` → bot gửi 900 tin → Zalo ban.

**Fix:** Thêm `MAX_NHAY_TOTAL = 30` cap. Nếu admin thực sự muốn nhiều hơn, phải explicit `max=N`.

```ts
const MAX_NHAY_TOTAL = 30;
const effectiveMax = typeof max === 'number' && max > 0 ? Math.min(max, MAX_NHAY_TOTAL) : MAX_NHAY_TOTAL;
if (effectiveLines.length > effectiveMax) {
    if (typeof max !== 'number') {
        console.warn(`[NhayMessages] ⚠ Capped to ${MAX_NHAY_TOTAL} tin — truyền max=N nếu muốn gửi nhiều hơn`);
    }
    effectiveLines = effectiveLines.slice(0, effectiveMax);
}
```

---

## 🟡 P1 — High Priority Bugs (4 fixes)

### C2. `currentThreadId` race condition — module-level variable chia sẻ giữa 5 concurrent threads
**File:** `src/module/ai.ts:1148-1167`

`queue.ts` chạy 5 threads song song. Khi 2 thread gọi `executeAI` concurrently, `currentThreadId = threadId` ghi đè lẫn nhau.

**Fix:** Truyền `threadId` qua parameter thay vì module-level.

```ts
// Before:
let currentThreadId: string | undefined;
function calcHumanDelay(content, isBurst) {
    return calcHumanDelayHuman(content, isBurst, currentThreadId);
}

// After:
function calcHumanDelay(content, isBurst, threadId?: string) {
    return calcHumanDelayHuman(content, isBurst, threadId);
}
```

---

### C5. `senderId` fallback inconsistency cho chat.photo / chat.video
**File:** `src/index.ts:712, 789`

Trước đây: nếu `uidFrom` thiếu cho group photo/video → `senderId = threadId` (= groupId) → toàn bộ users trong group chia sẻ 1 image cooldown.

**Fix:** Đồng bộ với pattern fix v1.5.19: `senderId = String(uidFrom ?? '')`.

---

### C7. `extractJsonArray` regex `[end]` là character class, không phải literal
**File:** `src/module/ai.ts:1943-1945`

Trước đây: `/^[end][a-zA-Z]*\n?/` = character class matching `{e, n, d}` → strip `'d'+'ata'` từ `'data: ...'` → JSON parse fail.

**Fix:** Escape `[` và `]`: `/^\[end\][a-zA-Z]*\n?/`.

---

### C8. `getServiceStats().successRate` luôn trả 0 hoặc 1
**File:** `src/module/apikey.ts:964-972`

Trước đây: `success / Math.max(1, success)` → luôn 0 hoặc 1.

**Fix:** `success / totalCalls` (tính đúng rate).

```ts
const allKeys = Array.from(map.values());
const totalCalls = allKeys.reduce((s, k) => s + k.totalCalls, 0);
const failedCalls = allKeys.reduce((s, k) => s + (k.totalCalls - k.successCalls), 0);
return {
    ...
    totalCalls,
    successfulCalls: success,
    failedCalls,
    successRate: totalCalls === 0 ? 0 : success / totalCalls,
};
```

---

## 🟢 P2 — Medium Priority (8 fixes)

### M3. Reaction cooldown per-turn → per-thread Map
**File:** `src/module/ai.ts:1159-1161, 1606, 1701`

Trước đây: `lastReactionAt` là local var reset mỗi `executeAI` call → bot có thể react mỗi turn.

**Fix:** Module-level `Map<threadId, timestamp>` để track cooldown cross-turn.

```ts
const reactionCooldownMap = new Map<string, number>();
// ...
const lastReactionAtForThread = reactionCooldownMap.get(threadId) ?? 0;
// ...
reactionCooldownMap.set(threadId, now);
```

---

### M4. `debugReportApiKey` luôn chạy trong production
**File:** `src/module/apikey.ts:199-210`

Trước đây: 5-10 file reads + 5-10 failed HTTP connections mỗi AI call → overhead.

**Fix:** Gate bằng env var `DEBUG_APIKEY=true`.

---

### M6. `FindUserInAnyGroup` sequential → parallel
**File:** `src/module/AiTool.ts:1290-1310`

Trước đây: 20 groups × 2-5s sequential = 40-100s.

**Fix:** `Promise.allSettled(threads.map(...))` → tổng thời gian = max(group) ≈ 5s.

---

### M7. `findTargetByName` sequential `getUserInfo` → bulk fetch
**File:** `src/module/proactive.ts:791-807`

Trước đây: 10 targets × 1-3s = 10-30s.

**Fix:** Dùng `getTargetDisplayNames(uids)` (đã có sẵn, dùng `Promise.all`).

---

### M10. Privacy: toàn bộ DM content logged ra stdout
**File:** `src/index.ts:683-692`

Trước đây: 80 ký tự đầu của MỌI tin nhắn (DM + group) log ra stdout → lộ nội dung riêng tư.

**Fix:** Mask content trong production (chỉ log type + length). Set `DEBUG_LOG=true` để xem preview.

---

### M11. `startTypingIndicator` setTimeout không cleanup
**File:** `src/module/human.ts:279-321`

Trước đây: 3 setTimeout scheduled nhưng không trả handle. Nếu `executeAI` kết thúc sớm, typing refreshes vẫn fire sau khi đã gửi.

**Fix:** Trả về cleanup function. Caller gọi `stopTyping()` ngay sau khi send.

```ts
return () => {
    for (const t of timers) clearTimeout(t);
};
```

---

### m1. `require('path')` / `require('fs')` → ESM import
**File:** `src/module/AiTool.ts:960-961, 998-999, 1021-1022`

Đã có `import path from 'path'; import fs from 'fs';` ở top-level nhưng trong code vẫn dùng `require('path')`. Dead code `const { path: pathMod } = { path: require('path') };` cũng được remove.

---

### m2. Fisher-Yates shuffle (uniform) thay vì `sort(Math.random()-0.5)` (biased)
**File:** `src/module/ai.ts:114-121`

`sort(Math.random() - 0.5)` không tạo uniform shuffle (bias toward original order). Fisher-Yates là thuật toán chuẩn.

---

### m4. Hardcode boss UID → env var
**File:** `src/module/social.ts:51`

```ts
// Before:
const isBoss = cleanUid === '2716720122162617538';

// After:
const BOSS_UID = process.env.BOSS_UID ?? '2716720122162617538';
const isBoss = cleanUid === BOSS_UID;
```

Cho phép đổi admin account mà không cần sửa code.

---

## 📊 Tổng kết

| Mức độ | Số fix | Files affected |
|---|---|---|
| 🔴 P0 Critical | 4 | ai.ts, AiTool.ts, human.ts, index.ts |
| 🟡 P1 High | 4 | ai.ts, index.ts, apikey.ts |
| 🟢 P2 Medium | 8 | ai.ts, AiTool.ts, human.ts, apikey.ts, proactive.ts, social.ts, autoResponder.ts, index.ts |
| **TOTAL** | **16** | **8 files** |

### Files changed:
- `src/module/ai.ts` — 8 fixes (timezone, reaction, typing throttle, currentThreadId, [end] regex, Fisher-Yates, typing cleanup, reaction cooldown)
- `src/module/AiTool.ts` — 3 fixes (NhayMessages cap, parallel search, require→ESM)
- `src/module/human.ts` — 2 fixes (timezone, typing cleanup)
- `src/index.ts` — 2 fixes (senderId photo/video, privacy log)
- `src/module/apikey.ts` — 2 fixes (successRate, debugReportApiKey)
- `src/module/proactive.ts` — 1 fix (parallel findTargetByName)
- `src/module/social.ts` — 1 fix (BOSS_UID env var)
- `src/module/autoResponder.ts` — 1 fix (delayMs optional + max/shuffle support)

### Version bump: `1.6.0` → `1.6.2`
