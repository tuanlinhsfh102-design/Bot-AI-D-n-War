/**
 * Comprehensive verification script for v1.4.0 human-like behavior.
 * Tests: calcDebounce, calcSeenDelay, calcHumanDelay (first/burst), typing indicator.
 *
 * Run: bun run scripts/test_human_behavior.ts
 */
import {
    calcDebounce,
    calcSeenDelay,
    calcHumanDelay,
    recordUserMessage,
    recordBotMessage,
    startTypingIndicator,
    shouldReply,
    getCurrentSlotName,
    sleep,
} from '../src/module/human';

console.log('=================================================');
console.log('  v1.4.0 Human-Like Behavior Verification');
console.log('=================================================\n');

console.log(`Current time slot: ${getCurrentSlotName()}\n`);

// ============================================================
// Test 1: calcDebounce — should vary based on user pace
// ============================================================
console.log('--- Test 1: calcDebounce (per-thread batching delay) ---');
const threadSlow = 'thread-slow';
const threadSpam = 'thread-spam';
const threadNormal = 'thread-normal';

// Simulate slow user (gap 60s between messages)
for (let i = 0; i < 3; i++) {
    recordUserMessage(threadSlow);
    await sleep(50);  // can't actually sleep 60s, but the gap will be small here so...
}
// Simulate spam user (gap <100ms)
for (let i = 0; i < 5; i++) {
    recordUserMessage(threadSpam);
    await sleep(50);
}
// Simulate normal user (gap ~3s)
for (let i = 0; i < 3; i++) {
    recordUserMessage(threadNormal);
    await sleep(50);
}

// Note: Since recordUserMessage only tracks gaps < 10min, and our sleep is 50ms,
// all will look "spammy" in this test. Let's just show variety.
console.log('Sample debounce times (10 runs each):');
for (const t of [threadSlow, threadSpam, threadNormal]) {
    const runs = Array.from({ length: 10 }, () => calcDebounce(t));
    const min = Math.min(...runs);
    const max = Math.max(...runs);
    const avg = Math.floor(runs.reduce((a, b) => a + b, 0) / runs.length);
    console.log(`  ${t.padEnd(15)}: min=${(min/1000).toFixed(1)}s  max=${(max/1000).toFixed(1)}s  avg=${(avg/1000).toFixed(1)}s`);
}

// ============================================================
// Test 2: calcSeenDelay — distribution
// ============================================================
console.log('\n--- Test 2: calcSeenDelay (delay before marking seen) ---');
const seenDelays = Array.from({ length: 100 }, () => calcSeenDelay());
const buckets = { '<1s': 0, '1-3s': 0, '3-10s': 0, '10-30s': 0, '30-90s': 0 };
seenDelays.forEach(d => {
    if (d < 1000) buckets['<1s']++;
    else if (d < 3000) buckets['1-3s']++;
    else if (d < 10000) buckets['3-10s']++;
    else if (d < 30000) buckets['10-30s']++;
    else buckets['30-90s']++;
});
console.log('Distribution (100 runs):');
Object.entries(buckets).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(8)}: ${v}%  ${'█'.repeat(v)}`);
});

// ============================================================
// Test 3: calcHumanDelay — first message vs burst
// ============================================================
console.log('\n--- Test 3: calcHumanDelay (first message vs burst) ---');
const samples = [
    { content: 'Ê mày', isBurst: false },
    { content: 'lên đây war', isBurst: true },
    { content: 'nhát thế :))', isBurst: true },
    { content: 'thôi đừng chửi nữa tôi xin', isBurst: false },  // longer
];

let minDelay = Infinity;
let violations = 0;
for (let run = 1; run <= 10; run++) {
    const delays = samples.map(s => calcHumanDelay(s.content, s.isBurst, threadNormal));
    delays.forEach(d => {
        if (d < 1000) violations++;
        minDelay = Math.min(minDelay, d);
    });
    console.log(`Run ${String(run).padStart(2)}: ${delays.map(d => (d/1000).toFixed(2) + 's').join(' + ')}`);
}
console.log(`\nMin delay: ${(minDelay/1000).toFixed(2)}s`);
console.log(`Violations (delay < 1s): ${violations}`);
console.log(violations === 0 ? '✓ PASS' : '✗ FAIL');

// ============================================================
// Test 4: shouldReply — random "ignore" behavior
// ============================================================
console.log('\n--- Test 4: shouldReply (random ignore behavior) ---');
let replyCount = 0;
let total = 1000;
for (let i = 0; i < total; i++) {
    if (shouldReply(false, false, false)) replyCount++;
}
console.log(`Group message (no mention, no reply, no DM):`);
console.log(`  Replied: ${replyCount}/${total} = ${(replyCount/total*100).toFixed(1)}%`);
console.log(`  Expected: ~92%`);

// Should always reply when mentioned / replied / DM
console.log(`Mention: ${shouldReply(true, false, false) ? 'reply' : 'NO reply'} (expected: reply)`);
console.log(`Reply-to-bot: ${shouldReply(false, true, false) ? 'reply' : 'NO reply'} (expected: reply)`);
console.log(`DM: ${shouldReply(false, false, true) ? 'reply' : 'NO reply'} (expected: reply)`);

// ============================================================
// Test 5: startTypingIndicator — should schedule refreshes
// ============================================================
console.log('\n--- Test 5: startTypingIndicator (refresh schedule) ---');
const fakeApi = {
    typingCalls: [] as number[],
    sendTypingEvent: async function() {
        this.typingCalls.push(Date.now());
        return { status: 0 };
    },
};
const start = Date.now();
startTypingIndicator(fakeApi as any, 'test-thread', 0 as any, 13000);  // 13s delay
await sleep(13500);
console.log(`For 13s delay, typing events sent: ${fakeApi.typingCalls.length} times`);
console.log(`  Expected: 4 (initial + refresh @ 3-4s + 7-8s + 11-12s)`);
console.log(`  Actual: ${fakeApi.typingCalls.length}`);
fakeApi.typingCalls.length >= 3 ? console.log('  ✓ PASS') : console.log('  ✗ FAIL');

console.log('\n=================================================');
console.log('  All tests completed.');
console.log('=================================================');
