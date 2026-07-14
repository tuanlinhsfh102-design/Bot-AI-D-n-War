/**
 * keystore_server.ts — Web UI đơn giản để paste/quản lý Gemini API key.
 *
 * Embed vào main bot (src/index.ts) — KHÔNG cần chạy script riêng.
 * Sau khi bot start → mở http://localhost:8787 để quản lý key.
 *
 * Tính năng:
 *   - Paste nhiều key cùng lúc (1 dòng 1 key)
 *   - Xem danh sách key + status (active/cooldown/dead)
 *   - Xoá key theo fingerprint/label
 *   - Revive key DEAD
 *   - Auto-refresh mỗi 5s (JavaScript fetch)
 *
 * Lưu ý:
 *   - LOCAL DEV TOOL — KHÔNG có auth, chỉ chạy localhost (127.0.0.1).
 *   - Nếu muốn expose ra ngoài → đặt BEHIND reverse proxy có auth.
 *   - File watcher của apikey.ts tự reload khi file thay đổi.
 *
 * Env vars:
 *   KEYSTORE_ENABLED=true|false  (default: true)
 *   KEYSTORE_PORT=8787          (default: 8787)
 *   KEYSTORE_HOST=127.0.0.1     (default: 127.0.0.1, không đổi nếu muốn public)
 */

import {
    getKeyDetails,
    addApiKey,
    removeApiKey,
    reviveApiKey,
    getServiceStats,
    type ServiceName,
} from './apikey';
import path from 'node:path';

declare const Bun: any;

// ============================================================
// HTML page (single-page, không cần framework)
// ============================================================
function renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🔑 Keystore — API Keys</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        background: #0f1419;
        color: #e6e6e6;
        padding: 24px;
        max-width: 980px;
        margin: 0 auto;
    }
    h1 { font-size: 22px; margin-bottom: 6px; }
    .subtitle { color: #888; font-size: 13px; margin-bottom: 24px; }
    .card {
        background: #1a1f2e;
        border: 1px solid #2a3142;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
    }
    .card h2 { font-size: 15px; margin-bottom: 14px; color: #c8d3e6; }
    textarea {
        width: 100%;
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 8px;
        color: #e6e6e6;
        padding: 12px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 13px;
        resize: vertical;
        min-height: 120px;
    }
    textarea:focus { outline: none; border-color: #3b82f6; }
    .row { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    input[type="text"], select {
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 8px;
        color: #e6e6e6;
        padding: 10px 12px;
        font-size: 13px;
    }
    input[type="text"] { flex: 1; }
    select { min-width: 100px; }
    input[type="text"]:focus, select:focus { outline: none; border-color: #3b82f6; }
    button {
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 10px 18px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
    }
    button:hover { background: #2563eb; }
    button.danger { background: #ef4444; }
    button.danger:hover { background: #dc2626; }
    button.ghost {
        background: transparent;
        border: 1px solid #30363d;
        color: #c8d3e6;
    }
    button.ghost:hover { background: #1a1f2e; border-color: #3b82f6; }
    .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
    }
    .stat {
        background: #0d1117;
        padding: 14px;
        border-radius: 8px;
        border: 1px solid #30363d;
    }
    .stat-label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 22px; font-weight: 700; color: #fff; margin-top: 4px; }
    .stat.active .stat-value { color: #22c55e; }
    .stat.cooldown .stat-value { color: #eab308; }
    .stat.dead .stat-value { color: #ef4444; }
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
    }
    th, td {
        padding: 10px 8px;
        text-align: left;
        border-bottom: 1px solid #2a3142;
    }
    th { color: #888; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    tr:hover { background: #0d1117; }
    .badge {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
    }
    .badge.active { background: #14532d; color: #86efac; }
    .badge.cooldown { background: #713f12; color: #fde047; }
    .badge.dead { background: #7f1d1d; color: #fca5a5; }
    .fp { font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; color: #94a3b8; }
    .empty { color: #888; padding: 32px; text-align: center; }
    .toast {
        position: fixed;
        top: 24px;
        right: 24px;
        background: #22c55e;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        opacity: 0;
        transition: opacity 0.3s;
        z-index: 1000;
    }
    .toast.show { opacity: 1; }
    .toast.error { background: #ef4444; }
    .small { font-size: 12px; color: #888; margin-top: 6px; }
    .actions { display: flex; gap: 6px; }
    .actions button { padding: 5px 10px; font-size: 12px; }
    .refresh-indicator {
        position: fixed;
        bottom: 16px;
        right: 16px;
        color: #555;
        font-size: 11px;
        background: #1a1f2e;
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid #2a3142;
    }
</style>
</head>
<body>
    <h1>🔑 Keystore — API Keys</h1>
    <div class="subtitle">
        Quản lý API key cho bot Nguyễn Đình Dương. Mọi thay đổi sẽ được áp dụng ngay (hot-reload).
    </div>

    <div class="card">
        <h2>📊 Trạng thái</h2>
        <div class="stats" id="stats"></div>
    </div>

    <div class="card">
        <h2>➕ Thêm key mới</h2>
        <div class="row" style="margin-bottom: 10px;">
            <select id="serviceSelect">
                <option value="zen">OpenCode Zen (main AI) — deepseek-v4-flash-free</option>
                <option value="gemini">Gemini (TTS only)</option>
                <option value="brave">Brave Search</option>
            </select>
        </div>
        <textarea id="keysInput" placeholder="Dán API key vào đây. Mỗi dòng 1 key.&#10;&#10;zen_xxx...key1 (OpenCode Zen — main AI)&#10;AIzaSy...key2 (Gemini TTS)&#10;BSA...key3 (Brave)"></textarea>
        <div class="row" style="margin-top: 12px;">
            <input type="text" id="labelInput" placeholder="Label tuỳ chọn (vd: work, backup, my-key-1)">
            <button onclick="addKeys()">Thêm</button>
        </div>
        <div class="small">
            💡 Tip: có thể dán nhiều key cùng lúc, mỗi dòng 1 key. Key trùng sẽ tự skip.
        </div>
    </div>

    <div class="card">
        <h2>🗂️ Danh sách key hiện có</h2>
        <div id="keyList"></div>
    </div>

    <div class="toast" id="toast"></div>
    <div class="refresh-indicator" id="refreshIndicator">↻ refreshing...</div>

<script>
let currentService = 'gemini';
let currentKeys = [];
let lastRefresh = 0;

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => t.className = 'toast', 2500);
}

function fmt(n) { return new Intl.NumberFormat('vi-VN').format(n); }

function renderStats(stats) {
    document.getElementById('stats').innerHTML = \`
        <div class="stat active"><div class="stat-label">Active</div><div class="stat-value">\${stats.activeKeys}</div></div>
        <div class="stat cooldown"><div class="stat-label">Cooldown</div><div class="stat-value">\${stats.cooldownKeys}</div></div>
        <div class="stat dead"><div class="stat-label">Dead</div><div class="stat-value">\${stats.deadKeys}</div></div>
        <div class="stat"><div class="stat-label">Total</div><div class="stat-value">\${stats.totalKeys}</div></div>
        <div class="stat"><div class="stat-label">Total calls</div><div class="stat-value">\${fmt(stats.totalCalls)}</div></div>
        <div class="stat"><div class="stat-label">Strategy</div><div class="stat-value" style="font-size:14px;">\${stats.strategy}</div></div>
    \`;
}

function renderKeys(keys) {
    if (keys.length === 0) {
        document.getElementById('keyList').innerHTML = '<div class="empty">Chưa có key nào. Dán key vào ô bên trên và bấm Thêm.</div>';
        return;
    }
    const rows = keys.map(k => {
        const statusBadge = \`<span class="badge \${k.status}">\${k.status}</span>\`;
        const failInfo = k.consecutiveFailures > 0 ? \` <span style="color:#eab308;">⚠\${k.consecutiveFailures} fail</span>\` : '';
        const rateInfo = k.totalCalls > 0 ? \` <span style="color:#888;">(\${Math.round(k.successRate * 100)}%)</span>\` : '';
        const cooldownInfo = k.status === 'cooldown' && k.cooldownRemainingMs
            ? \` <span style="color:#eab308;">⏱ \${Math.ceil(k.cooldownRemainingMs / 60000)}m</span>\`
            : '';
        const sourceLabel = k.source === 'env-single' ? 'env'
            : k.source === 'env-multi' ? 'env-multi'
            : k.source === 'file' ? 'file'
            : 'runtime';
        const labelInfo = k.label ? \` <span style="color:#60a5fa;">[\${escape(k.label)}]</span>\` : '';
        const reviveBtn = k.status === 'dead' ? \`<button class="ghost" onclick="revive('\${escape(k.fingerprint)}')">♻ Revive</button>\` : '';
        return \`<tr>
            <td>\${statusBadge}</td>
            <td class="fp">\${escape(k.fingerprint)}</td>
            <td>\${labelInfo} <span style="color:#555;">(\${sourceLabel})</span></td>
            <td>\${fmt(k.totalCalls)}\${rateInfo}\${failInfo}\${cooldownInfo}</td>
            <td class="actions">
                \${reviveBtn}
                <button class="danger" onclick="remove('\${escape(k.fingerprint)}')">Xoá</button>
            </td>
        </tr>\`;
    }).join('');
    document.getElementById('keyList').innerHTML = \`<table>
        <thead><tr>
            <th>Status</th><th>Fingerprint</th><th>Label</th><th>Calls</th><th></th>
        </tr></thead>
        <tbody>\${rows}</tbody>
    </table>\`;
}

function escape(s) {
    return String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function refresh() {
    try {
        const res = await fetch('/api/keys?service=' + currentService);
        const data = await res.json();
        currentKeys = data.keys;
        renderStats(data.stats);
        renderKeys(currentKeys);
        lastRefresh = Date.now();
        document.getElementById('refreshIndicator').textContent = '↻ ' + new Date().toLocaleTimeString('vi-VN');
    } catch (e) {
        showToast('Lỗi load data: ' + e.message, true);
    }
}

async function addKeys() {
    const input = document.getElementById('keysInput').value.trim();
    const label = document.getElementById('labelInput').value.trim();
    const service = document.getElementById('serviceSelect').value;
    if (!input) { showToast('Chưa nhập key', true); return; }
    const keys = input.split(/[\\r\\n,;|]+/).map(s => s.trim()).filter(Boolean);
    if (keys.length === 0) { showToast('Không tìm thấy key hợp lệ', true); return; }

    let added = 0, skipped = 0, failed = 0;
    for (const key of keys) {
        const res = await fetch('/api/keys?service=' + service, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, label: label || undefined }),
        });
        const data = await res.json();
        if (data.added) added++;
        else if (data.reason?.includes('trùng') || data.reason?.includes('duplicate')) skipped++;
        else failed++;
    }

    document.getElementById('keysInput').value = '';
    document.getElementById('labelInput').value = '';

    let msg = '';
    if (added) msg += \`✅ Đã thêm \${added} key\`;
    if (skipped) msg += \` | ⏭ Skip \${skipped} (trùng)\`;
    if (failed) msg += \` | ❌ Lỗi \${failed}\`;
    showToast(msg.trim() || 'Xong', failed > 0);
    refresh();
}

async function remove(fp) {
    if (!confirm('Xoá key ' + fp + '?')) return;
    const res = await fetch('/api/keys/' + encodeURIComponent(fp) + '?service=' + currentService, { method: 'DELETE' });
    const data = await res.json();
    showToast(data.removed ? \`✅ Đã xoá \${data.count} key\` : '❌ ' + (data.reason ?? 'lỗi'), !data.removed);
    refresh();
}

async function revive(fp) {
    const res = await fetch('/api/keys/' + encodeURIComponent(fp) + '/revive?service=' + currentService, { method: 'POST' });
    const data = await res.json();
    showToast(data.revived ? '♻ Đã revive key' : '❌ ' + (data.reason ?? 'lỗi'), !data.revived);
    refresh();
}

document.getElementById('serviceSelect').addEventListener('change', (e) => {
    currentService = e.target.value;
    refresh();
});

// Auto-refresh mỗi 3s
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

// ============================================================
// API handlers
// ============================================================

function getServiceFromUrl(url: URL): ServiceName {
    const s = url.searchParams.get('service') ?? 'gemini';
    return s === 'brave' ? 'brave' : 'gemini';
}

async function handleApiList(url: URL): Promise<Response> {
    const service = getServiceFromUrl(url);
    return Response.json({
        stats: getServiceStats(service),
        keys: getKeyDetails(service),
    });
}

async function handleApiAdd(req: Request, url: URL): Promise<Response> {
    const service = getServiceFromUrl(url);
    let body: any;
    try {
        body = await req.json();
    } catch {
        return Response.json({ added: false, reason: 'Invalid JSON' }, { status: 400 });
    }
    const key = String(body?.key ?? '').trim();
    const label = body?.label ? String(body.label).trim() : undefined;
    if (!key) return Response.json({ added: false, reason: 'Key rỗng' }, { status: 400 });

    const result = addApiKey(service, key, label);
    return Response.json(result);
}

async function handleApiRemove(fp: string, url: URL): Promise<Response> {
    const service = getServiceFromUrl(url);
    const result = removeApiKey(service, fp);
    return Response.json(result);
}

async function handleApiRevive(fp: string, url: URL): Promise<Response> {
    const service = getServiceFromUrl(url);
    const result = reviveApiKey(service, fp);
    return Response.json(result);
}

// ============================================================
// Server lifecycle
// ============================================================
let serverInstance: any = null;

/**
 * Khởi động keystore web UI.
 * Trả về server instance (Bun.Server) hoặc null nếu disabled.
 */
export function startKeystoreServer(): any {
    const enabled = String(process.env.KEYSTORE_ENABLED ?? 'true').toLowerCase();
    if (enabled === 'false' || enabled === '0' || enabled === 'off') {
        console.log('[Keystore] Tắt (KEYSTORE_ENABLED=false)');
        return null;
    }

    const port = Number(process.env.KEYSTORE_PORT ?? 8787);
    const host = process.env.KEYSTORE_HOST ?? '127.0.0.1';

    serverInstance = Bun.serve({
        port,
        hostname: host,
        async fetch(req: Request): Promise<Response> {
            const url = new URL(req.url);
            const pathname = url.pathname;

            // HTML
            if (pathname === '/' || pathname === '/index.html') {
                return new Response(renderHtml(), {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }

            // Health check
            if (pathname === '/health') {
                return Response.json({ ok: true, uptime: process.uptime() });
            }

            // API: GET /api/keys?service=gemini
            if (pathname === '/api/keys' && req.method === 'GET') {
                return handleApiList(url);
            }
            // API: POST /api/keys?service=gemini
            if (pathname === '/api/keys' && req.method === 'POST') {
                return handleApiAdd(req, url);
            }

            // API: DELETE /api/keys/:fp?service=gemini
            const removeMatch = pathname.match(/^\/api\/keys\/([^/]+)$/);
            if (removeMatch && req.method === 'DELETE') {
                return handleApiRemove(decodeURIComponent(removeMatch[1]), url);
            }

            // API: POST /api/keys/:fp/revive?service=gemini
            const reviveMatch = pathname.match(/^\/api\/keys\/([^/]+)\/revive$/);
            if (reviveMatch && req.method === 'POST') {
                return handleApiRevive(decodeURIComponent(reviveMatch[1]), url);
            }

            return new Response('Not found', { status: 404 });
        },
        error(error: Error) {
            console.error('[Keystore] Server error:', error);
            return new Response('Internal error', { status: 500 });
        },
    });

    console.log(`\n🔑 Keystore Web UI: http://${host}:${serverInstance.port}`);
    console.log(`   File gốc: ${path.relative(process.cwd(), path.join(process.cwd(), 'data', 'api_keys', 'gemini.txt'))}`);
    console.log(`   Tắt: set KEYSTORE_ENABLED=false trong .env\n`);

    return serverInstance;
}

/**
 * Stop keystore server (graceful).
 */
export function stopKeystoreServer(): void {
    if (serverInstance) {
        try {
            serverInstance.stop();
            console.log('[Keystore] Đã tắt web server');
        } catch { /* ignore */ }
        serverInstance = null;
    }
}

// Auto-stop khi process exit (graceful)
process.on('SIGINT', () => {
    stopKeystoreServer();
});
process.on('SIGTERM', () => {
    stopKeystoreServer();
});
process.on('beforeExit', () => {
    stopKeystoreServer();
});