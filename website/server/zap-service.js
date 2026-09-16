const rateLimit = require('./rate-limit');
const billing = require('../api/_billing');
const model = require('./zap-model');
const quota = require('./zap-quota');
const MAX_BODY_BYTES = 3 * 1024 * 1024;

function createHandler({ authenticate = billing.subscriptionForRefresh, reserve = quota.reserve, requestAI = model.requestAI, env = process.env } = {}) {
  return async function zapAI(request, response) {
    billing.secureResponse(response);
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return response.status(405).json({ error: 'Method not allowed' }); }
    if (!billing.isJsonRequest(request)) return response.status(415).json({ error: 'Content-Type must be application/json' });
    if (!await billing.limitRequest(request, response, 'zap-ai')) return;
    if (request.headers?.origin && !billing.verifyRequestOrigin(request)) return response.status(403).json({ error: 'Request origin was rejected' });
    const declared = request.headers?.['content-length'];
    if (declared !== undefined && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_BODY_BYTES)) return response.status(413).json({ error: 'Request too large' });
    let body; let settings;
    try {
      body = billing.parseBody(request, MAX_BODY_BYTES);
      if (!billing.hasExactKeys(body, ['mode', 'text', 'images', 'settings', 'deviceId', 'refreshToken']) || !billing.validDeviceId(body.deviceId) || !billing.validRefreshToken(body.refreshToken)) throw new Error('invalid');
      model.validateRequest(body);
      if (!billing.hasExactKeys(body.settings, ['language', 'context', 'maxTokens']) || body.settings.maxTokens > 4096) throw new Error('invalid');
      settings = model.cleanSettings(body.settings);
    } catch { return response.status(400).json({ error: 'Invalid AI request' }); }
    let verified;
    try { verified = await authenticate(body.refreshToken, body.deviceId); }
    catch (error) {
      const safe = billing.publicError(error);
      return response.status([401, 402, 403].includes(safe.status) ? safe.status : 403).json({ error: 'An active, connected Zap account is required.' });
    }
    const key = env.NVIDIA_API_KEY;
    if (!key || !/^nvapi-[A-Za-z0-9_-]{20,200}$/.test(key)) return response.status(503).json({ error: 'Zap AI is temporarily unavailable.' });
    try {
      const burst = await rateLimit.consume('ai-account', verified.subscription.id);
      if (!burst.allowed) { response.setHeader('Retry-After', String(burst.retryAfter)); return response.status(429).json({ error: 'Too many AI requests. Please wait and try again.' }); }
      await reserve(verified.subscription.id);
      // A shared service ceiling bounds provider usage across all subscriptions.
      await reserve('zap-service-global', undefined, Date.now(), 10000);
    }
    catch (error) {
      if (error.message === 'quota_exceeded') { response.setHeader('Retry-After', String(Math.ceil((86400000 - Date.now() % 86400000) / 1000))); return response.status(429).json({ error: 'Your daily Zap AI limit has been reached.' }); }
      return response.status(503).json({ error: 'Zap AI is temporarily unavailable.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50000);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.on?.('close', disconnect);
    try {
      const result = await requestAI(body, settings, () => key, { signal: controller.signal });
      return response.status(200).json({ ...result, model: 'Powered by NVIDIA', provider: 'Zap AI', webSearch: false });
    } catch {
      // Upstream error text can contain service details. Never log it or the request.
      return response.status(controller.signal.aborted ? 504 : 503).json({ error: 'Zap AI could not complete the request. Try again later.' });
    } finally { clearTimeout(timer); response.removeListener?.('close', disconnect); }
  };
}
module.exports = { createHandler, handle: createHandler() };
