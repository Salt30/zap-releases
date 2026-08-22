const assert = require('node:assert/strict');
const { app, globalShortcut } = require('electron');
const { replaceShortcutPair, validateShortcutPair } = require('../src/shortcut-utils');

const actions = { openComposer() {}, stopTyping() {} };
const first = { hotkeyStart: 'Control+Alt+Shift+8', hotkeyStop: 'Control+Alt+Shift+9' };
const second = { hotkeyStart: 'Command+Control+Alt+8', hotkeyStop: 'Command+Control+Alt+9' };

app.whenReady().then(() => {
  assert.deepEqual(validateShortcutPair('Option+5', 'Option+0'), {
    hotkeyStart: 'Alt+5', hotkeyStop: 'Alt+0'
  });
  const initial = replaceShortcutPair(globalShortcut, first, first, actions);
  assert.equal(initial.success, true, initial.failures.join(' '));
  assert.equal(globalShortcut.isRegistered(first.hotkeyStart), true);
  assert.equal(globalShortcut.isRegistered(first.hotkeyStop), true);

  const changed = replaceShortcutPair(globalShortcut, first, second, actions);
  assert.equal(changed.success, true, changed.failures.join(' '));
  assert.equal(globalShortcut.isRegistered(first.hotkeyStart), false);
  assert.equal(globalShortcut.isRegistered(first.hotkeyStop), false);
  assert.equal(globalShortcut.isRegistered(second.hotkeyStart), true);
  assert.equal(globalShortcut.isRegistered(second.hotkeyStop), true);
  console.log(`Native ${process.platform} shortcut registration and replacement passed.`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  globalShortcut.unregisterAll();
  app.quit();
});
