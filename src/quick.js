const text = document.getElementById('text');
const submit = document.getElementById('submit');
const clear = document.getElementById('clear');
const state = document.getElementById('state');
const privateDraftMessage = 'Private draft · stored in memory only';

function applyTheme(preference = 'system') {
  const resolved = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : preference;
  document.documentElement.dataset.theme = resolved;
}

function refresh() {
  const characters = [...text.value].length;
  const words = text.value.trim() ? text.value.trim().split(/\s+/).length : 0;
  document.getElementById('meta').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${characters} ${characters === 1 ? 'character' : 'characters'}`;
  const empty = !text.value.trim();
  submit.disabled = empty;
  clear.disabled = !text.value;
}

function insertText(value) {
  if (!value) {
    state.textContent = 'Clipboard has no text';
    return;
  }
  const start = text.selectionStart;
  const end = text.selectionEnd;
  const available = Math.max(0, 100000 - ([...text.value].length - [...text.value.slice(start, end)].length));
  const inserted = [...value].slice(0, available).join('');
  text.setRangeText(inserted, start, end, 'end');
  state.textContent = inserted ? 'Pasted from clipboard · kept local' : 'Composer limit reached';
  refresh();
  text.focus();
}

async function start() {
  if (!text.value.trim()) return;
  submit.disabled = true;
  state.textContent = 'Returning to target…';
  const result = await window.dripType.start(text.value);
  if (result?.error) {
    state.textContent = result.error;
    submit.disabled = false;
  } else {
    text.value = '';
    state.textContent = privateDraftMessage;
    refresh();
  }
}

text.addEventListener('input', refresh);
submit.addEventListener('click', start);
document.getElementById('paste').addEventListener('click', async () => insertText(await window.dripType.readClipboardText()));
clear.addEventListener('click', () => {
  text.value = '';
  state.textContent = privateDraftMessage;
  refresh();
  text.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.dripType.closeQuick();
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    start();
  }
});

window.dripType.onQuickOpened((data) => {
  const delay = data.settings?.dripDelay ?? 3;
  applyTheme(data.settings?.theme);
  document.getElementById('target').textContent = data.targetName || 'previous app';
  submit.textContent = delay ? `Drip after ${delay}s` : 'Drip now';
  state.textContent = privateDraftMessage;
  refresh();
  setTimeout(() => text.focus(), 30);
});
window.dripType.onTheme(({ theme }) => applyTheme(theme));
window.dripType.onState((data) => {
  if (data.status === 'error') state.textContent = data.message;
});
