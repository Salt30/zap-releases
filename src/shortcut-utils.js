const MODIFIER_ALIASES = new Map([
  ['command', 'Command'], ['cmd', 'Command'], ['meta', 'Command'],
  ['commandorcontrol', 'CommandOrControl'], ['cmdorctrl', 'CommandOrControl'],
  ['control', 'Control'], ['ctrl', 'Control'], ['^', 'Control'],
  ['alt', 'Alt'], ['option', 'Alt'],
  ['shift', 'Shift']
]);

const KEY_ALIASES = new Map([
  ['space', 'Space'], ['spacebar', 'Space'],
  ['tab', 'Tab'], ['enter', 'Enter'], ['return', 'Enter'],
  ['escape', 'Escape'], ['esc', 'Escape'],
  ['backspace', 'Backspace'], ['delete', 'Delete'], ['insert', 'Insert'],
  ['up', 'Up'], ['arrowup', 'Up'], ['down', 'Down'], ['arrowdown', 'Down'],
  ['left', 'Left'], ['arrowleft', 'Left'], ['right', 'Right'], ['arrowright', 'Right'],
  ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown']
]);

const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift'];

function tokeniseAccelerator(value) {
  return String(value || '')
    .trim()
    .replace(/[–—-]/g, '+')
    .replace(/⌘/g, 'Command+')
    .replace(/⌃/g, 'Control+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .split(/\s*\+\s*/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normaliseKey(token) {
  const lower = token.toLowerCase();
  if (KEY_ALIASES.has(lower)) return KEY_ALIASES.get(lower);
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (functionKey) return `F${functionKey[1]}`;
  return null;
}

function normalizeAccelerator(value) {
  const tokens = tokeniseAccelerator(value);
  if (!tokens.length) return { error: 'Press a shortcut that includes Option/Alt, Command, or Control.' };

  const modifiers = new Set();
  let key = null;
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    const candidate = normaliseKey(token);
    if (!candidate || key) return { error: 'Use one letter, number, arrow, navigation key, or F1–F24.' };
    key = candidate;
  }

  if (!key) return { error: 'Finish the shortcut with a letter, number, arrow, navigation key, or F1–F24.' };
  if (![...modifiers].some((modifier) => ['CommandOrControl', 'Command', 'Control', 'Alt'].includes(modifier))) {
    return { error: 'Include Option/Alt, Command, or Control so normal typing is never intercepted.' };
  }

  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return { accelerator: [...ordered, key].join('+') };
}

function validateShortcutPair(start, stop) {
  const normalizedStart = normalizeAccelerator(start);
  if (normalizedStart.error) return { error: `Open Drip Type: ${normalizedStart.error}` };
  const normalizedStop = normalizeAccelerator(stop);
  if (normalizedStop.error) return { error: `Stop Typing: ${normalizedStop.error}` };
  if (normalizedStart.accelerator === normalizedStop.accelerator) {
    return { error: 'Open Drip Type and Stop Typing need different shortcuts.' };
  }
  return { hotkeyStart: normalizedStart.accelerator, hotkeyStop: normalizedStop.accelerator };
}

function acceleratorFromKeyboardEvent(event = {}) {
  const modifiers = [];
  if (event.metaKey) modifiers.push('Command');
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  const code = String(event.code || '');
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else key = KEY_ALIASES.get(code.toLowerCase()) || null;
  if (!key) return { pending: true };
  return normalizeAccelerator([...modifiers, key].join('+'));
}

function formatAccelerator(value, platform = 'darwin') {
  const normalized = normalizeAccelerator(value);
  if (normalized.error) return String(value || '');
  if (platform === 'win32') {
    return normalized.accelerator.split('+').map((token) => ({
      CommandOrControl: 'Ctrl', Command: 'Win', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift'
    }[token] || token)).join('+');
  }
  return normalized.accelerator.split('+').map((token) => ({
    CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧'
  }[token] || token)).join('');
}

function registerShortcutPair(registry, pair, actions) {
  registry.unregisterAll();
  const failures = [];
  const shortcuts = [
    { key: pair.hotkeyStart, action: actions.openComposer, label: 'Open Drip Type' },
    { key: pair.hotkeyStop, action: actions.stopTyping, label: 'Stop Typing' }
  ];
  for (const shortcut of shortcuts) {
    try {
      if (!registry.register(shortcut.key, shortcut.action)) {
        failures.push(`${shortcut.label} (${shortcut.key}) is already used by the operating system or another app.`);
      }
    } catch (_) {
      failures.push(`${shortcut.label} (${shortcut.key}) is not a supported shortcut.`);
    }
  }
  return { success: failures.length === 0, failures };
}

function replaceShortcutPair(registry, previous, requested, actions) {
  const validated = validateShortcutPair(requested.hotkeyStart, requested.hotkeyStop);
  if (validated.error) return { success: false, failures: [validated.error], settings: previous };
  const registration = registerShortcutPair(registry, validated, actions);
  if (registration.success) return { ...registration, settings: validated };

  const rollback = validateShortcutPair(previous.hotkeyStart, previous.hotkeyStop);
  const rollbackResult = rollback.error
    ? { success: false }
    : registerShortcutPair(registry, rollback, actions);
  return { ...registration, settings: previous, rollbackSuccess: rollbackResult.success };
}

module.exports = {
  acceleratorFromKeyboardEvent,
  formatAccelerator,
  normalizeAccelerator,
  registerShortcutPair,
  replaceShortcutPair,
  validateShortcutPair
};
