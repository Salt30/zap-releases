// Desktop client: all inference and provider credentials stay on the Zap server.
const DEFAULT_SETTINGS = Object.freeze({ language: 'Spanish', context: '', maxTokens: 2048 });
const MODES = new Set(['answer', 'simple', 'translate', 'rewrite', 'summarize', 'explain', 'solve', 'code', 'research', 'flashcards', 'form']);
function cleanSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Zap settings.');
  const language = value.language ?? DEFAULT_SETTINGS.language;
  const context = value.context ?? '';
  const maxTokens = value.maxTokens ?? DEFAULT_SETTINGS.maxTokens;
  if (typeof language !== 'string' || !language.trim() || language.length > 80) throw new Error('Enter a target language (up to 80 characters).');
  if (typeof context !== 'string' || context.length > 4000) throw new Error('Custom instructions must be 4,000 characters or fewer.');
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 4096) throw new Error('Response limit must be between 256 and 4,096 tokens.');
  return { language: language.trim(), context, maxTokens };
}
function validateRequest(input) {
  if (!input || typeof input !== 'object' || !MODES.has(input.mode)) throw new Error('Choose a Zap tool.');
  const text = input.text ?? '';
  const images = input.images ?? [];
  if (typeof text !== 'string' || text.length > 100000) throw new Error('Use at most 100,000 characters.');
  if (!Array.isArray(images) || images.length > 1) throw new Error('Invalid screenshot.');
  for (const image of images) if (typeof image !== 'string' || image.length > 2500000 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error('Invalid screenshot. Capture a smaller region.');
  if (!text.trim() && !images.length) throw new Error('Add text or capture a screen first.');
  return { mode: input.mode, text, images };
}
function safeSource(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.href.length < 2048 ? parsed.href : null; } catch { return null; }
}
async function readJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The AI service returned an empty response.');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 2 * 1024 * 1024) throw new Error('The AI service response was too large.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
async function requestAI(input, settings, credentials, { signal, fetchImpl = fetch } = {}) {
  const request = validateRequest(input);
  const preferences = cleanSettings(settings);
  if (!credentials?.refreshToken || !credentials?.deviceId) throw new Error('Connect your Zap account in Billing to use AI.');
  const response = await fetchImpl('https://tryzap.net/api/zap-ai', {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...request, settings: preferences, deviceId: credentials.deviceId, refreshToken: credentials.refreshToken })
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(({401: 'Connect your Zap account in Billing to use AI.', 402: 'An active Zap subscription is required for Zap AI.', 403: 'Your account could not be verified. Reconnect it in Billing.', 413: 'The screenshot is too large. Capture a smaller region.', 429: 'Zap’s AI usage limit was reached. Please try again later.', 503: 'Zap AI is temporarily unavailable. Please try again later.', 504: 'The AI request timed out. Try a shorter question.', 404: 'Zap AI is not available on the server yet.'})[response.status] || 'The AI service could not complete this request.');
  }
  const data = await readJSON(response);
  if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000) throw new Error('The AI service returned no usable text.');
  return {
    text: data.text, provider: 'Zap AI', model: 'Powered by NVIDIA',
    sources: Array.isArray(data.sources) ? data.sources.filter((url) => typeof url === 'string').map(safeSource).filter(Boolean).slice(0, 30) : [],
    cards: Array.isArray(data.cards) ? data.cards.filter((card) => card && typeof card.front === 'string' && typeof card.back === 'string' && card.front.length <= 4000 && card.back.length <= 8000).slice(0, 30) : [],
    truncated: Boolean(data.truncated), webSearch: false
  };
}
module.exports = { DEFAULT_SETTINGS, cleanSettings, validateRequest, safeSource, requestAI };
