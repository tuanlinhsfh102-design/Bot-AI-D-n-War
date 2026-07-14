/**
 * test_zen_bot_like.ts — Test với prompt giống bot thực tế
 * Verify model có thể output JSON array format mà bot expect.
 */

const KEY = 'sk-ecROOSW1W82ao8IZ2aOnDv4nE6s70RAxrWnjqbe9YrmRhDLeB32Rw2BfCIf44rsq';
const MODEL = 'deepseek-v4-flash-free';

const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
const { streamText } = await import('ai');

const provider = createOpenAICompatible({
    name: 'opencode-zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: KEY,
});
const model = provider(MODEL);

// Prompt giống bot — yêu cầu output JSON array
const systemPrompt = `Bạn là một bot chat. Khi user nhắn, hãy reply bằng JSON array chứa actions.

QUY TRÌNH:
1. Phân tích tin nhắn user
2. Trả về JSON array chứa các action objects

FORMAT ACTION:
- sendMessage: {"type":"sendMessage","content":"nội dung reply"}

VÍ DỤ:
User: "chào mày"
Reply: [{"type":"sendMessage","content":"chào cái lz mẹ m"}]

User: "mày tên gì"
Reply: [{"type":"sendMessage","content":"tao là Sleiz, 15 tuổi, dân war nhí"}]

QUAN TRỌNG:
- Trả về CHỈ JSON array, không kèm text nào khác
- Không markdown code block
- Reply ngắn gọn, giọng gen Z Việt Nam, hay chửi thề`;

console.log('Testing bot-like prompt (JSON array output)...');
console.log('');

const tests = [
    { input: 'chào mày', expected: 'JSON array có sendMessage' },
    { input: 'mày bao nhiêu tuổi', expected: 'JSON array có sendMessage' },
    { input: 'địt mẹ mày', expected: 'JSON array có sendMessage chửi lại' },
];

for (const test of tests) {
    console.log(`─── Test: "${test.input}" ───`);
    try {
        const start = Date.now();
        const result = streamText({
            model,
            system: systemPrompt,
            prompt: test.input,
            temperature: 0.9,
        });

        let fullText = '';
        for await (const part of result.textStream) {
            fullText += part;
        }
        const latency = Date.now() - start;

        console.log(`Latency: ${latency}ms | Length: ${fullText.length} chars`);
        console.log(`Raw output:`);
        console.log(fullText);
        
        // Try parse JSON
        try {
            const parsed = JSON.parse(fullText.trim());
            if (Array.isArray(parsed)) {
                console.log(`✅ Valid JSON array with ${parsed.length} action(s)`);
                for (const a of parsed) {
                    console.log(`   - type: ${a.type}, content: "${String(a.content ?? '').slice(0, 60)}"`);
                }
            } else {
                console.log(`⚠ JSON nhưng không phải array:`, typeof parsed);
            }
        } catch (e: any) {
            // Try extract JSON array từ text
            const startIdx = fullText.indexOf('[');
            const endIdx = fullText.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1) {
                const slice = fullText.slice(startIdx, endIdx + 1);
                try {
                    const parsed = JSON.parse(slice);
                    if (Array.isArray(parsed)) {
                        console.log(`✅ JSON array extracted (sau khi strip text) — ${parsed.length} action(s)`);
                    }
                } catch {
                    console.log(`❌ Không parse được JSON: ${e.message}`);
                }
            } else {
                console.log(`❌ Không tìm thấy JSON array trong output`);
            }
        }
    } catch (e: any) {
        console.log(`❌ Error: ${e?.name}: ${e?.message}`);
    }
    console.log('');
}

console.log('═══════════════════════════════════════');
console.log('Test hoàn tất — bot prompt + JSON output');
console.log('═══════════════════════════════════════');
