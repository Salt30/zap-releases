const { BrowserWindow, desktopCapturer, screen, systemPreferences, shell, globalShortcut } = require('electron');
const { DEFAULT_SETTINGS, cleanSettings, requestAI, safeSource } = require('./zap-ai');
const { normalizeAccelerator } = require('./shortcut-utils');

function installZap({ store, getCredentials, handleTrusted, onTrusted, windowOptions, protectWindow, appPageUrl, navigate, isTyping, getTypingShortcuts }) {
  let pending = null;
  let capturing = false;
  let pinWindow = null;
  let pinText = '';
  let registeredShortcut = '';
  let shortcutError = '';
  let sessionRevision = 0;
  const settings = () => {
    try { return cleanSettings(store.get('zapSettings', DEFAULT_SETTINGS)); }
    catch { return { ...DEFAULT_SETTINGS }; }
  };
  function status() {
    return {
      settings: settings(),
      shortcut: store.get('zapShortcut', 'Alt+3'), shortcutError,
      screenPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
    };
  }
  function registerShortcut(value) {
    const next = value ? normalizeAccelerator(value) : { accelerator: '' };
    if (next.error) throw new Error(next.error);
    const accelerator = next.accelerator;
    if (accelerator === registeredShortcut) return;
    if (Object.values(getTypingShortcuts()).includes(accelerator) && accelerator) throw new Error('Zap needs a different shortcut from the composer and stop controls.');
    if (accelerator && !globalShortcut.register(accelerator, () => {
      if (!isTyping()) navigate({ page: 'zap', focus: 'zap-input' });
    })) throw new Error('That shortcut is in use. Quit standalone Zap Pro or choose another shortcut.');
    if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
    registeredShortcut = accelerator;
    shortcutError = '';
  }
  async function capture(displayId) {
    const revision = sessionRevision;
    if (capturing || isTyping()) return { error: 'Finish the current capture or typing session first.' };
    const display = screen.getAllDisplays().find((item) => String(item.id) === String(displayId));
    if (!display) return { error: 'This display is no longer connected. Refresh the display list.' };
    if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
      return { error: 'Allow Zap in System Settings → Privacy & Security → Screen Recording, then reopen the app.' };
    }
    capturing = true;
    const visible = BrowserWindow.getAllWindows().filter((window) => window.isVisible() && !window.isMinimized());
    const focused = BrowserWindow.getFocusedWindow();
    try {
      visible.forEach((window) => window.hide());
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false });
      if (revision !== sessionRevision) return { error: 'Capture cancelled after sign-out.' };
      const source = sources.find((item) => item.display_id === String(display.id)) || (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : null);
      if (!source || source.thumbnail.isEmpty()) return { error: 'Screen capture is unavailable. Check Screen Recording access and try again.' };
      return { image: source.thumbnail.toDataURL(), name: display.label || `Display ${display.id}` };
    } catch {
      return { error: 'Could not capture the screen. Check Screen Recording access and reopen Zap if you just enabled it.' };
    } finally {
      visible.forEach((window) => { if (!window.isDestroyed()) window.showInactive(); });
      if (focused && !focused.isDestroyed()) focused.focus();
      capturing = false;
    }
  }

  handleTrusted('zap:status', ['index.html'], status);
  handleTrusted('zap:settings', ['index.html'], (_event, value) => {
    try {
      const next = cleanSettings(value);
      registerShortcut(value.shortcut ?? store.get('zapShortcut', 'Alt+3'));
      store.set('zapSettings', next);
      store.set('zapShortcut', registeredShortcut);
      return { ...status(), success: true };
    } catch (error) { return { error: error.message }; }
  });
  handleTrusted('zap:request', ['index.html'], async (event, input) => {
    if (pending) return { error: 'A Zap request is already running. Cancel it or wait for it to finish.' };
    const controller = new AbortController();
    pending = controller;
    const timer = setTimeout(() => controller.abort('timeout'), 90000);
    const onDestroyed = () => controller.abort('closed');
    event.sender.once('destroyed', onDestroyed);
    try {
      const credentials = await getCredentials();
      return await requestAI(input, settings(), credentials, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return { error: controller.signal.reason === 'timeout' ? 'The AI request timed out. Try again.' : 'Request cancelled.', cancelled: controller.signal.reason !== 'timeout' };
      // Never return raw transport errors, which can contain headers or request data.
      const safe = /^(Connect your |Zap |Zap’s |An active |Your account |The AI service |The AI request |The screenshot |Choose |Enter |Use at most |Attach |Invalid |Screenshots |Add text |Custom instructions |Response limit |The API key |This API key |Add credit |Your provider |The provider |The AI provider |The selected model |Provider response |Empty provider)/;
      return { error: safe.test(error.message) ? error.message : 'Could not reach the AI provider. Check your connection and try again.' };
    } finally {
      clearTimeout(timer);
      event.sender.removeListener('destroyed', onDestroyed);
      if (pending === controller) pending = null;
    }
  });
  onTrusted('zap:cancel', ['index.html'], () => pending?.abort('cancelled'));
  handleTrusted('zap:displays', ['index.html'], () => screen.getAllDisplays().map((display, index) => ({ id: String(display.id), name: display.label || `Display ${index + 1}`, width: display.size.width, height: display.size.height })));
  handleTrusted('zap:capture', ['index.html'], (_event, displayId) => capture(displayId));
  handleTrusted('zap:screen-settings', ['index.html'], async () => {
    if (process.platform !== 'darwin') return { error: 'Check your operating system screen capture settings.' };
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { success: true };
  });
  handleTrusted('zap:open-source', ['index.html'], async (_event, url) => {
    const safe = typeof url === 'string' && safeSource(url);
    if (!safe) return { error: 'This source link is invalid.' };
    await shell.openExternal(safe);
    return { success: true };
  });
  handleTrusted('zap:pin', ['index.html'], (_event, text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) return { error: 'Generate a result first.' };
    pinText = text;
    if (!pinWindow || pinWindow.isDestroyed()) {
      pinWindow = new BrowserWindow({ ...windowOptions(), width: 440, height: 460, minWidth: 320, minHeight: 240, alwaysOnTop: true, title: 'Zap — Pinned answer' });
      protectWindow(pinWindow, 'zap-pin.html');
      pinWindow.loadURL(appPageUrl('zap-pin.html'));
      pinWindow.on('closed', () => { pinWindow = null; pinText = ''; });
    } else { pinWindow.webContents.send('zap:pin-changed', pinText); pinWindow.show(); }
    return { success: true };
  });
  handleTrusted('zap:pin-text', ['zap-pin.html'], () => pinText);
  onTrusted('zap:pin-close', ['zap-pin.html'], () => pinWindow?.close());
  return {
    resetSession() { sessionRevision++; pending?.abort('signed-out'); pinText = ''; pinWindow?.close(); },
    start() { try { registerShortcut(store.get('zapShortcut', 'Alt+3')); } catch (error) { shortcutError = error.message; } },
    stop() { pending?.abort('closed'); if (registeredShortcut) globalShortcut.unregister(registeredShortcut); },
    conflicts(value) { return Boolean(registeredShortcut && normalizeAccelerator(value).accelerator === registeredShortcut); }
  };
}

module.exports = { installZap };
