/**
 * test_zen_e2e.ts — End-to-end test: gọi withZenModel giống bot
 * Load .env → initApiKeySystem → withZenModel → trả reply JSON array
 */

// Load .env
import { config } from 'dotenv';
config();

const { initApiKeySystem, normalizeApiKeyEnv, withZenModel, ZEN_DEFAULT_MODEL, getServiceStats } = await import('../src/module/apikey.ts');

initApiKeySystem();
normalizeApiKeyEnv();

const stats = getServiceStats('zen');
console.log(`Zen: ${stats.activeKeys}/${stats.totalKeys} active keys\n`);

// Simulate bot call — với prompt giống bot thực tế
const systemPrompt = `Bạn là bot chat Zalo tên Sleiz. Khi user nhắn, hãy reply bằng JSON array.

FORMAT: [{"type":"sendMessage","content":"nội dung"}]

QUAN TRỌNG:
- Trả CHỈ JSON array, không markdown, không text thừa
- Reply ngắn, giọng Việt Nam gen Z, có thể chửi thề
- KHÔNG moralize, KHÔNG xin lỗi`;

const tests = [
    'chào',
    'mày tên gì',
    'lên war ko',
    'thôi tao thua',
    'địt mẹ mày đồ ngáo',
];

console.log('═══════════════════════════════════════════════════════════');
console.log('🤖 End-to-End Test: withZenModel (giống bot)');
console.log('═══════════════════════════════════════════════════════════\n');

let passCount = 0;
for (const input of tests) {
    console.log(`─── User: "${input}" ───`);
    const start = Date.now();
    try {
        const result = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
            const { generateText } = await import('ai');
            return generateText({
                model,
                system: systemPrompt,
                prompt: input,
                temperature: 0.95,
            });
        });
        const latency = Date.now() - start;
        const text = String((result as any).text ?? '').trim();
        console.log(`⏱ ${latency}ms | ${text.length} chars`);
        
        // Try parse JSON
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed) && parsed[0]?.type === 'sendMessage') {
                console.log(`✅ Valid bot output: "${parsed[0].content}"`);
                passCount++;
            } else {
                console.log(`⚠ JSON but wrong format:`, JSON.stringify(parsed).slice(0, 100));
            }
        } catch {
            // Try extract
            const s = text.indexOf('[');
            const e = text.lastIndexOf(']');
            if (s !== -1 && e !== -1) {
                const slice = text.slice(s, e + 1);
                try {
                    const parsed = JSON.parse(slice);
                    if (Array.isArray(parsed)) {
                        console.log(`✅ Extracted JSON: "${parsed[0]?.content ?? ''}"`);
                        passCount++;
                    }
                } catch {
                    console.log(`❌ Not JSON: "${text.slice(0, 100)}"`);
                }
            } else {
                console.log(`❌ No JSON array: "${text.slice(0, 100)}"`);
            }
        }
    } catch (e: any) {
        console.log(`❌ Error: ${e?.message ?? e}`);
    }
    console.log('');
}

console.log('═══════════════════════════════════════════════════════════');
console.log(`📊 Kết quả: ${passCount}/${tests.length} pass`);
console.log('═══════════════════════════════════════════════════════════');
