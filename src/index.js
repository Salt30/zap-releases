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
let templates = [];
let editingTemplateId = null;
let billingState = { allowed: true, status: 'checking', plan: 'core' };
let profiles = [];
let activeProfileId = null;

function hasFeature(feature) {
  return Array.isArray(billingState.features) && billingState.features.includes(feature);
}

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
  const button = document.querySelector(`.nav-button[data-page="${name}"]`);
  if (button?.dataset.feature && !hasFeature(button.dataset.feature)) {
    document.querySelectorAll('.nav-button').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
    return;
  }
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

function clearTemplateEditor() {
  editingTemplateId = null;
  $('template-name').value = '';
  $('template-body').value = '';
  $('save-template').textContent = 'Save template';
  $('cancel-template').hidden = true;
}

function editTemplate(template) {
  editingTemplateId = template.id;
  $('template-name').value = template.name;
  $('template-body').value = template.body;
  $('save-template').textContent = 'Update template';
  $('cancel-template').hidden = false;
  $('template-name').focus();
}

function renderTemplates(nextTemplates = []) {
  templates = Array.isArray(nextTemplates) ? nextTemplates : [];
  const list = $('template-list');
  list.replaceChildren();
  if (!templates.length) {
    const empty = document.createElement('div');
    empty.className = 'template-empty';
    empty.textContent = 'No templates yet. Create one above and it will appear in Drip Composer.';
    list.appendChild(empty);
    return;
  }
  for (const template of templates) {
    const item = document.createElement('article');
    item.className = 'template-item';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = template.category ? `${template.name} · ${template.category}` : template.name;
    const preview = document.createElement('p');
    preview.textContent = template.body.replace(/\s+/g, ' ').trim();
    copy.append(title, preview);
    const actions = document.createElement('div');
    actions.className = 'template-item-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => editTemplate(template));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${template.name}”?`)) return;
      const result = await window.dripType.deleteTemplate(template.id);
      renderTemplates(result.templates);
      if (editingTemplateId === template.id) clearTemplateEditor();
      $('template-note').textContent = result.error || 'Deleted';
      setTimeout(() => { $('template-note').textContent = ''; }, 2200);
    });
    actions.append(edit, remove);
    item.append(copy, actions);
    list.appendChild(item);
  }
  renderBatchTemplatePicker();
}

function renderBatchTemplatePicker() {
  const picker = $('batch-template');
  if (!picker) return;
  const previous = picker.value;
  picker.replaceChildren();
  for (const template of templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name;
    picker.appendChild(option);
  }
  if (templates.some((template) => template.id === previous)) picker.value = previous;
}

async function saveTemplate() {
  const name = $('template-name').value.trim();
  const body = $('template-body').value.replace(/\r\n?/g, '\n');
  if (!name || !body.trim()) {
    $('template-note').textContent = 'Add a name and template body.';
    return;
  }
  $('save-template').disabled = true;
  const result = await window.dripType.saveTemplate({ id: editingTemplateId, name, body });
  $('save-template').disabled = false;
  renderTemplates(result.templates);
  $('template-note').textContent = result.error || (editingTemplateId ? 'Updated' : 'Saved');
  if (!result.error) clearTemplateEditor();
  setTimeout(() => { $('template-note').textContent = ''; }, 2200);
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
  const trial = status === 'trial';
  const planName = billingState.plan === 'pro' ? 'Pro' : 'Core';

  $('billing-status').dataset.state = status;
  $('billing-status').textContent = active ? 'Subscription active' : trial ? 'Free trial active' : 'Subscription required';
  $('billing-plan').textContent = active ? `Drip Type ${planName}` : trial ? 'Drip Type Core trial' : 'Continue with Core';
  $('billing-copy').textContent = billingState.message || (active
    ? 'This Mac is activated and ready to use.'
    : trial
      ? 'All Core features are available during your trial.'
      : 'Choose Core to keep using Drip Composer and natural typing.');

  const expiry = active ? readableDate(billingState.expiresAt) : readableDate(billingState.trialEndsAt);
  $('billing-expiry').textContent = expiry
    ? active ? `Access verified through ${expiry}. It refreshes automatically.` : `Trial ends ${expiry}.`
    : '';
  $('billing-manage').disabled = !active;
  $('billing-subscribe').textContent = active ? (billingState.plan === 'pro' ? 'View plans' : 'Upgrade to Pro') : 'Choose a plan';
  renderProAccess();
  refreshTextMeta();
}

function renderProAccess() {
  const pro = billingState.status === 'active' && billingState.plan === 'pro';
  document.querySelectorAll('.nav-button[data-feature]').forEach((button) => {
    button.classList.toggle('locked', !hasFeature(button.dataset.feature));
  });
  document.querySelectorAll('[data-pro-lock]').forEach((element) => { element.hidden = pro; });
  document.querySelectorAll('[data-pro-content]').forEach((element) => element.setAttribute('aria-disabled', String(!pro)));
  $('install-library').disabled = !hasFeature('template_library');
  $('install-library').textContent = hasFeature('template_library') ? 'Install Pro library' : 'Pro library';
}

function sendToComposer(value) {
  $('text').value = String(value || '').slice(0, 100000);
  refreshTextMeta();
  setPage('composer');
  $('text').focus();
}

async function runBatch() {
  const template = templates.find((item) => item.id === $('batch-template').value);
  if (!template) { $('batch-note').textContent = 'Choose a template first.'; return; }
  const result = await window.dripType.renderBatch(template.body, $('batch-data').value);
  if (result?.code === 'PRO_REQUIRED') { $('batch-note').textContent = result.error; return; }
  $('batch-note').textContent = result.errors?.length ? result.errors.join(' ') : `Generated ${result.outputs.length} messages locally.`;
  const list = $('batch-results');
  list.replaceChildren();
  for (const output of result.outputs || []) {
    const item = document.createElement('article'); item.className = 'result-item';
    const head = document.createElement('div'); head.className = 'item-head';
    const title = document.createElement('strong'); title.textContent = `Row ${output.index}`;
    const actions = document.createElement('div'); actions.className = 'row';
    const copy = document.createElement('button'); copy.className = 'mini'; copy.textContent = 'Copy'; copy.addEventListener('click', () => window.dripType.writeClipboardText(output.text));
    const compose = document.createElement('button'); compose.className = 'mini'; compose.textContent = 'Compose'; compose.addEventListener('click', () => sendToComposer(output.text));
    actions.append(copy, compose); head.append(title, actions);
    const pre = document.createElement('pre'); pre.textContent = output.text;
    item.append(head, pre); list.appendChild(item);
  }
}

async function runTransform() {
  const result = await window.dripType.transformWriting($('transform-input').value, $('transform-mode').value);
  if (result?.error) { $('transform-note').textContent = result.error; return; }
  $('transform-output').value = result.text;
  $('transform-note').textContent = 'Transformed locally. No network service was used.';
}

function renderProfiles(result = {}) {
  profiles = Array.isArray(result.profiles) ? result.profiles : [];
  activeProfileId = result.activeProfileId || activeProfileId;
  const list = $('profile-list'); list.replaceChildren();
  for (const profile of profiles) {
    const item = document.createElement('article'); item.className = 'profile-item';
    const head = document.createElement('div'); head.className = 'item-head';
    const title = document.createElement('strong'); title.textContent = `${profile.name}${profile.id === activeProfileId ? ' · Active' : ''}`;
    const actions = document.createElement('div'); actions.className = 'row';
    const activate = document.createElement('button'); activate.className = 'mini'; activate.textContent = 'Activate'; activate.disabled = profile.id === activeProfileId;
    activate.addEventListener('click', async () => { const next = await window.dripType.activateProfile(profile.id); renderProfiles(next); if (next.profile) applyProfileControls(next.profile); });
    const remove = document.createElement('button'); remove.className = 'mini'; remove.textContent = 'Delete'; remove.addEventListener('click', async () => renderProfiles(await window.dripType.deleteProfile(profile.id)));
    actions.append(activate, remove); head.append(title, actions);
    const detail = document.createElement('div'); detail.className = 'pro-note'; detail.textContent = `${profile.dripWPM} WPM · ${profile.dripDelay}s delay · ${Math.round(profile.typoRate * 100)}% corrected typos`;
    item.append(head, detail); list.appendChild(item);
  }
}

function applyProfileControls(profile) {
  controls.wpm.value = profile.dripWPM; controls.delay.value = profile.dripDelay;
  controls.typos.value = profile.typoRate; controls.pauses.value = profile.dripPauseChance; controls.bursts.value = profile.dripBurstChance;
  refreshValues();
}

async function renderClipboard(query = '') {
  const result = await window.dripType.listClipboardItems(query);
  const list = $('clipboard-list'); list.replaceChildren();
  if (result?.error) { $('clipboard-note').textContent = result.error; return; }
  for (const clip of result.items || []) {
    const item = document.createElement('article'); item.className = 'clipboard-item';
    const head = document.createElement('div'); head.className = 'item-head';
    const title = document.createElement('strong'); title.textContent = `${clip.pinned ? 'Pinned · ' : ''}${new Date(clip.createdAt).toLocaleString()}`;
    const actions = document.createElement('div'); actions.className = 'row';
    for (const [label, action] of [['Copy', 'copy'], [clip.pinned ? 'Unpin' : 'Pin', 'pin'], ['Delete', 'delete']]) {
      const button = document.createElement('button'); button.className = 'mini'; button.textContent = label;
      button.addEventListener('click', async () => {
        if (action === 'copy') await window.dripType.writeClipboardText(clip.text);
        else { const next = await window.dripType.updateClipboardItem(clip.id, action); if (!next.error) renderClipboard($('clipboard-search').value); }
      }); actions.appendChild(button);
    }
    const compose = document.createElement('button'); compose.className = 'mini'; compose.textContent = 'Compose'; compose.addEventListener('click', () => sendToComposer(clip.text)); actions.appendChild(compose);
    head.append(title, actions); const copy = document.createElement('p'); copy.textContent = clip.text;
    item.append(head, copy); list.appendChild(item);
  }
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
$('billing-subscribe').addEventListener('click', async () => {
  $('billing-note').textContent = 'Opening secure checkout…';
  await window.dripType.subscribe();
  $('billing-note').textContent = 'Complete checkout in your browser, then return here.';
});
$('billing-refresh').addEventListener('click', async () => {
  $('billing-refresh').disabled = true;
  $('billing-note').textContent = 'Refreshing access…';
  const state = await window.dripType.refreshBilling();
  renderBilling(state);
  $('billing-refresh').disabled = false;
  $('billing-note').textContent = state.status === 'active' ? 'Access refreshed.' : state.message || '';
});
$('billing-manage').addEventListener('click', async () => {
  $('billing-manage').disabled = true;
  $('billing-note').textContent = 'Opening Stripe’s secure portal…';
  const result = await window.dripType.manageBilling();
  $('billing-manage').disabled = billingState.status !== 'active';
  $('billing-note').textContent = result?.error || 'Billing portal opened in your browser.';
});
$('save-template').addEventListener('click', saveTemplate);
$('cancel-template').addEventListener('click', clearTemplateEditor);
$('install-library').addEventListener('click', async () => {
  const result = await window.dripType.installTemplateLibrary();
  renderTemplates(result.templates || templates);
  $('template-note').textContent = result.error || `${result.installed} Pro templates installed.`;
});
$('batch-run').addEventListener('click', runBatch);
$('transform-run').addEventListener('click', runTransform);
$('transform-copy').addEventListener('click', async () => {
  const result = await window.dripType.writeClipboardText($('transform-output').value);
  $('transform-note').textContent = result.error || 'Copied.';
});
$('transform-compose').addEventListener('click', () => sendToComposer($('transform-output').value));
$('profile-save').addEventListener('click', async () => {
  const result = await window.dripType.saveProfile({ name: $('profile-name').value.trim(), ...currentBehavior() });
  renderProfiles(result);
  $('profile-note').textContent = result.error || 'Profile saved.';
  if (!result.error) $('profile-name').value = '';
});
$('clipboard-capture').addEventListener('click', async () => {
  const result = await window.dripType.captureClipboardItem();
  $('clipboard-note').textContent = result.error || 'Clipboard text saved locally.';
  if (!result.error) renderClipboard($('clipboard-search').value);
});
$('clipboard-search').addEventListener('input', () => renderClipboard($('clipboard-search').value));
document.querySelectorAll('[data-upgrade]').forEach((button) => button.addEventListener('click', async () => {
  $('billing-note').textContent = 'Opening secure plan selection…';
  await window.dripType.subscribe();
}));
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
  if (result?.code === 'SUBSCRIPTION_REQUIRED') {
    setPage('billing');
    renderBilling({ allowed: false, status: 'required', message: result.error });
  } else if (result?.error) setStatus({ status: 'error', message: result.error });
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
window.dripType.onBilling(renderBilling);
window.dripType.onTheme(({ theme }) => applyTheme(theme));
window.dripType.onNavigate(({ page, focus } = {}) => {
  if (page) setPage(page);
  if (focus === 'updates') {
    $('update-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('update-action').focus({ preventScroll: true });
  }
});

async function load() {
  const [settings, info, updater, savedTemplates, subscription, savedProfiles] = await Promise.all([
    window.dripType.getSettings(),
    window.dripType.getAppInfo(),
    window.dripType.getUpdateState(),
    window.dripType.listTemplates(),
    window.dripType.getBillingState(),
    window.dripType.listProfiles()
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
  renderTemplates(savedTemplates);
  renderBilling(subscription);
  renderProfiles(savedProfiles);
  if (subscription.plan === 'pro') renderClipboard();
}

load();
