const $ = (id) => document.getElementById(id);
const { acceleratorFromKeyboardEvent, formatAccelerator } = require('./shortcut-utils');
const { createAppearance } = require('./appearance');
const { setSavedRangeValue } = require('./settings-controls');
const { initZap } = require('./zap-ui');
const controls = {
  wpm: $('wpm'),
  delay: $('delay'),
  typos: $('typos'),
  pauses: $('pauses'),
  bursts: $('bursts')
};

let typing = false;
let saveTimer = null;
let updateState = { status: 'idle' };
let launchAtLogin = true;
let billingState = { allowed: false, status: 'checking', plan: null };
let savedShortcuts = { hotkeyStart: 'Alt+5', hotkeyStop: 'Alt+0' };
let currentPlatform = 'darwin';

function errorMessage(error, fallback = 'That action could not be completed. Try again.') {
  return String(error?.message || fallback);
}

function hasFeature(feature) {
  return Array.isArray(billingState.features) && billingState.features.includes(feature);
}

const applyTheme = createAppearance((themePreference) => {
  document.querySelectorAll('.theme-option').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeValue === themePreference);
    button.setAttribute('aria-pressed', String(button.dataset.themeValue === themePreference));
  });
});

function setPage(name) {
  const button = document.querySelector(`.nav-button[data-page="${name}"]`);
  if (!button) return;
  $('page-title').textContent = button.querySelector('span').textContent;
  document.querySelector('.content').scrollTop = 0;
  if (button?.dataset.feature && !hasFeature(button.dataset.feature)) {
    document.querySelectorAll('.nav-button').forEach((item) => {
      const active = item.dataset.page === name;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
    return;
  }
  document.querySelectorAll('.nav-button').forEach((button) => {
    const active = button.dataset.page === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.id === `page-${name}`);
  });
}

function renderLaunchAtLogin(enabled) {
  launchAtLogin = Boolean(enabled);
  $('launch-login').setAttribute('aria-checked', String(launchAtLogin));
  $('launch-login-label').textContent = launchAtLogin ? 'On' : 'Off';
  $('launch-login-copy').textContent = launchAtLogin
    ? `Starts quietly in the ${currentPlatform === 'win32' ? 'system tray' : 'menu bar'} so the global composer shortcut is always available.`
    : 'Zap must be opened manually before its global shortcuts can work.';
}

function rangeFill(input) {
  const value = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty('--fill', `${value}%`);
}

function refreshTextMeta() {
  const text = $('text').value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = [...text].length;
  const wpm = Number(controls.wpm.value || 45);
  const seconds = words ? Math.max(1, Math.round((words / wpm) * 60)) : 0;
  $('word-count').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  $('char-count').textContent = `${chars} ${chars === 1 ? 'character' : 'characters'}`;
  $('estimate').textContent = seconds ? `about ${seconds}s` : '—';
  $('start').disabled = typing || !text.trim() || !billingState.allowed;
}

function readableDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function renderBilling(state = {}) {
  billingState = { ...billingState, ...state };
  const status = billingState.status || 'required';
  const active = status === 'active';
  const planName = billingState.plan === 'pro' ? 'Pro' : 'Core';

  $('billing-status').dataset.state = status;
  $('billing-status').textContent = active ? 'Subscription active' : 'Subscription required';
  $('billing-plan').textContent = active ? `Zap ${planName}` : 'Continue with Core';
  $('billing-copy').textContent = billingState.message || (active
    ? 'This device is activated and ready to use.'
    : 'Choose Core to keep using Drip Type and natural typing.');

  const expiry = active ? readableDate(billingState.expiresAt) : '';
  $('billing-expiry').textContent = expiry
    ? `Access verified through ${expiry}. It refreshes automatically.`
    : '';
  $('billing-manage').disabled = !active;
  $('billing-subscribe').textContent = billingState.signedIn ? 'View account' : 'Sign in';
  $('account-sign-out').hidden = !billingState.signedIn && !billingState.cleanupPending;
  refreshTextMeta();
}

function sendToComposer(value) {
  $('text').value = String(value || '').slice(0, 100000);
  refreshTextMeta();
  setPage('composer');
  $('text').focus();
}

function applyTypingControls(profile) {
  for (const [name, key] of Object.entries({ wpm: 'dripWPM', delay: 'dripDelay', typos: 'typoRate', pauses: 'dripPauseChance', bursts: 'dripBurstChance' })) {
    setSavedRangeValue(controls[name], profile[key]);
  }
  refreshValues();
}

function refreshValues() {
  $('wpm-out').textContent = `${controls.wpm.value} WPM`;
  $('delay-out').textContent = `${controls.delay.value} ${controls.delay.value === '1' ? 'second' : 'seconds'}`;
  $('typos-out').textContent = `${Math.round(controls.typos.value * 100)}%`;
  $('pauses-out').textContent = `${Math.round(controls.pauses.value * 100)}%`;
  $('bursts-out').textContent = `${Math.round(controls.bursts.value * 100)}%`;
  Object.values(controls).forEach(rangeFill);
  refreshTextMeta();
}

function currentBehavior() {
  return {
    dripWPM: Number(controls.wpm.value),
    dripDelay: Number(controls.delay.value),
    typoRate: Number(controls.typos.value),
    dripPauseChance: Number(controls.pauses.value),
    dripBurstChance: Number(controls.bursts.value)
  };
}

function saveBehavior() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushBehavior().catch(reportActionError), 180);
}

async function flushBehavior() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return window.dripType.saveSettings(currentBehavior());
}

function renderShortcutInput(input, accelerator) {
  input.dataset.accelerator = accelerator;
  input.value = formatAccelerator(accelerator, currentPlatform);
}

function renderCurrentShortcuts(shortcuts = savedShortcuts) {
  const start = formatAccelerator(shortcuts.hotkeyStart, currentPlatform);
  const stop = formatAccelerator(shortcuts.hotkeyStop, currentPlatform);
  $('quick-shortcut').textContent = start;
  $('setup-shortcut-copy').textContent = `${start} opens Drip Type and ${stop} stops typing.`;
}

function shortcutMessage(message, error = false) {
  const note = $('shortcut-note');
  note.textContent = message;
  note.classList.toggle('error', error);
}

function captureShortcut(input) {
  input.addEventListener('keydown', (event) => {
    // Keep keyboard users able to leave the recorder without trapping focus.
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      const key = input.id === 'start-key' ? 'hotkeyStart' : 'hotkeyStop';
      renderShortcutInput(input, savedShortcuts[key]);
      shortcutMessage('Change canceled.');
      return;
    }
    const result = acceleratorFromKeyboardEvent(event);
    if (result.pending) {
      shortcutMessage('Keep holding the modifiers, then press a letter, number, arrow, navigation key, or function key.');
      return;
    }
    if (result.error) {
      shortcutMessage(result.error, true);
      return;
    }
    renderShortcutInput(input, result.accelerator);
    shortcutMessage('Shortcut captured. Save to apply it everywhere.');
  });
}

function setStatus(state) {
  const status = state.status || 'idle';
  $('status').dataset.status = status;
  $('status-copy').textContent = state.message || 'Ready';
  $('progress-bar').style.width = `${state.progress || 0}%`;
  typing = status === 'waiting' || status === 'typing';
  $('cancel').disabled = !typing;
  refreshTextMeta();
}

async function refreshPermission(prompt = false) {
  const trusted = prompt
    ? await window.dripType.requestAccessibility()
    : await window.dripType.getAccessibility();
  $('permission-card').classList.toggle('ready', trusted);
  const windows = currentPlatform === 'win32';
  $('permission-title').textContent = windows ? 'Windows typing ready' : trusted ? 'Accessibility enabled' : 'Accessibility needed';
  $('permission-copy').textContent = windows ? 'Zap is ready in every editable app.' : trusted ? 'Zap is ready.' : 'Click to enable typing access.';
  $('setup-permission-copy').textContent = trusted
    ? windows ? 'Ready. Windows can send local input to the focused app.' : 'Enabled. Zap can type into other applications.'
    : 'Required to type into other applications.';
  $('request-access').textContent = windows ? 'Ready' : trusted ? 'Permission enabled' : 'Open permission prompt';
  $('request-access').disabled = trusted;
  return trusted;
}

async function refreshPermissionChecklist() {
  const checklist = await window.dripType.getPermissionChecklist();
  const accessibilityState = $('accessibility-state');
  const automationState = $('automation-state');
  const shortcutState = $('shortcut-state');
  const windows = currentPlatform === 'win32';
  accessibilityState.textContent = windows ? 'Ready' : checklist.accessibility ? 'Allowed' : 'Required';
  accessibilityState.classList.toggle('ready', checklist.accessibility);
  automationState.textContent = windows ? 'Ready' : checklist.automation ? 'Allowed' : 'Required';
  automationState.classList.toggle('ready', checklist.automation);
  shortcutState.textContent = checklist.shortcuts ? 'Active' : 'Needs attention';
  shortcutState.classList.toggle('ready', checklist.shortcuts);
  $('automation-copy').textContent = checklist.automation
    ? windows ? 'Ready. The native Windows input engine stays on this device.' : 'Allowed. System Events is ready for secure local typing.'
    : 'Required so Zap can use macOS System Events.';
  $('request-automation').textContent = windows ? 'Ready' : checklist.automation ? 'Permission enabled' : 'Allow automation';
  $('request-automation').disabled = checklist.automation;
  return checklist;
}

function renderUpdate(state) {
  updateState = state || { status: 'idle' };
  const button = $('update-action');
  const copy = $('update-copy');
  const progress = $('update-progress');
  const release = $('update-release');
  const version = updateState.version ? ` ${updateState.version}` : '';

  $('update-card').dataset.updateStatus = updateState.status || 'idle';
  $('update-dot').hidden = !['available', 'downloaded'].includes(updateState.status);
  release.hidden = !updateState.releaseNotes;
  $('update-release-name').textContent = updateState.releaseName || 'What’s new';
  $('update-release-copy').textContent = updateState.releaseNotes || '';
  button.disabled = false;
  progress.hidden = true;
  progress.value = Number(updateState.percent || 0);

  if (updateState.status === 'checking') {
    copy.textContent = 'Checking the verified release channel…';
    button.textContent = 'Checking…';
    button.disabled = true;
  } else if (updateState.status === 'available') {
    copy.textContent = `Version${version} is verified and ready to download.`;
    button.textContent = 'Download update';
  } else if (updateState.status === 'downloading') {
    copy.textContent = `Downloading the verified update · ${Math.round(updateState.percent || 0)}%`;
    button.textContent = 'Downloading…';
    button.disabled = true;
    progress.hidden = false;
  } else if (updateState.status === 'downloaded') {
    copy.textContent = `Version${version} is verified and ready to install.`;
    button.textContent = 'Restart to update';
  } else if (updateState.status === 'current') {
    copy.textContent = 'You have the latest verified version.';
    button.textContent = 'Check again';
  } else if (updateState.status === 'error') {
    copy.textContent = updateState.message || 'The secure update check could not be completed.';
    button.textContent = 'Try again';
  } else if (updateState.status === 'development') {
    copy.textContent = 'Secure updates activate in packaged release builds.';
    button.textContent = 'Release builds only';
    button.disabled = true;
  } else {
    copy.textContent = 'Updates are verified and installed without replacing your settings.';
    button.textContent = 'Check for updates';
  }
}

async function runUpdateAction() {
  try {
    if (updateState.status === 'available') await window.dripType.downloadUpdate();
    else if (updateState.status === 'downloaded') window.dripType.installUpdate();
    else await window.dripType.checkForUpdates();
  } catch (error) {
    renderUpdate({ status: 'error', message: errorMessage(error, 'The update check failed. Try again.') });
  }
}

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => setPage(button.dataset.page));
});
Object.values(controls).forEach((control) => {
  control.addEventListener('input', () => {
    refreshValues();
    saveBehavior();
  });
  control.addEventListener('change', flushBehavior);
});
$('start-key').addEventListener('focus', () => shortcutMessage('Press the new key combination. Escape cancels.'));
$('stop-key').addEventListener('focus', () => shortcutMessage('Press the new key combination. Escape cancels.'));
captureShortcut($('start-key'));
captureShortcut($('stop-key'));
$('reset-shortcuts').addEventListener('click', () => {
  renderShortcutInput($('start-key'), 'Alt+5');
  renderShortcutInput($('stop-key'), 'Alt+0');
  shortcutMessage(`Defaults restored in the editor. Save to apply ${formatAccelerator('Alt+5', currentPlatform)} and ${formatAccelerator('Alt+0', currentPlatform)}.`);
});
$('text').addEventListener('input', refreshTextMeta);
$('permission-card').addEventListener('click', () => refreshPermission(true));
$('request-access').addEventListener('click', async () => {
  await refreshPermission(true);
  await refreshPermissionChecklist();
});
$('request-automation').addEventListener('click', async () => {
  await window.dripType.requestAutomation();
  await refreshPermissionChecklist();
});
$('open-shortcut-settings').addEventListener('click', () => setPage('shortcuts'));
$('preview-quick').addEventListener('click', () => window.dripType.showQuick());
$('toolbar-composer').addEventListener('click', () => window.dripType.showQuick());
$('launch-login').addEventListener('click', async () => {
  renderLaunchAtLogin(!launchAtLogin);
  await window.dripType.saveSettings({ launchAtLogin });
});
$('replay-onboarding').addEventListener('click', () => window.dripType.replayOnboarding());
$('update-action').addEventListener('click', runUpdateAction);
$('billing-subscribe').addEventListener('click', async () => {
  $('billing-subscribe').disabled = true;
  $('billing-note').textContent = 'Opening your secure account…';
  try {
    if (billingState.signedIn) await window.dripType.openAccount();
    else await window.dripType.signIn();
    $('billing-note').textContent = billingState.signedIn ? 'Account opened in your browser.' : 'Sign in at tryzap.net, then choose Connect app.';
  } catch (error) {
    $('billing-note').textContent = errorMessage(error, 'Sign-in could not be opened.');
  } finally { $('billing-subscribe').disabled = false; }
});
$('account-sign-out').addEventListener('click', async () => {
  $('account-sign-out').disabled = true;
  $('billing-subscribe').disabled = true;
  $('billing-note').textContent = 'Signing out…';
  try {
    const state = await window.dripType.signOut();
    renderBilling(state);
    $('billing-note').textContent = state.warning || 'Signed out of Zap on this device.';
  } catch { $('billing-note').textContent = 'Sign-out could not finish. Please try again.'; }
  finally { $('account-sign-out').disabled = false; $('billing-subscribe').disabled = false; }
});
window.dripType.onSignedOut(() => {
  $('text').value = '';
  refreshTextMeta();
  setPage('billing');
});
$('billing-refresh').addEventListener('click', async () => {
  $('billing-refresh').disabled = true;
  $('billing-note').textContent = 'Refreshing access…';
  try {
    const state = await window.dripType.refreshBilling();
    renderBilling(state);
    $('billing-note').textContent = state.status === 'active' ? 'Access refreshed.' : state.message || '';
  } catch (error) {
    $('billing-note').textContent = errorMessage(error, 'Access could not be refreshed.');
  } finally {
    $('billing-refresh').disabled = false;
  }
});
$('billing-manage').addEventListener('click', async () => {
  $('billing-manage').disabled = true;
  $('billing-note').textContent = 'Opening Stripe’s secure portal…';
  try {
    const result = await window.dripType.manageBilling();
    $('billing-note').textContent = result?.error || 'Billing portal opened in your browser.';
  } catch (error) {
    $('billing-note').textContent = errorMessage(error, 'Billing management could not be opened.');
  } finally {
    $('billing-manage').disabled = billingState.status !== 'active';
  }
});
document.querySelectorAll('.theme-option').forEach((button) => {
  button.addEventListener('click', async () => {
    applyTheme(button.dataset.themeValue);
    await window.dripType.saveSettings({ theme: button.dataset.themeValue });
  });
});

$('start').addEventListener('click', async () => {
  try {
    await flushBehavior();
    if (!await refreshPermission(false)) {
      setPage('setup');
      setStatus({ status: 'error', message: 'Enable Accessibility access before typing.' });
      return;
    }
    setStatus({ status: 'waiting', message: `Switch to the destination. Typing starts in ${controls.delay.value}s.` });
    const result = await window.dripType.start($('text').value);
    if (result?.code === 'SUBSCRIPTION_REQUIRED') {
      setPage('billing');
      renderBilling({ allowed: false, status: 'required', message: result.error });
    } else if (result?.error) setStatus({ status: 'error', message: result.error });
    else if (result?.fallback) setStatus({ status: 'complete', message: result.message });
  } catch (error) {
    setStatus({ status: 'error', message: errorMessage(error, 'Typing could not be started.') });
  }
});
$('cancel').addEventListener('click', () => window.dripType.cancel());

$('save-shortcuts').addEventListener('click', async () => {
  $('save-shortcuts').disabled = true;
  shortcutMessage('Checking shortcut availability…');
  try {
    const result = await window.dripType.saveSettings({
      hotkeyStart: $('start-key').dataset.accelerator,
      hotkeyStop: $('stop-key').dataset.accelerator
    });
    savedShortcuts = {
      hotkeyStart: result.settings.hotkeyStart,
      hotkeyStop: result.settings.hotkeyStop
    };
    renderShortcutInput($('start-key'), savedShortcuts.hotkeyStart);
    renderShortcutInput($('stop-key'), savedShortcuts.hotkeyStop);
    renderCurrentShortcuts();
    shortcutMessage(result.shortcutFailures?.length
      ? result.shortcutFailures.join(' ')
      : `${formatAccelerator(savedShortcuts.hotkeyStart, currentPlatform)} opens Drip Type; ${formatAccelerator(savedShortcuts.hotkeyStop, currentPlatform)} stops typing.`,
    Boolean(result.shortcutFailures?.length));
    await refreshPermissionChecklist();
  } catch (error) {
    shortcutMessage(errorMessage(error, 'The shortcuts could not be saved.'), true);
  } finally {
    $('save-shortcuts').disabled = false;
  }
});

window.dripType.onState(setStatus);
window.dripType.onUpdate(renderUpdate);
window.dripType.onBilling(renderBilling);
window.dripType.onNavigate(({ page, focus } = {}) => {
  if (page) setPage(page);
  if (focus === 'updates') {
    $('update-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('update-action').focus({ preventScroll: true });
  }
  if (focus === 'zap-input') $('zap-input').focus();
});

initZap({ sendToComposer, getComposerText: () => $('text').value });

async function load() {
  const [settings, info, updater, subscription] = await Promise.all([
    window.dripType.getSettings(),
    window.dripType.getAppInfo(),
    window.dripType.getUpdateState(),
    window.dripType.getBillingState()
  ]);
  currentPlatform = info.platform;
  applyTypingControls(settings);
  savedShortcuts = { hotkeyStart: settings.hotkeyStart, hotkeyStop: settings.hotkeyStop };
  renderShortcutInput($('start-key'), savedShortcuts.hotkeyStart);
  renderShortcutInput($('stop-key'), savedShortcuts.hotkeyStop);
  renderCurrentShortcuts();
  renderLaunchAtLogin(settings.launchAtLogin);
  applyTheme(settings.theme);
  $('brand-version').textContent = `Version ${info.version}`;
  $('about-version').textContent = info.version;
  $('about-id').textContent = info.appId;
  document.documentElement.dataset.platform = currentPlatform;
  if (currentPlatform === 'win32') {
    $('setup-lead').textContent = 'Zap uses the native Windows input engine to send keystrokes. Your text and settings stay on this device.';
    $('accessibility-label').textContent = 'Windows input engine';
    $('automation-label').textContent = 'Private local typing';
    $('appearance-copy').textContent = 'Match Windows automatically or choose a permanent theme.';
    $('typing-engine').textContent = 'Windows SendInput';
    $('billing-security-title').textContent = 'Windows protected';
    $('billing-security-copy').textContent = 'The private activation credential is encrypted with Windows DPAPI.';
  }
  refreshValues();
  refreshPermission(false);
  refreshPermissionChecklist();
  renderUpdate(updater);
  renderBilling(subscription);
}

function reportActionError() {
  $('app-alert').hidden = false;
  $('app-alert').textContent = 'That change could not be completed. Please try again. If the problem continues, reopen Zap. Your existing saved data has been preserved.';
}
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  reportActionError();
});
load().catch((error) => {
  setStatus({ status: 'error', message: errorMessage(error, 'Zap settings could not be loaded.') });
  $('permission-copy').textContent = 'Setup status could not be loaded. Reopen Zap and try again.';
});
