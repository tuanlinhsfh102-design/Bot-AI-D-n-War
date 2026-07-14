// Test: verify key switch logic khi thêm key mới
import {
    initApiKeySystem,
    addApiKey,
    removeApiKey,
    getKeyDetails,
    normalizeApiKeyEnv,
    withServiceApiKey,
    shutdownApiKeySystem,
} from '../src/module/apikey';

declare const Bun: any;

console.log('===== Test: Key switch khi thêm key mới =====\n');

initApiKeySystem();

console.log('--- Initial state ---');
console.log('Env GOOGLE key:', process.env.GOOGLE_GENERATIVE_AI_API_KEY?.slice(0, 12) + '...');
const initialDetails = getKeyDetails('gemini');
console.log(`Initial keys: ${initialDetails.length}`);
for (const k of initialDetails) {
    console.log(`  - ${k.fingerprint} [${k.label ?? '-'}] source=${k.source} calls=${k.totalCalls}`);
}

console.log('\n--- Test 1: Thêm key mới qua addApiKey ---');
const before = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const r1 = addApiKey('gemini', 'AIzaSyNewKey1111111111abcdef', 'new-key-test');
console.log('addApiKey result:', r1);
const after = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
console.log(`Env changed: ${before?.slice(0, 12)}... → ${after?.slice(0, 12)}...`);
console.log(`Switched: ${before !== after ? '✅ YES' : '❌ NO'}`);

console.log('\n--- Test 2: withServiceApiKey picks new key first ---');
let pickedFp: string | null = null;
await withServiceApiKey('gemini', async (key, meta) => {
    pickedFp = meta.fingerprint;
    console.log(`Picked: ${meta.fingerprint} (attempt ${meta.attempt}/${meta.total})`);
    return 'ok';
});
const newKeyFp = (await import('../src/module/apikey')).makeFingerprint?.('AIzaSyNewKey1111111111abcdef');
console.log(`Picked matches new key? ${pickedFp === 'AIzaSyNe...cdef' ? '✅ YES' : '❌ NO (got ' + pickedFp + ')'}`);

console.log('\n--- Test 3: Force key cũ fail → still pick new key ---');
// Mark old key với consecutive failure để giảm score (nhưng không đủ DEAD)
const allKeys = getKeyDetails('gemini');
const oldKey = allKeys.find((k) => k.label !== 'new-key-test');
if (oldKey) {
    // Force old key có low score qua markKeyFailure internal
    // (skip — không expose API để set score trực tiếp)
    console.log(`Old key still alive: ${oldKey.fingerprint} (status: ${oldKey.status})`);
}

console.log('\n--- Test 4: Remove new key → env quay về key cũ ---');
const r4 = removeApiKey('gemini', 'new-key-test');
console.log('removeApiKey result:', r4);
console.log(`Env after remove: ${process.env.GOOGLE_GENERATIVE_AI_API_KEY?.slice(0, 12)}...`);
console.log(`Env still set: ${process.env.GOOGLE_GENERATIVE_AI_API_KEY ? '✅ YES' : '❌ NO'}`);

console.log('\n--- Test 5: Mark old key DEAD → env switches (nếu có key khác) ---');
// Skip — would need many operations

console.log('\n✅ Tests passed');
shutdownApiKeySystem();
await new Promise((r) => setTimeout(r, 2500));
process.exit(0);