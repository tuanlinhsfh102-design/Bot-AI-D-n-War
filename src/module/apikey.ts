/**
 * apikey.ts — HỆ THỐNG API KEY THÔNG MINH
 * ==========================================
 *
 * "Ném key vào là chạy" — bot tự lo rotation, health tracking, cooldown,
 * persistent state. User chỉ cần drop file vào `data/api_keys/`.
 *
 * Nguồn key (ưu tiên từ trên xuống):
 *   1. Env var MULTI:  GOOGLE_GENERATIVE_AI_API_KEYS=key1,key2,key3
 *                     BRAVE_API_KEYS=key1|key2
 *   2. Env var SINGLE: GOOGLE_GENERATIVE_AI_API_KEY=AIza...
 *                     BRAVE_API_KEY=BSA...
 *   3. File:          data/api_keys/gemini.txt       (mỗi dòng 1 key)
 *                     data/api_keys/brave.txt
 *                     data/api_keys/gemini_*.txt     (1 file 1 key, auto-label)
 *                     data/api_keys/brave_label.txt  (label từ tên file)
 *   4. Runtime:       addApiKey(service, key, label?) — thêm từ code
 *
 * Tính năng "smart":
 *   - Health-weighted rotation: ưu tiên key khoẻ nhất (success rate + recency)
 *   - Auto-cooldown: 429/quota → 10 phút, 401/403 → 30 phút
 *   - Auto-blacklist: 3 lần 401/403 liên tiếp → mark DEAD vĩnh viễn
 *   - Quota tracking: tự cooldown nếu key bị spam > N calls/phút
 *   - File watcher: fs.watch data/api_keys/ → reload không cần restart
 *   - Persistent: data/api_key_state.json → restart vẫn nhớ key nào chết
 *   - Revive check: thử lại key DEAD mỗi giờ (có thể user gỡ limit)
 *   - Per-key stats: usage count, success rate, last error, source
 *
 * Dùng:
 *   await withServiceApiKey('gemini', async (key) => { ... })
 *   await withGoogleModel('gemini-3.1-flash-lite', async (model, key) => { ... })
 *
 * Reference:
 *   - zca-js: https://github.com/RFS-ADRENO/zca-js
 *   - zca-js docs: https://tdung.gitbook.io/zca-js
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
// ⭐ v1.7.0 — OpenCode Zen API (https://opencode.ai/docs/zen/)
// Endpoint: https://opencode.ai/zen/v1/chat/completions
// AI SDK: @ai-sdk/openai-compatible
// Default model: deepseek-v4-flash-free (Free — available limited time)
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// ============================================================
// Types
// ============================================================
export type ServiceName = 'gemini' | 'brave' | 'zen';

export type KeySource = 'env-multi' | 'env-single' | 'file' | 'runtime';

export interface KeyState {
    /** Masked fingerprint để tra cứu (vd: "AIzaSyAB...XYZW") */
    fingerprint: string;
    service: ServiceName;
    /** Raw key — chỉ lưu trong RAM, KHÔNG ghi ra file */
    key: string;
    source: KeySource;
    /** Label tuỳ chọn (từ tên file hoặc runtime) */
    label?: string;

    // ----- Health tracking -----
    totalCalls: number;
    successCalls: number;
    failureCalls: number;
    /** Số fail liên tiếp — reset về 0 khi có success */
    consecutiveFailures: number;

    // ----- Quota tracking (rolling window 60s) -----
    recentCalls: number[]; // timestamps trong 60s gần nhất

    // ----- Status -----
    /** Timestamp (ms) đến khi key ra khỏi cooldown. 0 = sẵn sàng */
    cooldownUntil: number;
    /** Key bị blacklist vĩnh viễn (401/403 x N lần). Cần manual revive */
    dead: boolean;
    deadReason?: string;
    deadSince?: number;

    // ----- Metadata -----
    addedAt: number;
    lastUsedAt?: number;
    lastError?: string;
    /** Thời điểm check revive gần nhất (cho key DEAD) */
    lastReviveCheckAt?: number;
}

interface ServiceStats {
    service: ServiceName;
    totalKeys: number;
    activeKeys: number;
    cooldownKeys: number;
    deadKeys: number;
    totalCalls: number;
    successfulCalls: number;
    failedCalls?: number;
    successRate: number;
    strategy: 'health-weighted' | 'round-robin' | 'single';
}

// ============================================================
// Constants
// ============================================================
const ROTATION_WINDOW_MS = 60_000;          // rolling window cho quota tracking
const MAX_CALLS_PER_MIN_PER_KEY = 30;       // > 30 calls/phút/key → cooldown 60s
const DEAD_AFTER_CONSECUTIVE_AUTH_FAILS = 3; // 401/403 x 3 lần liên tiếp → DEAD
const REVIVE_CHECK_INTERVAL_MS = 60 * 60_000; // thử revive DEAD key mỗi 1 giờ
const FRESH_KEY_TTL_MS = 60 * 60_000;       // key mới trong 1h → score=1.0 (ưu tiên thử trước)
const STATE_FILE = path.join(process.cwd(), 'data', 'api_key_state.json');
const KEYS_DIR = path.join(process.cwd(), 'data', 'api_keys');

// Cooldown duration theo loại lỗi
const COOLDOWN_QUOTA_MS = 10 * 60_000;       // 429, quota, rate limit → 10 phút
const COOLDOWN_AUTH_MS = 30 * 60_000;        // 401, 403, invalid key → 30 phút
const COOLDOWN_GENERIC_MS = 3 * 60_000;      // lỗi khác → 3 phút
const COOLDOWN_QUOTA_SOFT_MS = 60_000;       // self-imposed (spam detection) → 60s

// Service config
const SERVICE_CONFIG: Record<ServiceName, {
    multiEnv: string[];
    singleEnv: string[];
    label: string;
    /** File mặc định cho mỗi service (vd: data/api_keys/gemini.txt) */
    defaultFile: string;
    /** Prefix để nhận diện key (vd: AIza cho Gemini, BSA cho Brave) */
    keyPrefix?: string[];
}> = {
    gemini: {
        multiEnv: [
            'GOOGLE_GENERATIVE_AI_API_KEYS',
            'GEMINI_API_KEYS',
            'GOOGLE_API_KEYS',
            'GOOGLE_AI_API_KEYS',
        ],
        singleEnv: [
            'GOOGLE_GENERATIVE_AI_API_KEY',
            'GEMINI_API_KEY',
            'GOOGLE_API_KEY',
            'GOOGLE_AI_API_KEY',
        ],
        label: 'Gemini',
        defaultFile: 'gemini.txt',
        keyPrefix: ['AIza'],
    },
    brave: {
        multiEnv: ['BRAVE_API_KEYS', 'BRAVE_SEARCH_API_KEYS'],
        singleEnv: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
        label: 'Brave Search',
        defaultFile: 'brave.txt',
    },
    // ⭐ v1.7.0 — OpenCode Zen (https://opencode.ai/docs/zen/)
    // Lấy API key tại: https://opencode.ai/zen (sign in → billing → copy API key)
    zen: {
        multiEnv: ['OPENCODE_ZEN_API_KEYS', 'ZEN_API_KEYS'],
        singleEnv: ['OPENCODE_ZEN_API_KEY', 'ZEN_API_KEY'],
        label: 'OpenCode Zen',
        defaultFile: 'zen.txt',
    },
};

// ============================================================
// Internal state (in-memory)
// ============================================================
const keysByService = new Map<ServiceName, Map<string, KeyState>>();
const roundRobinIndex = new Map<ServiceName, number>();
let fileWatcher: fs.FSWatcher | null = null;
let reviveTimer: NodeJS.Timeout | null = null;
let initialized = false;

// ============================================================
// Utilities
// ============================================================
function makeFingerprint(key: string): string {
    if (key.length <= 12) return `${key.slice(0, 4)}...${key.slice(-2)}`;
    return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function splitEnvList(value: string): string[] {
    return String(value ?? '')
        .split(/[\r\n,;|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function unique(items: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

function getOrCreateKeyMap(service: ServiceName): Map<string, KeyState> {
    let m = keysByService.get(service);
    if (!m) {
        m = new Map();
        keysByService.set(service, m);
    }
    return m;
}

function nowMs(): number {
    return Date.now();
}

// #region debug-point A:report-helper
// ⚠️ FIX v1.6.2 — Gate debugReportApiKey bằng env var DEBUG_APIKEY.
// Trước đây: hàm này luôn chạy, đọc file .dbg/ (gần như không tồn tại) + fetch 127.0.0.1:7778
// (server thường không chạy) mỗi API call → overhead + catch silent 5-10 lần/AI call.
// Giờ: chỉ chạy khi DEBUG_APIKEY=true được set trong .env.
const DEBUG_APIKEY = process.env.DEBUG_APIKEY === 'true';
function debugReportApiKey(
    hypothesisId: 'A' | 'B' | 'C' | 'D' | 'E',
    location: string,
    msg: string,
    data: Record<string, unknown>,
): void {
    if (!DEBUG_APIKEY) return;
    try {
        let debugUrl = 'http://127.0.0.1:7778/event';
        let sessionId = 'gemini-key-invalid';
        try {
            const envText = fs.readFileSync(path.join(process.cwd(), '.dbg', 'gemini-key-invalid.env'), 'utf-8');
            debugUrl = envText.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || debugUrl;
            sessionId = envText.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || sessionId;
        } catch { /* ignore */ }
        fetch(debugUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId,
                runId: 'pre-fix',
                hypothesisId,
                location,
                msg: `[DEBUG] ${msg}`,
                data,
                ts: Date.now(),
            }),
        }).catch(() => {});
    } catch { /* ignore */ }
}
// #endregion

// ============================================================
// Cooldown & rotation error detection
// ============================================================
function classifyError(err: unknown): 'auth' | 'quota' | 'generic' {
    const text = String((err as any)?.message ?? err ?? '').toLowerCase();
    if (
        text.includes('429') ||
        text.includes('quota') ||
        text.includes('rate limit') ||
        text.includes('resource_exhausted') ||
        text.includes('too many requests')
    ) return 'quota';
    if (
        text.includes('401') ||
        text.includes('403') ||
        text.includes('unauthorized') ||
        text.includes('permission') ||
        text.includes('invalid api key') ||
        text.includes('api key not valid') ||
        text.includes('forbidden')
    ) return 'auth';
    return 'generic';
}

function shouldRotateKey(err: unknown): boolean {
    const cls = classifyError(err);
    return cls === 'auth' || cls === 'quota';
}

function getCooldownMs(err: unknown): number {
    return classifyError(err) === 'auth'
        ? COOLDOWN_AUTH_MS
        : classifyError(err) === 'quota'
            ? COOLDOWN_QUOTA_MS
            : COOLDOWN_GENERIC_MS;
}

// ============================================================
// Key discovery — env, file, runtime
// ============================================================
function ensureKeysDir(): void {
    try {
        if (!fs.existsSync(KEYS_DIR)) {
            fs.mkdirSync(KEYS_DIR, { recursive: true });
        }
    } catch { /* ignore */ }
}

function readKeysFromDefaultFile(service: ServiceName): Array<{ key: string; label?: string }> {
    const cfg = SERVICE_CONFIG[service];
    const filePath = path.join(KEYS_DIR, cfg.defaultFile);
    if (!fs.existsSync(filePath)) return [];
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return splitEnvList(content).map((key) => ({ key }));
    } catch (e: any) {
        console.warn(`[ApiKey] Không đọc được ${filePath}: ${e?.message ?? e}`);
        return [];
    }
}

function readKeysFromIndividualFiles(service: ServiceName): Array<{ key: string; label?: string }> {
    if (!fs.existsSync(KEYS_DIR)) return [];
    const cfg = SERVICE_CONFIG[service];
    const servicePrefix = `${service}_`;
    const out: Array<{ key: string; label?: string }> = [];

    let entries: string[];
    try {
        entries = fs.readdirSync(KEYS_DIR);
    } catch {
        return [];
    }

    for (const name of entries) {
        // Match pattern: gemini_xxx.txt, brave_xxx.txt
        if (!name.startsWith(servicePrefix)) continue;
        if (!name.endsWith('.txt')) continue;
        if (name === cfg.defaultFile) continue; // đã đọc ở default file
        const filePath = path.join(KEYS_DIR, name);
        try {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content) continue;
            // File có thể chứa nhiều key, hoặc label\nkey\nkey
            const lines = splitEnvList(content);
            if (lines.length === 0) continue;
            // Label lấy từ phần tên file (bỏ prefix service_ và đuôi .txt)
            const labelFromName = name.slice(servicePrefix.length, -4).trim();
            // Nếu file chỉ có 1 dòng → lấy đó làm key, label từ tên file
            // Nếu nhiều dòng → dòng đầu là label, các dòng sau là key
            if (lines.length === 1) {
                out.push({ key: lines[0], label: labelFromName || undefined });
            } else {
                const labelFromContent = lines[0];
                for (let i = 1; i < lines.length; i++) {
                    out.push({ key: lines[i], label: labelFromContent || labelFromName });
                }
            }
        } catch (e: any) {
            console.warn(`[ApiKey] Không đọc được ${filePath}: ${e?.message ?? e}`);
        }
    }
    return out;
}

function readKeysFromEnv(service: ServiceName): Array<{ key: string; source: KeySource }> {
    const cfg = SERVICE_CONFIG[service];
    const out: Array<{ key: string; source: KeySource }> = [];

    for (const envName of cfg.multiEnv) {
        const value = process.env[envName];
        if (value?.trim()) {
            for (const key of splitEnvList(value)) {
                out.push({ key, source: 'env-multi' });
            }
        }
    }

    for (const envName of cfg.singleEnv) {
        const value = process.env[envName]?.trim();
        if (value) out.push({ key: value, source: 'env-single' });
    }

    // #region debug-point B:env-scan
    debugReportApiKey('B', 'apikey.ts:readKeysFromEnv', `Scanned env keys for ${service}`, {
        service,
        multiEnv: cfg.multiEnv.map((envName) => ({
            envName,
            present: Boolean(process.env[envName]?.trim()),
            valuePreview: process.env[envName]?.trim() ? makeFingerprint(process.env[envName]!.trim()) : '',
            valueLength: process.env[envName]?.trim()?.length ?? 0,
        })),
        singleEnv: cfg.singleEnv.map((envName) => ({
            envName,
            present: Boolean(process.env[envName]?.trim()),
            valuePreview: process.env[envName]?.trim() ? makeFingerprint(process.env[envName]!.trim()) : '',
            valueLength: process.env[envName]?.trim()?.length ?? 0,
        })),
        discoveredFingerprints: out.map((entry) => makeFingerprint(entry.key)),
    });
    // #endregion

    return out;
}

/**
 * Lấy TẤT CẢ key cho 1 service (env + file + runtime), merge vào in-memory store.
 * Idempotent — gọi nhiều lần không tạo duplicate.
 */
function reloadService(service: ServiceName): { added: number; removed: number } {
    const map = getOrCreateKeyMap(service);
    const before = map.size;
    const beforeFingerprints = Array.from(map.values()).map((k) => ({ fingerprint: k.fingerprint, source: k.source, hasKey: Boolean(k.key) }));

    // 1. Env keys — luôn merge vào (override key cũ nếu trùng fingerprint)
    for (const { key, source } of readKeysFromEnv(service)) {
        upsertKey(service, key, { source });
    }

    // 2. Default file
    for (const { key } of readKeysFromDefaultFile(service)) {
        upsertKey(service, key, { source: 'file', label: path.basename(SERVICE_CONFIG[service].defaultFile, '.txt') });
    }

    // 3. Individual files
    for (const { key, label } of readKeysFromIndividualFiles(service)) {
        upsertKey(service, key, { source: 'file', label });
    }

    const after = map.size;
    // #region debug-point C:reload-merge
    debugReportApiKey('C', 'apikey.ts:reloadService', `Reloaded key pool for ${service}`, {
        service,
        before,
        after,
        beforeFingerprints,
        afterKeys: Array.from(map.values()).map((k) => ({
            fingerprint: k.fingerprint,
            source: k.source,
            label: k.label ?? '',
            hasKey: Boolean(k.key),
            keyLength: k.key.length,
        })),
        fileKeys: [
            ...readKeysFromDefaultFile(service).map((entry) => ({ fingerprint: makeFingerprint(entry.key), label: entry.label ?? '' })),
            ...readKeysFromIndividualFiles(service).map((entry) => ({ fingerprint: makeFingerprint(entry.key), label: entry.label ?? '' })),
        ],
    });
    // #endregion
    return { added: after - before, removed: 0 };
}

function upsertKey(
    service: ServiceName,
    key: string,
    opts: { source?: KeySource; label?: string; resetStats?: boolean } = {},
): KeyState {
    const map = getOrCreateKeyMap(service);
    const fp = makeFingerprint(key);
    const existing = map.get(fp);

    if (existing) {
        // Cập nhật key mới (nếu user paste lại) + source
        existing.key = key;
        if (opts.source) existing.source = opts.source;
        if (opts.label) existing.label = opts.label;
        // KHÔNG reset stats khi reload — preserve health history
        return existing;
    }

    const state: KeyState = {
        fingerprint: fp,
        service,
        key,
        source: opts.source ?? 'runtime',
        label: opts.label,
        totalCalls: 0,
        successCalls: 0,
        failureCalls: 0,
        consecutiveFailures: 0,
        recentCalls: [],
        cooldownUntil: 0,
        dead: false,
        addedAt: nowMs(),
    };
    map.set(fp, state);
    return state;
}

// ============================================================
// Persistent state
// ============================================================
interface PersistedShape {
    version: 1;
    savedAt: number;
    services: Record<ServiceName, Array<{
        fingerprint: string;
        label?: string;
        totalCalls: number;
        successCalls: number;
        failureCalls: number;
        consecutiveFailures: number;
        cooldownUntil: number;
        dead: boolean;
        deadReason?: string;
        deadSince?: number;
        lastUsedAt?: number;
        lastError?: string;
        lastReviveCheckAt?: number;
        addedAt: number;
    }>>;
}

function loadPersistedState(): PersistedShape | null {
    if (!fs.existsSync(STATE_FILE)) return null;
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedShape;
        if (parsed?.version !== 1) return null;
        return parsed;
    } catch (e: any) {
        console.warn(`[ApiKey] Không đọc được state file: ${e?.message ?? e}`);
        return null;
    }
}

function savePersistedState(): void {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const services = {} as PersistedShape['services'];
        for (const [service, map] of keysByService.entries()) {
            services[service] = Array.from(map.values()).map((k) => ({
                fingerprint: k.fingerprint,
                label: k.label,
                totalCalls: k.totalCalls,
                successCalls: k.successCalls,
                failureCalls: k.failureCalls,
                consecutiveFailures: k.consecutiveFailures,
                cooldownUntil: k.cooldownUntil,
                dead: k.dead,
                deadReason: k.deadReason,
                deadSince: k.deadSince,
                lastUsedAt: k.lastUsedAt,
                lastError: k.lastError,
                lastReviveCheckAt: k.lastReviveCheckAt,
                addedAt: k.addedAt,
            }));
        }

        const payload: PersistedShape = {
            version: 1,
            savedAt: nowMs(),
            services,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e: any) {
        console.warn(`[ApiKey] Không ghi được state file: ${e?.message ?? e}`);
    }
}

let saveStateDirty = false;
let saveStateTimer: NodeJS.Timeout | null = null;
function schedulePersist(): void {
    saveStateDirty = true;
    if (saveStateTimer) return;
    saveStateTimer = setTimeout(() => {
        saveStateTimer = null;
        if (saveStateDirty) {
            saveStateDirty = false;
            savePersistedState();
        }
    }, 2000); // debounce 2s
}

// ============================================================
// File watcher
// ============================================================
function startFileWatcher(): void {
    if (fileWatcher) return;
    ensureKeysDir();
    try {
        fileWatcher = fs.watch(KEYS_DIR, { persistent: false }, (eventType, filename) => {
            if (!filename) return;
            const nameStr = String(filename);
            // Reload tất cả service khi có bất kỳ file nào thay đổi
            // (đơn giản hơn là detect từng service)
            console.log(`[ApiKey] File ${eventType}: ${nameStr} → reload`);
            reloadAllServices();
        });
        fileWatcher.on('error', (e: any) => {
            console.warn(`[ApiKey] File watcher lỗi: ${e?.message ?? e}`);
            // Thử restart watcher
            stopFileWatcher();
            setTimeout(startFileWatcher, 5000);
        });
        console.log(`[ApiKey] ✓ Đang theo dõi ${KEYS_DIR}`);
    } catch (e: any) {
        console.warn(`[ApiKey] Không khởi tạo được file watcher: ${e?.message ?? e}`);
    }
}

function stopFileWatcher(): void {
    if (fileWatcher) {
        try { fileWatcher.close(); } catch { /* ignore */ }
        fileWatcher = null;
    }
}

// ============================================================
// Revive checker — thử lại key DEAD định kỳ
// ============================================================
function startReviveChecker(): void {
    if (reviveTimer) return;
    reviveTimer = setInterval(() => {
        const now = nowMs();
        let revived = 0;
        for (const map of keysByService.values()) {
            for (const k of map.values()) {
                if (!k.dead) continue;
                if ((k.lastReviveCheckAt ?? 0) + REVIVE_CHECK_INTERVAL_MS > now) continue;
                // Cho key DEAD có cơ hội thử lại — chỉ cần 1 call thành công sẽ revive
                // Ở đây ta KHÔNG tự gọi API (tốn quota) — chỉ mark là "eligible to retry"
                // Logic revive thực sự nằm ở markKeySuccess: nếu key DEAD mà success → revive
                k.lastReviveCheckAt = now;
                revived++;
            }
        }
        if (revived > 0) {
            console.log(`[ApiKey] Revive check: ${revived} key DEAD sẵn sàng thử lại`);
            schedulePersist();
        }
    }, REVIVE_CHECK_INTERVAL_MS);
    // Unref để không giữ event loop
    if (typeof reviveTimer.unref === 'function') reviveTimer.unref();
}

function stopReviveChecker(): void {
    if (reviveTimer) {
        clearInterval(reviveTimer);
        reviveTimer = null;
    }
}

// ============================================================
// Quota tracking — phát hiện spam per-key
// ============================================================
function trackCall(keyState: KeyState): boolean {
    // Trả về true nếu OK, false nếu vượt quota
    const now = nowMs();
    // Drop old timestamps
    keyState.recentCalls = keyState.recentCalls.filter((t) => now - t < ROTATION_WINDOW_MS);
    if (keyState.recentCalls.length >= MAX_CALLS_PER_MIN_PER_KEY) {
        // Self-imposed cooldown — key bị spam quá nhiều
        keyState.cooldownUntil = Math.max(keyState.cooldownUntil, now + COOLDOWN_QUOTA_SOFT_MS);
        return false;
    }
    keyState.recentCalls.push(now);
    return true;
}

// ============================================================
// Key selection — health-weighted rotation
// ============================================================
function getHealthyKeys(service: ServiceName): KeyState[] {
    const map = keysByService.get(service);
    if (!map) return [];
    const now = nowMs();
    const out: KeyState[] = [];
    for (const k of map.values()) {
        if (k.dead) continue;
        if (k.cooldownUntil > now) continue;
        out.push(k);
    }
    return out;
}

function computeHealthScore(k: KeyState): number {
    const now = nowMs();

    // FRESH KEY GRACE PERIOD: key mới thêm trong vòng FRESH_KEY_TTL_MS (1h)
    // → score tối đa (1.0) để rotation THỬ KEY MỚI TRƯỚC.
    // Fix bug "user thêm key mới nhưng bot vẫn dùng key cũ".
    if (now - k.addedAt < FRESH_KEY_TTL_MS) {
        return 1.0;
    }

    if (k.totalCalls === 0) return 0.5; // key mới nhưng đã qua grace → score trung bình
    const successRate = k.successCalls / k.totalCalls;
    // Penalty cho consecutive failures (giảm dần theo thời gian)
    const recentPenalty = Math.min(0.5, k.consecutiveFailures * 0.1);
    // ⚠️ FIX v1.5.0 — Recency PENALTY thay vì bonus.
    // Trước đây: key vừa dùng thành công → +0.05 bonus → key đó CỨ thắng →
    // các key khác không bao giờ được dùng (4/5 keys có 0 calls trong production).
    // Giờ: key vừa dùng < 10s → -0.15 penalty → cho key khác cơ hội được dùng.
    // Vẫn giữ "warm" bonus nhẹ ở 10-60s (0.02) để tận dụng connection reuse.
    let recencyAdjust = 0;
    if (k.lastUsedAt) {
        const sinceLast = now - k.lastUsedAt;
        if (sinceLast < 10_000) {
            recencyAdjust = -0.15; // vừa dùng → step back
        } else if (sinceLast < 60_000) {
            recencyAdjust = 0.02; // ấm → nhẹ bonus
        }
    }
    return Math.max(0.1, successRate - recentPenalty + recencyAdjust);
}

/**
 * Weighted random pick — thay vì always-pick-top.
 *
 * ⚠️ FIX v1.5.0 — Trước đây pickKeyByHealth sort theo score giảm dần rồi lấy [0],
 * cộng `+ Math.random() * 0.05` làm tie-break. Nhưng khi 1 key có score 1.0 và 4 key
 * có score 0.5, random tie-break 0.05 KHÔNG đủ để lật kết quả → key 1.0 luôn thắng
 * → 4 key kia không bao giờ được dùng (0 calls).
 *
 * Giờ: weighted random selection. Tổng score = sum(score_i). Pick theo probability
 * score_i / total. Key có score cao hơn được pick PROBABILISTIC nhiều hơn, nhưng key
 * score thấp vẫn có cơ hội được dùng → load balancer thực sự.
 */
function pickKeyByHealth(service: ServiceName): KeyState | null {
    const healthy = getHealthyKeys(service);
    if (healthy.length === 0) {
        // Fallback: nếu TẤT CẢ key đều cooldown/dead, thử lấy key chưa DEAD
        // (kể cả đang cooldown — user có thể cần hơn là không có gì)
        const map = keysByService.get(service);
        if (!map) return null;
        const candidates = Array.from(map.values()).filter((k) => !k.dead);
        if (candidates.length === 0) return null;
        // Lấy key có cooldownUntil thấp nhất
        candidates.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
        return candidates[0];
    }
    if (healthy.length === 1) return healthy[0];

    // Weighted random selection
    const scored = healthy.map((k) => ({
        key: k,
        // Floor score at 0.1 để key có score thấp vẫn có cơ hội (10% của top)
        score: Math.max(0.1, computeHealthScore(k)),
    }));
    const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
    if (totalScore <= 0) return scored[0].key;

    let r = Math.random() * totalScore;
    for (const s of scored) {
        r -= s.score;
        if (r <= 0) return s.key;
    }
    // Fallback (shouldn't reach here)
    return scored[scored.length - 1].key;
}

function pickKeyByRoundRobin(service: ServiceName): KeyState | null {
    const healthy = getHealthyKeys(service);
    if (healthy.length === 0) return null;
    if (healthy.length === 1) return healthy[0];
    const idx = (roundRobinIndex.get(service) ?? 0) % healthy.length;
    roundRobinIndex.set(service, (idx + 1) % healthy.length);
    return healthy[idx];
}

// ============================================================
// Outcome tracking
// ============================================================
function markKeySuccess(service: ServiceName, key: string): void {
    const map = keysByService.get(service);
    if (!map) return;
    const fp = makeFingerprint(key);
    const k = map.get(fp);
    if (!k) return;
    k.totalCalls++;
    k.successCalls++;
    k.consecutiveFailures = 0;
    k.lastUsedAt = nowMs();
    k.lastError = undefined;
    // Nếu đang cooldown thì reset cooldown (key vừa chạy được)
    k.cooldownUntil = 0;

    // Revive key DEAD nếu thành công
    if (k.dead) {
        console.log(`[ApiKey] ♻ Key ${k.fingerprint} (${k.label ?? 'unlabeled'}) REVIVED sau khi test thành công`);
        k.dead = false;
        k.deadReason = undefined;
        k.deadSince = undefined;
    }
    schedulePersist();
}

function markKeyFailure(service: ServiceName, key: string, err: unknown): void {
    const map = keysByService.get(service);
    if (!map) return;
    const fp = makeFingerprint(key);
    const k = map.get(fp);
    if (!k) return;

    const now = nowMs();
    const cls = classifyError(err);
    const cooldown = getCooldownMs(err);

    k.totalCalls++;
    k.failureCalls++;
    k.consecutiveFailures++;
    k.lastUsedAt = now;
    k.lastError = String((err as any)?.message ?? err ?? 'unknown').slice(0, 200);

    const wasInCooldown = k.cooldownUntil > now;
    k.cooldownUntil = Math.max(k.cooldownUntil, now + cooldown);

    // Auto-blacklist: 401/403 x N lần liên tiếp → DEAD
    if (cls === 'auth' && k.consecutiveFailures >= DEAD_AFTER_CONSECUTIVE_AUTH_FAILS) {
        if (!k.dead) {
            console.warn(`[ApiKey] ☠ Key ${k.fingerprint} (${k.label ?? 'unlabeled'}) bị DEAD — ${k.consecutiveFailures} lần auth fail liên tiếp`);
        }
        k.dead = true;
        k.deadReason = `Auth fail ${k.consecutiveFailures} lần liên tiếp`;
        k.deadSince = now;
    }

    // ⚠️ FIX: Khi key vào cooldown (429/quota/auth/generic) → PHẢI switch env default
    // sang key khác. Trước đây chỉ gọi normalizeApiKeyEnv() khi key DEAD, dẫn đến
    // các thư viện đọc trực tiếp process.env (tool.ts, tool/memory.ts, AiTool.ts
    // dùng google(...)) vẫn dùng key đã hết quota.
    // Gọi khi: (a) key mới vào cooldown, hoặc (b) key vừa DEAD.
    if ((!wasInCooldown && k.cooldownUntil > now) || k.dead) {
        normalizeApiKeyEnv();
    }
    schedulePersist();
}

// ============================================================
// Public API — initialization
// ============================================================

/**
 * Khởi tạo hệ thống apikey thông minh. Gọi 1 lần lúc boot.
 * Load state cũ → reload env/file → start watcher + revive checker.
 */
export function initApiKeySystem(): void {
    if (initialized) return;
    initialized = true;
    ensureKeysDir();

    // 1. Load persisted state TRƯỚC (để preserve stats nếu key vẫn còn)
    const persisted = loadPersistedState();
    if (persisted) {
        console.log(`[ApiKey] Đang nạp state từ ${path.basename(STATE_FILE)}...`);
        for (const [service, entries] of Object.entries(persisted.services) as [ServiceName, PersistedShape['services'][ServiceName]][]) {
            const map = getOrCreateKeyMap(service);
            for (const e of entries) {
                // Placeholder — key sẽ được fill lại khi reload từ env/file
                // Match theo fingerprint, nhưng raw key sẽ overwrite
                map.set(e.fingerprint, {
                    fingerprint: e.fingerprint,
                    service,
                    key: '', // sẽ fill khi reload
                    source: 'env-single', // sẽ fix khi reload
                    label: e.label,
                    totalCalls: e.totalCalls,
                    successCalls: e.successCalls,
                    failureCalls: e.failureCalls,
                    consecutiveFailures: e.consecutiveFailures,
                    recentCalls: [],
                    cooldownUntil: e.cooldownUntil,
                    dead: e.dead,
                    deadReason: e.deadReason,
                    deadSince: e.deadSince,
                    addedAt: e.addedAt,
                    lastUsedAt: e.lastUsedAt,
                    lastError: e.lastError,
                    lastReviveCheckAt: e.lastReviveCheckAt,
                });
            }
        }
        // #region debug-point D:state-load
        debugReportApiKey('C', 'apikey.ts:initApiKeySystem', 'Loaded persisted api key state', {
            stateFile: path.basename(STATE_FILE),
            services: Object.fromEntries(
                Object.entries(persisted.services).map(([service, entries]) => [
                    service,
                    entries.map((entry) => ({
                        fingerprint: entry.fingerprint,
                        label: entry.label ?? '',
                        totalCalls: entry.totalCalls,
                        failureCalls: entry.failureCalls,
                        dead: entry.dead,
                    })),
                ]),
            ),
        });
        // #endregion
    }

    // 2. Reload tất cả service từ env + file (merge, preserve stats)
    for (const service of Object.keys(SERVICE_CONFIG) as ServiceName[]) {
        reloadService(service);
    }

    // 3. Start watcher + revive checker
    startFileWatcher();
    startReviveChecker();

    // 4. Summary
    for (const service of Object.keys(SERVICE_CONFIG) as ServiceName[]) {
        const stats = getServiceStats(service);
        if (stats.totalKeys === 0) {
            console.log(`[ApiKey] ${stats.service}: chưa có key nào`);
        } else {
            console.log(`[ApiKey] ${stats.service}: ${stats.activeKeys}/${stats.totalKeys} active` +
                (stats.deadKeys ? `, ${stats.deadKeys} dead` : '') +
                (stats.cooldownKeys ? `, ${stats.cooldownKeys} cooldown` : '') +
                (stats.totalCalls ? `, ${stats.totalCalls} calls, ${(stats.successRate * 100).toFixed(0)}% success` : ''));
        }
    }
}

/**
 * Reload toàn bộ — gọi khi file thay đổi hoặc manual.
 */
export function reloadAllServices(): void {
    for (const service of Object.keys(SERVICE_CONFIG) as ServiceName[]) {
        const result = reloadService(service);
        if (result.added > 0) {
            console.log(`[ApiKey] ${service}: thêm ${result.added} key mới`);
        }
    }
    schedulePersist();
    // Sync env var — file mới drop vào data/api_keys/ sẽ được ưu tiên
    normalizeApiKeyEnv();
}

// ============================================================
// Public API — query & manage
// ============================================================

/**
 * Trả về danh sách key cho service (chỉ fingerprint, không leak raw key).
 */
export function getApiKeys(service: ServiceName): string[] {
    const map = keysByService.get(service);
    if (!map) return [];
    // Trả về raw key — chỉ dùng nội bộ để gọi API
    return Array.from(map.values())
        .filter((k) => !k.dead)
        .map((k) => k.key)
        .filter(Boolean);
}

/**
 * Trả về tóm tắt (không leak raw key).
 */
export function getApiKeySummary(service: ServiceName): { count: number; masked: string[] } {
    const map = keysByService.get(service);
    if (!map) return { count: 0, masked: [] };
    return {
        count: map.size,
        masked: Array.from(map.values()).map((k) => k.fingerprint),
    };
}

/**
 * Trả về stats chi tiết cho 1 service.
 */
export function getServiceStats(service: ServiceName): ServiceStats {
    const map = keysByService.get(service);
    if (!map) {
        return {
            service,
            totalKeys: 0,
            activeKeys: 0,
            cooldownKeys: 0,
            deadKeys: 0,
            totalCalls: 0,
            successfulCalls: 0,
            successRate: 0,
            strategy: 'single',
        };
    }
    const now = nowMs();
    let active = 0, cooldown = 0, dead = 0, total = 0, success = 0;
    for (const k of map.values()) {
        total++;
        if (k.dead) dead++;
        else if (k.cooldownUntil > now) cooldown++;
        else active++;
        success += k.successCalls;
    }
    // ⚠️ FIX v1.6.2 — successRate tính đúng: success / (success + fail).
    // Trước đây: success / Math.max(1, success) → luôn trả 0 hoặc 1, không phản ánh rate thực.
    const allKeys = Array.from(map.values());
    const totalCalls = allKeys.reduce((s, k) => s + k.totalCalls, 0);
    const failedCalls = allKeys.reduce((s, k) => s + (k.totalCalls - k.successCalls), 0);
    return {
        service,
        totalKeys: total,
        activeKeys: active,
        cooldownKeys: cooldown,
        deadKeys: dead,
        totalCalls: totalCalls,
        successfulCalls: success,
        failedCalls,
        successRate: totalCalls === 0 ? 0 : success / totalCalls,
        strategy: total > 1 ? 'health-weighted' : total === 1 ? 'single' : 'single',
    };
}

/**
 * Trả về chi tiết từng key (an toàn để hiển thị).
 */
export function getKeyDetails(service: ServiceName): Array<{
    fingerprint: string;
    label?: string;
    source: KeySource;
    status: 'active' | 'cooldown' | 'dead';
    consecutiveFailures: number;
    totalCalls: number;
    successRate: number;
    lastError?: string;
    cooldownRemainingMs?: number;
    addedAt: number;
}> {
    const map = keysByService.get(service);
    if (!map) return [];
    const now = nowMs();
    return Array.from(map.values()).map((k) => {
        let status: 'active' | 'cooldown' | 'dead' = 'active';
        if (k.dead) status = 'dead';
        else if (k.cooldownUntil > now) status = 'cooldown';

        return {
            fingerprint: k.fingerprint,
            label: k.label,
            source: k.source,
            status,
            consecutiveFailures: k.consecutiveFailures,
            totalCalls: k.totalCalls,
            successRate: k.totalCalls === 0 ? 0 : k.successCalls / k.totalCalls,
            lastError: k.lastError,
            cooldownRemainingMs: status === 'cooldown' ? k.cooldownUntil - now : undefined,
            addedAt: k.addedAt,
        };
    });
}

/**
 * Thêm key runtime (vd: từ admin command hoặc web UI).
 *
 * ⚠️ FIX PERSISTENCE: Trước đây, key added runtime chỉ lưu trong RAM (raw key)
 * + fingerprint trong state file. Khi restart, raw key MẤT → key trở thành
 * placeholder (key='') → bị skip → user tưởng đã thêm nhưng thực chất mất.
 *
 * Giờ: ghi key ra file `data/api_keys/<service>_runtime_<fingerprint>.txt`
 * để restart vẫn load lại được. File watcher sẽ tự reload (idempotent).
 */
export function addApiKey(service: ServiceName, key: string, label?: string): { added: boolean; fingerprint: string; reason?: string } {
    if (!key || !key.trim()) return { added: false, fingerprint: '', reason: 'Key rỗng' };
    const cleaned = key.trim();

    // Validate prefix nếu có
    const cfg = SERVICE_CONFIG[service];
    if (cfg.keyPrefix?.length) {
        const ok = cfg.keyPrefix.some((p) => cleaned.startsWith(p));
        if (!ok) {
            return {
                added: false,
                fingerprint: '',
                reason: `Key ${service} không khớp prefix (${cfg.keyPrefix.join('/')})`,
            };
        }
    }

    const state = upsertKey(service, cleaned, { source: 'runtime', label });

    // ⚠️ Persist ra file để restart vẫn còn. Tên file = <service>_runtime_<fingerprint>.txt
    // (fingerprint chứa "..." — thay bằng "_" để làm filename an toàn)
    persistRuntimeKey(service, cleaned, state.fingerprint, label);

    schedulePersist();
    // Sync env var — KEY MỚI sẽ được ưu tiên nhờ fresh-key grace period
    normalizeApiKeyEnv();
    console.log(`[ApiKey] + Thêm ${service} key ${state.fingerprint}${label ? ` (${label})` : ''}`);
    return { added: true, fingerprint: state.fingerprint };
}

/**
 * Ghi runtime key ra file để persist qua restart.
 * File: data/api_keys/<service>_runtime_<safeFp>.txt
 * Nội dung: nếu có label → "label\nkey", không → "key"
 */
function persistRuntimeKey(service: ServiceName, key: string, fingerprint: string, label?: string): void {
    try {
        ensureKeysDir();
        const safeFp = fingerprint.replace(/[^A-Za-z0-9]/g, '_');
        const fileName = `${service}_runtime_${safeFp}.txt`;
        const filePath = path.join(KEYS_DIR, fileName);
        const content = label ? `${label}\n${key}\n` : `${key}\n`;
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (e: any) {
        console.warn(`[ApiKey] Không persist runtime key ra file: ${e?.message ?? e}`);
    }
}

/**
 * Xoá file persist runtime key (khi removeApiKey được gọi).
 */
function unpersistRuntimeKey(service: ServiceName, fingerprint: string): void {
    try {
        const safeFp = fingerprint.replace(/[^A-Za-z0-9]/g, '_');
        const fileName = `${service}_runtime_${safeFp}.txt`;
        const filePath = path.join(KEYS_DIR, fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e: any) {
        // ignore — không critical
    }
}

/**
 * Xoá key theo fingerprint hoặc label.
 */
export function removeApiKey(service: ServiceName, identifier: string): { removed: boolean; count: number; reason?: string } {
    const map = keysByService.get(service);
    if (!map) return { removed: false, count: 0, reason: 'Service không tồn tại' };

    let count = 0;
    for (const [fp, k] of Array.from(map.entries())) {
        const match = fp === identifier || k.fingerprint === identifier || k.label === identifier;
        if (match) {
            map.delete(fp);
            // ⚠️ Xoá cả file persist (nếu có) để restart không load lại
            unpersistRuntimeKey(service, fp);
            count++;
        }
    }
    if (count > 0) {
        schedulePersist();
        // Sync env var — nếu key bị xoá là env default, switch sang key khoẻ nhất
        normalizeApiKeyEnv();
        console.log(`[ApiKey] - Xoá ${count} key ${service} matching "${identifier}"`);
    }
    return { removed: count > 0, count, reason: count === 0 ? 'Không tìm thấy' : undefined };
}

/**
 * Đánh dấu key DEAD được "thử lại" (manual revive).
 */
export function reviveApiKey(service: ServiceName, identifier: string): { revived: boolean; reason?: string } {
    const map = keysByService.get(service);
    if (!map) return { revived: false, reason: 'Service không tồn tại' };

    for (const k of map.values()) {
        const match = k.fingerprint === identifier || k.label === identifier;
        if (match && k.dead) {
            k.dead = false;
            k.deadReason = undefined;
            k.deadSince = undefined;
            k.consecutiveFailures = 0;
            k.lastReviveCheckAt = nowMs();
            schedulePersist();
            // Sync env var — key vừa revive có thể trở thành best key
            normalizeApiKeyEnv();
            console.log(`[ApiKey] ♻ Manual revive ${service} key ${k.fingerprint}`);
            return { revived: true };
        }
    }
    return { revived: false, reason: 'Không tìm thấy key DEAD matching' };
}

/**
 * Pick key tốt nhất cho env var (dùng bởi các SDK đọc trực tiếp process.env).
 * Ưu tiên: key fresh trong grace period > key healthy có score cao nhất.
 * Trả về null nếu không có key khả dụng.
 *
 * ⚠️ FIX: Trước đây pickBestKeyForEnv không skip key đang cooldown, nên env var
 * vẫn trỏ vào key đã hết quota. Giờ ta ưu tiên key không cooldown trước; chỉ
 * fallback sang key cooldown ( với cooldownUntil thấp nhất) nếu tất cả đều cooldown.
 */
function pickBestKeyForEnv(service: ServiceName): string | null {
    const map = keysByService.get(service);
    if (!map) return null;
    const now = nowMs();
    const candidates = Array.from(map.values()).filter((k) => !k.dead && k.key);
    if (candidates.length === 0) return null;

    // Ưu tiên key KHÔNG trong cooldown
    const ready = candidates.filter((k) => k.cooldownUntil <= now);
    if (ready.length > 0) {
        ready.sort((a, b) => computeHealthScore(b) - computeHealthScore(a));
        // #region debug-point E:env-pick
        debugReportApiKey('E', 'apikey.ts:pickBestKeyForEnv', `Picked env default for ${service}`, {
            service,
            mode: 'ready',
            candidates: ready.map((k) => ({
                fingerprint: k.fingerprint,
                source: k.source,
                label: k.label ?? '',
                score: computeHealthScore(k),
                cooldownUntil: k.cooldownUntil,
                dead: k.dead,
                keyLength: k.key.length,
            })),
            picked: ready[0].fingerprint,
        });
        // #endregion
        return ready[0].key;
    }

    // Fallback: tất cả đều cooldown → pick key có cooldownUntil thấp nhất (sớm ra nhất)
    candidates.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    // #region debug-point E:env-pick-fallback
    debugReportApiKey('E', 'apikey.ts:pickBestKeyForEnv', `Picked cooldown fallback for ${service}`, {
        service,
        mode: 'cooldown-fallback',
        candidates: candidates.map((k) => ({
            fingerprint: k.fingerprint,
            source: k.source,
            label: k.label ?? '',
            cooldownUntil: k.cooldownUntil,
            dead: k.dead,
            keyLength: k.key.length,
        })),
        picked: candidates[0]?.fingerprint ?? '',
    });
    // #endregion
    return candidates[0].key;
}

/**
 * Normalize env var cho các thư viện đọc trực tiếp process.env
 * (vd: @ai-sdk/google đọc GOOGLE_GENERATIVE_AI_API_KEY).
 * Set KEY TỐT NHẤT (không phải first key) làm env default.
 *
 * Gọi hàm này:
 *   - 1 lần lúc startup (env.ts làm rồi)
 *   - Mỗi khi state thay đổi: addApiKey / removeApiKey / reviveApiKey /
 *     key bị mark DEAD → tự động switch env sang key khoẻ nhất
 *
 * KHÔNG gọi trong hot path (mỗi request) — chỉ gọi khi state đổi.
 */
export function normalizeApiKeyEnv(): void {
    const geminiKey = pickBestKeyForEnv('gemini');
    if (geminiKey) {
        const prev = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = geminiKey;
        if (prev !== geminiKey) {
            const newFp = makeFingerprint(geminiKey);
            console.log(`[ApiKey] ↻ Env default → Gemini key ${newFp}`);
        }
    } else if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        // Không còn key nào → xoá env (tránh dùng key đã xoá)
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        console.warn(`[ApiKey] ⚠ Không còn Gemini key nào — đã xoá env`);
    }

    const braveKey = pickBestKeyForEnv('brave');
    if (braveKey) {
        const prev = process.env.BRAVE_API_KEY;
        process.env.BRAVE_API_KEY = braveKey;
        if (prev !== braveKey) {
            const newFp = makeFingerprint(braveKey);
            console.log(`[ApiKey] ↻ Env default → Brave key ${newFp}`);
        }
    } else if (process.env.BRAVE_API_KEY) {
        delete process.env.BRAVE_API_KEY;
    }
}

// ============================================================
// Public API — runtime execution
// ============================================================

/**
 * Wrapper chính: gọi `fn` với 1 key hợp lệ. Tự rotate khi lỗi.
 *
 * @param service  'gemini' | 'brave'
 * @param fn       async (apiKey, meta) => result
 *
 * Meta: { attempt: number; total: number; fingerprint: string }
 *
 * ⚠️ QUAN TRỌNG VỀ STREAMING:
 * Nếu `fn` trả về một stream/iterator lazy (vd: kết quả của `streamText()` từ
 * ai-sdk v5, hoặc `generateContentStream()` từ @google/genai), HTTP request chỉ
 * thực sự xảy ra khi caller consume stream — nằm NGOÀI try/catch của hàm này.
 * → 429/quota lỗi sẽ KHÔNG bị bắt → KHÔNG rotate key.
 *
 * Giải pháp: consume stream INSIDE `fn`. Xem `streamWithGoogleModel` và
 * `streamWithGoogleGenAI` bên dưới.
 */
export async function withServiceApiKey<T>(
    service: ServiceName,
    fn: (apiKey: string, meta: { attempt: number; total: number; fingerprint: string }) => Promise<T>,
    opts: { preferHealthWeighted?: boolean } = {},
): Promise<T> {
    const map = keysByService.get(service);
    const now = nowMs();
    // Tách 2 nhóm: key sẵn sàng (không cooldown) và key đang cooldown.
    // Ưu tiên key sẵn sàng trước; chỉ fallback sang cooldown nếu hết cách.
    const allNonDead = map ? Array.from(map.values()).filter((k) => !k.dead && k.key) : [];
    if (allNonDead.length === 0) {
        const cfg = SERVICE_CONFIG[service];
        throw new Error(`Chưa có API key cho ${cfg.label}. Thêm vào .env hoặc data/api_keys/${cfg.defaultFile}`);
    }
    const ready = allNonDead.filter((k) => k.cooldownUntil <= now);
    const inCooldown = allNonDead.filter((k) => k.cooldownUntil > now);

    const useHealth = opts.preferHealthWeighted ?? true;

    /**
     * Build thử tự retry cho 1 call.
     *
     * ⚠️ FIX v1.5.0 — Trước đây sort theo health score giảm dần rồi lấy [0] đầu tiên.
     * Bug: 1 key có score 1.0 luôn thắng 4 key score 0.5 → 4 key kia không bao giờ
     * được dùng (production: 267 calls vs 0 calls).
     *
     * Giờ: weighted random selection. Key khỏe được pick probabilistic nhiều hơn,
     * nhưng key yếu vẫn có cơ hội → load balancer thực sự, tất cả key đều được
     * warm-up để khi key chính lỗi (429/quota), các key dự phòng đã sẵn sàng.
     *
     * Order vẫn giữ ưu tiên: healthy key trước, cooldown key sau (fallback).
     */
    function buildOrder(keys: KeyState[]): KeyState[] {
        if (keys.length <= 1) return keys;
        if (useHealth) {
            // Weighted shuffle: pick random theo weight, remove, repeat.
            // Kết quả là 1 permutation của keys, với key score cao hơn có xác suất
            // xuất hiện sớm hơn (nhưng không phải luôn luôn đầu tiên).
            const remaining = [...keys];
            const order: KeyState[] = [];
            while (remaining.length > 0) {
                const scored = remaining.map((k) => ({
                    key: k,
                    score: Math.max(0.1, computeHealthScore(k)),
                }));
                const total = scored.reduce((sum, s) => sum + s.score, 0);
                if (total <= 0) {
                    // Fallback: shuffle ngẫu nhiên
                    order.push(...remaining.sort(() => Math.random() - 0.5));
                    break;
                }
                let r = Math.random() * total;
                let pickedIdx = 0;
                for (let i = 0; i < scored.length; i++) {
                    r -= scored[i].score;
                    if (r <= 0) {
                        pickedIdx = i;
                        break;
                    }
                }
                order.push(scored[pickedIdx].key);
                remaining.splice(pickedIdx, 1);
            }
            return order;
        }
        // Round-robin
        const rrIdx = roundRobinIndex.get(service) ?? 0;
        const order = [...keys.slice(rrIdx), ...keys.slice(0, rrIdx)];
        roundRobinIndex.set(service, (rrIdx + 1) % keys.length);
        return order;
    }

    // Ưu tiên ready keys; nếu tất cả đều cooldown thì vẫn thử (better than nothing)
    const order: KeyState[] = buildOrder(ready.length > 0 ? ready : inCooldown);

    let lastError: unknown;
    for (let i = 0; i < order.length; i++) {
        const keyState = order[i];
        // Skip key không có raw key (placeholder từ persisted state chưa reload)
        if (!keyState.key) continue;

        // Quota check trước khi gọi
        if (!trackCall(keyState)) {
            // Skip key bị soft-quota, tiếp key tiếp theo
            continue;
        }

        // #region debug-point A:attempt
        debugReportApiKey('A', 'apikey.ts:withServiceApiKey', `Attempt ${i + 1}/${order.length} for ${service}`, {
            service,
            attempt: i + 1,
            total: order.length,
            fingerprint: keyState.fingerprint,
            source: keyState.source,
            label: keyState.label ?? '',
            keyLength: keyState.key.length,
            envDefaultFingerprint: process.env.GOOGLE_GENERATIVE_AI_API_KEY
                ? makeFingerprint(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
                : '',
            readyFingerprints: ready.map((k) => k.fingerprint),
            cooldownFingerprints: inCooldown.map((k) => k.fingerprint),
        });
        // #endregion

        try {
            const result = await fn(keyState.key, {
                attempt: i + 1,
                total: order.length,
                fingerprint: keyState.fingerprint,
            });
            markKeySuccess(service, keyState.key);
            return result;
        } catch (err) {
            lastError = err;
            const cls = classifyError(err);
            // #region debug-point A:failure
            debugReportApiKey('A', 'apikey.ts:withServiceApiKey', `Key attempt failed for ${service}`, {
                service,
                attempt: i + 1,
                total: order.length,
                fingerprint: keyState.fingerprint,
                source: keyState.source,
                label: keyState.label ?? '',
                keyLength: keyState.key.length,
                errorClass: cls,
                errorMessage: String((err as any)?.message ?? err ?? '').slice(0, 300),
            });
            // #endregion
            markKeyFailure(service, keyState.key, err);
            if (cls !== 'auth' && cls !== 'quota') {
                // Lỗi không liên quan đến key → không rotate, throw luôn
                throw err;
            }
            if (i === order.length - 1) break; // hết key
            console.warn(`[ApiKey] ${service} key ${keyState.fingerprint} lỗi (${cls}) → thử key tiếp theo`);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Unknown API key error'));
}

/**
 * Helper cho Google AI SDK: tạo provider + model với key rotate tự động.
 */
export async function withGoogleModel<T>(
    modelId: string,
    fn: (
        model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>>,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => Promise<T>,
): Promise<T> {
    return withServiceApiKey('gemini', async (apiKey, meta) => {
        const provider = createGoogleGenerativeAI({ apiKey });
        const model = provider(modelId);
        return fn(model, apiKey, meta);
    });
}

/**
 * Helper cho GoogleGenAI SDK (@google/genai — dùng cho TTS):
 * tạo client mới với key rotate.
 */
export async function withGoogleGenAI<T>(
    fn: (client: GoogleGenAI, apiKey: string, meta: { attempt: number; total: number; fingerprint: string }) => Promise<T>,
): Promise<T> {
    return withServiceApiKey('gemini', async (apiKey, meta) => {
        const client = new GoogleGenAI({ apiKey });
        return fn(client, apiKey, meta);
    });
}

// ============================================================
// Streaming helpers — FIX lazy stream bug
// ============================================================

/**
 * Streaming helper cho Google AI SDK (@ai-sdk/google).
 *
 * ⚠️ VẤN ĐỀ: `streamText()` từ ai-sdk v5 trả về stream object ĐỒNG BỘ, nhưng
 * HTTP request chỉ xảy ra khi caller consume `result.textStream`. Nếu caller
 * consume stream NGOÀI `withGoogleModel`/`withServiceApiKey` → 429/quota lỗi
 * KHÔNG bị bắt trong try/catch của wrapper → KHÔNG rotate key → bot cứ dùng
 * key cũ đã hết quota.
 *
 * GIẢI PHÁP: helper này nhận 2 callback:
 *   1. `buildStream(model, apiKey, meta)` — trả về stream object (gọi streamText)
 *   2. `consume(stream, apiKey, meta)` — consume stream và trả về result cuối
 *
 * Cả 2 chạy INSIDE try/catch của `withServiceApiKey` → 429/quota sẽ trigger
 * rotation sang key tiếp theo.
 *
 * @example
 * const text = await streamWithGoogleModel(
 *   'gemini-3.1-flash-lite-preview',
 *   (model) => streamText({ model, messages, system, ... }),
 *   async (result) => {
 *     let text = '';
 *     for await (const part of result.textStream) text += part;
 *     return text;
 *   },
 * );
 */
export async function streamWithGoogleModel<TStream, TResult>(
    modelId: string,
    buildStream: (
        model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>>,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => TStream,
    consume: (
        stream: TStream,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => Promise<TResult>,
): Promise<TResult> {
    return withServiceApiKey('gemini', async (apiKey, meta) => {
        const provider = createGoogleGenerativeAI({ apiKey });
        const model = provider(modelId);
        let stream = buildStream(model, apiKey, meta);
        // ⚠️ FIX v1.5.11 — Defensive: buildStream có thể return Promise (vd @google/genai
        // generateContentStream). Await nếu là thenable để consume nhận AsyncIterable thật.
        if (stream && typeof (stream as any).then === 'function') {
            stream = await stream;
        }
        // ⚠️ Consume INSIDE try/catch — nếu stream throw 429 → trigger rotation
        return consume(stream, apiKey, meta);
    });
}

/**
 * Streaming helper cho @google/genai (dùng cho TTS với generateContentStream).
 * Tương tự `streamWithGoogleModel` nhưng cho GoogleGenAI client.
 *
 * @example
 * const text = await streamWithGoogleGenAI(
 *   (ai) => ai.models.generateContentStream({ model, config, contents }),
 *   async (response) => {
 *     const parts: string[] = [];
 *     for await (const chunk of response as any) {
 *       const inline = chunk?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
 *       if (inline?.data) parts.push(inline.data);
 *     }
 *     return parts;
 *   },
 * );
 */
export async function streamWithGoogleGenAI<TStream, TResult>(
    buildStream: (
        client: GoogleGenAI,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => TStream,
    consume: (
        stream: TStream,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => Promise<TResult>,
): Promise<TResult> {
    return withServiceApiKey('gemini', async (apiKey, meta) => {
        const client = new GoogleGenAI({ apiKey });
        let stream = buildStream(client, apiKey, meta);
        // ⚠️ FIX v1.5.11 — buildStream có thể return Promise<AsyncIterable> (vd generateContentStream
        // trả về Promise<AsyncGenerator>). Nếu không await, consume sẽ nhận Promise thay vì
        // AsyncIterable → "for await (const chunk of response)" fail với "undefined is not a function".
        // Solution: await stream nếu là Promise (thenable), còn không thì giữ nguyên.
        if (stream && typeof (stream as any).then === 'function') {
            stream = await stream;
        }
        // ⚠️ Consume INSIDE try/catch — nếu stream throw 429 → trigger rotation
        return consume(stream, apiKey, meta);
    });
}

// ============================================================
// ⭐ v1.7.0 — OpenCode Zen API helpers (https://opencode.ai/docs/zen/)
// ============================================================
// Zen là OpenAI-compatible endpoint:
//   POST https://opencode.ai/zen/v1/chat/completions
//   Authorization: Bearer <ZEN_API_KEY>
//   body: { model: "deepseek-v4-flash-free", messages: [...], stream: true }
//
// Dùng @ai-sdk/openai-compatible (đã có sẵn trong deps).
// Default model: 'deepseek-v4-flash-free' (Free — limited time).
// Models khác: 'glm-5.2', 'kimi-k2.7-code', 'claude-sonnet-5', 'gpt-5.4' (cần billing).
// ============================================================

/** Endpoint Zen mặc định (có thể override bằng env OPENCODE_ZEN_BASE_URL). */
const ZEN_BASE_URL = process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1';

/** Default model khi caller không chỉ định. */
export const ZEN_DEFAULT_MODEL = process.env.OPENCODE_ZEN_MODEL ?? 'deepseek-v4-flash-free';

/**
 * ⭐ MODEL FALLBACK: khi model chính hết quota/deny, tự chuyển sang model
 * khác CÙNG hệ Zen (dùng chung 1 key, mỗi model có quota riêng).
 * Anh có thể override qua env: OPENCODE_ZEN_FALLBACK_MODELS=model1,model2
 */
export const ZEN_FALLBACK_MODELS: string[] = (process.env.OPENCODE_ZEN_FALLBACK_MODELS
    ? String(process.env.OPENCODE_ZEN_FALLBACK_MODELS).split(',').map(s => s.trim()).filter(Boolean)
    : ['north-mini-code-free', 'big-pickle', 'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-flash-free']);

/** Helper: build danh sách model thử (chính + fallback, bỏ trùng). */
function zenModelQueue(primary: string): string[] {
    const q = [primary, ...ZEN_FALLBACK_MODELS];
    return Array.from(new Set(q.filter(Boolean)));
}

/**
 * Helper cho OpenCode Zen API: tạo OpenAI-compatible provider + model với key rotate tự động.
 *
 * @example
 * const { text } = await withZenModel('deepseek-v4-flash-free', async (model) => {
 *   return generateText({ model, prompt: 'Hello' });
 * });
 */
export async function withZenModel<T>(
    modelId: string,
    fn: (
        model: ReturnType<ReturnType<typeof createOpenAICompatible>>,
        apiKey: any,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => Promise<T>,
): Promise<T> {
    const models = zenModelQueue(modelId);
    let lastErr: any;
    for (const m of models) {
        try {
            return await withServiceApiKey('zen', async (apiKey, meta) => {
                const provider = createOpenAICompatible({
                    name: 'opencode-zen',
                    baseURL: ZEN_BASE_URL,
                    apiKey,
                });
                const model = provider(m);
                return fn(model, apiKey, meta);
            });
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message ?? e ?? '');
            const isQuota = /quota|429|rate.?limit|exhaust|limit exceeded|too many|freeusagelimit|denied|403|401|unauthorized/i.test(msg);
            if (!isQuota) throw e; // lỗi code → ném ngay
            console.warn(`[Zen] model ${m} lỗi (${msg.slice(0, 80)}) → thử model tiếp theo`);
        }
    }
    throw lastErr;
}

/**
 * Streaming helper cho Zen API.
 *
 * ⚠️ VẤN ĐỀ: `streamText()` từ ai-sdk v5 trả về stream object ĐỒNG BỘ, nhưng
 * HTTP request chỉ xảy ra khi caller consume `result.textStream`. Nếu caller
 * consume stream NGOÀI wrapper → 429/quota lỗi KHÔNG bị bắt → KHÔNG rotate key.
 *
 * Giải pháp: helper này nhận 2 callback (giống streamWithGoogleModel):
 *   1. `buildStream(model, apiKey, meta)` — trả về stream object
 *   2. `consume(stream, apiKey, meta)` — consume stream và trả về result cuối
 *
 * @example
 * const text = await streamWithZenModel(
 *   'deepseek-v4-flash-free',
 *   (model) => streamText({ model, messages }),
 *   async (result) => {
 *     let text = '';
 *     for await (const part of result.textStream) text += part;
 *     return text;
 *   },
 * );
 */
export async function streamWithZenModel<TStream, TResult>(
    modelId: string,
    buildStream: (
        model: ReturnType<ReturnType<typeof createOpenAICompatible>>,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => TStream,
    consume: (
        stream: TStream,
        apiKey: string,
        meta: { attempt: number; total: number; fingerprint: string },
    ) => Promise<TResult>,
): Promise<TResult> {
    const models = zenModelQueue(modelId);
    let lastErr: any;
    for (const m of models) {
        try {
            return await withServiceApiKey('zen', async (apiKey, meta) => {
                const provider = createOpenAICompatible({
                    name: 'opencode-zen',
                    baseURL: ZEN_BASE_URL,
                    apiKey,
                });
                const model = provider(m);
                let stream = buildStream(model, apiKey, meta);
                if (stream && typeof (stream as any).then === 'function') {
                    stream = await stream;
                }
                return consume(stream, apiKey, meta);
            });
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message ?? e ?? '');
            const isQuota = /quota|429|rate.?limit|exhaust|limit exceeded|too many|freeusagelimit|denied|403|401|unauthorized/i.test(msg);
            if (!isQuota) throw e;
            console.warn(`[Zen] stream model ${m} lỗi (${msg.slice(0, 80)}) → thử model tiếp theo`);
        }
    }
    throw lastErr;
}

// ============================================================
// Lifecycle
// ============================================================
/**
 * Shutdown gracefully — stop watcher + flush state.
 */
export function shutdownApiKeySystem(): void {
    stopFileWatcher();
    stopReviveChecker();
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
    }
    if (saveStateDirty) {
        savePersistedState();
    }
    initialized = false;
}

// Auto-shutdown khi process exit
function syncFlushState(): void {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
    }
    if (saveStateDirty) {
        savePersistedState();
        saveStateDirty = false;
    }
}

process.on('SIGINT', () => {
    syncFlushState();
    process.exit(0);
});
process.on('SIGTERM', () => {
    syncFlushState();
    process.exit(0);
});
process.on('beforeExit', () => {
    syncFlushState();
});
process.on('exit', () => {
    // exit handler KHÔNG chạy được async — nhưng syncFlushState đã sync
    syncFlushState();
});
