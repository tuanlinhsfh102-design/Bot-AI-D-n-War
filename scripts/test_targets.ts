// Test targets + threads + proactive logic
import { loadTargets, matchUserToTarget, pickRandomTarget, normalizeName, listTargets, addTarget, findTargetByName } from '../src/module/targets';
import { addKnownThread, getRecentThreads, pickRandomRecentThread } from '../src/module/threads';

console.log('=== Test Targets ===\n');

// 1. Load defaults
const targets = loadTargets();
console.log(`1. Loaded ${targets.length} targets:`);
targets.forEach((t, i) => console.log(`   ${i + 1}. ${t.name} — aliases: ${t.aliases.join(', ')}`));

// 2. Normalize test
console.log(`\n2. Normalize test:`);
console.log(`   "Kiều Anh" → "${normalizeName('Kiều Anh')}"`);
console.log(`   "Trương Minh Anh" → "${normalizeName('Trương Minh Anh')}"`);
console.log(`   "Khởm" → "${normalizeName('Khởm')}"`);

// 3. Match test
console.log(`\n3. Match test:`);
const m1 = matchUserToTarget('Kiều Anh Nguyễn', '123456789', 'group_abc');
console.log(`   Match "Kiều Anh Nguyễn" → ${m1 ? `✓ ${m1.name} (uid=${m1.uid})` : '✗ no match'}`);

const m2 = matchUserToTarget('Trương Minh Anh', '987654321', 'group_abc');
console.log(`   Match "Trương Minh Anh" → ${m2 ? `✓ ${m2.name} (uid=${m2.uid})` : '✗ no match'}`);

const m3 = matchUserToTarget('Nguyễn Văn A', '555555', 'group_abc');
console.log(`   Match "Nguyễn Văn A" → ${m3 ? `✓ ${m3.name}` : '✗ no match (correct)'}`);

const m4 = matchUserToTarget('khom', '777777', 'group_abc');
console.log(`   Match "khom" → ${m4 ? `✓ ${m4.name} (uid=${m4.uid})` : '✗ no match'}`);

// 4. Pick random
console.log(`\n4. Pick random (preferWithUid=true):`);
const picked = pickRandomTarget(true);
console.log(`   Picked: ${picked?.name} (uid=${picked?.uid ?? 'none'})`);

// 5. List
console.log(`\n5. List targets:`);
console.log(listTargets());

// 6. Add new target
console.log(`\n6. Add new target "Test User":`);
const added = addTarget('Test User', ['test', 'tu']);
console.log(`   Added: ${added.name}, aliases: ${added.aliases.join(', ')}`);

// 7. Find by name
console.log(`\n7. Find by name "test user":`);
const found = findTargetByName('test user');
console.log(`   Found: ${found?.name ?? 'NOT FOUND'}`);

console.log('\n=== Test Threads ===\n');

// 8. Add threads
addKnownThread('group_abc', 'Group', { memberUids: ['123456789', '987654321'], groupName: 'Group Test' });
addKnownThread('user_xyz', 'User');
console.log('8. Added 2 threads');

// 9. Get recent
const recent = getRecentThreads();
console.log(`9. Recent threads: ${recent.length}`);
recent.forEach((t) => console.log(`   - ${t.threadId} (${t.threadType}) ${t.groupName ?? ''} members=${t.memberUids?.length ?? 0}`));

// 10. Pick random
const pt = pickRandomRecentThread(true);
console.log(`10. Pick random (preferGroup): ${pt?.threadId} (${pt?.threadType})`);

console.log('\n=== Test Done ===');
