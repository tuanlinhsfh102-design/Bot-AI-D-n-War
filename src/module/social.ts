import fs from 'fs';
import path from 'path';
import { findTargetByUid } from './targets';

export interface SocialProfile {
    uid: string;
    displayName: string;
    role: 'enemy' | 'rival' | 'neutral' | 'ally';
    friendScore: number;   // 0-100
    enemyScore: number;    // 0-100
    autoDetected: boolean;
    evidence: string[];
    lastUpdated: number;
}

const DATA_FILE = path.join(process.cwd(), 'data', 'social_graph.json');

function ensureDataFile(): void {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
    }
}

export function loadSocialProfiles(): Record<string, SocialProfile> {
    try {
        ensureDataFile();
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(raw) ?? {};
    } catch {
        return {};
    }
}

export function saveSocialProfiles(profiles: Record<string, SocialProfile>): void {
    try {
        ensureDataFile();
        fs.writeFileSync(DATA_FILE, JSON.stringify(profiles, null, 2));
    } catch (e) {
        console.warn('[Social] Save graph failed:', e);
    }
}

export function getSocialProfile(uid: string, displayName: string = ''): SocialProfile {
    const profiles = loadSocialProfiles();
    const cleanUid = String(uid);

    // BOSS (Đại Ca) đặc biệt của Nguyễn Đình Dương
    // ⚠️ FIX v1.6.2 — Đọc BOSS_UID từ env (mặc định giữ UID gốc). Cho phép đổi admin account mà không cần sửa code.
    const BOSS_UID = process.env.BOSS_UID ?? '2716720122162617538';
    const isBoss = cleanUid === BOSS_UID;

    // Kiểm tra xem có trong danh sách đen targets cứng của Nguyễn Đình Dương không
    const isTarget = !isBoss && !!findTargetByUid(cleanUid);

    if (profiles[cleanUid]) {
        // Cập nhật tên nếu có tên mới
        if (displayName && profiles[cleanUid].displayName !== displayName) {
            profiles[cleanUid].displayName = displayName;
            saveSocialProfiles(profiles);
        }
        // Đồng bộ cứng target/boss nếu có thay đổi
        if (isBoss) {
            profiles[cleanUid].role = 'ally';
            profiles[cleanUid].friendScore = 100;
            profiles[cleanUid].enemyScore = 0;
            saveSocialProfiles(profiles);
        } else if (isTarget && profiles[cleanUid].role !== 'enemy') {
            profiles[cleanUid].role = 'enemy';
            profiles[cleanUid].enemyScore = Math.max(80, profiles[cleanUid].enemyScore);
            saveSocialProfiles(profiles);
        }
        return profiles[cleanUid];
    }

    // Tạo profile mới
    const defaultRole = isBoss ? 'ally' : (isTarget ? 'enemy' : 'neutral');
    const defaultEnemyScore = isTarget ? 80 : 0;
    const defaultFriendScore = isBoss ? 100 : 0;

    const newProfile: SocialProfile = {
        uid: cleanUid,
        displayName: displayName || (isBoss ? 'Tuấn Linh' : `User_${cleanUid}`),
        role: defaultRole,
        friendScore: defaultFriendScore,
        enemyScore: defaultEnemyScore,
        autoDetected: true,
        evidence: isBoss 
            ? ['ĐẠI CA TUẤN LINH tối cao, chủ sở hữu bot']
            : (isTarget ? ['Có tên trong danh sách đen (TARGETS) mặc định'] : []),
        lastUpdated: Date.now(),
    };

    profiles[cleanUid] = newProfile;
    saveSocialProfiles(profiles);
    return newProfile;
}

export function classifyRole(friend: number, enemy: number, isTarget: boolean): 'enemy' | 'rival' | 'neutral' | 'ally' {
    if (isTarget) return 'enemy';
    if (enemy >= 55) return 'enemy';
    if (enemy >= 25) return 'rival';
    if (friend >= 35 && enemy < 15) return 'ally';
    return 'neutral';
}

export function recordSocialSignal(
    uid: string,
    displayName: string,
    type: 'friend' | 'enemy',
    points: number,
    reason: string
): SocialProfile {
    const profiles = loadSocialProfiles();
    const cleanUid = String(uid);
    const profile = getSocialProfile(cleanUid, displayName);

    const isTarget = !!findTargetByUid(cleanUid);

    if (type === 'friend') {
        profile.friendScore = Math.max(0, Math.min(100, profile.friendScore + points));
        // Khi tăng điểm bạn bè, giảm nhẹ thù hận
        profile.enemyScore = Math.max(0, Math.min(100, profile.enemyScore - Math.floor(points / 2)));
    } else {
        profile.enemyScore = Math.max(0, Math.min(100, profile.enemyScore + points));
        // Khi tăng thù hận, giảm mạnh điểm bạn bè
        profile.friendScore = Math.max(0, Math.min(100, profile.friendScore - points));
    }

    // Lưu bằng chứng gần nhất (max 5)
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    profile.evidence.push(`[${timeStr}] ${reason} (${type === 'friend' ? '+' : '-'}${points})`);
    if (profile.evidence.length > 5) {
        profile.evidence.shift();
    }

    profile.role = classifyRole(profile.friendScore, profile.enemyScore, isTarget);
    profile.lastUpdated = Date.now();

    profiles[cleanUid] = profile;
    saveSocialProfiles(profiles);
    console.log(`[Social] Recalculated ${profile.displayName} (${cleanUid}): role=${profile.role}, friend=${profile.friendScore}, enemy=${profile.enemyScore}`);
    return profile;
}

export function getSocialContext(uid: string, displayName: string = ''): string {
    const p = getSocialProfile(uid, displayName);
    const roleVN = {
        enemy: 'KẺ THÙ (Chửi thẳng mặt, war mode tối đa)',
        rival: 'ĐỐI THỦ (Hay cà khịa, sẵn sàng combat nhưng giữ chừng mực)',
        neutral: 'NGƯỜI LẠ/TRUNG LẬP (Nói chuyện bình thường, chill gen z)',
        ally: 'ĐỒNG MINH/BẠN BÈ (Thân thiết, bênh vực khi bị tấn công, khen, ủng hộ)',
    }[p.role];

    return `Mối quan hệ xã hội với người này:
- Trạng thái: ${roleVN}
- Điểm bạn bè (friendScore): ${p.friendScore}/100
- Điểm kẻ thù (enemyScore): ${p.enemyScore}/100
- Lịch sử bằng chứng: ${p.evidence.length > 0 ? '\n  ' + p.evidence.join('\n  ') : '(Chưa có bằng chứng nổi bật)'}`;
}
