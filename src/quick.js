const text = document.getElementById('text');
const submit = document.getElementById('submit');
const state = document.getElementById('state');

function applyTheme(preference = 'system') {
  const resolved = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : preference;
  document.documentElement.dataset.theme = resolved;
}

function refresh() {
  const count = [...text.value].length;
  document.getElementById('meta').textContent = `${count} ${count === 1 ? 'character' : 'characters'}`;
  submit.disabled = !text.value.trim();
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
    refresh();
  }
}

text.addEventListener('input', refresh);
submit.addEventListener('click', start);
document.getElementById('cancel').addEventListener('click', () => window.dripType.closeQuick());
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
  submit.textContent = `Type after ${delay}s`;
  state.textContent = '';
  setTimeout(() => text.focus(), 30);
});
window.dripType.onTheme(({ theme }) => applyTheme(theme));
window.dripType.onState((data) => {
  if (data.status === 'error') state.textContent = data.message;
});
