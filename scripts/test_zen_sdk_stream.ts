/**
 * test_zen_sdk_stream.ts — Test streamText qua @ai-sdk/openai-compatible
 * Giống hệt cách bot gọi streamWithZenModel trong ai.ts
 */

const KEY = 'sk-X87fqc3rQ1uDrfehxdsri0pswOAThC8gXuN0MBYfFpP7z0Y0R9p31AiauiTnl5qK';
const MODEL = 'deepseek-v4-flash-free';

const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
const { streamText } = await import('ai');

const provider = createOpenAICompatible({
    name: 'opencode-zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: KEY,
});
const model = provider(MODEL);

console.log('Testing streamText qua SDK...');
console.log('Model:', MODEL);
console.log('');

const start = Date.now();
let chunkCount = 0;
let fullText = '';

try {
    const result = streamText({
        model,
        system: 'You are a Vietnamese assistant. Reply in Vietnamese only.',
        prompt: 'Đếm từ 1 đến 5, mỗi số trên 1 dòng.',
        temperature: 0.5,
    });

    for await (const part of result.textStream) {
        chunkCount++;
        fullText += part;
        if (chunkCount <= 5) {
            console.log(`  chunk ${chunkCount}: "${part}"`);
        }
    }

    const latency = Date.now() - start;
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`✅ streamText works!`);
    console.log(`   Chunks: ${chunkCount}`);
    console.log(`   Latency: ${latency}ms`);
    console.log(`   Full text:\n${fullText}`);
    console.log('═══════════════════════════════════════');
} catch (e: any) {
    console.log(`❌ streamText failed: ${e?.name}: ${e?.message}`);
    if (e?.cause) console.log('   cause:', e.cause);
    process.exit(1);
}

// Test với tools (giống bot có 102 tools)
console.log('\nTesting streamText với tools (giống bot)...');
try {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    
    const testTools = {
        getWeather: tool({
            description: 'Get weather for a city',
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }: any) => `Weather in ${city}: 25°C, sunny`,
        }),
    };

    const result2 = streamText({
        model,
        system: 'You are a weather assistant. Use getWeather tool when asked about weather.',
        prompt: 'Thời tiết ở Hà Nội hôm nay thế nào? Dùng tool getWeather.',
        tools: testTools,
        maxSteps: 3,
    });

    let chunkCount2 = 0;
    let fullText2 = '';
    for await (const part of result2.textStream) {
        chunkCount2++;
        fullText2 += part;
    }
    
    console.log(`✅ streamText with tools works! ${chunkCount2} chunks`);
    console.log(`   Response: "${fullText2.slice(0, 200)}"`);
} catch (e: any) {
    console.log(`❌ streamText with tools failed: ${e?.name}: ${e?.message}`);
}
