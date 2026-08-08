const $ = (id) => document.getElementById(id);
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
let themePreference = 'system';
let launchAtLogin = true;

function applyTheme(preference = 'system') {
  themePreference = ['system', 'light', 'dark'].includes(preference) ? preference : 'system';
  const resolved = themePreference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : themePreference;
  document.documentElement.dataset.theme = resolved;
  document.querySelectorAll('.theme-option').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeValue === themePreference);
    button.setAttribute('aria-pressed', String(button.dataset.themeValue === themePreference));
  });
}

function setPage(name) {
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === name);
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
    ? 'Starts quietly in the menu bar so the global composer shortcut is always available.'
    : 'Drip Type must be opened manually before its global shortcuts can work.';
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
  $('start').disabled = typing || !text.trim();
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
  saveTimer = setTimeout(() => window.dripType.saveSettings(currentBehavior()), 180);
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
  $('permission-title').textContent = trusted ? 'Accessibility enabled' : 'Accessibility needed';
  $('permission-copy').textContent = trusted ? 'Drip Type is ready.' : 'Click to enable typing access.';
  $('setup-permission-copy').textContent = trusted
    ? 'Enabled. Drip Type can type into other applications.'
    : 'Required to type into other applications.';
  $('request-access').textContent = trusted ? 'Permission enabled' : 'Open permission prompt';
  $('request-access').disabled = trusted;
  return trusted;
}

async function refreshPermissionChecklist() {
  const checklist = await window.dripType.getPermissionChecklist();
  const accessibilityState = $('accessibility-state');
  const automationState = $('automation-state');
  accessibilityState.textContent = checklist.accessibility ? 'Allowed' : 'Required';
  accessibilityState.classList.toggle('ready', checklist.accessibility);
  automationState.textContent = checklist.automation ? 'Allowed' : 'Required';
  automationState.classList.toggle('ready', checklist.automation);
  $('automation-copy').textContent = checklist.automation
    ? 'Allowed. System Events is ready for secure local typing.'
    : 'Required so Drip Type can use macOS System Events.';
  $('request-automation').textContent = checklist.automation ? 'Permission enabled' : 'Allow automation';
  $('request-automation').disabled = checklist.automation;
  return checklist;
}

function renderUpdate(state) {
  updateState = state || { status: 'idle' };
  const button = $('update-action');
  const copy = $('update-copy');
  const progress = $('update-progress');
  const version = updateState.version ? ` ${updateState.version}` : '';

  button.disabled = false;
  progress.hidden = true;
  progress.value = Number(updateState.percent || 0);

  if (updateState.status === 'checking') {
    copy.textContent = 'Checking the signed release channel…';
    button.textContent = 'Checking…';
    button.disabled = true;
  } else if (updateState.status === 'available') {
    copy.textContent = `Version${version} is signed and ready to download.`;
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
    copy.textContent = 'You have the latest signed version.';
    button.textContent = 'Check again';
  } else if (updateState.status === 'error') {
    copy.textContent = updateState.message || 'The secure update check could not be completed.';
    button.textContent = 'Try again';
  } else if (updateState.status === 'development') {
    copy.textContent = 'Secure updates activate in signed release builds.';
    button.textContent = 'Release builds only';
    button.disabled = true;
  } else {
    copy.textContent = 'Updates are signed, verified, and installed without replacing your settings.';
    button.textContent = 'Check for updates';
  }
}

async function runUpdateAction() {
  if (updateState.status === 'available') await window.dripType.downloadUpdate();
  else if (updateState.status === 'downloaded') window.dripType.installUpdate();
  else await window.dripType.checkForUpdates();
}

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => setPage(button.dataset.page));
});
Object.values(controls).forEach((control) => {
  control.addEventListener('input', () => {
    refreshValues();
    saveBehavior();
  });
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
$('preview-quick').addEventListener('click', () => window.dripType.showQuick());
$('launch-login').addEventListener('click', async () => {
  renderLaunchAtLogin(!launchAtLogin);
  await window.dripType.saveSettings({ launchAtLogin });
});
$('replay-onboarding').addEventListener('click', () => window.dripType.replayOnboarding());
$('update-action').addEventListener('click', runUpdateAction);
document.querySelectorAll('.theme-option').forEach((button) => {
  button.addEventListener('click', async () => {
    applyTheme(button.dataset.themeValue);
    await window.dripType.saveSettings({ theme: themePreference });
  });
});
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (themePreference === 'system') applyTheme('system');
});

$('start').addEventListener('click', async () => {
  if (!await refreshPermission(false)) {
    setPage('setup');
    setStatus({ status: 'error', message: 'Enable Accessibility access before typing.' });
    return;
  }
  setStatus({ status: 'waiting', message: `Switch to the destination. Typing starts in ${controls.delay.value}s.` });
  const result = await window.dripType.start($('text').value);
  if (result?.error) setStatus({ status: 'error', message: result.error });
  else if (result?.fallback) setStatus({ status: 'complete', message: result.message });
});
$('cancel').addEventListener('click', () => window.dripType.cancel());

document.querySelectorAll('.preset').forEach((button) => {
  button.addEventListener('click', () => {
    const presets = {
      steady: { wpm: 55, delay: 3, typos: 0, pauses: 0.01, bursts: 0.03 },
      natural: { wpm: 45, delay: 3, typos: 0.03, pauses: 0.03, bursts: 0.08 },
      expressive: { wpm: 38, delay: 4, typos: 0.05, pauses: 0.06, bursts: 0.15 }
    };
    const preset = presets[button.dataset.preset];
    Object.entries(preset).forEach(([key, value]) => { controls[key].value = value; });
    refreshValues();
    saveBehavior();
  });
});

$('save-shortcuts').addEventListener('click', async () => {
  const result = await window.dripType.saveSettings({
    hotkeyStart: $('start-key').value.trim(),
    hotkeyStop: $('stop-key').value.trim()
  });
  $('shortcut-note').textContent = result.shortcutFailures?.length
    ? `Could not register: ${result.shortcutFailures.join(', ')}`
    : 'Saved';
  setTimeout(() => { $('shortcut-note').textContent = ''; }, 2500);
});

window.dripType.onState(setStatus);
window.dripType.onUpdate(renderUpdate);
window.dripType.onTheme(({ theme }) => applyTheme(theme));

async function load() {
  const [settings, info, updater] = await Promise.all([
    window.dripType.getSettings(),
    window.dripType.getAppInfo(),
    window.dripType.getUpdateState()
  ]);
  controls.wpm.value = settings.dripWPM;
  controls.delay.value = settings.dripDelay;
  controls.typos.value = settings.typoRate;
  controls.pauses.value = settings.dripPauseChance;
  controls.bursts.value = settings.dripBurstChance;
  $('start-key').value = settings.hotkeyStart;
  $('stop-key').value = settings.hotkeyStop;
  renderLaunchAtLogin(settings.launchAtLogin);
  applyTheme(settings.theme);
  $('brand-version').textContent = `Version ${info.version}`;
  $('about-version').textContent = info.version;
  $('about-id').textContent = info.appId;
  refreshValues();
  refreshPermission(false);
  refreshPermissionChecklist();
  renderUpdate(updater);
}

load();
