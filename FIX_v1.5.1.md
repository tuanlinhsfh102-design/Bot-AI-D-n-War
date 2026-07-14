# FIX v1.5.1 — Train bot thông minh hơn, tùy cơ ứng biến

## Tổng quan

User feedback: "Bot hơi ngu, không tùy cơ ứng biến xử lý được mọi tình huống."

Phân tích source + AI config, tìm ra **8 điểm yếu** khiến bot "ngu":

| # | Điểm yếu | Hậu quả | Fix |
|---|---|---|---|
| 1 | Dùng `gemini-3.1-flash-lite-preview` (model lite) | Model lite kém reasoning, hay lặp pattern, sinh text lộn xộn | Upgrade → `gemini-3.1-flash` |
| 2 | Temperature 1.3 quá cao | Sinh text loạn, mất focus, lặp pattern | Giảm → 0.95 |
| 3 | `thinkingBudget: -1` (auto) | Model không đủ time suy nghĩ với prompt phức tạp | Set → 8192 token |
| 4 | History quá ngắn (20 items / 12 recent / 3500 chars) | Bot quên context sau 12 turn → reply không mạch lạc | Tăng → 40/20/8000 |
| 5 | 60% reaction drop ngẫu nhiên | Bot ít react → trông vô hồn, machine-like | Bỏ drop → 0% (trust AI) |
| 6 | shouldReply 92% (8% skip) | Bot hay "bơ" tin nhắn quan trọng | Tăng → 98% (2% skip) |
| 7 | Image cooldown 20s quá cao | User gửi 3 ảnh/30s → bot chỉ hiểu ảnh đầu → reply ngu | Giảm → 10s |
| 8 | System prompt rườm rà, thiếu reasoning guide | Model không biết phải "suy nghĩ" trước khi reply | Rewrite với REASONING section + ADAPTIVE BEHAVIOR |

Bonus: Thêm **auto-emotion trigger** — bot tự update emotion state dựa trên nội dung user gửi TRƯỚC khi gọi AI → AI nhận emotion context chính xác hơn.

---

## 1. Upgrade model: flash-lite → flash

**File:** `src/module/ai.ts` + `tool.ts` + `tool/memory.ts` + `tool/enemyFace.ts` + `AiTool.ts` + `proactive.ts`

```typescript
// CODE CŨ — model lite, kém reasoning
'gemini-3.1-flash-lite-preview'

// CODE MỚI — flash chuẩn, reasoning + tool use tốt hơn nhiều
'gemini-3.1-flash'
```

**Lý do:** `flash-lite-preview` là model nhẹ preview, bị critique là "ngu" — sinh text lộn xộn, không nắm context tốt, lặp lại pattern. `flash` chuẩn có capability reasoning + tool use tốt hơn nhiều, đặc biệt với prompt phức tạp và multi-step tool calls.

**Trade-off:** Tốn ~2x token/turn hơn lite, nhưng Gemini Flash 2.0 có context window 1M token và rate limit generous → không vấn đề. Quality > cost.

---

## 2. Temperature 1.3 → 0.95

**File:** `src/module/ai.ts`

```typescript
// CODE CŨ
temperature: 1.3,  // cao hơn trap girl để chửi đa dạng

// CODE MỚI
temperature: 0.95,
```

**Lý do:** Temperature 1.3 quá cao → model sinh text loạn, mất focus, lặp pattern sai (vì random quá). 0.95 vẫn creative nhưng coherent hơn, đặc biệt với reasoning tasks.

---

## 3. thinkingBudget: -1 → 8192

**File:** `src/module/ai.ts`

```typescript
// CODE CŨ
thinkingConfig: { thinkingBudget: -1 },  // auto

// CODE MỚI
thinkingConfig: { thinkingBudget: 8192, includeThoughts: false },
```

**Lý do:** `-1` (auto) có thể chọn quá thấp với prompt phức tạp (system prompt ~3000 token + history 8000 token + tools). 8192 token cho model suy nghĩ ~2-3 paragraph trước khi reply → reasoning tốt hơn, đặc biệt cho tình huống phức tạp (user nổ cần fact-check, user hỏi info cần tool call, v.v.).

Cũng tăng từ `stepCountIs(10)` → `stepCountIs(15)` để bot có thể gọi nhiều tool hơn trước khi reply (search, get members, send image, ...).

---

## 4. Tăng history limit

**File:** `src/module/ai.ts` + `src/module/tool.ts`

```typescript
// CODE CŨ
const MAX_HISTORY_ITEMS = 20;
const KEEP_RECENT = 12;
const MAX_HISTORY_CHARS = 3500;
const TALK_HISTORY_KEEP_LAST = 48;
const TALK_SUMMARY_KEEP_RECENT = 12;

// CODE MỚI
const MAX_HISTORY_ITEMS = 40;
const KEEP_RECENT = 20;
const MAX_HISTORY_CHARS = 8000;
const TALK_HISTORY_KEEP_LAST = 80;
const TALK_SUMMARY_KEEP_RECENT = 20;
```

**Lý do:** Trước đây bot quên context sau 12 turn → không nhớ user đã nói gì cách đây 13 turn → reply không mạch lạc, lặp ý. Giờ bot nhớ 20 turn gần nhất + 8000 chars history → reply có context phong phú hơn.

Cũng tăng `last10` → `last15` trong system prompt để bot thấy nhiều context hơn.

---

## 5. Bỏ 60% reaction drop

**File:** `src/module/ai.ts`

```typescript
// CODE CŨ
const REACTION_COOLDOWN_MS = 5 * 60 * 1000;  // 5 phút
const REACTION_DROP_CHANCE = 0.6;  // 60% drop ngẫu nhiên

// CODE MỚI
const REACTION_COOLDOWN_MS = 2 * 60 * 1000;  // 2 phút
const REACTION_DROP_CHANCE = 0.0;  // 0% drop — trust AI decision
```

**Lý do:** Trước đây AI quyết định react → 60% bị drop random → bot trông vô hồn, ít reaction. Giờ trust AI — AI đã có rule "tối đa 30% reaction" trong prompt, không cần drop thêm. Bot sẽ react khi AI thấy phù hợp → tự nhiên hơn.

---

## 6. shouldReply 92% → 98%

**File:** `src/module/human.ts`

```typescript
// CODE CŨ
return Math.random() < 0.92;  // 8% skip

// CODE MỚI
return Math.random() < 0.98;  // 2% skip
```

**Lý do:** 8% skip quá cao → bot thường "bơ" tin nhắn quan trọng, trông như bot bị lỗi. 2% skip vẫn giữ tính "người thật" (đôi khi bận không reply) nhưng không bỏ lỡ context quan trọng.

---

## 7. Giảm image cooldown 20s → 10s

**File:** `src/module/index.ts`

```typescript
// CODE CŨ
const IMAGE_COOLDOWN_MS = 20_000;   // 20s
const VIDEO_COOLDOWN_MS = 60_000;   // 60s

// CODE MỚI
const IMAGE_COOLDOWN_MS = 10_000;   // 10s
const VIDEO_COOLDOWN_MS = 30_000;   // 30s
```

**Lý do:** Trước đây 20s quá cao → nếu user gửi 3 ảnh trong 30s, bot chỉ mô tả ảnh đầu, 2 ảnh sau bị skip → bot không hiểu context đầy đủ → reply ngu. 10s vẫn đủ chống spam nhưng đỡ skip context quan trọng.

---

## 8. Rewrite system prompt

**File:** `src/module/ai.ts`

### Thay đổi chính:

#### a) Thêm section "REASONING BEFORE REPLY" ở đầu prompt

```
## 🧠 REASONING BEFORE REPLY (BẮT BUỘC)

Trước khi trả lời, hãy TỰ SUY NGHĨ theo các bước:

1. **ĐỌC CONTEXT**: Ai đang nói? Vai trò của họ với mình là gì?
2. **PHÂN TÍCH Ý ĐỊNH**: Họ đang hỏi thật? Thử thách? Khịa? Xin lỗi? Nổ?
3. **CHỌN PHẢN ỨNG**: Dựa vào ý định + vai trò + context gần đây
4. **KIỂM TRA CONTEXT GẦN ĐÂY**: Tránh lặp lại câu đã dùng
5. **CHỌN FORMAT**: 1-4 tin ngắn, có delay, có thể add reaction
```

→ Buộc model "think step by step" trước khi reply → reply chất lượng hơn.

#### b) Dùng markdown headings + tables thay vì plain text

Trước đây: prompt là 1 block text dài, khó parse. Giờ: `## SECTION` + `| Table |` → model hiểu structure tốt hơn.

#### c) Thêm section "TÙY CƠ ỨNG BIẾN (ADAPTIVE BEHAVIOR)"

```
- User hỏi nghiêm túc → trả lời tử tế (kể cả ENEMY hỏi info → có thể trả lời rồi khịa)
- User buồn/kể chuyện → empathy nhẹ, không phải lúc nào cũng chửi
- User kể chuyện hài → react HAHA, có thể contribution thêm
- User hỏi opinion → đưa opinion cá nhân, có góc nhìn riêng
- User spam/sticker → có thể spam lại, hoặc chửi "rảnh hả"
- User im lặng lâu rồi nhắn → "ê m còn sống không :)))"
- User thay đổi topic → follow topic mới
- User thách đấu (game, thể thao, info) → chấp nhận challenge, dùng tool để win
```

→ Bot không còn "machine-like" — biết tùy cơ ứng biến theo từng tình huống.

#### d) Bỏ rule trùng lặp, rườm rà

- Gộp "DANH SÁCH ĐEN" vào section "QUY TẮC ỨNG XỬ THEO VAI TRÒ"
- Bỏ phần "WAR MODE TỪ TỤC" + "VÍ DỤ CHILL" + "VÍ DỤ WAR" dài dòng — đã có samples section
- Gộp "HÀNH VI" vào section "TOOLS QUAN TRỌNG"

---

## 9. Auto-emotion trigger (BONUS)

**File:** `src/module/ai.ts`

```typescript
// ⚠️ FIX v1.5.1 — Auto-trigger emotion dựa trên nội dung tin nhắn user vừa gửi.
// Trước đây bot chỉ update emotion qua tool RecordSocialSignal (chậm, AI hay quên).
// Giờ: phân tích nhanh nội dung user gửi → trigger emotion phù hợp TRƯỚC khi gọi AI
// → AI nhận emotion context chính xác hơn → reply phù hợp mood.
try {
    const latestUserContent = (messages[messages.length - 1] ?? '').toLowerCase();
    const isInsult = /\b(đĩ|địt|lồn|cặc|đm|sủa|câm|cút|óc chó|ngu|...)\b/i.test(latestUserContent);
    const isCompliment = /\b(đẹp trai|thông minh|giỏi|pro|vip|...)\b/i.test(latestUserContent);
    const isChallenge = /\b(war đi|lên đi|thách thức|1v1|...)\b/i.test(latestUserContent);
    const isBragging = /\b(tao có|tao giàu|nhà tao|mẹ tao|...)\b/i.test(latestUserContent);

    if (isInsult) {
        triggerEmotion(senderId, 'aggressive', 7, `User chửi: ${latestUserContent.slice(0, 60)}`);
    } else if (isCompliment) {
        bumpAffinity(senderId, 5);
    } else if (isChallenge) {
        triggerEmotion(senderId, 'cocky', 6, `User thách thức: ...`);
    } else if (isBragging) {
        triggerEmotion(senderId, 'savage', 5, `User nổ: ...`);
    }
} catch { /* silent fail */ }
```

**Lý do:** Trước đây emotion state chỉ update qua tool `RecordSocialSignal` mà AI gọi — nhưng AI hay quên hoặc gọi không đúng lúc. Giờ code tự phân tích nhanh nội dung user gửi → trigger emotion phù hợp **TRƯỚC** khi gọi AI → AI nhận emotion context chính xác → reply phù hợp mood (aggressive khi bị chửi, cocky khi bị thách thức, savage khi user nổ).

**Test:** `bun /home/z/my-project/scripts/test_emotion.ts` — 5/5 test pass.

---

## Files changed

| File | Change |
|---|---|
| `src/module/ai.ts` | Model upgrade, temp, thinkingBudget, history limit, system prompt rewrite, auto-emotion trigger, reaction drop removal |
| `src/module/human.ts` | shouldReply 92% → 98% |
| `src/module/tool.ts` | Talk history limits 48/12 → 80/20 |
| `src/module/tool/memory.ts` | Model flash-lite → flash |
| `src/module/tool/enemyFace.ts` | Model flash-lite → flash |
| `src/module/AiTool.ts` | Model flash-lite → flash |
| `src/module/proactive.ts` | Model flash-lite → flash |
| `src/index.ts` | Image cooldown 20s → 10s, video cooldown 60s → 30s |

---

## Test

```bash
# Test emotion trigger (5/5 pass)
bun /home/z/my-project/scripts/test_emotion.ts

# Test queue (12/12 pass — vẫn giữ từ v1.5.0)
bun /home/z/my-project/scripts/test_queue.ts

# Build check
cd eaz && bun build src/index.ts --target=bun --outdir /tmp/eaz-build
# → Bundled 624 modules in 129ms, no errors
```

---

## Cách verify sau deploy

1. **Bot reply mượt hơn** — đọc log `[AI]` để xem AI response. Trước đây hay lặp pattern "đĩ mẹ m war đi" → giờ đa dạng hơn.

2. **Bot nhớ context dài hơn** — chat 20 turn, hỏi lại "nãy m nói gì" → bot nhớ (trước đây quên sau 12 turn).

3. **Bot react tự nhiên hơn** — đếm số reaction / 10 turn. Trước đây ~1/10 (do 60% drop), giờ ~3/10.

4. **Bot xử lý ảnh nhanh hơn** — gửi 3 ảnh trong 20s → bot mô tả cả 3 (trước đây chỉ 1).

5. **Bot thông minh hơn khi reasoning** — hỏi câu phức tạp "nếu A thì B, nhưng nếu C thì D, vậy kết luận gì?" → bot trả lời mạch lạc (trước đây trả lời lộn xộn).

6. **Bot tùy cơ ứng biến** — test các tình huống:
   - Hỏi nghiêm túc "thời tiết HN hôm nay" → bot dùng tool weather
   - Nổ "nhà tao giàu" → bot savage "rảnh vãi đi khoe"
   - Buồn "hôm nay tao buồn" → bot empathy nhẹ "sao z, kể đi"
   - Spam sticker → bot "rảnh hả :)))"

7. **Emotion state update real-time** — check `data/user/<uid>/emotion.json` sau khi chat. State phải thay đổi theo nội dung chat (aggressive khi chửi, cocky khi thách thức, savage khi nổ).
