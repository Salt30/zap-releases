const assert = require('node:assert/strict');
const { parseStudyCards, validCards } = require('../src/zap-content');
const pkg = require('../package.json');
assert.equal(pkg.main, 'build-app/main.js');
assert.equal(pkg.scripts.start, 'npm run build:app && electron .');
const expected = [{ front: 'Capital of France?', back: 'Paris' }, { front: '2 + 2?', back: '4' }];
assert.deepEqual(parseStudyCards('1. **Q:** Capital of France?\n**A:** Paris\n\n2. Q: 2 + 2? → A: 4'), expected);
assert.deepEqual(parseStudyCards('```json\n' + JSON.stringify({ cards: expected }) + '\n```'), expected);
assert.deepEqual(parseStudyCards('Q: Explain\nthis concept\nA: First line\nSecond line'), [{ front: 'Explain\nthis concept', back: 'First line\nSecond line' }]);
for (const input of [null, {}, 'Q: Missing answer', 'ordinary prose', 'x'.repeat(100001), JSON.stringify({cards: [{front: {}, back: 'x'}]})]) assert.deepEqual(parseStudyCards(input), []);
assert.deepEqual(validCards([{ front: 'x'.repeat(4001), back: 'answer' }]), []);
assert.deepEqual(validCards(Array.from({length:31}, () => expected[0])), []);
assert.deepEqual(parseStudyCards(Array.from({length:31}, (_, i) => `Q: ${i}\nA: answer`).join('\n')), []);
const original = [{ front: ' <img src=x onerror=alert(1)> ', back: '<script>literal</script>' }];
const copy = validCards(original);
assert.equal(copy[0].front, '<img src=x onerror=alert(1)>'); // Text, never interpreted as markup.
copy[0].front = 'changed';
assert.notEqual(original[0].front, 'changed');
console.log('Zap content passed: legacy/JSON cards, strict limits, incomplete cards, and independent deck copies.');
