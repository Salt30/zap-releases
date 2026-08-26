const slides = [...document.querySelectorAll('.slide')];
const dots = [...document.querySelectorAll('.step-dot')];
const wpm = document.getElementById('wpm');
const delay = document.getElementById('delay');
const typo = document.getElementById('typo');
const pause = document.getElementById('pause');
const burst = document.getElementById('burst');
let index = 0;
let demoTimer = null;
let permissionTimer = null;
let permissionsReady = false;
let currentPlatform = 'darwin';

function applyTheme(preference = 'system') {
  const resolved = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : preference;
  document.documentElement.dataset.theme = resolved;
}

function render() {
  slides.forEach((slide, slideIndex) => slide.classList.toggle('active', slideIndex === index));
  dots.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex === index));
  document.getElementById('back').classList.toggle('hidden', index === 0);
  document.getElementById('next').textContent = index === slides.length - 1 ? 'Open Drip Type' : 'Continue';
  document.getElementById('next').disabled = index === slides.length - 1 && !permissionsReady;
  clearInterval(permissionTimer);
  if (index === slides.length - 1) {
    refreshPermissionChecklist();
    permissionTimer = setInterval(refreshPermissionChecklist, 1500);
  }
}

function values() {
  document.getElementById('wpm-value').textContent = `${wpm.value} WPM`;
  document.getElementById('delay-value').textContent = `${delay.value} ${delay.value === '1' ? 'second' : 'seconds'}`;
  document.getElementById('typo-value').textContent = `${Math.round(typo.value * 100)}%`;
  document.getElementById('pause-value').textContent = `${Math.round(pause.value * 100)}%`;
  document.getElementById('burst-value').textContent = `${Math.round(burst.value * 100)}%`;
}

async function refreshPermissionChecklist() {
  let permissions;
  try {
    permissions = await window.dripType.getPermissionChecklist();
  } catch (error) {
    permissionsReady = false;
    document.getElementById('permission-status').textContent = error?.message || 'Permission status could not be checked. Try again.';
    document.getElementById('next').disabled = index === slides.length - 1;
    return { accessibility: false, automation: false };
  }
  const rows = [
    ['access', permissions.accessibility],
    ['automation', permissions.automation]
  ];
  rows.forEach(([name, ready]) => {
    document.getElementById(`${name}-row`).classList.toggle('ready', ready);
    document.getElementById(`${name}-state`).textContent = currentPlatform === 'win32' && ready ? 'Ready' : ready ? 'Allowed' : 'Required';
    const button = document.getElementById(name === 'access' ? 'enable-access' : 'enable-automation');
    button.textContent = currentPlatform === 'win32' && ready ? 'Ready' : ready ? 'Allowed' : 'Allow';
    button.disabled = ready;
  });
  permissionsReady = permissions.accessibility && permissions.automation;
  document.getElementById('permission-status').textContent = permissionsReady
    ? currentPlatform === 'win32' ? 'Windows is ready. Drip Type can type into the focused app.' : 'Checklist complete. Drip Type is ready.'
    : 'Complete both required items to continue.';
  document.getElementById('next').disabled = index === slides.length - 1 && !permissionsReady;
  return permissions;
}

document.getElementById('back').addEventListener('click', () => {
  index = Math.max(0, index - 1);
  render();
});
document.getElementById('next').addEventListener('click', async () => {
  if (index < slides.length - 1) {
    index += 1;
    render();
    if (index === 3) refreshPermissionChecklist();
  } else {
    try {
      const result = await window.dripType.completeOnboarding({
        dripWPM: Number(wpm.value),
        dripDelay: Number(delay.value),
        typoRate: Number(typo.value),
        dripPauseChance: Number(pause.value),
        dripBurstChance: Number(burst.value)
      });
      if (result?.success) return;
      permissionsReady = false;
      document.getElementById('permission-status').textContent = `Still required: ${(result?.missing || []).join(' and ')}.`;
      render();
    } catch (error) {
      permissionsReady = false;
      document.getElementById('permission-status').textContent = error?.message || 'Setup could not be completed. Try again.';
      render();
    }
  }
});
document.getElementById('run-demo').addEventListener('click', () => {
  clearInterval(demoTimer);
  const sample = 'A thoughtfully written message feels clear, calm, and human.';
  const output = document.getElementById('demo-output');
  output.textContent = '';
  let character = 0;
  demoTimer = setInterval(() => {
    output.textContent += sample[character++] || '';
    if (character >= sample.length) clearInterval(demoTimer);
  }, 42);
});
[wpm, delay, typo, pause, burst].forEach((control) => control.addEventListener('input', values));
document.getElementById('enable-access').addEventListener('click', async () => {
  try {
    await window.dripType.requestAccessibility();
  } catch (error) {
    document.getElementById('permission-status').textContent = error?.message || 'Accessibility settings could not be opened.';
  }
  await refreshPermissionChecklist();
});
document.getElementById('enable-automation').addEventListener('click', async () => {
  try {
    await window.dripType.requestAutomation();
  } catch (error) {
    document.getElementById('permission-status').textContent = error?.message || 'Automation permission could not be requested.';
  }
  await refreshPermissionChecklist();
});
window.dripType.onTheme(({ theme }) => applyTheme(theme));

async function load() {
  const [settings, info] = await Promise.all([
    window.dripType.getSettings(),
    window.dripType.getAppInfo()
  ]);
  currentPlatform = info.platform;
  applyTheme(settings.theme);
  if (currentPlatform === 'win32') {
    document.documentElement.dataset.platform = 'win32';
    document.getElementById('welcome-lead').textContent = 'Drip Type turns prepared text into natural keystrokes in any Windows app. Everything runs locally, and you stay in control.';
    document.getElementById('welcome-hotkey').textContent = 'Alt+5';
    document.getElementById('demo-hotkey').textContent = 'Alt+5';
    document.getElementById('permission-eyebrow').textContent = 'Windows readiness';
    document.getElementById('permission-heading').textContent = 'No extra permissions needed.';
    document.getElementById('permission-lead').textContent = 'The native Windows input engine and global shortcuts are included and ready on this device.';
    document.getElementById('access-title').textContent = 'Windows input engine';
    document.getElementById('access-desc').textContent = 'Sends local Unicode keystrokes to the app you choose.';
    document.getElementById('automation-title').textContent = 'Private local operation';
    document.getElementById('automation-desc').textContent = 'Your composer text and typing plan stay on this device.';
  }
  render();
  values();
}

load().catch((error) => {
  document.getElementById('permission-status').textContent = error?.message || 'Setup could not be loaded. Reopen Drip Type and try again.';
});
