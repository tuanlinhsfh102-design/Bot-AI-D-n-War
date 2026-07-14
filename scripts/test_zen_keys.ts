/**
 * test_zen_keys.ts — Test thật 6 OpenCode Zen API keys
 * 
 * Làm 2 việc:
 * 1. Gọi trực tiếp fetch() tới https://opencode.ai/zen/v1/chat/completions
 *    với từng key → xem key nào valid, key nào 401/403/quota.
 * 2. Test qua @ai-sdk/openai-compatible (giống bot sẽ dùng) để verify SDK works.
 */

const ZEN_KEYS = [
    'sk-X87fqc3rQ1uDrfehxdsri0pswOAThC8gXuN0MBYfFpP7z0Y0R9p31AiauiTnl5qK',
    'sk-ecROOSW1W82ao8IZ2aOnDv4nE6s70RAxrWnjqbe9YrmRhDLeB32Rw2BfCIf44rsq',
    'sk-4kiNgliZYZoxyBilyf4x8fsRFgUtGzkCX2TyT5OuMooZggTOZv796TpWWiL1DjVL',
    'sk-ThpItnJIcZIJDvXF11j1Uh1rZiUvlkpGlrs8Sxum83LMdl3CLXt3HG858vx2ensY',
    'sk-JS6UX3eMt4M3MZESoPGWjZAGvpH3IYAhaH6za5GRZLCBo2kLkVtQ99pmBhB7s1GW',
    'sk-GvJgojpFn1o4Fscu5kJLnYpT38oDKcSmCDqfsof7eul7uK0j15v3DyxRpormBdBi',
];

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const MODEL = 'deepseek-v4-flash-free';

function fingerprint(key: string): string {
    return `${key.slice(0, 10)}...${key.slice(-4)}`;
}

async function testKeyDirect(key: string, label: string): Promise<{
    key: string;
    fingerprint: string;
    ok: boolean;
    status?: number;
    error?: string;
    responsePreview?: string;
    latencyMs: number;
}> {
    const start = Date.now();
    const fp = fingerprint(key);
    try {
        const body = {
            model: MODEL,
            messages: [
                { role: 'system', content: 'You are a helpful assistant. Reply briefly.' },
                { role: 'user', content: `Say "key ${label} works" in exactly 5 words.` },
            ],
            stream: false,
            max_tokens: 50,
            temperature: 0.7,
        };
        const res = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
        const latencyMs = Date.now() - start;

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return {
                key,
                fingerprint: fp,
                ok: false,
                status: res.status,
                error: `HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
                latencyMs,
            };
        }

        const data: any = await res.json();
        const content = data?.choices?.[0]?.message?.content ?? '(empty)';
        return {
            key,
            fingerprint: fp,
            ok: true,
            status: 200,
            responsePreview: String(content).slice(0, 200),
            latencyMs,
        };
    } catch (e: any) {
        return {
            key,
            fingerprint: fp,
            ok: false,
            error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`,
            latencyMs: Date.now() - start,
        };
    }
}

async function testViaSdk(key: string): Promise<{ ok: boolean; error?: string; text?: string }> {
    try {
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const { generateText } = await import('ai');
        const provider = createOpenAICompatible({
            name: 'opencode-zen',
            baseURL: ZEN_BASE_URL,
            apiKey: key,
        });
        const model = provider(MODEL);
        const result = await generateText({
            model,
            prompt: 'Reply with exactly: SDK_OK',
            temperature: 0,
        });
        return { ok: true, text: String(result.text ?? '').slice(0, 100) };
    } catch (e: any) {
        return { ok: false, error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`.slice(0, 300) };
    }
}

async function testListModels(key: string): Promise<{ ok: boolean; modelCount?: number; error?: string; sample?: string[] }> {
    try {
        const res = await fetch(`${ZEN_BASE_URL}/models`, {
            headers: { 'Authorization': `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status}` };
        }
        const data: any = await res.json();
        const models = (data?.data ?? []).map((m: any) => m?.id).filter(Boolean);
        return {
            ok: true,
            modelCount: models.length,
            sample: models.slice(0, 10),
        };
    } catch (e: any) {
        return { ok: false, error: `${e?.name}: ${e?.message}` };
    }
}

(async () => {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`🧪 Testing ${ZEN_KEYS.length} OpenCode Zen API keys`);
    console.log(`   Endpoint: ${ZEN_BASE_URL}/chat/completions`);
    console.log(`   Model: ${MODEL}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // === Phase 1: Direct HTTP test for each key ===
    console.log('─── Phase 1: Direct HTTP test (chat/completions) ───\n');
    const results: Array<Awaited<ReturnType<typeof testKeyDirect>>> = [];
    for (let i = 0; i < ZEN_KEYS.length; i++) {
        const r = await testKeyDirect(ZEN_KEYS[i], `#${i + 1}`);
        results.push(r);
        const icon = r.ok ? '✅' : '❌';
        console.log(`${icon} Key #${i + 1} ${r.fingerprint}`);
        console.log(`   Status: ${r.status ?? 'N/A'} | Latency: ${r.latencyMs}ms`);
        if (r.ok) {
            console.log(`   Response: "${r.responsePreview}"`);
        } else {
            console.log(`   Error: ${r.error}`);
        }
        console.log('');
    }

    const workingKeys = results.filter(r => r.ok).map(r => r.key);
    const failedKeys = results.filter(r => !r.ok);

    console.log('─── Summary Phase 1 ───');
    console.log(`✓ Working: ${workingKeys.length}/${ZEN_KEYS.length}`);
    console.log(`✗ Failed:  ${failedKeys.length}/${ZEN_KEYS.length}`);
    if (failedKeys.length > 0) {
        console.log('\nFailed details:');
        for (const f of failedKeys) {
            console.log(`  ${f.fingerprint}: ${f.error}`);
        }
    }
    console.log('');

    if (workingKeys.length === 0) {
        console.log('❌ Không có key nào hoạt động. Dừng test.');
        process.exit(1);
    }

    // === Phase 2: Test via @ai-sdk/openai-compatible (giống bot) ===
    console.log('─── Phase 2: SDK test (@ai-sdk/openai-compatible) ───\n');
    const firstWorkingKey = workingKeys[0];
    console.log(`Dùng key ${fingerprint(firstWorkingKey)} để test SDK...\n`);
    const sdkResult = await testViaSdk(firstWorkingKey);
    if (sdkResult.ok) {
        console.log(`✅ SDK works! Response: "${sdkResult.text}"`);
    } else {
        console.log(`❌ SDK failed: ${sdkResult.error}`);
    }
    console.log('');

    // === Phase 3: List models để verify endpoint /models hoạt động ===
    console.log('─── Phase 3: List available models ───\n');
    const modelsResult = await testListModels(firstWorkingKey);
    if (modelsResult.ok) {
        console.log(`✅ /models endpoint works — ${modelsResult.modelCount} models available`);
        console.log(`   Sample: ${(modelsResult.sample ?? []).join(', ')}`);
    } else {
        console.log(`⚠ /models endpoint failed: ${modelsResult.error}`);
        console.log('   (Không critical — bot chỉ dùng /chat/completions)');
    }
    console.log('');

    // === Phase 4: Test streaming (giống bot thực tế) ===
    console.log('─── Phase 4: Streaming test (giống bot) ───\n');
    try {
        const body = {
            model: MODEL,
            messages: [
                { role: 'user', content: 'Đếm từ 1 đến 5, mỗi số cách nhau bởi dấu phẩy.' },
            ],
            stream: true,
            max_tokens: 50,
        };
        const res = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${firstWorkingKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            console.log(`❌ Streaming failed: HTTP ${res.status}`);
        } else if (!res.body) {
            console.log(`❌ Streaming failed: no body`);
        } else {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let chunks = 0;
            let fullText = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                for (const line of text.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const j = JSON.parse(data);
                        const delta = j?.choices?.[0]?.delta?.content ?? '';
                        if (delta) {
                            chunks++;
                            fullText += delta;
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
            console.log(`✅ Streaming works! Received ${chunks} chunks`);
            console.log(`   Full text: "${fullText}"`);
        }
    } catch (e: any) {
        console.log(`❌ Streaming failed: ${e?.message ?? e}`);
    }
    console.log('');

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🎉 Test hoàn tất!');
    console.log(`   Working keys: ${workingKeys.length}/${ZEN_KEYS.length}`);
    console.log('═══════════════════════════════════════════════════════════════');

    // Print working keys for .env
    if (workingKeys.length > 0) {
        console.log('\n📋 Paste vào .env:');
        if (workingKeys.length === 1) {
            console.log(`OPENCODE_ZEN_API_KEY=${workingKeys[0]}`);
        } else {
            console.log(`OPENCODE_ZEN_API_KEYS=${workingKeys.join(',')}`);
        }
    }
})();
