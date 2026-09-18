'use strict';

const ORIGIN = 'http://127.0.0.1:8765';
const MAX_MODEL_INPUT = 1500;

async function rewriteWithLocalModel(text, fetchImpl = fetch) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MODEL_INPUT) {
    return { error: 'Use 1–1,500 characters for the trained model preview.' };
  }
  try {
    const response = await fetchImpl(`${ORIGIN}/rewrite`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json', 'X-Drip-Humanizer': '1' },
      body: JSON.stringify({ text })
    });
    const body = await response.text();
    if (body.length > 20000) return { error: 'The local model returned an oversized response.' };
    const result = JSON.parse(body);
    if (!response.ok) return { error: typeof result.error === 'string' ? result.error : 'The local model could not finish this draft.' };
    if (result.engine !== 'trained-local-model' || typeof result.text !== 'string' || !result.text.trim()) {
      return { error: 'The local model returned an invalid response.' };
    }
    return { text: result.text, engine: result.engine, experimental: true };
  } catch (error) {
    return { error: error.name === 'TimeoutError'
      ? 'The local model took too long. Try a shorter draft.'
      : 'Start the local model preview service to use this option. The basic humanizer is available without it.' };
  }
}

module.exports = { MAX_MODEL_INPUT, rewriteWithLocalModel };
