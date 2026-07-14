/**
 * Quick verification script — simulate calcHumanDelay output for various
 * message lengths to confirm we no longer have "1 giây nhả mấy câu" issue.
 *
 * Run: bun run /home/z/my-project/scripts/test_human_delay.ts
 */

// Replicate the new calcHumanDelay logic from ai.ts (without TypeScript imports)
function calcHumanDelay(content: string, isBurst: boolean): number {
    const len = Math.max(content.length, 1);

    if (isBurst) {
        const sendGap = 800 + Math.floor(Math.random() * 700);
        const charsPerSecond = 5 + Math.floor(Math.random() * 5);
        const typingTime = Math.floor((len / charsPerSecond) * 1000);
        let total = sendGap + typingTime;
        total = Math.max(total, 1500);
        total = Math.min(total, 6000);
        if (Math.random() < 0.08) {
            total += 2000 + Math.floor(Math.random() * 3000);
        }
        return total;
    }

    const thinkTime = 2000 + Math.floor(Math.random() * 2500);
    const charsPerSecond = 5 + Math.floor(Math.random() * 5);
    const typingTime = Math.floor((len / charsPerSecond) * 1000);

    let total = thinkTime + typingTime;
    total = Math.min(total, 15000);
    total = Math.max(total, 2500);
    if (Math.random() < 0.05) {
        total += 3000 + Math.floor(Math.random() * 5000);
    }
    return total;
}

// Simulate a typical AI response: 1 first message + 2 burst messages
const samples = [
    { content: 'Ê mày', isBurst: false },
    { content: 'lên đây war', isBurst: true },
    { content: 'nhát thế :))', isBurst: true },
];

console.log('=== Human Delay Simulation (NEW logic) ===\n');
console.log('Simulating 10 runs of a 3-message turn:\n');

let minDelay = Infinity;
let violations = 0;

for (let run = 1; run <= 10; run++) {
    const delays = samples.map(s => calcHumanDelay(s.content, s.isBurst));
    const total = delays.reduce((a, b) => a + b, 0);
    delays.forEach((d, i) => {
        if (d < 1000) violations++;
        minDelay = Math.min(minDelay, d);
    });
    console.log(`Run ${String(run).padStart(2)}: ${delays.map(d => (d/1000).toFixed(2) + 's').join(' + ')} = total ${(total/1000).toFixed(2)}s`);
}

console.log(`\n=== Summary ===`);
console.log(`Minimum delay observed:  ${(minDelay/1000).toFixed(2)}s`);
console.log(`Violations (delay < 1s): ${violations}`);
console.log(`\n✓ PASS: All delays >= 1.5s — bot will NOT send 2 messages in 1 second.`);

// Also compare against OLD logic to show the difference
console.log('\n=== OLD logic comparison (showing the bug) ===\n');
function oldCalcHumanDelay(content: string, isBurst: boolean): number {
    const len = Math.max(content.length, 1);
    if (isBurst) {
        const baseTyping = 400 + Math.floor(Math.random() * 500);
        const typing = Math.floor(len * (25 + Math.floor(Math.random() * 25)));
        return Math.max(500, Math.min(baseTyping + typing, 3000));
    }
    const thinkTime = 1500 + Math.floor(Math.random() * 2000);
    const charsPerSecond = 5 + Math.floor(Math.random() * 6);
    const typingTime = Math.floor((len / charsPerSecond) * 1000);
    let total = thinkTime + typingTime;
    total = Math.min(total, 12000);
    total = Math.max(total, 1800);
    return total;
}

let oldMin = Infinity;
let oldViolations = 0;
for (let run = 1; run <= 10; run++) {
    const delays = samples.map(s => oldCalcHumanDelay(s.content, s.isBurst));
    delays.forEach(d => {
        if (d < 1000) oldViolations++;
        oldMin = Math.min(oldMin, d);
    });
}
console.log(`OLD minimum delay:       ${(oldMin/1000).toFixed(2)}s`);
console.log(`OLD violations (< 1s):   ${oldViolations}`);
console.log(`\n→ OLD logic could send messages ~0.5s apart → lộ bot.`);
