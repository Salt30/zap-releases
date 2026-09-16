const { hasUnresolvedVariables } = require('./text-tools');
const { createAppearance } = require('./appearance');
const applyTheme = createAppearance();

const text = document.getElementById('text');
const submit = document.getElementById('submit');
const state = document.getElementById('state');
const focusHint = document.getElementById('focus-hint');
const privateDraftMessage = 'Private draft · kept in memory only';
let quickFullScreen = false;
let starting = false;

function renderFullScreenState(value) {
  quickFullScreen = Boolean(value);
  document.documentElement.dataset.fullScreen = String(quickFullScreen);
  const button = document.getElementById('toggle-full-screen');
  button.textContent = quickFullScreen ? '↙' : '⛶';
  button.title = quickFullScreen ? 'Exit full screen (⌃⌘F)' : 'Enter full screen (⌃⌘F)';
  button.setAttribute('aria-label', quickFullScreen ? 'Exit full screen' : 'Enter full screen');
}

function refresh() {
  submit.disabled = !text.value.trim();
}

async function start() {
  if (starting || !text.value.trim()) return;
  if (hasUnresolvedVariables(text.value)) {
    state.textContent = 'Replace every {{field}} before typing';
    return;
  }
  starting = true;
  submit.disabled = true;
  state.textContent = 'Hiding Zap. Click the destination field.';
  try {
    const result = await window.dripType.start(text.value);
    if (result?.error) {
      state.textContent = result.error;
      submit.disabled = false;
      return;
    }
    if (result?.cancelled) {
      state.textContent = 'Stopped. Your draft is kept here; check what already typed before restarting.';
      return;
    }
    text.value = '';
    state.textContent = privateDraftMessage;
    refresh();
  } catch (error) {
    state.textContent = error?.message || 'Typing could not be started. Try again.';
    submit.disabled = false;
  } finally {
    starting = false;
    refresh();
  }
}

async function toggleFullScreen() {
  try {
    const result = await window.dripType.toggleQuickFullScreen();
    renderFullScreenState(result?.fullScreen);
  } catch {
    state.textContent = 'Full screen could not be changed.';
  }
}

function close() {
  if (quickFullScreen) toggleFullScreen();
  else window.dripType.closeQuick();
}

text.addEventListener('input', refresh);
submit.addEventListener('click', start);
document.getElementById('toggle-full-screen').addEventListener('click', toggleFullScreen);
document.getElementById('close').addEventListener('click', close);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    start();
  }
});

window.dripType.onQuickOpened((data) => {
  const delay = data.settings?.dripDelay ?? 10;
  applyTheme(data.settings?.theme);
  focusHint.textContent = delay
    ? `Window hides. Click the destination field within ${delay} seconds.`
    : 'Window hides, then typing starts immediately.';
  submit.textContent = delay ? `Start · ${delay}s` : 'Start typing';
  state.textContent = privateDraftMessage;
  refresh();
  setTimeout(() => text.focus(), 30);
});
window.dripType.onQuickFullScreen(renderFullScreenState);
window.dripType.onState((data) => {
  if (data.status === 'error') state.textContent = data.message;
});
