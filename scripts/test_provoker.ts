// Quick test: load provoker lines và verify các picker
import {
    loadProvokerLines,
    randomProvokerLine,
    pickByLevel,
    pickByCategory,
    pickByKeywordMatch,
    pickMany,
    listCategories,
} from '../src/module/provoker';

console.log('=== Test Provoker Module ===\n');

// 1. Load
const all = loadProvokerLines();
console.log(`1. Loaded ${all.length} lines`);

// 2. Random
const r = randomProvokerLine();
console.log(`2. Random: ${r}`);

// 3. By level
console.log(`3. By level:`);
console.log(`   mild: ${pickByLevel('mild')}`);
console.log(`   medium: ${pickByLevel('medium')}`);
console.log(`   spicy: ${pickByLevel('spicy')}`);

// 4. By category
console.log(`4. By category:`);
const cats = listCategories();
console.log(`   Categories: ${cats.join(', ')}`);
for (const c of cats) {
    console.log(`   ${c}: ${pickByCategory(c)}`);
}

// 5. Match
console.log(`5. Match:`);
console.log(`   "m tức quá": ${pickByKeywordMatch('m tức quá')}`);
console.log(`   "tao bá lắm": ${pickByKeywordMatch('tao bá lắm')}`);
console.log(`   "m rét à": ${pickByKeywordMatch('m rét à')}`);

// 6. Pick many
console.log(`6. Pick 3:`);
const many = pickMany(3);
many.forEach((l, i) => console.log(`   ${i + 1}. ${l}`));

console.log('\n=== Test Done ===');
