const assert = require('node:assert/strict');
const {
  acceleratorFromKeyboardEvent,
  formatAccelerator,
  normalizeAccelerator,
  replaceShortcutPair,
  validateShortcutPair
} = require('../src/shortcut-utils');

assert.deepEqual(normalizeAccelerator('Option+5'), { accelerator: 'Alt+5' });
assert.deepEqual(normalizeAccelerator('⌥5'), { accelerator: 'Alt+5' });
assert.deepEqual(normalizeAccelerator('cmd + shift + k'), { accelerator: 'Command+Shift+K' });
assert.deepEqual(normalizeAccelerator('Control+Alt+Left'), { accelerator: 'Control+Alt+Left' });
assert.match(normalizeAccelerator('Shift+K').error, /Option, Command, or Control/);
assert.match(normalizeAccelerator('Alt').error, /Finish the shortcut/);
assert.match(normalizeAccelerator('Alt+K+L').error, /Use one/);
assert.match(validateShortcutPair('Alt+5', 'Option+5').error, /different shortcuts/);
assert.deepEqual(validateShortcutPair('⌥5', 'Command+Shift+K'), {
  hotkeyStart: 'Alt+5', hotkeyStop: 'Command+Shift+K'
});

assert.deepEqual(acceleratorFromKeyboardEvent({ altKey: true, code: 'Digit5' }), { accelerator: 'Alt+5' });
assert.deepEqual(acceleratorFromKeyboardEvent({ metaKey: true, shiftKey: true, code: 'KeyK' }), {
  accelerator: 'Command+Shift+K'
});
assert.deepEqual(acceleratorFromKeyboardEvent({ ctrlKey: true, code: 'ArrowUp' }), {
  accelerator: 'Control+Up'
});
assert.equal(acceleratorFromKeyboardEvent({ altKey: true, code: 'AltLeft' }).pending, true);
assert.equal(formatAccelerator('Alt+5'), '⌥5');
assert.equal(formatAccelerator('Command+Shift+K'), '⌘⇧K');

function shortcutRegistry(blocked = []) {
  const registered = new Set();
  return {
    registered,
    unregisterAll() { registered.clear(); },
    register(accelerator) {
      if (blocked.includes(accelerator) || registered.has(accelerator)) return false;
      registered.add(accelerator);
      return true;
    }
  };
}

const actions = { openComposer() {}, stopTyping() {} };
const availableRegistry = shortcutRegistry();
const replacement = replaceShortcutPair(
  availableRegistry,
  { hotkeyStart: 'Alt+5', hotkeyStop: 'Alt+0' },
  { hotkeyStart: 'Command+Shift+K', hotkeyStop: 'Control+Alt+X' },
  actions
);
assert.equal(replacement.success, true);
assert.deepEqual([...availableRegistry.registered], ['Command+Shift+K', 'Control+Alt+X']);

const blockedRegistry = shortcutRegistry(['Command+Shift+K']);
const rejected = replaceShortcutPair(
  blockedRegistry,
  { hotkeyStart: 'Alt+5', hotkeyStop: 'Alt+0' },
  { hotkeyStart: 'Command+Shift+K', hotkeyStop: 'Control+Alt+X' },
  actions
);
assert.equal(rejected.success, false);
assert.equal(rejected.rollbackSuccess, true);
assert.deepEqual([...blockedRegistry.registered], ['Alt+5', 'Alt+0']);
assert.deepEqual(rejected.settings, { hotkeyStart: 'Alt+5', hotkeyStop: 'Alt+0' });

console.log('Shortcut normalization and capture tests passed.');
