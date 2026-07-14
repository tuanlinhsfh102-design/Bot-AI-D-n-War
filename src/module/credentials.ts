/**
 * credentials.ts — Quản lý credentials Zalo (cookie + imei + userAgent + uid)
 *
 * Lưu tại: ./credentials.json
 * Schema:
 *   {
 *     "imei": "xxxx-xxxx-...",
 *     "userAgent": "Mozilla/5.0 ...",
 *     "cookie": [ { name, value, domain, path, ... } ],   // tough-cookie serialized
 *     "uid": "123456789",                                  // optional
 *     "savedAt": 1735600000000                             // unix ms, optional
 *   }
 *
 * Flow sử dụng (trong index.ts):
 *   1. tryLoadCredentials() → nếu có credentials.json
 *        → thử api.login({cookie, imei, userAgent})
 *        → bắt mọi lỗi (ZaloApiError, TypeError zpw_enk null, ...) → fallback QR
 *   2. Nếu fallback hoặc không có credentials.json
 *        → api.loginQR({qrPath}, callback)
 *        → callback nhận GotLoginInfo → saveCredentials()
 */
import fs from 'node:fs';
import path from 'path';

export interface ZaloCredentials {
    imei: string;
    userAgent: string;
    cookie: any[] | { url: string; cookies: any[] };
    uid?: string;
    savedAt?: number;
}

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

export function credentialsExists(): boolean {
    return fs.existsSync(CREDENTIALS_PATH);
}

export function loadCredentials(): ZaloCredentials | null {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    try {
        const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (!obj.imei || !obj.userAgent || !obj.cookie) return null;
        return {
            imei: String(obj.imei),
            userAgent: String(obj.userAgent),
            cookie: obj.cookie,
            uid: obj.uid ? String(obj.uid) : undefined,
            savedAt: obj.savedAt ? Number(obj.savedAt) : undefined,
        };
    } catch (e) {
        console.warn('[Credentials] load failed:', e);
        return null;
    }
}

export function saveCredentials(creds: ZaloCredentials): void {
    try {
        const data: ZaloCredentials = {
            ...creds,
            savedAt: Date.now(),
        };
        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2));
        console.log(`[Credentials] Saved to ${CREDENTIALS_PATH}`);
    } catch (e) {
        console.error('[Credentials] save failed:', e);
    }
}

/**
 * Convert CookieJar (tough-cookie) → array format để JSON serialize.
 * Zalo API chấp nhận cả array hoặc {url, cookies}. Ta dùng array cho đơn giản.
 */
export function cookieJarToArray(jar: any): any[] {
    try {
        // tough-cookie CookieJar.toJSON() returns { cookies: [...] } or { version, storeType, cookies }
        const serialized = typeof jar?.toJSON === 'function' ? jar.toJSON() : jar;
        if (Array.isArray(serialized)) return serialized;
        if (Array.isArray(serialized?.cookies)) return serialized.cookies;
        // Fallback: try getCookies for each domain — hard without knowing domains
        return serialized ? [serialized] : [];
    } catch (e) {
        console.warn('[Credentials] cookieJarToArray failed:', e);
        return [];
    }
}

/**
 * Kiểm tra credentials cũ quá (hơn 30 ngày) → có thể đã hết hạn
 */
export function isCredentialsStale(creds: ZaloCredentials, maxAgeDays: number = 30): boolean {
    if (!creds.savedAt) return true;
    const ageMs = Date.now() - creds.savedAt;
    return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Kiểm tra cookie có nguy cơ hết hạn session.
 *
 * ⚠️ QUAN TRỌNG: Zalo's `zlogin_session` cookie chỉ có maxAge = 3600s (1 GIỜ).
 * Sau 1 giờ, login sẽ fail với lỗi "Đăng nhập thất bại".
 * Tuy nhiên `zpw_sek` (maxAge 90 ngày) vẫn còn hiệu lực, nhưng zca-js cần
 * `zlogin_session` để gọi /api/login step.
 *
 * Logic:
 *   - Nếu savedAt > 50 phút trước → warning (sắp hết hạn)
 *   - Nếu savedAt > 60 phút trước → expired (cần re-login qua QR)
 *
 * Giải pháp: thiết lập auto-refresh cookie mỗi 45 phút bằng cách re-login
 * (xem index.ts auto-refresh scheduler).
 *
 * @returns 'fresh' | 'warning' | 'expired'
 */
export function getCookieFreshness(creds: ZaloCredentials): 'fresh' | 'warning' | 'expired' {
    if (!creds.savedAt) return 'expired';
    const ageMs = Date.now() - creds.savedAt;
    const ONE_HOUR = 60 * 60 * 1000;
    if (ageMs > ONE_HOUR) return 'expired';
    if (ageMs > 50 * 60 * 1000) return 'warning';  // >50 phút
    return 'fresh';
}
