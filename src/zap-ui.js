const { acceleratorFromKeyboardEvent, formatAccelerator } = require('./shortcut-utils');
const HELP = {
  answer: 'Ask a question or attach a screenshot for context.', simple: 'Get a short, direct answer.',
  translate: 'Translate text or a screen region. Choose your target language in AI settings.',
  rewrite: 'Polish wording while keeping your meaning.', summarize: 'Turn longer material into a summary and key points.',
  explain: 'Understand the material with a clear explanation.', solve: 'Work through a problem with the steps explained.',
  code: 'Get code and explanations. Review code before running it.',
  research: 'Prepare a research brief from your material and existing knowledge. Live web search is not included.',
  flashcards: 'Turn your material into a set of interactive study cards.',
  form: 'Draft field responses using the facts you provide, then review and send the text to Drip Type.'
};

function initZap({ sendToComposer, getComposerText }) {
  const $ = (id) => document.getElementById(id);
  const api = window.dripType;
  let mode = 'answer';
  let busy = false;
  let sessionRevision = 0;
  let attachments = [];
  let result = null;
  let history = [];
  let cards = [];
  let cardIndex = 0;
  let flipped = false;
  let savedStatus = null;
  let shortcut = 'Alt+3';
  let screenshot = null;
  let crop = null;
  let dragStart = null;
  let captureBusy = false;
  const canvas = $('zap-canvas');
  const ctx = canvas.getContext('2d');
  const note = (message, error = false) => { $('zap-status').textContent = message; $('zap-status').dataset.error = String(error); };
  const guard = (handler, target = 'zap-status') => async (...args) => {
    try { await handler(...args); }
    catch { $(target).textContent = 'That action could not be completed. Please try again.'; }
  };
  function selectMode(next) {
    if (!Object.hasOwn(HELP, next) || busy) return;
    mode = next;
    document.querySelectorAll('[data-zap-mode]').forEach((button) => {
      const active = button.dataset.zapMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('zap-mode-help').textContent = HELP[mode];
    $('zap-run').textContent = mode === 'research' ? 'Research' : mode === 'flashcards' ? 'Make flashcards' : 'Ask Zap';
    updatePrivacy();
  }
  function updatePrivacy() {
    $('zap-privacy').textContent = `Submitting sends your text, custom instructions, and ${attachments.length ? `${attachments.length} attached screenshot${attachments.length === 1 ? '' : 's'}` : 'any attached screenshots'} through Zap to NVIDIA. Your account includes AI access, subject to usage limits.`;
  }
  function setBusy(value) {
    busy = value;
    $('zap-run').disabled = value;
    $('zap-input').disabled = value;
    $('zap-cancel').hidden = !value;
    $('zap-settings-open').disabled = value;
    $('zap-capture-open').disabled = value;
    $('zap-from-composer').disabled = value;
    document.querySelectorAll('[data-zap-mode], .zap-attachment button').forEach((button) => { button.disabled = value; });
  }
  function renderAttachments() {
    $('zap-attachments').replaceChildren();
    attachments.forEach((item, index) => {
      const wrapper = document.createElement('div'); wrapper.className = 'zap-attachment';
      const image = document.createElement('img'); image.src = item.image; image.alt = item.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = `Remove screenshot ${index + 1}`;
      remove.addEventListener('click', () => { if (!busy) { attachments.splice(index, 1); renderAttachments(); } });
      wrapper.append(image, remove); $('zap-attachments').appendChild(wrapper);
    });
    updatePrivacy();
  }
  function renderCard() {
    if (!cards.length) return;
    $('zap-card-count').textContent = `${cardIndex + 1} of ${cards.length}`;
    $('zap-card-side').textContent = flipped ? 'Answer' : 'Question';
    $('zap-card-text').textContent = flipped ? cards[cardIndex].back : cards[cardIndex].front;
    $('zap-card-flip').setAttribute('aria-label', flipped ? 'Show question' : 'Show answer');
  }
  function renderResult(next) {
    result = next;
    $('zap-result').hidden = !next;
    if (!next) { $('zap-output').textContent = ''; $('zap-sources').replaceChildren(); cards = []; return; }
    $('zap-output').textContent = next.text;
    $('zap-result-model').textContent = `${next.provider} · ${next.model}`;
    $('zap-result-title').textContent = next.mode === 'flashcards' ? 'Study cards' : 'Zap’s response';
    $('zap-sources').replaceChildren();
    (next.sources || []).forEach((url, index) => {
      const link = document.createElement('button'); link.type = 'button'; link.textContent = `[${index + 1}] ${url}`;
      link.addEventListener('click', guard(async () => { const response = await api.openZapSource(url); if (response.error) note(response.error, true); }));
      $('zap-sources').appendChild(link);
    });
    cards = (next.cards || []).map((card) => ({ ...card })); cardIndex = 0; flipped = false;
    $('zap-flashcards').hidden = !cards.length;
    $('zap-output').hidden = Boolean(cards.length);
    renderCard();
  }
  function renderHistory() {
    $('zap-history-count').textContent = history.length;
    $('zap-history-list').replaceChildren();
    history.forEach((item) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'zap-history-item';
      button.textContent = `${item.mode} · ${item.input || 'Screenshot'} · ${new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      button.addEventListener('click', () => { if (!busy) { renderResult(item); note('Showing a previous result.'); } });
      $('zap-history-list').appendChild(button);
    });
  }
  async function combinedScreenshots() {
    if (!attachments.length) return [];
    const images = await Promise.all(attachments.map((item) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = item.image; })));
    // NVIDIA's vision endpoint accepts one image. Combine explicitly attached
    // regions into a numbered contact sheet without uploading separate captures.
    const columns = images.length === 1 ? 1 : 2;
    const cellWidth = images.length === 1 ? 1600 : 1100;
    const cellHeight = images.length === 1 ? Math.min(1600, Math.round(images[0].height * cellWidth / images[0].width)) : 850;
    const sheet = document.createElement('canvas'); sheet.width = columns * cellWidth; sheet.height = Math.ceil(images.length / columns) * (cellHeight + 32);
    const context = sheet.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, sheet.width, sheet.height);
    images.forEach((image, index) => {
      const x = (index % columns) * cellWidth; const y = Math.floor(index / columns) * (cellHeight + 32);
      const scale = Math.min(cellWidth / image.width, cellHeight / image.height);
      context.fillStyle = '#111111'; context.font = '20px sans-serif'; context.fillText(`Screenshot ${index + 1}`, x + 8, y + 24);
      context.drawImage(image, x, y + 32, Math.round(image.width * scale), Math.round(image.height * scale));
    });
    let image = sheet.toDataURL('image/jpeg', .85);
    if (image.length > 2500000) image = sheet.toDataURL('image/jpeg', .55);
    if (image.length > 2500000) throw new Error('Screenshot too large');
    return [image];
  }
  async function run() {
    const revision = sessionRevision;
    if (busy) return;
    const text = $('zap-input').value;
    if (!text.trim() && !attachments.length) { note('Add text or capture a screen first.', true); $('zap-input').focus(); return; }
    const selectedMode = mode;
    setBusy(true); note('Zap is working…');
    try {
      const request = { mode: selectedMode, text, images: await combinedScreenshots() };
      if (revision !== sessionRevision) return;
      const response = await api.requestZap(request);
      if (revision !== sessionRevision) return;
      if (response.error) { note(response.error, !response.cancelled); return; }
      const entry = { ...response, mode: request.mode, input: text.slice(0, 160), time: Date.now() };
      renderResult(entry);
      history = [entry, ...history].slice(0, 20); renderHistory();
      note(response.truncated ? 'The response reached your token limit. Increase the limit in AI settings or ask a narrower question.' : request.mode === 'flashcards' && !response.cards?.length ? 'The provider returned text instead of valid flashcards. Try again with a smaller set.' : 'Ready. Review the result, then send it to Drip Type.');
    } catch { note('Zap could not complete the request. Check your connection and try again.', true); }
    finally { setBusy(false); }
  }

  async function loadSettings() {
    const status = await api.getZapStatus(); savedStatus = status;
    const settings = status.settings;
    $('zap-language').value = settings.language; $('zap-context').value = settings.context; $('zap-max-tokens').value = settings.maxTokens;
    shortcut = status.shortcut; $('zap-shortcut').value = shortcut ? formatAccelerator(shortcut, document.documentElement.dataset.platform || 'darwin') : 'Disabled';
    $('zap-settings-note').textContent = status.shortcutError || '';
    return status;
  }
  document.querySelectorAll('[data-zap-mode]').forEach((button) => button.addEventListener('click', () => selectMode(button.dataset.zapMode)));
  $('zap-run').addEventListener('click', run);
  $('zap-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run(); } });
  $('zap-cancel').addEventListener('click', () => { api.cancelZap(); note('Cancelling request…'); });
  $('zap-from-composer').addEventListener('click', () => { $('zap-input').value = getComposerText(); $('zap-input').focus(); });
  $('zap-compose').addEventListener('click', () => { if (result) sendToComposer(result.text); });
  $('zap-copy').addEventListener('click', guard(async () => { if (result) { const response = await api.writeClipboardText(result.text); note(response.error || 'Copied.', Boolean(response.error)); } }));
  $('zap-pin').addEventListener('click', guard(async () => { if (result) { const response = await api.pinZapAnswer(result.text); note(response.error || 'Answer pinned above other windows.', Boolean(response.error)); } }));
  $('zap-follow-up').addEventListener('click', () => { if (result && !busy) { $('zap-input').value = `${result.text}\n\nFollow-up: `.slice(0, 100000); $('zap-input').focus(); note('Add your follow-up question. It will be sent with the text above.'); } });
  $('zap-clear-history').addEventListener('click', () => { history = []; renderHistory(); renderResult(null); note('Session history cleared.'); });
  $('zap-card-flip').addEventListener('click', () => { flipped = !flipped; renderCard(); });
  $('zap-card-prev').addEventListener('click', () => { if (cards.length) { cardIndex = (cardIndex - 1 + cards.length) % cards.length; flipped = false; renderCard(); } });
  $('zap-card-next').addEventListener('click', () => { if (cards.length) { cardIndex = (cardIndex + 1) % cards.length; flipped = false; renderCard(); } });
  $('zap-card-shuffle').addEventListener('click', () => {
    for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    cardIndex = 0; flipped = false; renderCard();
  });
  $('zap-settings-open').addEventListener('click', guard(async () => { await loadSettings(); $('zap-settings-dialog').showModal(); }));
  $('zap-settings-close').addEventListener('click', () => $('zap-settings-dialog').close());
  $('zap-shortcut').addEventListener('keydown', (event) => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (event.key === 'Backspace') { shortcut = ''; $('zap-shortcut').value = 'Disabled'; return; }
    const next = acceleratorFromKeyboardEvent(event);
    if (next.accelerator) { shortcut = next.accelerator; $('zap-shortcut').value = formatAccelerator(shortcut, document.documentElement.dataset.platform || 'darwin'); }
    else if (next.error) $('zap-settings-note').textContent = next.error;
  });
  $('zap-settings-form').addEventListener('submit', guard(async (event) => {
    event.preventDefault(); $('zap-settings-save').disabled = true;
    try {
      const response = await api.saveZapSettings({ language: $('zap-language').value, context: $('zap-context').value, maxTokens: Number($('zap-max-tokens').value), shortcut });
      $('zap-settings-note').textContent = response.error || 'Preferences saved.';
      if (!response.error) savedStatus = response;
    } finally { $('zap-settings-save').disabled = false; }
  }, 'zap-settings-note'));
  async function loadDisplays() {
    const displays = await api.getZapDisplays();
    const previous = $('zap-display').value;
    $('zap-display').replaceChildren();
    displays.forEach((display) => { const option = document.createElement('option'); option.value = display.id; option.textContent = `${display.name} · ${display.width} × ${display.height}`; $('zap-display').appendChild(option); });
    if (displays.some((display) => display.id === previous)) $('zap-display').value = previous;
    $('zap-capture-take').disabled = !displays.length;
  }
  function paintCrop() {
    if (!screenshot || !crop) return;
    ctx.drawImage(screenshot, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenshot, crop.x, crop.y, crop.width, crop.height, crop.x, crop.y, crop.width, crop.height);
    ctx.strokeStyle = '#ffd45b'; ctx.lineWidth = Math.max(2, canvas.width / 400); ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
    for (const key of ['x', 'y', 'width', 'height']) $(`zap-crop-${key}`).value = crop[key];
  }
  function resetCrop() { if (screenshot) { crop = { x: 0, y: 0, width: screenshot.width, height: screenshot.height }; paintCrop(); } }
  function clearCapture() {
    screenshot = null; crop = null; dragStart = null;
    canvas.width = 1; canvas.height = 1;
    $('zap-canvas-wrap').hidden = true; $('zap-crop-controls').hidden = true;
    $('zap-capture-attach').disabled = true; $('zap-crop-reset').disabled = true;
  }
  $('zap-capture-open').addEventListener('click', guard(async () => {
    if (attachments.length >= 4) { note('You can attach up to four screenshots. Remove one first.', true); return; }
    clearCapture(); await loadDisplays(); $('zap-capture-dialog').showModal();
  }));
  $('zap-capture-refresh').addEventListener('click', guard(loadDisplays, 'zap-capture-note'));
  $('zap-capture-close').addEventListener('click', () => { if (!captureBusy) $('zap-capture-dialog').close(); });
  $('zap-capture-dialog').addEventListener('cancel', (event) => { if (captureBusy) event.preventDefault(); });
  $('zap-capture-dialog').addEventListener('close', clearCapture);
  $('zap-capture-take').addEventListener('click', guard(async () => {
    const revision = sessionRevision;
    if (captureBusy) return;
    captureBusy = true; clearCapture();
    for (const id of ['zap-capture-take', 'zap-capture-close', 'zap-capture-refresh', 'zap-display']) $(id).disabled = true;
    $('zap-capture-note').textContent = 'Capturing your selected display…';
    try {
      const response = await api.captureZapScreen($('zap-display').value);
      if (revision !== sessionRevision) return;
      if (response.error) { $('zap-capture-note').textContent = response.error; return; }
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = response.image; });
      if (revision !== sessionRevision) return;
      screenshot = image; canvas.width = image.width; canvas.height = image.height;
      $('zap-canvas-wrap').hidden = false; $('zap-crop-controls').hidden = false;
      $('zap-capture-attach').disabled = false; $('zap-crop-reset').disabled = false;
      resetCrop(); $('zap-capture-note').textContent = 'Drag to select a region, adjust the pixel fields, or attach the full screenshot. Nothing has been sent.';
    } finally { captureBusy = false; for (const id of ['zap-capture-take', 'zap-capture-close', 'zap-capture-refresh', 'zap-display']) $(id).disabled = false; }
  }, 'zap-capture-note'));
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(canvas.width - 1, (event.clientX - rect.left) * canvas.width / rect.width))), y: Math.round(Math.max(0, Math.min(canvas.height - 1, (event.clientY - rect.top) * canvas.height / rect.height))) };
  };
  canvas.addEventListener('pointerdown', (event) => { if (screenshot) { dragStart = point(event); canvas.setPointerCapture(event.pointerId); } });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    const current = point(event);
    crop = { x: Math.min(dragStart.x, current.x), y: Math.min(dragStart.y, current.y), width: Math.max(1, Math.abs(current.x - dragStart.x)), height: Math.max(1, Math.abs(current.y - dragStart.y)) }; paintCrop();
  });
  canvas.addEventListener('pointerup', () => { dragStart = null; });
  canvas.addEventListener('pointercancel', () => { dragStart = null; });
  for (const key of ['x', 'y', 'width', 'height']) $(`zap-crop-${key}`).addEventListener('change', () => {
    if (!crop) return;
    crop[key] = Math.round(Number($(`zap-crop-${key}`).value) || 0);
    crop.x = Math.max(0, Math.min(canvas.width - 1, crop.x)); crop.y = Math.max(0, Math.min(canvas.height - 1, crop.y));
    crop.width = Math.max(1, Math.min(canvas.width - crop.x, crop.width)); crop.height = Math.max(1, Math.min(canvas.height - crop.y, crop.height)); paintCrop();
  });
  $('zap-crop-reset').addEventListener('click', resetCrop);
  $('zap-capture-attach').addEventListener('click', () => {
    if (!screenshot || !crop || attachments.length >= 4) return;
    const output = document.createElement('canvas'); output.width = crop.width; output.height = crop.height;
    output.getContext('2d').drawImage(screenshot, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    attachments.push({ image: output.toDataURL('image/jpeg', .9), name: `Screen region ${crop.width} × ${crop.height}` });
    renderAttachments(); $('zap-capture-dialog').close(); note('Screenshot attached. Review your prompt, then ask Zap to send it.');
  });
  $('zap-screen-settings').addEventListener('click', guard(async () => { const response = await api.openZapScreenSettings(); if (response.error) $('zap-capture-note').textContent = response.error; }, 'zap-capture-note'));
  loadSettings().then((status) => {
    note(status.shortcutError || 'Ready. Zap provides the AI through your connected account.');
  }).catch(() => note('Zap settings could not be loaded. Try reopening the app.', true));
  api.onSignedOut(() => {
    sessionRevision++;
    api.cancelZap();
    attachments = []; history = []; screenshot = null;
    $('zap-input').value = ''; $('zap-context').value = '';
    clearCapture(); renderAttachments(); renderHistory(); renderResult(null);
    for (const id of ['zap-capture-dialog', 'zap-settings-dialog']) if ($(id).open) $(id).close();
    note('Signed out. Sign in from Billing to use Zap AI.');
  });
}

module.exports = { initZap };
