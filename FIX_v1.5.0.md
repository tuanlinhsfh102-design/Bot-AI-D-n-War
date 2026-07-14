# FIX v1.5.0 — Bot chỉ tương tác 1 group, bơ mấy group còn lại

## Tổng quan

User report: Bot chỉ reply/react ở 1 group duy nhất, không phản hồi ở các group khác
dù đã được add vào. Sau khi phân tích source code + database (945 messages trong
`8072231092820900983` vs 5-7 messages ở 2 DM), tìm ra **3 root cause**:

---

## Root Cause #1 — MessageQueue serial blocking (CRITICAL)

**File:** `src/module/queue.ts`

**Vấn đề:**

```typescript
// CODE CŨ — global serial flag
private processing = false;  // ← SINGLE GLOBAL FLAG

private async processNext() {
    if (this.processing) return;  // ← BLOCK tất cả thread nếu đang xử lý 1 thread
    // ...
    this.processing = true;
    // ...
}
```

Khi 1 thread đang được `processThread` xử lý (mất **15-75 giây** do AI generate +
multiple sendMessage với human-like delay), TẤT CẢ thread khác (group B, C, DM, ...)
bị BLOCK trong queue. User thấy bot "chỉ rep ở 1 group, bơ mấy group còn lại".

Đặc biệt nguy hiểm khi group A active nhiều → queue luôn ưu tiên A → các group khác
không bao giờ được xử lý kịp thời.

**Fix:**

```typescript
// CODE MỚI — per-thread concurrency
private processingThreads = new Set<string>();  // ← PER-THREAD LOCK
private activeCount = 0;
private readonly maxConcurrency: number = 5;   // ← CAP

private async processNext() {
    if (this.activeCount >= this.maxConcurrency) return;
    
    // Pick threadId KHÔNG đang được xử lý
    let nextId: string | undefined;
    let i = 0;
    while (i < this.queue.length) {
        const candidate = this.queue[i];
        if (this.processingThreads.has(candidate)) {
            i++;  // Skip — đang xử lý
            continue;
        }
        this.queue.splice(i, 1);
        this.inQueue.delete(candidate);
        nextId = candidate;
        break;
    }
    // ...
}
```

**Behavior sau fix:**

| Tình huống | Trước fix | Sau fix |
|---|---|---|
| 3 thread đến cùng lúc | Xử lý serial (3 × 60s = 180s) | Xử lý song song (60s) ✓ |
| Group A đang xử lý, Group B msg đến | B chờ A xong (60s delay) | B xử lý ngay ✓ |
| Cùng Group A msg đến trong lúc xử lý | Re-queue, xử lý sau | Vẫn serial per-thread (ko lộ bot) ✓ |
| 10 thread đến cùng lúc | Tất cả chờ | 5 chạy + 5 chờ (maxConcurrency=5) ✓ |

**Test:** `bun /home/z/my-project/scripts/test_queue.ts` — 12/12 test pass.

---

## Root Cause #2 — API key rotation broken (4/5 keys never used)

**File:** `src/module/apikey.ts`

**Vấn đề:**

Trong production, state file `data/api_key_state.json` cho thấy:

```
AIzaSyBb...oMPc: 267 calls (100% success)
AIzaSyAx...8oQk:   0 calls  ← chưa bao giờ được dùng!
AIzaSyCQ...jR3Y:   0 calls  ← chưa bao giờ được dùng!
AIzaSyDI...j_Yc:   0 calls  ← chưa bao giờ được dùng!
```

**Root cause:**

```typescript
// CODE CŨ — sort giảm dần, lấy [0]
const scored = healthy.map((k) => ({ key: k, score: computeHealthScore(k) + Math.random() * 0.05 }));
scored.sort((a, b) => b.score - a.score);
return scored[0].key;  // ← luôn trả về key có score cao nhất
```

Khi 1 key có score 1.0 (healthy, dùng thành công nhiều) và 4 key có score 0.5
(chưa từng dùng, qua grace period 1h), random tie-break 0.05 KHÔNG đủ để lật
kết quả → key 1.0 luôn thắng → 4 key kia không bao giờ có cơ hội.

**Hậu quả:**
- Khi key chính (AIzaSyBb) bị 429/quota → bot stuck (rotation không kịp switch)
- 4 key dự phòng không được warm-up → khi cần dùng cũng có thể fail
- All eggs in 1 basket → single point of failure

**Fix:**

```typescript
// CODE MỚI — weighted random selection
const scored = healthy.map((k) => ({
    key: k,
    score: Math.max(0.1, computeHealthScore(k)),  // floor 0.1 để key yếu vẫn có cơ hội
}));
const totalScore = scored.reduce((sum, s) => sum + s.score, 0);

let r = Math.random() * totalScore;
for (const s of scored) {
    r -= s.score;
    if (r <= 0) return s.key;
}
```

**Cũng fix `computeHealthScore`:**

```typescript
// CODE CŨ — recency BONUS (+0.05) → key càng dùng nhiều càng được dùng tiếp
const recencyBonus = k.lastUsedAt && (now - k.lastUsedAt < 30_000) ? 0.05 : 0;

// CODE MỚI — recency PENALTY (-0.15) → key vừa dùng sẽ step back, cho key khác cơ hội
let recencyAdjust = 0;
if (k.lastUsedAt) {
    const sinceLast = now - k.lastUsedAt;
    if (sinceLast < 10_000) recencyAdjust = -0.15;      // vừa dùng → step back
    else if (sinceLast < 60_000) recencyAdjust = 0.02;  // ấm → nhẹ bonus
}
```

**Behavior sau fix:**

| Tình huống | Trước fix | Sau fix |
|---|---|---|
| 5 key healthy, 1 dùng nhiều | Luôn dùng key đó | Phân phối theo weight (key tốt được pick nhiều hơn nhưng không phải luôn luôn) |
| Key chính 429 | Switch sang key dự phòng (cold) | Switch sang key đã được warm-up |
| Long-term | 1 key = 100% load | 5 key chia đều load |

---

## Root Cause #3 — Proactive scheduler bias 1 group

**File:** `src/module/proactive.ts` + `src/module/threads.ts` + `src/index.ts`

**Vấn đề:**

Proactive scheduler (`fireProvoke`) pick thread để gửi chửi chủ động:

```typescript
// CODE CŨ
if (target.uid) {
    const t = pickRandomThreadWithUid(target.uid);  // ← chỉ tìm trong known_threads
    if (t) { ... }
}
if (!threadId) {
    const t = pickRandomRecentThread(true);  // ← chỉ lấy group có activity trong 7 ngày
    if (t) { ... }
}
```

Vấn đề: `known_threads.json` chỉ chứa group nơi bot ĐÃ nhận tin nhắn.
Nếu user add bot vào 5 group nhưng chỉ 1 group có activity → scheduler chỉ fire vào
group đó. Bot không bao giờ "xưng presence" ở group mới.

**Fix 1 — Sync group list từ Zalo API khi connect:**

```typescript
// src/module/threads.ts — hàm mới
export async function syncAllGroupsFromZalo(): Promise<{ added: number; refreshed: number; total: number }> {
    const resp: any = await (global.api as any).getAllGroups();
    const gridVerMap = resp?.gridVerMap ?? {};
    const groupIds = Object.keys(gridVerMap);
    
    // Batch getGroupInfo chunk 10 group/lần
    for (let i = 0; i < groupIds.length; i += 10) {
        const chunk = groupIds.slice(i, i + 10);
        const info: any = await (global.api as any).getGroupInfo(chunk);
        // Cache name + memberUids vào known_threads.json
    }
}
```

Gọi khi `listener.onConnected`:

```typescript
// src/index.ts
listener.onConnected(() => {
    // ...
    void (async () => {
        const result = await syncAllGroupsFromZalo();
        console.log(`[Threads] ✓ Đã thêm ${result.added} group mới`);
    })();
});
```

**Fix 2 — Fair thread selection trong fireProvoke:**

```typescript
// CODE MỚI — 4-tier selection với exclude list (recent fire history)
const st = loadState();
const exclude = st.recentThreadIds?.slice(-3) ?? [];  // exclude 3 thread gần nhất

// Tier 1: group có target uid (chưa fire gần đây)
if (target.uid) {
    const t = pickRandomThreadWithUid(target.uid);
    if (t && !exclude.includes(t.threadId)) { ... }
}

// Tier 2: random known group (chưa fire gần đây) — bao gồm group mới sync
if (!threadId) {
    const t = pickRandomKnownGroup(exclude);
    if (t) { ... }
}

// Tier 3-4: fallback không exclude (better than nothing)
```

**Fix 3 — Track recent fire history:**

```typescript
// proactive.ts
interface ProactiveState {
    enabled: boolean;
    lastFireAt: number;
    totalFires: number;
    recentThreadIds?: string[];  // ← MỚI: track 3 thread gần nhất
}

// Sau khi fire thành công:
st.recentThreadIds.push(threadId);
if (st.recentThreadIds.length > 6) {
    st.recentThreadIds = st.recentThreadIds.slice(-6);
}
```

**Behavior sau fix:**

| Tình huống | Trước fix | Sau fix |
|---|---|---|
| Bot ở 5 group, 1 active | Chỉ fire ở 1 group | Fire đều 5 group ✓ |
| Fire lần N | Có thể trùng group lần N-1 | Exclude 3 group gần nhất → không trùng ✓ |
| Group mới add bot | Phải đợi có ai chat mới được fire | Sync ngay khi connect → được fire ✓ |

---

## Diagnostic Logging (bonus)

**File:** `src/index.ts` + `src/module/queue.ts`

Thêm stats chi tiết trong heartbeat:

```
[Heartbeat] listenerStarted=true msgCount=42 sinceLastMsg=0 phút | Queue: active=2/5 queued=1 peak=3 processed=38 errors=0
```

Thêm warning khi queue đạt max concurrency:

```
[Queue] ⚠ Đã đạt max concurrency (5/5), 2 thread đang chờ.
```

Queue cũng log khi bắt đầu và kết thúc xử lý 1 thread:

```
[Queue] ▶ Processing 8072231092820900983 (active=2/5, queued=1, msgs=3)
[Queue] ✓ Done 8072231092820900983 in 12.4s
```

→ User có thể theo dõi real-time để verify bot đang xử lý đa luồng.

---

## Files changed

| File | Change | Lines |
|---|---|---|
| `src/module/queue.ts` | Rewrite: per-thread concurrency + maxConcurrency cap + stats | ~210 |
| `src/module/apikey.ts` | Weighted random selection + recency penalty in computeHealthScore | ~80 |
| `src/module/threads.ts` | Add `syncAllGroupsFromZalo()`, `getAllKnownGroups()`, `pickRandomKnownGroup()` | ~125 |
| `src/module/proactive.ts` | Fair thread selection with exclude list + recentThreadIds tracking | ~60 |
| `src/index.ts` | Call syncAllGroupsFromZalo on connect + queue stats in heartbeat | ~40 |

---

## Test

```bash
# Test queue mechanics (12/12 pass)
bun /home/z/my-project/scripts/test_queue.ts

# Build check
cd eaz && bun build src/index.ts --target=bun --outdir /tmp/eaz-build
# → Bundled 624 modules in 112ms, no errors
```

---

## Cách verify sau khi deploy

1. **Đăng nhập Zalo** — bot tự sync danh sách group từ `getAllGroups()`
2. **Watch log:** `[Threads] ✓ Đã thêm N group mới từ Zalo API` — verify N = số group bot đang ở
3. **Watch log:** `[Queue] ▶ Processing <groupId> (active=X/5)` — verify X > 1 khi nhiều group chat cùng lúc
4. **Watch log:** `[Proactive] ✓ Fired chửi target="..." thread=<groupId>` — verify thread ID thay đổi sau mỗi fire (không lặp lại 1 group)
5. **Watch log:** `[ApiKey] ↻ Env default → Gemini key <fingerprint>` — verify key rotation khi 1 key vào cooldown
6. **`data/api_key_state.json`** sau 1 ngày — verify TẤT CẢ keys đều có totalCalls > 0
