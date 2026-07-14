# 🛠️ Group Admin Tools — FIX v1.6.0

Bộ **48 tool quản trị nhóm Zalo** mới được thêm vào `src/module/AiTool.ts`, dựa trên [`zca-js`](https://github.com/RFS-ADRENO/zca-js).

> ⚠️ Hầu hết các tool yêu cầu bot là **Owner** hoặc **Deputy** của group.
> Zalo trả error code **166** khi không đủ quyền, **165** khi user không ở group, **170/178** cho pending-related errors.

---

## 📊 Tổng quan

| Module | Source | Số tool |
|---|---|---|
| `src/module/groupAdmin.ts` | Mới (v1.6.0) | 48 wrappers |
| `src/module/AiTool.ts` | Update | +48 tool entries |

**Tổng tool trong bot**: 102 (trước 54 + sau 48 mới)

---

## 🗂️ Danh sách tool theo nhóm

### 1. Đổi tên / avatar nhóm (2 tool)
| Tool | Mô tả |
|---|---|
| `ChangeGroupName` | Đổi tên nhóm |
| `ChangeGroupAvatar` | Đổi avatar nhóm (từ file path) |

### 2. Settings group (2 tool)
| Tool | Mô tả |
|---|---|
| `UpdateGroupSettings` | Bật/tắt blockName, signAdminMsg, setTopicOnly, enableMsgHistory, joinAppr, lockCreatePost, lockCreatePoll, lockSendMsg, lockViewMember |
| `GetGroupSettings` | Xem settings + thông tin group hiện tại |

### 3. Tạo / giải tán / rời nhóm (3 tool)
| Tool | Mô tả |
|---|---|
| `CreateGroup` | Tạo group mới (bot làm Owner) |
| `DisperseGroup` | Giải tán nhóm (⚠️ không undo) |
| `LeaveGroup` | Bot tự rời group |

### 4. Thành viên (3 tool)
| Tool | Mô tả |
|---|---|
| `AddUserToGroup` | Add user vào group (single/batch) |
| `RemoveUserFromGroup` | Kick user khỏi group (single/batch) |
| `InviteUserToGroups` | Mời 1 user vào nhiều group cùng lúc |

### 5. Phó nhóm / Chủ nhóm (3 tool)
| Tool | Mô tả |
|---|---|
| `AddGroupDeputy` | Add phó nhóm |
| `RemoveGroupDeputy` | Gỡ phó nhóm |
| `ChangeGroupOwner` | Chuyển quyền Owner (⚠️ bot mất quyền) |

### 6. Block member (3 tool)
| Tool | Mô tả |
|---|---|
| `AddGroupBlockedMember` | Block user trong group |
| `RemoveGroupBlockedMember` | Unblock user |
| `GetGroupBlockedMembers` | Xem danh sách blocked |

### 7. Link tham gia (4 tool)
| Tool | Mô tả |
|---|---|
| `EnableGroupLink` | Bật + tạo link tham gia |
| `DisableGroupLink` | Tắt link tham gia |
| `GetGroupLinkDetail` | Xem chi tiết link của group |
| `GetGroupLinkInfo` | Lấy info group từ link |

### 8. Pending members (2 tool)
| Tool | Mô tả |
|---|---|
| `GetPendingGroupMembers` | Xem danh sách user chờ duyệt |
| `ReviewPendingMemberRequest` | Duyệt / từ chối pending |

### 9. 📌 Ghim hội thoại + Note (4 tool)
| Tool | Mô tả |
|---|---|
| `PinConversation` | Ghim / bỏ ghim cả hội thoại lên đầu chat list |
| `GetPinConversations` | Xem danh sách hội thoại đã ghim |
| `CreateNote` | Tạo note (có pinAct=true để ghim note) |
| `EditNote` | Sửa note / ghim-bỏ-ghim note có sẵn |

### 10. Poll (5 tool)
| Tool | Mô tả |
|---|---|
| `CreatePoll` | Tạo poll mới |
| `VotePoll` | Vote poll |
| `AddPollOptions` | Thêm option mới |
| `LockPoll` | Khoá poll |
| `GetPollDetail` | Xem chi tiết poll |
| `SharePoll` | Share poll (ghim lên đầu) |

### 11. Reminder nhóm (5 tool)
| Tool | Mô tả |
|---|---|
| `CreateReminder` | Tạo reminder (Group hoặc User) |
| `EditReminder` | Sửa reminder |
| `RemoveReminder` | Xoá reminder |
| `GetListReminder` | Xem danh sách reminder |
| `GetReminder` | Xem chi tiết 1 reminder |
| `GetReminderResponses` | Xem accept/reject list |

### 12. Board / Reaction / Typing / Mute (4 tool)
| Tool | Mô tả |
|---|---|
| `GetListBoard` | Xem tất cả board items (note/poll/pinned) |
| `AddReaction` | Reaction tin nhắn (50+ icon) |
| `SendTypingEvent` | Gửi typing "đang gõ..." |
| `SetMute` | Mute/unmute hội thoại |

### 13. Undo / Delete / Forward (3 tool)
| Tool | Mô tả |
|---|---|
| `UndoMessage` | Thu hồi tin nhắn (24h window) |
| `DeleteMessage` | Delete (onlyMe hoặc with everyone) |
| `ForwardMessage` | Forward tới nhiều thread |

### 14. Group info / history (3 tool)
| Tool | Mô tả |
|---|---|
| `GetGroupChatHistory` | Lấy 50 tin gần nhất |
| `ListAllGroups` | Liệt kê tất cả group bot đang ở |
| `GetGroupInfo` | Xem chi tiết 1 group (settings + members + admins) |

---

## 📦 JSON Array Examples

Dưới đây là các ví dụ input cho từng tool, dùng để test hoặc làm reference cho AI:

### Đổi tên + avatar nhóm
```json
[
  {"groupId": "123456789012345", "name": "War Zone 2k11"},
  {"groupId": "123456789012345", "imagePath": "data/media/avatar.jpg"}
]
```

### Settings group
```json
[
  {"groupId": "12345", "settings": {"joinAppr": true, "lockCreatePoll": true}},
  {"groupId": "12345", "settings": {"blockName": true, "signAdminMsg": true}},
  {"groupId": "12345", "settings": {"lockSendMsg": false, "enableMsgHistory": true}},
  {"groupId": "12345"}
]
```

### Tạo / giải tán / rời nhóm
```json
[
  {"name": "War Zone 2k11", "members": ["111", "222", "333"], "avatarPath": "data/media/war.jpg"},
  {"groupId": "12345"},
  {"groupId": "12345", "silent": true}
]
```

### Thành viên
```json
[
  {"groupId": "12345", "memberIds": ["111", "222", "333"]},
  {"groupId": "12345", "memberIds": ["111", "222"]},
  {"userId": "111", "groupIds": ["g1", "g2", "g3"]}
]
```

### Phó nhóm / Chủ nhóm
```json
[
  {"groupId": "12345", "memberIds": ["111", "222"]},
  {"groupId": "12345", "memberIds": ["111"]},
  {"groupId": "12345", "memberId": "111"}
]
```

### Block member
```json
[
  {"groupId": "12345", "memberIds": ["111"]},
  {"groupId": "12345", "memberIds": ["111"]},
  {"groupId": "12345", "page": 1, "count": 50}
]
```

### Link tham gia
```json
[
  {"groupId": "12345"},
  {"groupId": "12345"},
  {"groupId": "12345"},
  {"link": "https://zalo.me/g/abc123xyz", "memberPage": 1}
]
```

### Pending members
```json
[
  {"groupId": "12345"},
  {"groupId": "12345", "memberIds": ["111", "222"], "isApprove": true},
  {"groupId": "12345", "memberIds": ["111"], "isApprove": false}
]
```

### 📌 Ghim hội thoại + Note (PIN)
```json
[
  {"pinned": true, "threadIds": ["12345", "67890"], "type": "Group"},
  {"pinned": false, "threadIds": ["12345"], "type": "Group"},
  {},
  {"groupId": "12345", "title": "Quy định nhóm: cấm spam!", "pinAct": true},
  {"groupId": "12345", "title": "War lúc 8h tối", "pinAct": true},
  {"groupId": "12345", "topicId": "note_123", "title": "Quy định mới (updated)", "pinAct": false}
]
```

> ⚠️ **Về "ghim tin nhắn"**: Zalo web/app **không có** API ghim 1 tin nhắn riêng lẻ thông qua `zca-js`. Phương án gần nhất:
> - **`PinConversation`** — ghim cả cuộc hội thoại lên đầu danh sách chat
> - **`CreateNote` với `pinAct=true`** — tạo note và ghim note lên đầu conversation
> - **`EditNote` với `pinAct=true`** — ghim một note đã có sẵn
> - **`SharePoll`** — ghim poll lên đầu conversation

### Poll
```json
[
  {"groupId": "12345", "question": "Ai là skibidi sigma?", "options": ["Tao", "Mày", "Hắn"], "isAnonymous": true},
  {"groupId": "12345", "question": "War lúc mấy?", "options": ["8h", "9h", "10h"], "allowMultiChoices": false, "expiredTime": 0},
  {"pollId": 12345, "optionIds": [1]},
  {"pollId": 12345, "optionIds": [1, 3]},
  {"pollId": 12345, "options": [{"content": "Option mới", "voted": false}]},
  {"pollId": 12345},
  {"pollId": 12345},
  {"pollId": 12345}
]
```

### Reminder nhóm
```json
[
  {"threadId": "12345", "type": "Group", "title": "War 8h tối", "startTime": 1752200000000, "repeat": 1},
  {"threadId": "12345", "type": "Group", "title": "Họp nhóm mỗi tuần", "emoji": "📅", "repeat": 2},
  {"threadId": "12345", "type": "Group", "topicId": "rem_1", "title": "War 9h tối", "repeat": 1},
  {"threadId": "12345", "type": "Group", "reminderId": "rem_1"},
  {"threadId": "12345", "type": "Group", "page": 1, "count": 20},
  {"reminderId": "rem_1"},
  {"reminderId": "rem_1"}
]
```

### Board / Reaction / Typing / Mute
```json
[
  {"groupId": "12345", "page": 1, "count": 20},
  {"icon": "ANGRY", "msgId": "12345", "cliMsgId": "67890", "threadId": "group123", "type": "Group"},
  {"icon": "HAHA", "msgId": "12345", "cliMsgId": "67890", "threadId": "group123"},
  {"icon": "HEART", "msgId": "12345", "cliMsgId": "67890", "threadId": "user123", "type": "User"},
  {"threadId": "12345", "type": "Group"},
  {"threadId": "12345", "type": "Group", "action": "mute", "duration": "ONE_HOUR"},
  {"threadId": "12345", "type": "Group", "action": "mute", "duration": "FOREVER"},
  {"threadId": "12345", "type": "Group", "action": "unmute"}
]
```

### Undo / Delete / Forward
```json
[
  {"threadId": "12345", "type": "Group", "msgId": "12345", "cliMsgId": "67890"},
  {"threadId": "12345", "type": "Group", "msgId": "111", "cliMsgId": "222", "uidFrom": "bot_uid", "onlyMe": false},
  {"threadId": "12345", "type": "Group", "msgId": "111", "cliMsgId": "222", "uidFrom": "bot_uid", "onlyMe": true},
  {"message": "Nội dung forward", "threadIds": ["111", "222"], "type": "Group"},
  {"message": "Tin quan trọng", "threadIds": ["g1", "g2", "g3"], "type": "Group"}
]
```

### Group info / history
```json
[
  {"groupId": "12345", "count": 20},
  {"groupId": "12345", "count": 50},
  {},
  {"groupId": "12345"}
]
```

---

## 🔣 Reaction icons hỗ trợ (50+)

```
HEART, LIKE, HAHA, WOW, CRY, ANGRY, KISS, TEARS_OF_JOY,
SHIT, ROSE, BROKEN_HEART, DISLIKE, LOVE, CONFUSED, WINK,
FADE, SUN, BIRTHDAY, BOMB, OK, PEACE, THANKS, PUNCH, SHARE,
PRAY, NO, BAD, LOVE_YOU, SAD, VERY_SAD, COOL, NERD,
BIG_SMILE, SUNGLASSES, NEUTRAL, SAD_FACE, BYE, SLEEPY, WIPE,
DIG, ANGUISH, HANDCLAP, ANGRY_FACE, F_CHAIR, L_CHAIR, R_CHAIR,
SILENT, SURPRISE, EMBARRASSED, AFRAID, SAD2, BIG_LAUGH, RICH, BEER
```

---

## 🔐 Quyền hạn theo vai trò

| Vai trò | Quyền |
|---|---|
| **Member** | Chỉ xem info, vote poll (nếu được phép), tạo poll (nếu không bị lock), reaction, forward, delete own message |
| **Deputy** | + Add/kick member, add/remove deputy khác (không), block/unblock, enable/disable link, change group name/avatar, settings (một số) |
| **Owner** | Tất cả + Change owner, Disperse group, Update all settings, Add/remove deputy |

---

## 🚀 Cách AI dùng tool

Bot (Nguyễn Đình Dương) có thể tự gọi tool qua AI function calling. Ví dụ user nhắn:

> "đổi tên nhóm thành 'War Zone 2k11' đi"

→ AI sẽ gọi:
```json
{
  "tool": "ChangeGroupName",
  "input": {"groupId": "<current_group>", "name": "War Zone 2k11"}
}
```

> "ghim hội thoại này lại"

→ AI sẽ gọi:
```json
{
  "tool": "PinConversation",
  "input": {"pinned": true, "threadIds": ["<current_thread>"], "type": "Group"}
}
```

> "tạo poll ai lên war lúc 8h"

→ AI sẽ gọi:
```json
{
  "tool": "CreatePoll",
  "input": {
    "groupId": "<current_group>",
    "question": "Ai lên war lúc 8h?",
    "options": ["Lên", "Không lên", "Lên muộn"],
    "isAnonymous": true
  }
}
```

---

## 📁 Cấu trúc code

```
src/module/
├── groupAdmin.ts    # ⭐ MỚI — 48 wrapper functions cho zca-js group APIs
├── AiTool.ts        # ⭐ UPDATE — thêm 48 tool entries vào registry
└── ...
```

Mỗi wrapper:
- Validate input (groupId phải là số 10-25 chữ số, UID cũng vậy, không rỗng, ...)
- Gọi `globalThis.api.<zcaMethod>(...)` (api được set sau khi login)
- Bắt error + map error code Zalo (165/166/170/178) → message tiếng Việt
- Trả về string success/error để AI đọc

---

## ⚠️ Lưu ý quan trọng

1. **`globalThis.api` phải sẵn sàng** — bot phải login Zalo trước khi gọi tool. Nếu chưa login → trả về error message.
2. **Rate limit** — Zalo có thể rate limit nếu gọi quá nhanh. Bot nên đợi 1-2s giữa các thao tác nặng.
3. **Error code Zalo**:
   - `166` — Insufficient permission (cần Owner/Deputy)
   - `165` — User không ở trong group
   - `170` — User không trong pending list
   - `178` — User đã ở trong group
4. **Pin message** — Zalo web API không hỗ trợ ghim 1 tin nhắn riêng (chỉ ghim hội thoại hoặc note/poll có pinAct).
5. **Undo window** — Zalo chỉ cho thu hồi tin nhắn trong 24h.
6. **ChangeGroupOwner** — Bot sẽ MẤT quyền Owner sau khi gọi. Tool này có warning rõ trong description.
7. **DisperseGroup** — Không thể undo. Toàn bộ thành viên bị kick, group bị xoá.

---

## 📚 Tham khảo

- **zca-js source**: https://github.com/RFS-ADRENO/zca-js
- **zca-js docs**: https://tdung.gitbook.io/zca-js
- **API list**: `/tmp/zca-js-src/src/apis/` (150+ API methods)
