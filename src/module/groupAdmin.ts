/**
 * groupAdmin.ts — Wrapper cho Zalo Group Admin APIs (zca-js)
 * ------------------------------------------------------------------
 * Cung cấp các hàm sẵn sàng cho AI tool calls:
 *   - Đổi tên / avatar nhóm
 *   - Setting group (lockSendMsg, blockName, joinAppr, lockCreatePoll, ...)
 *   - Tạo / giải tán / rời nhóm
 *   - Thêm / kick / mời thành viên
 *   - Add / remove phó nhóm, chuyển chủ nhóm
 *   - Block / unblock member, xem danh sách block
 *   - Bật / tắt / lấy link tham gia nhóm
 *   - Duyệt pending members (joinAppr)
 *   - Pin / unpin conversation (ghim hội thoại)
 *   - Tạo / sửa note (có pinAct), tạo / vote / khoá poll, add poll options
 *   - Tạo / sửa / xoá reminder trong group
 *   - Reaction + typing event
 *   - Mute / unmute hội thoại
 *   - Undo / delete / forward tin nhắn
 *   - Get group chat history
 *
 * ⚠️ Tất cả hàm đều trả về string tiếng Việt (success/error) để AI đọc trực tiếp.
 * ⚠️ Yêu cầu: `globalThis.api` phải sẵn sàng (bot đã login Zalo).
 * ⚠️ Nhiều thao tác yêu cầu quyền Owner/Deputy — Zalo trả code 166 khi không đủ quyền.
 */

import fs from 'fs';

// ============================================================
// Helpers
// ============================================================

function api(): any {
    const a = (globalThis as any).api;
    if (!a) throw new Error('globalThis.api chưa sẵn sàng — bot chưa login Zalo');
    return a;
}

function err(e: any, label: string): string {
    const msg = e?.message ?? String(e);
    // Map một số error code phổ biến của Zalo
    if (/166/.test(msg)) return `❌ ${label} thất bại: không đủ quyền (code 166 — cần Owner/Deputy).`;
    if (/165/.test(msg)) return `❌ ${label} thất bại: user không ở trong group (code 165).`;
    if (/170/.test(msg)) return `❌ ${label} thất bại: user không trong danh sách pending (code 170).`;
    if (/178/.test(msg)) return `❌ ${label} thất bại: user đã ở trong group (code 178).`;
    return `❌ ${label} thất bại: ${msg}`;
}

function asArray<T>(v: T | T[]): T[] {
    return Array.isArray(v) ? v : [v];
}

function validGid(groupId: string): boolean {
    return !!groupId && /^\d{10,25}$/.test(String(groupId));
}

function validUid(uid: string): boolean {
    return !!uid && /^\d{10,25}$/.test(String(uid));
}

// ============================================================
// 1. Đổi tên nhóm
// ============================================================
export async function changeGroupName({ groupId, name }: {
    groupId: string;
    name: string;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    const newName = String(name ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ (phải là số 10-25 chữ số).`;
    if (!newName) return `❌ Tên nhóm mới rỗng.`;
    if (newName.length > 100) return `❌ Tên nhóm quá dài (${newName.length} > 100 ký tự).`;
    try {
        const r = await api().changeGroupName(newName, gid);
        return `✓ Đã đổi tên group ${gid} thành "${newName}". (status: ${r?.status ?? 'ok'})`;
    } catch (e: any) {
        return err(e, 'changeGroupName');
    }
}

// ============================================================
// 2. Đổi avatar nhóm
// ============================================================
export async function changeGroupAvatar({ groupId, imagePath }: {
    groupId: string;
    imagePath: string;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    const p = String(imagePath ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    if (!p) return `❌ imagePath rỗng. Cần đường dẫn file ảnh trên server bot.`;
    if (!fs.existsSync(p)) return `❌ File không tồn tại: ${p}`;
    try {
        await api().changeGroupAvatar(p, gid);
        return `✓ Đã đổi avatar group ${gid} từ file "${p}".`;
    } catch (e: any) {
        return err(e, 'changeGroupAvatar');
    }
}

// ============================================================
// 3. Update group settings
// ============================================================
export async function updateGroupSettings({ groupId, settings }: {
    groupId: string;
    settings: {
        blockName?: boolean;          // Cấm thành viên đổi tên + avatar nhóm
        signAdminMsg?: boolean;       // Highlight tin nhắn từ Owner/admins
        setTopicOnly?: boolean;       // KHÔNG ghim note/poll/message lên đầu conversation
        enableMsgHistory?: boolean;   // Cho phép member mới xem lịch sử tin nhắn gần
        joinAppr?: boolean;           // Bật duyệt thành viên (join approval)
        lockCreatePost?: boolean;     // Cấm member tạo note/reminder
        lockCreatePoll?: boolean;     // Cấm member tạo poll
        lockSendMsg?: boolean;        // Cấm member gửi tin nhắn (chỉ admin được gửi)
        lockViewMember?: boolean;     // Cấm member xem danh sách thành viên (community only)
    };
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    if (!settings || Object.keys(settings).length === 0) {
        return `❌ Cần truyền ít nhất 1 setting (blockName/signAdminMsg/setTopicOnly/enableMsgHistory/joinAppr/lockCreatePost/lockCreatePoll/lockSendMsg/lockViewMember).`;
    }
    try {
        await api().updateGroupSettings(settings, gid);
        const lines = Object.entries(settings).map(([k, v]) => `  • ${k}: ${v ? 'BẬT' : 'TẮT'}`);
        return `✓ Đã cập nhật settings group ${gid}:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'updateGroupSettings');
    }
}

// ============================================================
// 4. Lấy settings hiện tại của group
// ============================================================
export async function getGroupSettings({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const info: any = await api().getGroupInfo(gid);
        const g = info?.gridInfoMap?.[gid] ?? {};
        const s = g?.setting ?? {};
        const settingLines = [
            `  • blockName (cấm đổi tên/avt): ${s.blockName ? 'BẬT' : 'TẮT'}`,
            `  • signAdminMsg (highlight admin msg): ${s.signAdminMsg ? 'BẬT' : 'TẮT'}`,
            `  • setTopicOnly (không ghim note/poll): ${s.setTopicOnly ? 'BẬT' : 'TẮT'}`,
            `  • enableMsgHistory (cho member mới xem old msg): ${s.enableMsgHistory ? 'BẬT' : 'TẮT'}`,
            `  • joinAppr (duyệt thành viên): ${s.joinAppr ? 'BẬT' : 'TẮT'}`,
            `  • lockCreatePost (cấm tạo note/reminder): ${s.lockCreatePost ? 'BẬT' : 'TẮT'}`,
            `  • lockCreatePoll (cấm tạo poll): ${s.lockCreatePoll ? 'BẬT' : 'TẮT'}`,
            `  • lockSendMsg (cấm member chat): ${s.lockSendMsg ? 'BẬT' : 'TẮT'}`,
            `  • lockViewMember (cấm xem member list): ${s.lockViewMember ? 'BẬT' : 'TẮT'}`,
        ];
        const header = `Group: ${g?.name ?? '(không tên)'} — ${g?.totalMember ?? '?'} members — type: ${g?.type ?? '?'} — creatorId: ${g?.creatorId ?? '?'}`;
        return `${header}\nSettings:\n${settingLines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getGroupSettings');
    }
}

// ============================================================
// 5. Tạo group mới
// ============================================================
export async function createGroup({ name, members, avatarPath }: {
    name?: string;
    members: string[];
    avatarPath?: string;
}): Promise<string> {
    if (!Array.isArray(members) || members.length === 0) {
        return `❌ Cần ít nhất 1 member UID để tạo group.`;
    }
    const invalid = members.filter(m => !validUid(m));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        const opts: any = { members, name: name?.trim() || undefined };
        if (avatarPath) opts.avatarSource = avatarPath;
        const r = await api().createGroup(opts);
        return `✓ Đã tạo group mới: groupId=${r?.groupId}, successMembers=${r?.sucessMembers?.length ?? 0}/${members.length}, errorMembers=${r?.errorMembers?.length ?? 0}.`;
    } catch (e: any) {
        return err(e, 'createGroup');
    }
}

// ============================================================
// 6. Giải tán group
// ============================================================
export async function disperseGroup({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        await api().disperseGroup(gid);
        return `✓ Đã giải tán group ${gid}.`;
    } catch (e: any) {
        return err(e, 'disperseGroup');
    }
}

// ============================================================
// 7. Rời group
// ============================================================
export async function leaveGroup({ groupId, silent }: {
    groupId: string;
    silent?: boolean;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        await api().leaveGroup(gid, !!silent);
        return `✓ Đã rời group ${gid} (silent=${!!silent}).`;
    } catch (e: any) {
        return err(e, 'leaveGroup');
    }
}

// ============================================================
// 8. Thêm user vào group
// ============================================================
export async function addUserToGroup({ groupId, memberIds }: {
    groupId: string;
    memberIds: string | string[];
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    const invalid = uids.filter(u => !validUid(u));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        const r = await api().addUserToGroup(uids, gid);
        const errMembers = r?.errorMembers ?? [];
        if (errMembers.length > 0) {
            return `✓ Đã add ${uids.length - errMembers.length}/${uids.length} thành viên vào group ${gid}. Lỗi: ${errMembers.join(', ')}`;
        }
        return `✓ Đã add ${uids.length}/${uids.length} thành viên vào group ${gid}.`;
    } catch (e: any) {
        return err(e, 'addUserToGroup');
    }
}

// ============================================================
// 9. Kick user khỏi group
// ============================================================
export async function removeUserFromGroup({ groupId, memberIds }: {
    groupId: string;
    memberIds: string | string[];
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    const invalid = uids.filter(u => !validUid(u));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        const r = await api().removeUserFromGroup(uids, gid);
        const errMembers = r?.errorMembers ?? [];
        if (errMembers.length > 0) {
            return `✓ Đã kick ${uids.length - errMembers.length}/${uids.length} user khỏi group ${gid}. Lỗi: ${errMembers.join(', ')}`;
        }
        return `✓ Đã kick ${uids.length} user khỏi group ${gid}: ${uids.join(', ')}`;
    } catch (e: any) {
        return err(e, 'removeUserFromGroup');
    }
}

// ============================================================
// 10. Mời user vào nhiều group cùng lúc
// ============================================================
export async function inviteUserToGroups({ userId, groupIds }: {
    userId: string;
    groupIds: string | string[];
}): Promise<string> {
    const uid = String(userId ?? '').trim();
    if (!validUid(uid)) return `❌ userId "${uid}" không hợp lệ.`;
    const gids = asArray(groupIds).map(String).filter(Boolean);
    if (gids.length === 0) return `❌ Cần ít nhất 1 groupId.`;
    const invalid = gids.filter(g => !validGid(g));
    if (invalid.length > 0) return `❌ GroupId không hợp lệ: ${invalid.join(', ')}`;
    try {
        const r = await api().inviteUserToGroups(uid, gids);
        const lines = gids.map(g => {
            const m = r?.grid_message_map?.[g];
            return m?.error_code ? `  ✗ ${g}: ${m.error_message ?? m.error_code}` : `  ✓ ${g}: OK`;
        });
        return `✓ Invite user ${uid} vào ${gids.length} group:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'inviteUserToGroups');
    }
}

// ============================================================
// 11. Add phó nhóm
// ============================================================
export async function addGroupDeputy({ groupId, memberIds }: {
    groupId: string;
    memberIds: string | string[];
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    const invalid = uids.filter(u => !validUid(u));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        await api().addGroupDeputy(uids, gid);
        return `✓ Đã add ${uids.length} phó nhóm vào group ${gid}: ${uids.join(', ')}`;
    } catch (e: any) {
        return err(e, 'addGroupDeputy');
    }
}

// ============================================================
// 12. Remove phó nhóm
// ============================================================
export async function removeGroupDeputy({ groupId, memberIds }: {
    groupId: string;
    memberIds: string | string[];
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    const invalid = uids.filter(u => !validUid(u));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        await api().removeGroupDeputy(uids, gid);
        return `✓ Đã gỡ ${uids.length} phó nhóm khỏi group ${gid}: ${uids.join(', ')}`;
    } catch (e: any) {
        return err(e, 'removeGroupDeputy');
    }
}

// ============================================================
// 13. Chuyển chủ nhóm
// ============================================================
export async function changeGroupOwner({ groupId, memberId }: {
    groupId: string;
    memberId: string;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    const uid = String(memberId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    if (!validUid(uid)) return `❌ memberId "${uid}" không hợp lệ.`;
    try {
        const r = await api().changeGroupOwner(uid, gid);
        return `✓ Đã chuyển chủ group ${gid} sang user ${uid}. (time: ${r?.time ?? '?'})\n⚠️ Bot mất quyền Owner.`;
    } catch (e: any) {
        return err(e, 'changeGroupOwner');
    }
}

// ============================================================
// 14. Block member trong group
// ============================================================
export async function addGroupBlockedMember({ groupId, memberIds }: {
    groupId: string;
    memberIds: string | string[];
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    const invalid = uids.filter(u => !validUid(u));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        await api().addGroupBlockedMember(uids, gid);
        return `✓ Đã block ${uids.length} user trong group ${gid}: ${uids.join(', ')}`;
    } catch (e: any) {
        return err(e, 'addGroupBlockedMember');
    }
}

// ============================================================
// 15. Unblock member
// ============================================================
export async function removeGroupBlockedMember({ groupId, memberIds }: {
    groupId: string;
    memberIds: string | string[];
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    const invalid = uids.filter(u => !validUid(u));
    if (invalid.length > 0) return `❌ UID không hợp lệ: ${invalid.join(', ')}`;
    try {
        await api().removeGroupBlockedMember(uids, gid);
        return `✓ Đã unblock ${uids.length} user trong group ${gid}: ${uids.join(', ')}`;
    } catch (e: any) {
        return err(e, 'removeGroupBlockedMember');
    }
}

// ============================================================
// 16. Lấy danh sách block
// ============================================================
export async function getGroupBlockedMembers({ groupId, page, count }: {
    groupId: string;
    page?: number;
    count?: number;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const r = await api().getGroupBlockedMember({ page: page ?? 1, count: count ?? 50 }, gid);
        const list = r?.blocked_members ?? [];
        if (list.length === 0) return `Group ${gid} không có user nào bị block.`;
        const lines = list.map((m: any, i: number) =>
            `${i + 1}. ${m.dName ?? '(no name)'} (uid=${m.id})`
        );
        return `📋 ${list.length} user bị block trong group ${gid}:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getGroupBlockedMembers');
    }
}

// ============================================================
// 17. Bật link tham gia group
// ============================================================
export async function enableGroupLink({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const r = await api().enableGroupLink(gid);
        return `✓ Đã bật link tham gia group ${gid}.\nLink: ${r?.link ?? '(unknown)'}\nHết hạn: ${r?.expiration_date ? new Date(r.expiration_date).toLocaleString('vi-VN') : '(không)'}`;
    } catch (e: any) {
        return err(e, 'enableGroupLink');
    }
}

// ============================================================
// 18. Tắt link tham gia group
// ============================================================
export async function disableGroupLink({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        await api().disableGroupLink(gid);
        return `✓ Đã tắt link tham gia group ${gid}.`;
    } catch (e: any) {
        return err(e, 'disableGroupLink');
    }
}

// ============================================================
// 19. Lấy chi tiết link tham gia
// ============================================================
export async function getGroupLinkDetail({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const r = await api().getGroupLinkDetail(gid);
        return `Group ${gid} link detail:\n  • enabled: ${r?.enabled ? 'BẬT' : 'TẮT'}\n  • link: ${r?.link ?? '(chưa tạo)'}\n  • expiration_date: ${r?.expiration_date ? new Date(r.expiration_date).toLocaleString('vi-VN') : '(không)'}`;
    } catch (e: any) {
        return err(e, 'getGroupLinkDetail');
    }
}

// ============================================================
// 20. Lấy info group từ link
// ============================================================
export async function getGroupLinkInfo({ link, memberPage }: {
    link: string;
    memberPage?: number;
}): Promise<string> {
    const l = String(link ?? '').trim();
    if (!l) return `❌ link rỗng.`;
    try {
        const r = await api().getGroupLinkInfo({ link: l, memberPage: memberPage ?? 1 });
        const mems = r?.currentMems ?? [];
        const lines = mems.slice(0, 30).map((m: any, i: number) =>
            `${i + 1}. ${m.dName ?? m.zaloName ?? '(no name)'} (uid=${m.id})`
        );
        return `Group từ link:\n  • groupId: ${r?.groupId}\n  • name: ${r?.name}\n  • desc: ${r?.desc ?? ''}\n  • totalMember: ${r?.totalMember ?? mems.length}\n  • creatorId: ${r?.creatorId}\n  • adminIds: ${(r?.adminIds ?? []).join(', ')}\nMembers (page ${memberPage ?? 1}, ${mems.length}):\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getGroupLinkInfo');
    }
}

// ============================================================
// 21. Lấy danh sách pending members (cần duyệt)
// ============================================================
export async function getPendingGroupMembers({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const r = await api().getPendingGroupMembers(gid);
        const users = r?.users ?? [];
        if (users.length === 0) return `Group ${gid} không có user nào đang pending (chờ duyệt).`;
        const lines = users.map((u: any, i: number) =>
            `${i + 1}. ${u.dpn ?? '(no name)'} (uid=${u.uid})`
        );
        return `📋 ${users.length} user pending trong group ${gid}:\n${lines.join('\n')}\n→ Dùng ReviewPendingMember để duyệt/từ chối.`;
    } catch (e: any) {
        return err(e, 'getPendingGroupMembers');
    }
}

// ============================================================
// 22. Duyệt / từ chối pending member
// ============================================================
export async function reviewPendingMemberRequest({ groupId, memberIds, isApprove }: {
    groupId: string;
    memberIds: string | string[];
    isApprove: boolean;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const uids = asArray(memberIds).map(String).filter(Boolean);
    if (uids.length === 0) return `❌ Cần ít nhất 1 member UID.`;
    try {
        const r = await api().reviewPendingMemberRequest({ members: uids, isApprove }, gid);
        const lines = uids.map(uid => {
            const status = r?.[uid];
            const label = status === 0 ? '✓ SUCCESS'
                : status === 170 ? '✗ NOT_IN_PENDING_LIST'
                : status === 178 ? '✗ ALREADY_IN_GROUP'
                : status === 166 ? '✗ INSUFFICIENT_PERMISSION'
                : `? ${status}`;
            return `  ${uid}: ${label}`;
        });
        return `${isApprove ? 'Duyệt' : 'Từ chối'} ${uids.length} pending member trong group ${gid}:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'reviewPendingMemberRequest');
    }
}

// ============================================================
// 23. Ghim / bỏ ghim hội thoại (Pin Conversation)
// ============================================================
export async function setPinnedConversations({ pinned, threadIds, type }: {
    pinned: boolean;
    threadIds: string | string[];
    type?: 'User' | 'Group';
}): Promise<string> {
    const ids = asArray(threadIds).map(String).filter(Boolean);
    if (ids.length === 0) return `❌ Cần ít nhất 1 threadId.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        await api().setPinnedConversations(!!pinned, ids, tt);
        return `✓ Đã ${pinned ? 'GHIM' : 'BỎ GHIM'} ${ids.length} hội thoại (${type ?? 'Group'}): ${ids.join(', ')}`;
    } catch (e: any) {
        return err(e, 'setPinnedConversations');
    }
}

// ============================================================
// 24. Lấy danh sách hội thoại đã ghim
// ============================================================
export async function getPinConversations(): Promise<string> {
    try {
        const r = await api().getPinConversations();
        const conv = r?.conversations ?? [];
        if (conv.length === 0) return `Chưa có hội thoại nào được ghim.`;
        // Conversations format: ["g<groupId>", "u<userId>", ...]
        const lines = conv.map((c: string) => {
            if (c.startsWith('g')) return `  • Group: ${c.slice(1)}`;
            if (c.startsWith('u')) return `  • User: ${c.slice(1)}`;
            return `  • ${c}`;
        });
        return `📋 ${conv.length} hội thoại đã ghim:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getPinConversations');
    }
}

// ============================================================
// 25. Tạo note (có thể pinAct = ghim note)
// ============================================================
export async function createNote({ groupId, title, pinAct }: {
    groupId: string;
    title: string;
    pinAct?: boolean;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const t = String(title ?? '').trim();
    if (!t) return `❌ title rỗng.`;
    if (t.length > 500) return `❌ title quá dài (${t.length} > 500).`;
    try {
        const r = await api().createNote({ title: t, pinAct: !!pinAct }, gid);
        const noteId = r?.id ?? '(unknown)';
        return `✓ Đã tạo note trong group ${gid}: "${t.slice(0, 80)}${t.length > 80 ? '...' : ''}" (id=${noteId}, pinAct=${!!pinAct})`;
    } catch (e: any) {
        return err(e, 'createNote');
    }
}

// ============================================================
// 26. Sửa note (có thể pinAct = ghim / bỏ ghim note có sẵn)
// ============================================================
export async function editNote({ groupId, title, topicId, pinAct }: {
    groupId: string;
    title: string;
    topicId: string;
    pinAct?: boolean;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const t = String(title ?? '').trim();
    const tid = String(topicId ?? '').trim();
    if (!t) return `❌ title rỗng.`;
    if (!tid) return `❌ topicId rỗng.`;
    try {
        const r = await api().editNote({ title: t, topicId: tid, pinAct: !!pinAct }, gid);
        return `✓ Đã sửa note ${tid} trong group ${gid}: "${t.slice(0, 80)}${t.length > 80 ? '...' : ''}" (pinAct=${!!pinAct})`;
    } catch (e: any) {
        return err(e, 'editNote');
    }
}

// ============================================================
// 27. Tạo poll
// ============================================================
export async function createPoll({ groupId, question, options, expiredTime, allowMultiChoices, allowAddNewOption, hideVotePreview, isAnonymous }: {
    groupId: string;
    question: string;
    options: string[];
    expiredTime?: number;            // ms (0 = no expiration)
    allowMultiChoices?: boolean;
    allowAddNewOption?: boolean;
    hideVotePreview?: boolean;
    isAnonymous?: boolean;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    const q = String(question ?? '').trim();
    if (!q) return `❌ question rỗng.`;
    if (!Array.isArray(options) || options.length < 2) return `❌ Cần ít nhất 2 options.`;
    try {
        const r = await api().createPoll({
            question: q,
            options: options.map(String),
            expiredTime: typeof expiredTime === 'number' ? expiredTime : 0,
            allowMultiChoices: !!allowMultiChoices,
            allowAddNewOption: !!allowAddNewOption,
            hideVotePreview: !!hideVotePreview,
            isAnonymous: !!isAnonymous,
        }, gid);
        return `✓ Đã tạo poll "${q}" trong group ${gid} (poll_id=${r?.poll_id ?? '?'}). Options: ${options.join(' | ')}`;
    } catch (e: any) {
        return err(e, 'createPoll');
    }
}

// ============================================================
// 28. Vote poll
// ============================================================
export async function votePoll({ pollId, optionIds }: {
    pollId: number;
    optionIds: number | number[];
}): Promise<string> {
    if (!pollId || typeof pollId !== 'number') return `❌ pollId phải là số.`;
    const ids = asArray(optionIds).map(Number).filter(n => Number.isFinite(n));
    if (ids.length === 0) return `❌ Cần ít nhất 1 optionId (số). Truyền [] để unvote.`;
    try {
        const r = await api().votePoll(pollId, ids);
        const lines = (r?.options ?? []).map((o: any) =>
            `  • [${o.option_id}] ${o.content} — ${o.votes} votes${o.voted ? ' ✓ (voted)' : ''}`
        );
        return `✓ Đã vote poll ${pollId} (option ${ids.join(', ')}).\nOptions hiện tại:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'votePoll');
    }
}

// ============================================================
// 29. Add option vào poll
// ============================================================
export async function addPollOptions({ pollId, options, votedOptionIds }: {
    pollId: number;
    options: Array<{ content: string; voted?: boolean }>;
    votedOptionIds?: number[];
}): Promise<string> {
    if (!pollId || typeof pollId !== 'number') return `❌ pollId phải là số.`;
    if (!Array.isArray(options) || options.length === 0) return `❌ Cần ít nhất 1 option.`;
    try {
        const r = await api().addPollOptions({
            pollId,
            options: options.map(o => ({ content: String(o.content), voted: !!o.voted })),
            votedOptionIds: votedOptionIds ?? [],
        });
        const lines = (r?.options ?? []).map((o: any) =>
            `  • [${o.option_id}] ${o.content} — ${o.votes} votes`
        );
        return `✓ Đã add ${options.length} option(s) vào poll ${pollId}.\nOptions hiện tại:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'addPollOptions');
    }
}

// ============================================================
// 30. Khoá poll (lock)
// ============================================================
export async function lockPoll({ pollId }: { pollId: number }): Promise<string> {
    if (!pollId || typeof pollId !== 'number') return `❌ pollId phải là số.`;
    try {
        await api().lockPoll(pollId);
        return `✓ Đã khoá poll ${pollId} — không cho vote tiếp.`;
    } catch (e: any) {
        return err(e, 'lockPoll');
    }
}

// ============================================================
// 31. Lấy chi tiết poll
// ============================================================
export async function getPollDetail({ pollId }: { pollId: number }): Promise<string> {
    if (!pollId || typeof pollId !== 'number') return `❌ pollId phải là số.`;
    try {
        const r = await api().getPollDetail(pollId);
        const opts = r?.options ?? [];
        const lines = opts.map((o: any) =>
            `  • [${o.option_id}] ${o.content} — ${o.votes} votes${o.voted ? ' ✓' : ''}`
        );
        const header = `Poll: "${r?.question ?? '?'}"\n` +
            `  • poll_id: ${r?.poll_id}\n` +
            `  • creator: ${r?.creator}\n` +
            `  • joined: ${r?.joined ? 'yes' : 'no'}\n` +
            `  • closed: ${r?.closed ? 'yes' : 'no'}\n` +
            `  • multi: ${r?.allow_multi_choices ? 'yes' : 'no'}\n` +
            `  • anonymous: ${r?.is_anonymous ? 'yes' : 'no'}\n` +
            `  • total votes: ${r?.num_vote ?? 0}`;
        return `${header}\nOptions:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getPollDetail');
    }
}

// ============================================================
// 32. Share poll (pin poll lên đầu conversation)
// ============================================================
export async function sharePoll({ pollId }: { pollId: number }): Promise<string> {
    if (!pollId || typeof pollId !== 'number') return `❌ pollId phải là số.`;
    try {
        await api().sharePoll(pollId);
        return `✓ Đã share poll ${pollId} (ghim lên đầu conversation).`;
    } catch (e: any) {
        return err(e, 'sharePoll');
    }
}

// ============================================================
// 33. Tạo reminder (User hoặc Group)
// ============================================================
export async function createReminder({ threadId, type, title, emoji, startTime, repeat }: {
    threadId: string;
    type?: 'User' | 'Group';
    title: string;
    emoji?: string;
    startTime?: number;            // unix ms
    repeat?: 0 | 1 | 2 | 3;        // 0=None, 1=Daily, 2=Weekly, 3=Monthly
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    const t = String(title ?? '').trim();
    if (!t) return `❌ title rỗng.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const r = await api().createReminder({
            title: t,
            emoji: emoji ?? '⏰',
            startTime: startTime ?? Date.now(),
            repeat: repeat ?? 0,
        }, tid, tt);
        const id = (r as any)?.reminderId ?? (r as any)?.id ?? '(unknown)';
        return `✓ Đã tạo reminder "${t}" trong ${type ?? 'Group'} ${tid} (id=${id}, emoji=${emoji ?? '⏰'}, repeat=${repeat ?? 0}).`;
    } catch (e: any) {
        return err(e, 'createReminder');
    }
}

// ============================================================
// 34. Sửa reminder
// ============================================================
export async function editReminder({ threadId, type, topicId, title, emoji, startTime, repeat }: {
    threadId: string;
    type?: 'User' | 'Group';
    topicId: string;
    title: string;
    emoji?: string;
    startTime?: number;
    repeat?: 0 | 1 | 2 | 3;
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    const tpId = String(topicId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    if (!tpId) return `❌ topicId rỗng.`;
    const t = String(title ?? '').trim();
    if (!t) return `❌ title rỗng.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        await api().editReminder({
            title: t,
            topicId: tpId,
            emoji: emoji ?? '⏰',
            startTime: startTime ?? Date.now(),
            repeat: repeat ?? 0,
        }, tid, tt);
        return `✓ Đã sửa reminder ${tpId} trong ${type ?? 'Group'} ${tid}: "${t.slice(0, 80)}"`;
    } catch (e: any) {
        return err(e, 'editReminder');
    }
}

// ============================================================
// 35. Xoá reminder
// ============================================================
export async function removeReminder({ threadId, type, reminderId }: {
    threadId: string;
    type?: 'User' | 'Group';
    reminderId: string;
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    const rid = String(reminderId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    if (!rid) return `❌ reminderId rỗng.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        await api().removeReminder(rid, tid, tt);
        return `✓ Đã xoá reminder ${rid} trong ${type ?? 'Group'} ${tid}.`;
    } catch (e: any) {
        return err(e, 'removeReminder');
    }
}

// ============================================================
// 36. Lấy danh sách reminder
// ============================================================
export async function getListReminder({ threadId, type, page, count }: {
    threadId: string;
    type?: 'User' | 'Group';
    page?: number;
    count?: number;
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const r = await api().getListReminder({ page: page ?? 1, count: count ?? 20 }, tid, tt);
        if (!Array.isArray(r) || r.length === 0) return `${type ?? 'Group'} ${tid} không có reminder nào.`;
        const lines = r.map((rm: any, i: number) => {
            const id = rm?.reminderId ?? rm?.id ?? '?';
            const title = rm?.params?.title ?? '(no title)';
            const start = rm?.startTime ? new Date(rm.startTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '?';
            const repeatMap: Record<number, string> = { 0: 'None', 1: 'Daily', 2: 'Weekly', 3: 'Monthly' };
            const rep = repeatMap[rm?.repeat ?? 0] ?? '?';
            return `${i + 1}. id=${id} — "${title}" — startTime: ${start} — repeat: ${rep}`;
        });
        return `📋 ${r.length} reminder trong ${type ?? 'Group'} ${tid}:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getListReminder');
    }
}

// ============================================================
// 37. Lấy chi tiết 1 reminder (group)
// ============================================================
export async function getReminder({ reminderId }: { reminderId: string }): Promise<string> {
    const rid = String(reminderId ?? '').trim();
    if (!rid) return `❌ reminderId rỗng.`;
    try {
        const r = await api().getReminder(rid);
        const title = r?.params?.title ?? '(no title)';
        const start = r?.startTime ? new Date(r.startTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '?';
        return `Reminder ${rid}:\n  • title: ${title}\n  • groupId: ${r?.groupId ?? '?'}\n  • creatorId: ${r?.creatorId ?? '?'}\n  • startTime: ${start}\n  • repeat: ${r?.repeat ?? 0}\n  • emoji: ${r?.emoji ?? ''}`;
    } catch (e: any) {
        return err(e, 'getReminder');
    }
}

// ============================================================
// 38. Lấy danh sách response (accept/reject) cho reminder
// ============================================================
export async function getReminderResponses({ reminderId }: { reminderId: string }): Promise<string> {
    const rid = String(reminderId ?? '').trim();
    if (!rid) return `❌ reminderId rỗng.`;
    try {
        const r = await api().getReminderResponses(rid);
        const acc = r?.acceptMember ?? [];
        const rej = r?.rejectMember ?? [];
        return `Reminder ${rid} responses:\n  • Accept (${acc.length}): ${acc.join(', ') || '(chưa có)'}\n  • Reject (${rej.length}): ${rej.join(', ') || '(chưa có)'}`;
    } catch (e: any) {
        return err(e, 'getReminderResponses');
    }
}

// ============================================================
// 39. Lấy danh sách board (note + poll + pinned message) trong group
// ============================================================
export async function getListBoard({ groupId, page, count }: {
    groupId: string;
    page?: number;
    count?: number;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const r = await api().getListBoard({ page: page ?? 1, count: count ?? 20 }, gid);
        const items = r?.items ?? [];
        if (items.length === 0) return `Group ${gid} không có board items nào (note/poll/pinned).`;
        const typeMap: Record<number, string> = { 1: 'Note', 2: 'PinnedMsg', 3: 'Poll' };
        const lines = items.map((it: any, i: number) => {
            const t = typeMap[it.boardType] ?? `Type${it.boardType}`;
            const d = it.data ?? {};
            const id = d.id ?? d.poll_id ?? '?';
            const title = d.params?.title ?? d.question ?? '(no title)';
            return `${i + 1}. [${t}] id=${id} — "${title}"`;
        });
        return `📋 ${items.length} board items trong group ${gid}:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getListBoard');
    }
}

// ============================================================
// 40. Reaction tin nhắn (group hoặc user)
// ============================================================
export async function addReaction({ icon, msgId, cliMsgId, threadId, type }: {
    icon: string;                  // vd: "LIKE", "HEART", "HAHA", "ANGRY", "WOW", "CRY", ...
    msgId: string;
    cliMsgId: string;
    threadId: string;
    type?: 'User' | 'Group';
}): Promise<string> {
    const ic = String(icon ?? '').trim().toUpperCase();
    const supported = ['HEART', 'LIKE', 'HAHA', 'WOW', 'CRY', 'ANGRY', 'KISS', 'TEARS_OF_JOY', 'SHIT', 'ROSE', 'BROKEN_HEART', 'DISLIKE', 'LOVE', 'CONFUSED', 'WINK', 'FADE', 'SUN', 'BIRTHDAY', 'BOMB', 'OK', 'PEACE', 'THANKS', 'PUNCH', 'SHARE', 'PRAY', 'NO', 'BAD', 'LOVE_YOU', 'SAD', 'VERY_SAD', 'COOL', 'NERD', 'BIG_SMILE', 'SUNGLASSES', 'NEUTRAL', 'SAD_FACE', 'BYE', 'SLEEPY', 'WIPE', 'DIG', 'ANGUISH', 'HANDCLAP', 'ANGRY_FACE', 'F_CHAIR', 'L_CHAIR', 'R_CHAIR', 'SILENT', 'SURPRISE', 'EMBARRASSED', 'AFRAID', 'SAD2', 'BIG_LAUGH', 'RICH', 'BEER'];
    if (!supported.includes(ic)) return `❌ icon không hỗ trợ. Supported: ${supported.join(', ')}`;
    const mId = String(msgId ?? '').trim();
    const cId = String(cliMsgId ?? '').trim();
    const tid = String(threadId ?? '').trim();
    if (!mId || !cId || !tid) return `❌ Cần msgId, cliMsgId, threadId. (nhìn trong context tin nhắn bot nhận được)`;
    try {
        const { ThreadType, Reactions } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const iconEnum = (Reactions as any)[ic];
        if (!iconEnum) return `❌ Reactions.${ic} không tồn tại trong zca-js.`;
        await api().addReaction(iconEnum, {
            data: { msgId: mId, cliMsgId: cId },
            threadId: tid,
            type: tt,
        });
        return `✓ Đã reaction ${ic} vào msgId=${mId} trong ${type ?? 'Group'} ${tid}.`;
    } catch (e: any) {
        return err(e, 'addReaction');
    }
}

// ============================================================
// 41. Send typing event
// ============================================================
export async function sendTypingEvent({ threadId, type }: {
    threadId: string;
    type?: 'User' | 'Group';
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        await api().sendTypingEvent(tid, tt);
        return `✓ Đã gửi typing event vào ${type ?? 'Group'} ${tid}.`;
    } catch (e: any) {
        return err(e, 'sendTypingEvent');
    }
}

// ============================================================
// 42. Mute / unmute hội thoại
// ============================================================
export async function setMute({ threadId, type, action, duration }: {
    threadId: string;
    type?: 'User' | 'Group';
    action: 'mute' | 'unmute';
    duration?: number | 'ONE_HOUR' | 'FOUR_HOURS' | 'FOREVER' | 'UNTIL_8AM';
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    try {
        const { ThreadType, MuteAction, MuteDuration } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const act = action === 'unmute' ? MuteAction.UNMUTE : MuteAction.MUTE;
        let dur: any = MuteDuration.FOREVER;
        if (typeof duration === 'number') dur = duration;
        else if (duration === 'ONE_HOUR') dur = MuteDuration.ONE_HOUR;
        else if (duration === 'FOUR_HOURS') dur = MuteDuration.FOUR_HOURS;
        else if (duration === 'UNTIL_8AM') dur = MuteDuration.UNTIL_8AM;
        else dur = MuteDuration.FOREVER;
        await api().setMute({ duration: dur, action: act }, tid, tt);
        return `✓ Đã ${action} ${type ?? 'Group'} ${tid}${action === 'mute' ? ` (duration=${duration ?? 'FOREVER'})` : ''}.`;
    } catch (e: any) {
        return err(e, 'setMute');
    }
}

// ============================================================
// 43. Undo (thu hồi) tin nhắn
// ============================================================
export async function undoMessage({ threadId, type, msgId, cliMsgId }: {
    threadId: string;
    type?: 'User' | 'Group';
    msgId: string | number;
    cliMsgId: string | number;
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    const mId = String(msgId ?? '').trim();
    const cId = String(cliMsgId ?? '').trim();
    if (!mId || !cId) return `❌ Cần msgId + cliMsgId. (nhìn trong context tin nhắn bot đã gửi)`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const r = await api().undo({ msgId: mId, cliMsgId: cId }, tid, tt);
        return `✓ Đã thu hồi msgId=${mId} cliMsgId=${cId} trong ${type ?? 'Group'} ${tid}. (status: ${r?.status ?? 'ok'})`;
    } catch (e: any) {
        return err(e, 'undoMessage');
    }
}

// ============================================================
// 44. Delete message (chỉ xoá với mình hoặc xoá với tất cả)
// ============================================================
export async function deleteMessage({ threadId, type, msgId, cliMsgId, uidFrom, onlyMe }: {
    threadId: string;
    type?: 'User' | 'Group';
    msgId: string;
    cliMsgId: string;
    uidFrom: string;
    onlyMe?: boolean;
}): Promise<string> {
    const tid = String(threadId ?? '').trim();
    if (!tid) return `❌ threadId rỗng.`;
    const mId = String(msgId ?? '').trim();
    const cId = String(cliMsgId ?? '').trim();
    const uFrom = String(uidFrom ?? '').trim();
    if (!mId || !cId || !uFrom) return `❌ Cần msgId, cliMsgId, uidFrom.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const r = await api().deleteMessage({
            data: { cliMsgId: cId, msgId: mId, uidFrom: uFrom },
            threadId: tid,
            type: tt,
        }, !!onlyMe);
        return `✓ Đã delete msgId=${mId} trong ${type ?? 'Group'} ${tid}${onlyMe ? ' (onlyMe)' : ' (xoá với tất cả)'}. (status: ${r?.status ?? 'ok'})`;
    } catch (e: any) {
        return err(e, 'deleteMessage');
    }
}

// ============================================================
// 45. Forward message đến nhiều thread
// ============================================================
export async function forwardMessage({ message, threadIds, type, reference }: {
    message: string;
    threadIds: string[];
    type?: 'User' | 'Group';
    reference?: { id: string; ts: number; logSrcType: number; fwLvl: number };
}): Promise<string> {
    const msg = String(message ?? '').trim();
    if (!msg) return `❌ message rỗng.`;
    if (!Array.isArray(threadIds) || threadIds.length === 0) return `❌ Cần ít nhất 1 threadId.`;
    try {
        const { ThreadType } = await import('zca-js');
        const tt = (type ?? 'Group') === 'Group' ? ThreadType.Group : ThreadType.User;
        const r = await api().forwardMessage({ message: msg, reference }, threadIds, tt);
        const succ = r?.success ?? [];
        const fail = r?.fail ?? [];
        if (fail.length > 0) {
            const failLines = fail.map((f: any) => `  ✗ ${f.clientId}: ${f.error_code}`);
            return `✓ Forwarded ${succ.length}/${threadIds.length} thành công. Fail:\n${failLines.join('\n')}`;
        }
        return `✓ Đã forward message vào ${succ.length}/${threadIds.length} ${type ?? 'Group'}(s).`;
    } catch (e: any) {
        return err(e, 'forwardMessage');
    }
}

// ============================================================
// 46. Lấy group chat history
// ============================================================
export async function getGroupChatHistory({ groupId, count }: {
    groupId: string;
    count?: number;
}): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const c = Math.max(1, Math.min(50, typeof count === 'number' ? count : 20));
        const r = await api().getGroupChatHistory(gid, c);
        const msgs = r?.groupMsgs ?? [];
        if (msgs.length === 0) return `Group ${gid} không có tin nhắn nào (hoặc không lấy được).`;
        const lines = msgs.slice(0, c).map((m: any, i: number) => {
            const ts = m?.ts ? new Date(Number(m.ts)).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '?';
            const from = m?.dName ?? m?.uidFrom ?? '?';
            const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
            return `${i + 1}. [${ts}] ${from}: ${content.slice(0, 120)}`;
        });
        return `📋 ${msgs.length} tin gần nhất trong group ${gid}:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'getGroupChatHistory');
    }
}

// ============================================================
// 47. Lấy danh sách tất cả group bot đang ở
// ============================================================
export async function listAllGroups(): Promise<string> {
    try {
        const r = await api().getAllGroups();
        const gridVerMap = r?.gridVerMap ?? {};
        const gids = Object.keys(gridVerMap).filter(Boolean);
        if (gids.length === 0) return `Bot chưa ở group nào.`;
        // Batch getGroupInfo để lấy tên + member count
        const info: any = await api().getGroupInfo(gids);
        const gridInfoMap = info?.gridInfoMap ?? {};
        const lines = gids.map((gid, i) => {
            const g = gridInfoMap[gid] ?? {};
            const name = g?.name ?? '(không tên)';
            const total = g?.totalMember ?? '?';
            return `${i + 1}. "${name}" — groupId: ${gid} — ${total} members`;
        });
        return `📋 ${gids.length} group bot đang ở:\n${lines.join('\n')}`;
    } catch (e: any) {
        return err(e, 'listAllGroups');
    }
}

// ============================================================
// 48. Lấy chi tiết group (getGroupInfo + extract setting + members)
// ============================================================
export async function getGroupInfo({ groupId }: { groupId: string }): Promise<string> {
    const gid = String(groupId ?? '').trim();
    if (!validGid(gid)) return `❌ groupId "${gid}" không hợp lệ.`;
    try {
        const info: any = await api().getGroupInfo(gid);
        const g = info?.gridInfoMap?.[gid] ?? {};
        const memVerList: string[] = Array.isArray(g?.memVerList) ? g.memVerList : [];
        const uids = memVerList.map((s: string) => String(s).split('_')[0]).filter((u: string) => /^\d+$/.test(u));
        const setting = g?.setting ?? {};
        const settingLines = [
            `blockName=${setting.blockName}`,
            `signAdminMsg=${setting.signAdminMsg}`,
            `setTopicOnly=${setting.setTopicOnly}`,
            `enableMsgHistory=${setting.enableMsgHistory}`,
            `joinAppr=${setting.joinAppr}`,
            `lockCreatePost=${setting.lockCreatePost}`,
            `lockCreatePoll=${setting.lockCreatePoll}`,
            `lockSendMsg=${setting.lockSendMsg}`,
            `lockViewMember=${setting.lockViewMember}`,
        ];
        const header = `Group: ${g?.name ?? '(không tên)'} (id=${gid})\n` +
            `  • type: ${g?.type}\n` +
            `  • creatorId: ${g?.creatorId}\n` +
            `  • totalMember: ${g?.totalMember ?? uids.length}\n` +
            `  • maxMember: ${g?.maxMember ?? '?'}\n` +
            `  • adminIds: ${(g?.adminIds ?? []).join(', ') || '(none)'}\n` +
            `  • createdTime: ${g?.createdTime ? new Date(g.createdTime).toLocaleString('vi-VN') : '?'}\n` +
            `  • e2ee: ${g?.e2ee}\n` +
            `  • desc: ${g?.desc ?? ''}`;
        return `${header}\nSettings: ${settingLines.join(', ')}\nMember UIDs (first 20): ${uids.slice(0, 20).join(', ')}${uids.length > 20 ? ` ... (+${uids.length - 20})` : ''}`;
    } catch (e: any) {
        return err(e, 'getGroupInfo');
    }
}
