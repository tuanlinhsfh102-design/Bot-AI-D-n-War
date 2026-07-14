/**
 * test_zen_stream.ts — Debug streaming format của Zen API
 * In raw SSE events để xem format stream có chuẩn OpenAI không.
 */

const KEY = 'sk-X87fqc3rQ1uDrfehxdsri0pswOAThC8gXuN0MBYfFpP7z0Y0R9p31AiauiTnl5qK';
const URL = 'https://opencode.ai/zen/v1/chat/completions';
const MODEL = 'deepseek-v4-flash-free';

const res = await fetch(URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEY}`,
    },
    body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Đếm từ 1 đến 5.' }],
        stream: true,
        max_tokens: 100,
    }),
    signal: AbortSignal.timeout(30000),
});

console.log('Status:', res.status, res.statusText);
console.log('Content-Type:', res.headers.get('content-type'));
console.log('');

if (!res.ok || !res.body) {
    console.log('FAIL:', await res.text().catch(() => 'no body'));
    process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let eventCount = 0;
let fullContent = '';
let rawChunks: string[] = [];

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    rawChunks.push(text);
    
    // Try parse từng line
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        eventCount++;
        if (eventCount <= 15) {
            console.log(`[event ${eventCount}] ${line.slice(0, 200)}`);
        }
        
        // Parse SSE
        if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
                console.log(`[event ${eventCount}] ← [DONE] marker`);
                continue;
            }
            try {
                const j = JSON.parse(data);
                const delta = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? '';
                if (delta) fullContent += delta;
            } catch (e: any) {
                console.log(`  ⚠ Parse fail: ${e.message} — data: ${data.slice(0, 100)}`);
            }
        }
    }
}

console.log('');
console.log('═══════════════════════════════════════');
console.log(`Total events: ${eventCount}`);
console.log(`Raw chunks: ${rawChunks.length}`);
console.log(`Full content extracted: "${fullContent}"`);
console.log('═══════════════════════════════════════');

// Show raw first chunk
if (rawChunks.length > 0) {
    console.log('\nFirst raw chunk (first 500 chars):');
    console.log(rawChunks[0].slice(0, 500));
}
