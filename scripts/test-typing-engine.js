const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCharacterSteps, renderAppleScript, validateTypingEvents } = require('../src/typing-engine');

const stable = () => 0.5;
const steps = buildCharacterSteps('A\n\t.', 100, 0, 0, 0, stable);
assert.equal(steps.length, 4);
assert.deepEqual(steps[0][0], { type: 'text', value: 'A' });
assert.deepEqual(steps[1][0], { type: 'key', value: 'enter' });
assert.deepEqual(steps[2][0], { type: 'key', value: 'tab' });
assert.deepEqual(steps[3][0], { type: 'text', value: '.' });
assert.equal(validateTypingEvents(steps.flat()), true);

const typoSteps = buildCharacterSteps('a', 100, 1, 0, 0, () => 0.1).flat();
assert.equal(typoSteps.some((event) => event.type === 'key' && event.value === 'backspace'), true);
assert.equal(validateTypingEvents([{ type: 'delay', ms: 5001 }]), false);
assert.equal(validateTypingEvents([{ type: 'text', value: 'ab' }]), false);
assert.equal(validateTypingEvents([{ type: 'shell', value: 'whoami' }]), false);

const script = renderAppleScript([
  { type: 'text', value: '"' },
  { type: 'key', value: 'backspace' },
  { type: 'delay', ms: 125 }
]);
assert.match(script, /keystroke "\\""/);
assert.match(script, /key code 51/);
assert.match(script, /delay 0\.1250/);

const windowsHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'windows-host.ps1'), 'utf8');
for (const marker of ['SendInput', 'KEYEVENTF_UNICODE', "ValidateSet('Target', 'Restore', 'Type')", 'ConvertFrom-Json']) {
  assert.ok(windowsHost.includes(marker), `Windows typing host is missing ${marker}`);
}
assert.ok(!windowsHost.includes('Invoke-Expression'), 'Windows host must never execute user text as PowerShell.');

console.log('Cross-platform typing plan and Windows host checks passed.');
