// Isolated UI fixture: real bundled renderers/preload, simulated service data.
// Never loads the production main process, registers shortcuts, types into other
// apps, modifies login items, contacts Stripe, or reads a user's saved vault.
const { app, BrowserWindow, ipcMain, nativeTheme, nativeImage, protocol, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'drip', privileges: { standard: true, secure: true } }]);
function registerFixtureProtocol() {
  // Exercise the production resource resolver without starting production services.
  const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const resources = source.match(/const APP_RESOURCES = new Set\((\[[\s\S]*?\])\);/)[1];
  const definition = source.slice(source.indexOf('function registerAppProtocol()'), source.indexOf('\nfunction protectWindow('));
  vm.runInNewContext(`${definition}\nregisterAppProtocol();`, {
    protocol, net, path, pathToFileURL, URL, Response, Headers,
    __dirname: path.join(root, 'build-app'), APP_SCHEME: 'drip', APP_HOST: 'app',
    APP_RESOURCES: new Set(vm.runInNewContext(resources)),
    APP_CONTENT_SECURITY_POLICY: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  });
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'drip-ui-audit-')));
app.setName('Zap Preview');
const preview = process.argv.includes('--preview');
const errors = [];
const windows = [];
const settings = { dripWPM: 150, dripDelay: 22, typoRate: .045, dripPauseChance: .2, dripBurstChance: 0, hotkeyStart: 'Alt+6', hotkeyStop: 'Alt+0', launchAtLogin: false, theme: 'light' };
let completedSettings;
let reducedTransparency = false;
let highContrast = false;
let startCount = 0;
let zapRequestCount = 0;
let lastZapRequest;
let cancelZapRequest;
let accountSignedIn = true;
let signInCount = 0;
let zapSettings = { language: 'Spanish', context: '', maxTokens: 2048 };
const zapStatus = () => ({ settings: zapSettings, shortcut: 'Alt+3', shortcutError: '', screenPermission: 'granted' });
ipcMain.on('zap:cancel', () => cancelZapRequest?.({ error: 'Request cancelled.', cancelled: true }));
const appearance = () => ({ theme: settings.theme, resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', reducedTransparency, highContrast, platform: process.platform });
function publishAppearance() { windows.forEach((window) => { if (!window.isDestroyed()) window.webContents.send('theme:changed', appearance()); }); }
const services = {
  'zap:status': zapStatus,
  'zap:settings': (_event, value) => { zapSettings = { language: value.language, context: value.context, maxTokens: value.maxTokens }; return { ...zapStatus(), success: true }; },
  'zap:displays': () => [{ id: 'fixture-screen', name: 'Test display', width: 128, height: 128 }],
  'zap:capture': () => ({ image: nativeImage.createFromBitmap(Buffer.alloc(128 * 128 * 4, 255), { width: 128, height: 128 }).toDataURL(), name: 'Test display' }),
  'zap:request': async (_event, request) => {
    zapRequestCount++; lastZapRequest = request;
    if (request.text === 'cancel fixture') return new Promise((resolve) => { cancelZapRequest = resolve; });
    return { text: request.mode === 'flashcards' ? 'Study cards' : 'Integrated Zap answer <script>literal</script>', cards: request.mode === 'flashcards' ? [{ front: 'Capital of France?', back: 'Paris' }, { front: '2 + 2?', back: '4' }] : [], sources: [], provider: 'Zap AI', model: 'Powered by NVIDIA' };
  },
  'zap:pin': () => ({ success: true }),
  'zap:pin-text': () => 'Pinned fixture <script>literal</script>',
  'appearance:get': appearance,
  'settings:get': () => settings,
  'settings:save': (_event, next) => { Object.assign(settings, next); nativeTheme.themeSource = settings.theme; publishAppearance(); return { settings, shortcutFailures: [] }; },
  'app:get-info': () => ({ name: 'Zap', version: `${require('../package.json').version} · design preview`, platform: process.platform, appId: 'com.salt30.driptype' }),
  'updater:get-state': () => ({ status: 'development' }),
  'billing:get-state': () => ({ signedIn: accountSignedIn, status: accountSignedIn ? 'active' : 'required', allowed: accountSignedIn, plan: accountSignedIn ? 'pro' : null, features: ['composer', 'typing'] }),
  'account:sign-in': () => { signInCount++; return {}; },
  'account:open': () => ({}),
  'account:sign-out': (event) => {
    accountSignedIn = false;
    cancelZapRequest?.({ cancelled: true });
    event.sender.send('account:signed-out');
    const state = services['billing:get-state']();
    event.sender.send('billing:state', state);
    return state;
  },
  'accessibility:get': () => true,
  'permissions:get': () => ({ accessibility: true, automation: true, shortcuts: true }),
  'onboarding:complete': (_event, next) => { completedSettings = next; return { success: true }; },
  'drip-type:start': async () => { startCount++; await new Promise((resolve) => setTimeout(resolve, 100)); return { error: 'Preview only: no keystrokes sent.' }; },
  'quick:toggle-full-screen': (event) => { const window = BrowserWindow.fromWebContents(event.sender); const next = !window.isFullScreen(); window.setFullScreen(next); return { fullScreen: next }; },
};
for (const [name, handler] of Object.entries(services)) ipcMain.handle(name, handler);

async function makeWindow(page, width, height) {
  const quick = page === 'quick.html';
  const window = new BrowserWindow({
    width, height, show: preview, title: 'Zap • isolated design preview',
    titleBarStyle: !quick && process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    ...(quick ? { frame: false, transparent: true } : {}),
    backgroundColor: '#00000000', vibrancy: process.platform === 'darwin' ? (quick ? 'under-window' : 'sidebar') : undefined,
    visualEffectState: 'followWindow',
    webPreferences: { preload: path.join(root, 'build-app/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  windows.push(window);
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  await window.loadURL(`drip://app/${page}`);
  return window;
}
async function evaluate(window, code) { return window.webContents.executeJavaScript(code, true); }
async function eventually(window, expression) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(window, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`UI did not settle: ${expression}`);
}

app.whenReady().then(async () => {
  registerFixtureProtocol();
  nativeTheme.themeSource = 'light';
  const main = await makeWindow('index.html', 1000, 740);
  ipcMain.on('quick:show', async () => {
    const quick = await makeWindow('quick.html', 560, 350);
    quick.webContents.send('quick:opened', { settings });
    quick.show();
  });
  ipcMain.on('quick:close', (event) => BrowserWindow.fromWebContents(event.sender).close());
  await eventually(main, "document.getElementById('brand-version').textContent.includes('design preview')");
  assert.equal(await evaluate(main, "document.title"), 'Zap');
  assert.deepEqual(await evaluate(main, "['templates','studio','profiles','clipboard'].filter(name => document.getElementById('page-'+name) || document.querySelector('[data-page='+name+']'))"), []);
  assert.deepEqual(await evaluate(main, "['listTemplates','saveTemplate','listProfiles','listClipboardItems','renderBatch','transformWriting'].filter(name => name in window.dripType)"), []);
  assert.equal(await evaluate(main, "document.querySelector('.brand-name').textContent.trim()"), 'Zap');
  assert.equal(await evaluate(main, "document.querySelector('[data-page=composer]').textContent.trim()"), 'Drip Type');
  await evaluate(main, `document.querySelector('[data-page="zap"]').click();document.getElementById('zap-settings-open').click()`);
  await eventually(main, "document.getElementById('zap-settings-dialog').open");
  assert.equal(await evaluate(main, "document.querySelectorAll('#zap-settings-dialog input[type=password]').length"), 0);
  await evaluate(main, "document.getElementById('zap-language').value='French';document.getElementById('zap-settings-form').requestSubmit()");
  await eventually(main, "document.getElementById('zap-settings-note').textContent === 'Preferences saved.'");
  assert.equal(zapSettings.language, 'French');
  await evaluate(main, "document.getElementById('zap-settings-close').click();document.getElementById('zap-input').value='Explain this';document.getElementById('zap-run').click();document.getElementById('zap-run').click()");
  await eventually(main, "document.getElementById('zap-output').textContent.includes('Integrated Zap answer')");
  assert.equal(zapRequestCount, 1);
  assert.equal(await evaluate(main, "document.getElementById('zap-output').querySelector('script')"), null);
  await evaluate(main, "document.getElementById('zap-compose').click()");
  assert.equal(await evaluate(main, "document.querySelector('.page.active').id"), 'page-composer');
  assert.equal(await evaluate(main, "document.getElementById('page-title').textContent"), 'Drip Type');
  assert.equal(await evaluate(main, "document.getElementById('text').value"), 'Integrated Zap answer <script>literal</script>');
  await evaluate(main, "document.querySelector('[data-page=zap]').click();document.getElementById('zap-capture-open').click()");
  await eventually(main, "document.getElementById('zap-capture-dialog').open");
  await evaluate(main, "document.getElementById('zap-capture-take').click()");
  await eventually(main, "!document.getElementById('zap-capture-attach').disabled");
  assert.equal(zapRequestCount, 1, 'Capture uploaded an image before submission');
  await evaluate(main, "document.getElementById('zap-crop-width').value=64;document.getElementById('zap-crop-width').dispatchEvent(new Event('change'));document.getElementById('zap-capture-attach').click()");
  assert.equal(await evaluate(main, "document.querySelectorAll('.zap-attachment').length"), 1);
  await evaluate(main, "document.getElementById('zap-input').value='Describe it';document.getElementById('zap-run').click()");
  await eventually(main, "!document.getElementById('zap-run').disabled");
  assert.equal(lastZapRequest.images.length, 1); assert.match(lastZapRequest.images[0], /^data:image\/jpeg;base64,/);
  await evaluate(main, "document.querySelector('.zap-attachment button').click();document.querySelector('[data-zap-mode=flashcards]').click();document.getElementById('zap-run').click()");
  await eventually(main, "!document.getElementById('zap-flashcards').hidden");
  assert.equal(await evaluate(main, "document.getElementById('zap-card-text').textContent"), 'Capital of France?');
  await evaluate(main, "document.getElementById('zap-card-flip').click()");
  assert.equal(await evaluate(main, "document.getElementById('zap-card-text').textContent"), 'Paris');
  await evaluate(main, "document.getElementById('zap-card-next').click()");
  assert.equal(await evaluate(main, "document.getElementById('zap-card-text').textContent"), '2 + 2?');
  await evaluate(main, "document.getElementById('zap-input').value='cancel fixture';document.getElementById('zap-run').click()");
  await eventually(main, "!document.getElementById('zap-cancel').hidden");
  await evaluate(main, "document.getElementById('zap-cancel').click()");
  await eventually(main, "document.getElementById('zap-status').textContent==='Request cancelled.'");
  await evaluate(main, "document.getElementById('zap-clear-history').click()");
  assert.equal(await evaluate(main, "document.getElementById('zap-history-count').textContent"), '0');
  for (const [id, key] of Object.entries({ wpm: 'dripWPM', delay: 'dripDelay', typos: 'typoRate', pauses: 'dripPauseChance', bursts: 'dripBurstChance' })) {
    assert.equal(await evaluate(main, `Number(document.getElementById('${id}').value)`), settings[key], `Saved ${key} was clamped`);
  }
  for (const theme of ['light', 'dark']) {
    await evaluate(main, `document.querySelector('[data-page="setup"]').click(); document.querySelector('[data-theme-value="${theme}"]').click()`);
    await eventually(main, `document.documentElement.dataset.theme === '${theme}'`);
    for (const page of ['zap', 'composer', 'typing', 'shortcuts', 'billing', 'setup']) {
      await evaluate(main, `document.querySelector('[data-page="${page}"]').click()`);
      const dimensions = await evaluate(main, `(() => { const page = document.querySelector('.page.active'); const content = document.querySelector('.content'); return { id: page.id, overflow: page.scrollWidth > page.clientWidth + 1 || content.scrollWidth > content.clientWidth + 1 }; })()`);
      assert.equal(dimensions.id, `page-${page}`);
      assert.equal(dimensions.overflow, false, `${page} overflow in ${theme}`);
    }
  }
  await evaluate(main, "document.querySelector('[data-page=shortcuts]').click()");
  assert.equal(await evaluate(main, "(() => { const e = new KeyboardEvent('keydown', { key:'Tab', bubbles:true, cancelable:true }); document.getElementById('start-key').dispatchEvent(e); return e.defaultPrevented; })()"), false);
  main.setSize(820, 600);
  for (const page of ['zap', 'composer', 'typing', 'setup', 'billing']) {
    await evaluate(main, `document.querySelector('[data-page="${page}"]').click()`);
    assert.equal(await evaluate(main, "document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth + 1"), false, `Minimum window overflow: ${page}`);
  }
  reducedTransparency = true; highContrast = true; publishAppearance();
  await eventually(main, "document.documentElement.dataset.reducedTransparency === 'true'");
  assert.equal(await evaluate(main, "getComputedStyle(document.querySelector('.window-toolbar')).backdropFilter"), 'none');
  reducedTransparency = false; highContrast = false; publishAppearance();
  const onboarding = await makeWindow('onboarding.html', 800, 620);
  await eventually(onboarding, "document.getElementById('wpm').value === '150'");
  assert.equal(await evaluate(onboarding, "document.getElementById('delay').value"), '22');
  assert.equal(await evaluate(onboarding, "(() => { const input = document.getElementById('burst'); input.stepUp(); const value = Number(input.value); input.stepDown(); return value; })()"), .01);
  assert.equal(await evaluate(onboarding, "document.getElementById('welcome-hotkey').textContent"), process.platform === 'darwin' ? '⌥6' : 'Alt+6');
  await evaluate(onboarding, "document.getElementById('next').click();document.getElementById('next').click();document.getElementById('next').click()");
  await eventually(onboarding, "!document.getElementById('next').disabled");
  await evaluate(onboarding, "document.getElementById('next').click()");
  assert.deepEqual(completedSettings, Object.fromEntries(['dripWPM', 'dripDelay', 'typoRate', 'dripPauseChance', 'dripBurstChance'].map((key) => [key, settings[key]])));
  onboarding.close();
  const quick = await makeWindow('quick.html', 560, 350);
  quick.webContents.send('quick:opened', { settings });
  await evaluate(quick, "document.getElementById('text').value='Preview text';document.getElementById('text').dispatchEvent(new Event('input'));document.getElementById('submit').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true}))");
  await eventually(quick, "document.getElementById('state').textContent.includes('Preview only')");
  assert.equal(startCount, 1);
  assert.equal(await evaluate(quick, "document.getElementById('text').value"), 'Preview text');
  assert.equal(await evaluate(quick, "document.querySelector('.shell').scrollHeight > document.querySelector('.shell').clientHeight + 2"), false);
  if (!process.argv.includes('--skip-native-fullscreen')) {
  quick.show();
  await evaluate(quick, "document.getElementById('toggle-full-screen').click()");
  await eventually(quick, "document.documentElement.dataset.fullScreen === 'true'");
  for (let i = 0; i < 200 && !quick.isFullScreen(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(quick.isFullScreen(), true);
  await evaluate(quick, "document.getElementById('toggle-full-screen').click()");
  await eventually(quick, "document.documentElement.dataset.fullScreen === 'false'");
  }

  assert.deepEqual(errors, []);
  const pin = await makeWindow('zap-pin.html', 440, 460);
  await eventually(pin, "document.getElementById('answer').textContent.includes('Pinned fixture')");
  assert.equal(await evaluate(pin, "document.querySelector('#answer script')"), null);
  pin.close();
  main.setSize(1000, 740);
  // Verify the default shortcut through the real settings flow after checking
  // that custom shortcuts survive onboarding. Capture the default brand view.
  await evaluate(main, "document.querySelector('[data-page=shortcuts]').click();document.getElementById('reset-shortcuts').click();document.getElementById('save-shortcuts').click()");
  await eventually(main, "document.getElementById('quick-shortcut').textContent === " + JSON.stringify(process.platform === 'darwin' ? '⌥5' : 'Alt+5'));
  assert.equal(settings.hotkeyStart, 'Alt+5');
  await evaluate(main, "document.querySelector('[data-page=zap]').click();document.querySelector('[data-zap-mode=answer]').click();document.getElementById('zap-input').value='Explain this idea and help me write it clearly.';document.getElementById('zap-run').click()");
  await eventually(main, "!document.getElementById('zap-run').disabled");
  main.show();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await evaluate(main, "document.getElementById('page-zap').checkVisibility({checkOpacity:true, checkVisibilityCSS:true})"), true);
  fs.writeFileSync(path.join(os.tmpdir(), 'zap-integrated-desktop.png'), (await main.webContents.capturePage()).toPNG());
  await evaluate(main, "document.querySelector('[data-page=billing]').click()");
  assert.equal(await evaluate(main, "document.getElementById('account-sign-out').hidden"), false);
  await eventually(main, "Number(getComputedStyle(document.getElementById('page-billing')).opacity) >= .99 && document.getElementById('page-billing').checkVisibility({checkVisibilityCSS:true})");
  fs.writeFileSync(path.join(os.tmpdir(), 'zap-account-controls.png'), (await main.webContents.capturePage()).toPNG());
  await evaluate(main, "document.querySelector('[data-page=zap]').click();document.getElementById('zap-input').value='cancel fixture';document.getElementById('zap-run').click()");
  await eventually(main, "document.getElementById('zap-run').disabled");
  await evaluate(main, "document.querySelector('[data-page=billing]').click()");
  await evaluate(main, "document.getElementById('text').value='Private draft';document.getElementById('account-sign-out').click()");
  await eventually(main, "document.getElementById('billing-subscribe').textContent === 'Sign in' && !document.getElementById('billing-subscribe').disabled");
  assert.equal(await evaluate(main, "document.getElementById('text').value"), '');
  assert.equal(await evaluate(main, "document.getElementById('zap-input').value"), '');
  assert.equal(await evaluate(main, "document.getElementById('zap-history-count').textContent"), '0');
  assert.equal(await evaluate(main, "document.getElementById('zap-result').hidden"), true);
  await evaluate(main, "document.getElementById('billing-subscribe').click()");
  await eventually(main, "!document.getElementById('billing-subscribe').disabled");
  assert.equal(signInCount, 1);
  assert.deepEqual(errors, []);
  if (preview) { main.show(); main.focus(); console.log('PREVIEW_READY: isolated native windows; no production data or payments.'); }
  else windows.forEach((window) => { if (!window.isDestroyed()) window.close(); });
  if (process.argv.includes('--skip-native-fullscreen')) console.log('Native fullscreen check skipped for this account-focused run.');
  console.log('Desktop UI passed: secure sign-in/sign-out, private data clearing, 6 pages, Zap AI/crop/flashcards/cancellation/handoff, light/dark, compact layout, accessibility, removed feature isolation, shortcut focus, onboarding preservation and composer repeat-submit protection.');
  if (!preview) app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
