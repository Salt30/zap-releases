const {
  cleanSpacing,
  fillTemplate,
  hasUnresolvedVariables,
  toggleBulletsText,
  variableNames
} = require('./text-tools');

const text = document.getElementById('text');
const submit = document.getElementById('submit');
const clear = document.getElementById('clear');
const state = document.getElementById('state');
const privateDraftMessage = 'Private draft · stored in memory only';
const templatePicker = document.getElementById('template-picker');
const templateDialog = document.getElementById('template-dialog');
const variableFields = document.getElementById('variable-fields');
let templates = [];
let pendingTemplate = null;

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

function replaceText(value, message) {
  text.value = [...String(value || '')].slice(0, 100000).join('');
  state.textContent = message;
  refresh();
  text.focus();
}

function toggleBullets() {
  const start = text.selectionStart;
  const end = text.selectionEnd;
  const selected = text.value.slice(start, end) || text.value;
  if (!selected.trim()) return;
  const transformed = toggleBulletsText(selected);
  if (start !== end) {
    text.setRangeText(transformed.text, start, end, 'select');
    state.textContent = transformed.added ? 'Bullets added locally' : 'Bullets removed locally';
    refresh();
    text.focus();
  } else {
    replaceText(transformed.text, transformed.added ? 'Bullets added locally' : 'Bullets removed locally');
  }
}

function renderTemplates(nextTemplates = []) {
  templates = Array.isArray(nextTemplates) ? nextTemplates : [];
  templatePicker.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = templates.length ? 'Insert a template…' : 'No templates saved';
  templatePicker.appendChild(placeholder);
  for (const template of templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name;
    templatePicker.appendChild(option);
  }
  templatePicker.disabled = templates.length === 0;
}

function chooseTemplate(id) {
  const template = templates.find((item) => item.id === id);
  templatePicker.value = '';
  if (!template) return;
  const variables = variableNames(template.body);
  if (!variables.length) {
    insertText(template.body);
    state.textContent = `Inserted ${template.name} · kept local`;
    return;
  }
  pendingTemplate = template;
  document.getElementById('template-dialog-title').textContent = template.name;
  variableFields.replaceChildren();
  for (const variable of variables) {
    const label = document.createElement('label');
    label.textContent = variable.replace(/_/g, ' ');
    const input = document.createElement('input');
    input.dataset.variable = variable;
    input.maxLength = 500;
    input.autocomplete = 'off';
    label.appendChild(input);
    variableFields.appendChild(label);
  }
  templateDialog.showModal();
  variableFields.querySelector('input')?.focus();
}

function closeTemplateDialog() {
  pendingTemplate = null;
  templateDialog.close();
  text.focus();
}

function insertPendingTemplate() {
  if (!pendingTemplate) return;
  const values = new Map([...variableFields.querySelectorAll('input')]
    .map((input) => [input.dataset.variable, input.value.trim()]));
  const missing = [...values.entries()].find(([, value]) => !value);
  if (missing) {
    const input = [...variableFields.querySelectorAll('input')]
      .find((field) => field.dataset.variable === missing[0]);
    input?.focus();
    return;
  }
  const body = fillTemplate(pendingTemplate.body, Object.fromEntries(values));
  const name = pendingTemplate.name;
  templateDialog.close();
  pendingTemplate = null;
  insertText(body);
  state.textContent = `Inserted ${name} · values not saved`;
}

async function start() {
  if (!text.value.trim()) return;
  if (hasUnresolvedVariables(text.value)) {
    state.textContent = 'Replace every template field before typing';
    return;
  }
  submit.disabled = true;
  state.textContent = 'Returning to target…';
  try {
    const result = await window.dripType.start(text.value);
    if (result?.error) {
      state.textContent = result.error;
      submit.disabled = false;
    } else {
      text.value = '';
      state.textContent = privateDraftMessage;
      refresh();
    }
  } catch (error) {
    state.textContent = error?.message || 'Typing could not be started. Try again.';
    submit.disabled = false;
  }
}

text.addEventListener('input', refresh);
submit.addEventListener('click', start);
document.getElementById('paste').addEventListener('click', async () => {
  try {
    insertText(await window.dripType.readClipboardText());
  } catch (error) {
    state.textContent = error?.message || 'Clipboard text could not be read.';
  }
});
document.getElementById('tool-clean').addEventListener('click', () => replaceText(cleanSpacing(text.value), 'Spacing cleaned locally'));
document.getElementById('tool-bullets').addEventListener('click', toggleBullets);
templatePicker.addEventListener('change', () => chooseTemplate(templatePicker.value));
document.getElementById('template-cancel').addEventListener('click', closeTemplateDialog);
document.getElementById('template-insert').addEventListener('click', insertPendingTemplate);
templateDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeTemplateDialog();
});
variableFields.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) insertPendingTemplate();
});
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
  renderTemplates(data.templates);
  submit.textContent = delay ? `Drip after ${delay}s` : 'Drip now';
  state.textContent = privateDraftMessage;
  refresh();
  setTimeout(() => text.focus(), 30);
});
window.dripType.onTheme(({ theme }) => applyTheme(theme));
window.dripType.onState((data) => {
  if (data.status === 'error') state.textContent = data.message;
});
