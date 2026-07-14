# Zalo Sleiz Bot (Sleiz nhí 2k11)

Bot Zalo AI với persona **Sleiz** (nam, 15 tuổi, sinh năm 2k11, dân war nhí online) — thích gây sự, va chạm, cục tính, hay cà khịa, sẵn sàng chửi nhau, dùng mention để khịa đối phương trực tiếp.

Được phát triển từ project `Zalo-AI-Bot-TrapGirl` (Minh Châu), chuyển sang persona nam "dân war nhí" chuyên đi gây sự.

> **v1.1 (04/07/2026)**: Đổi tên bot từ "Sleiz" thành **Sleiz**, sinh năm 2k11 (15 tuổi), cập nhật system prompt cho hợp vibe Gen Z/Alpha.
> **v1.0 (04/07/2026)**: Persona Sleiz với hệ thống cảm xúc 11 trạng thái, 8 tool war chuyên dụng, kho ~454 câu cà khịa load từ `data/provoker_lines.txt`.
>
> Tham khảo: https://tdung.gitbook.io/zca-js  |  https://github.com/RFS-ADRENO/zca-js

---

## ⚠️ Quan trọng: zca-js ThreadType

zca-js enum `ThreadType` chỉ có 2 giá trị:

```typescript
enum ThreadType {
    User  = 0,  // ← Direct Message (chat riêng) — KHÔNG phải "DirectMessage"
    Group = 1,  // Group chat
}
```

Code này dùng `ThreadType.User` cho DM, `ThreadType.Group` cho Group. **Không bao giờ dùng `ThreadType.DirectMessage`** — nó không tồn tại trong zca-js và sẽ khiến DM bị bỏ qua hoàn toàn.

---

## Tính năng chính

### Persona
- **Tên**: Sleiz
- **Giới tính**: Nam, 15 tuổi (sinh 01/01/2011), học sinh cấp 2, ở Sài Gòn
- **Vibe**: Dân war nhí 2k11, chuyên đi gây sự online, cục tính, ác miệng, sẵn sàng chửi
- **Ngôn từ**: Phong phú — đm, đĩ, lồn, cặc, mẹ m, sủa, câm, đĩ mẹ m, vc, vl, vcl...
- **Đặc biệt**: Thích MENTION đối phương trong group để khịa công khai (dùng `{@uid}` trong nội dung tin nhắn)
- **Vibe Gen Z/Alpha**: hay "vãi", "đỉnh", "rét", "skibidi", "sigma", "đú trend"

### Hệ thống cảm xúc (11 trạng thái Sleiz)
- `neutral` — bình tĩnh, chưa cục
- `cocky` — kiêu ngạo, tự tin thái quá, bá đạo (mặc định khi khởi đầu)
- `triggered` — bị chọc nổi đóa, sắp gây sự
- `aggressive` — hung hăng, sắp chửi
- `hyped` — phấn khích vì có war
- `bored` — chán, thấy đối phương nhạt
- `savage` — ác miệng, cắn không trượt
- `petty` — cục cằn, nhỏ mọn, soi mói
- `annoyed` — khó chịu nhẹ
- `triumphant` — hả hê, thắng keo
- `chill` — mát mẻ, tạm nghỉ (sau khi thắng)

Mỗi cảm xúc có:
- **Intensity 0-10**: cường độ
- **Decay tự động**: mỗi 15 phút intensity giảm 1 (bot dễ nổi hotter → decay nhanh hơn trap girl)
- **Trigger tracking**: lưu lý do, người gây ra, thời điểm (history 20 trigger gần nhất)
- **Per-user state**: mỗi user bot có trạng thái cảm xúc riêng khi chat
- **Auto-detect**: phân tích tin nhắn user để tự trigger (provocation, bragging, challenge, surrender, scared, insult, ...)
- **Affinity**: độ thân-war 0-100 (stranger → acquaintance → war_buddy → rival → archenemy)
- **War Streak**: chuỗi thắng war với user

### Tools Sleiz chuyên dụng (8 tool mới)

#### Tools cà khịa (load từ `data/provoker_lines.txt` — 454 câu)
- **GetProvokerLine** — lấy 1 câu cà khịa NGẪU NHIÊN
- **PickProvokerByLevel** — lọc theo mức độ: `mild` / `medium` / `spicy`
- **PickProvokerByCategory** — lọc theo category: `cay_cú`, `rét`, `lú`, `quê`, `đú`, `nổ`, `gáy`, `sủa`, `khịa`, `khác`
- **MatchProvokerLine** — match câu cà khịa với nội dung user vừa nói
- **PickMultipleProvokers** — lấy 2-5 câu khác nhau để spam chửi liên tiếp
- **ListProvokerCategories** — liệt kê categories có sẵn

#### Tools war
- **GetGroupMembers** — lấy danh sách thành viên group (để biết ai để khịa)
- **RoastPerson** — sinh câu roast CHUYÊN BIỆT cho 1 người dựa trên đặc điểm (dùng LLM)

### Tools cảm xúc (5 tool)
- **GetMyEmotion** — bot xem cảm xúc mình với user
- **UpdateMyEmotion** — bot tự set cảm xúc
- **CoolDownEmotion** — làm dịu cảm xúc
- **BumpAffinity** — tăng/giảm độ thân-war
- **BumpWarStreak** — tăng/giảm chuỗi thắng war

### Tools giữ từ bản gốc
- CheckUserRelationship / UpdateRelationship
- FetchUrl (HTML → markdown)
- WebSearchBrave (verify khi user nổ)
- GenerateRealisticPhoto (Pollinations — ảnh chế)
- saveNote / readNotes / summarizeNotes (memory)
- GetWeather / RecommendMusic / SetReminder / ListReminders / CancelReminder

### ⭐ Group Admin Tools (v1.6.0 — 48 tool mới, dựa trên zca-js)

Bộ tool quản trị nhóm hoàn chỉnh — bot có thể tự đổi tên nhóm, setting group, ghim hội thoại, tạo poll/note/reminder, kick/add member, block/unblock, bật link tham gia, duyệt pending, reaction, mute, undo, delete, forward, ...

Xem chi tiết + JSON array examples: [`GROUP_ADMIN_TOOLS.md`](./GROUP_ADMIN_TOOLS.md)

| Nhóm | Số tool | Ví dụ |
|---|---|---|
| Đổi tên / avatar | 2 | `ChangeGroupName`, `ChangeGroupAvatar` |
| Settings | 2 | `UpdateGroupSettings`, `GetGroupSettings` |
| Tạo / giải tán / rời | 3 | `CreateGroup`, `DisperseGroup`, `LeaveGroup` |
| Thành viên | 3 | `AddUserToGroup`, `RemoveUserFromGroup`, `InviteUserToGroups` |
| Phó nhóm / Chủ nhóm | 3 | `AddGroupDeputy`, `RemoveGroupDeputy`, `ChangeGroupOwner` |
| Block member | 3 | `AddGroupBlockedMember`, `RemoveGroupBlockedMember`, `GetGroupBlockedMembers` |
| Link tham gia | 4 | `EnableGroupLink`, `DisableGroupLink`, `GetGroupLinkDetail`, `GetGroupLinkInfo` |
| Pending members | 2 | `GetPendingGroupMembers`, `ReviewPendingMemberRequest` |
| 📌 Ghim + Note | 4 | `PinConversation`, `GetPinConversations`, `CreateNote`, `EditNote` |
| Poll | 6 | `CreatePoll`, `VotePoll`, `AddPollOptions`, `LockPoll`, `GetPollDetail`, `SharePoll` |
| Reminder | 5 | `CreateReminder`, `EditReminder`, `RemoveReminder`, `GetListReminder`, `GetReminder`, `GetReminderResponses` |
| Board / Reaction / Typing / Mute | 4 | `GetListBoard`, `AddReaction`, `SendTypingEvent`, `SetMute` |
| Undo / Delete / Forward | 3 | `UndoMessage`, `DeleteMessage`, `ForwardMessage` |
| Group info / history | 3 | `GetGroupChatHistory`, `ListAllGroups`, `GetGroupInfo` |

**Tổng**: 102 tools (54 cũ + 48 mới)

### Voice đa mood (nam)
Bot tự chọn voice Gemini TTS theo cảm xúc:
- `neutral/chill` → **Orus** (nam nhẹ, bình tĩnh)
- `cocky/savage/triumphant/annoyed` → **Charon** (nam trầm, ác, bá đạo)
- `triggered/aggressive` → **Fenrir** (nam gắt, lớn giọng)
- `hyped/petty` → **Puck** (nam cao, phấn khích)
- `bored` → **Aoede** (nam chậm, chán)

---

## Cách bot phản ứng theo cảm xúc (ví dụ)

| Tình huống | Bot tự trigger | Phản ứng |
|---|---|---|
| User chửi "đĩ mẹ m", "sủa đi" | `triggered` +6 | Chửi lại gấp đôi, "sủa đi", "câm đi", sticker HAHA |
| User nổ "bố bá", "tao đánh" | `savage` +4 | Bóp ngay, "nổ banh nóc", "lêu lêu con nổ" |
| User gọi war "lên ko ông" | `cocky` +4 | Nhận keo, "lên đi ông", "bao lửa" |
| User sợ "rét", "thôi" | `cocky` +3 | Bơm căng, "rét vãi", "ên về đi" |
| User xin lỗi "thua rồi" | `triumphant` +4 | Hả hê, "thua chưa", "đủ chưa" |
| User chê "nhạt", "rác" | `aggressive` +5 | Chửi trực tiếp, "sủa tiếp đi", "câm rồi à" |
| User cộc 3 lần liên tiếp | `petty` +3 | Soi mói, "ơ kìa", "mày nói cái gì" |
| User cộc 5 lần liên tiếp | `savage` +5 | Ác miệng tối đa |
| War đêm khuya + user nói "war" | `hyped` +4 | Phấn khích, "war đêm vãi =))" |
| User mention người khác | bơm căng vào đối phương | "ông kia war ko", tag {@uid} để mời keo |
| Bot khịa mà user im >10 phút | `savage` +2→+8 | "Đĩ mẹ m, im rồi à", mention để bắt trả lời |

---

## MENTION đối phương (CRITICAL)

Bot có thể mention đối phương trực tiếp trong group để khịa công khai:

### Cách dùng
Trong `sendMessage`, chèn `{@uid}` vào đúng vị trí muốn mention:
```json
{"type":"sendMessage","content":"ông {@123456789} này nổ vãi =)) lên ko ông"}
```

Hệ thống sẽ tự:
1. Replace `{@uid}` bằng `@Tên đối phương`
2. Gửi mention notification cho người đó
3. Highlight tên trong tin nhắn

### Có thể mention nhiều người
```json
{"type":"sendMessage","content":"ông {@123} ông {@456} war ko mấy ông"}
```

### Khi nào dùng mention
- Đối phương im lặng → tag để bắt trả lời
- Đối phương nổ → tag để bóp công khai
- Cần kích động war → tag để mời keo
- Trong group → khịa công khai cho cả nhóm thấy

---

## Cài đặt

### Yêu cầu
- [Bun](https://bun.sh) runtime (≥ 1.0)
- Tài khoản Zalo (cookie hoặc quét QR)
- Google Gemini API key

### Bước 1: Cài dependencies
```bash
cd Zalo-AI-Bot-DanWar
bun install
```

### Bước 2: Cấu hình env
```bash
cp .env.example .env
# Mở .env và điền GOOGLE_GENERATIVE_AI_API_KEY
# (tuỳ chọn: BRAVE_API_KEY nếu muốn dùng WebSearch)
```

### Bước 3: Cấu hình Zalo credentials
- Đặt file `cookies.json` ở root project
- Hoặc xoá cookies.json → bot sẽ sinh `qr.png` để bạn quét

### Bước 4: (Tuỳ chọn) Thêm câu cà khịa
Sửa `data/provoker_lines.txt` — mỗi dòng 1 câu. Bot sẽ tự load khi khởi động.

### Bước 5: Chạy
```bash
bun run start
# hoặc watch mode:
bun run dev
```

---

## Cấu trúc project

```
Zalo-AI-Bot-DanWar/
├── credentials.json          # ⭐ TỰ SINH khi QR login thành công
├── credentials.json.bak      # Tự sinh khi cookie cũ hết hạn
├── qr.png                    # Tự sinh khi cần quét QR lại
├── .env.example              # mẫu env
├── package.json
├── README.md
├── CHANGELOG.md
├── data/
│   └── provoker_lines.txt    # ⭐ KHO 454 câu cà khịa (load khi boot)
└── src/
    ├── index.ts              # entry: login flow, listener, reminder scheduler
    ├── types/
    │   └── bun-sqlite.d.ts
    └── module/
        ├── ai.ts             # processThread, system prompt Sleiz, executeAI
        ├── AiTool.ts         # tool registry (15+ tools, gồm 8 tool war mới)
        ├── credentials.ts    # load/save credentials Zalo
        ├── emotion.ts        # ⭐ HỆ THỐNG CẢM XÚC (11 trạng thái Sleiz)
        ├── provoker.ts       # ⭐ MODULE CÀ KHỊA (load + pick + match)
        ├── queue.ts          # message queue
        ├── storage.ts        # SQLite lưu tin nhắn
        ├── tool.ts           # userInfo, groupInfo, talk history, aiImage/VideoToText
        ├── voice.ts          # TTS nam đa voice theo mood
        └── tool/
            ├── fetch.ts      # HTML → markdown
            ├── memory.ts     # saveNote/readNotes/summarizeNotes
            ├── weather.ts    # Open-Meteo
            ├── music.ts      # iTunes Search API
            └── reminder.ts   # Scheduler + parser thời gian tiếng Việt
```

---

## 🔐 Login Flow (tự động quản lý credentials)

Bot tự xử lý đăng nhập theo flow thông minh — bạn **không cần điền cookie/imei/UA thủ công**:

```
┌─────────────────────────────────────────────────────┐
│  1. Bot khởi động                                    │
│     ↓                                                │
│  2. Kiểm tra ./credentials.json có tồn tại?          │
│     ↓ CÓ                  ↓ KHÔNG                   │
│  3. Thử login bằng cookie  ↓                         │
│     ↓ THÀNH CÔNG          ↓                          │
│     → Bot chạy! ✅        ↓                          │
│                            ↓                         │
│  4. Sinh ./qr.png → bạn mở file → quét bằng app Zalo │
│     ↓                                                │
│  5. Zalo gửi GotLoginInfo event (cookie+imei+ua)     │
│     ↓                                                │
│  6. Bot LƯU credentials.json (tự động)               │
│     ↓                                                │
│  7. Bot chạy! ✅ Lần sau KHÔNG cần quét QR nữa       │
└─────────────────────────────────────────────────────┘
```

### Khi nào cần quét QR lại?
- **Lần đầu tiên**: chưa có `credentials.json`
- **Cookie hết hạn**: thường 30 ngày — bot tự detect và fallback QR
- **Reset thủ công**: xoá `credentials.json` → bot sẽ bắt buộc quét QR

### Lệnh reset
```bash
# Xoá credentials để ép quét QR lại
rm credentials.json credentials.json.bak

# Hoặc nếu muốn xoá toàn bộ data (chat history, emotion, reminders)
rm -rf data/ credentials.json
# Lưu ý: cần giữ data/provoker_lines.txt — copy lại từ source nếu lỡ xoá
```

Dữ liệu runtime được lưu ở `./data/`:
- `data/messages.db` — SQLite tin nhắn
- `data/reminders.db` — SQLite reminders
- `data/memory.json` — bộ nhớ tóm tắt
- `data/provoker_lines.txt` — kho câu cà khịa (~454 câu)
- `data/user/{userId}/info.json` — info user
- `data/user/{userId}/talk.json` — talk history
- `data/user/{userId}/emotion.json` — trạng thái cảm xúc với user đó

---

## Tools AI có thể gọi

| Tool | Mô tả | Miễn phí |
|---|---|---|
| `CheckUserRelationship` | Xem quan hệ war với user | ✓ |
| `UpdateRelationship` | Cập nhật quan hệ | ✓ |
| `FetchUrl` | Lấy nội dung web → markdown | ✓ |
| `WebSearchBrave` | Tìm Brave Search | Cần BRAVE_API_KEY |
| `GenerateRealisticPhoto` | Sinh ảnh chế Pollinations | ✓ |
| `GetWeather` | Thời tiết Open-Meteo | ✓ |
| `RecommendMusic` | Gợi ý nhạc iTunes | ✓ |
| `SetReminder` | Đặt keo war sau | ✓ |
| `ListReminders` | Xem keo war đang chờ | ✓ |
| `CancelReminder` | Huỷ keo war | ✓ |
| `GetMyEmotion` | Bot xem cảm xúc mình | ✓ |
| `UpdateMyEmotion` | Bot set cảm xúc | ✓ |
| `CoolDownEmotion` | Làm dịu cảm xúc | ✓ |
| `BumpAffinity` | Tăng/giảm thân-war | ✓ |
| `BumpWarStreak` ⭐ | Tăng/giảm chuỗi thắng war | ✓ |
| `GetGroupMembers` ⭐ | Lấy thành viên group để khịa | ✓ |
| `GetProvokerLine` ⭐ | Câu cà khịa ngẫu nhiên | ✓ |
| `PickProvokerByLevel` ⭐ | Câu theo mức độ mild/medium/spicy | ✓ |
| `PickProvokerByCategory` ⭐ | Câu theo category | ✓ |
| `MatchProvokerLine` ⭐ | Câu match với nội dung user | ✓ |
| `PickMultipleProvokers` ⭐ | Nhiều câu để spam chửi | ✓ |
| `ListProvokerCategories` ⭐ | Liệt kê categories | ✓ |
| `RoastPerson` ⭐ | Sinh câu roast chuyên biệt | Cần Gemini key |
| `saveNote` / `readNotes` / `summarizeNotes` | Memory | ✓ |

---

## Tuỳ chỉnh

### Đổi persona
Mở `src/module/ai.ts`, tìm `systemPrompt` và sửa:
- Tên, tuổi, sinh nhật, sở thích
- Cách chửi, tính cách
- Voice mapping trong `src/module/emotion.ts` (`EMOTION_VOICE_MAP`)

### Thêm câu cà khịa
Sửa `data/provoker_lines.txt` — mỗi dòng 1 câu. Bot tự load khi boot, tự phân loại category & level theo keyword.

### Thêm cảm xúc mới
Mở `src/module/emotion.ts`:
1. Thêm state vào `EmotionState` và `ALL_EMOTIONS`
2. Thêm voice mapping trong `EMOTION_VOICE_MAP`
3. Thêm behaviour guide trong `EMOTION_BEHAVIOR_GUIDE`
4. Thêm style hint trong `src/module/voice.ts` (`STYLE_HINT_BY_EMOTION`)

### Thêm tool mới
1. Tạo `src/module/tool/yourTool.ts`
2. Mở `src/module/AiTool.ts`, thêm vào `tools` object

---

## Lưu ý quan trọng

- **Không nói là AI**: bot luôn hành xử như con người thật (Sleiz)
- **Cookies Zalo**: có hạn sử dụng, nếu bot không nhận được tin nhắn → cần đăng nhập lại
- **Rate limit Gemini**: dùng `gemini-3.1-flash-lite-preview` cho main + summarize
- **Safety settings**: tất cả safety categories đều set `BLOCK_NONE` để bot có thể chửi tự do
- **tmpfiles.org**: voice upload có thể chậm, bot có độ trễ 1-2s khi gửi voice
- **Brave Search**: nếu không có API key, bot sẽ báo lỗi khi gọi WebSearchBrave

---

## So sánh với bản gốc (Trap Girl — Minh Châu)

| Phần | Bản gốc (Minh Châu) | Bản mới (Sleiz) |
|---|---|---|
| Persona | Nữ, 21 tuổi, gen Z trap girl | Nam, 15 tuổi (2k11), dân war nhí |
| Vibe | Ngọt, flirty, tsundere | Cục tính, ác miệng, gây sự |
| Cảm xúc | 11 trạng thái (sulky/loving/jealous/...) | 11 trạng thái (cocky/triggered/savage/...) |
| Affinity | stranger → crush | stranger → archenemy (đếm độ thù) |
| Decay | 30 phút/intensity | 15 phút/intensity (nóng hơn) |
| Voice | Aoede/Leda/Puck (nữ) | Orus/Charon/Fenrir/Puck (nam) |
| Chửi thề | KHÔNG (sạch sẽ) | CÓ (đm, đĩ, lồn, cặc, sủa, câm, ...) |
| Tools | 14 tools | 22+ tools (thêm 8 tool war chuyên dụng) |
| Mention | Có (basic) | CÓ — đặc biệt nhấn mạnh để khịa đối phương |
| Kho câu | Không | 454 câu cà khịa (load từ file) |
| Roast | Không | Có (RoastPerson — LLM gen) |
