const blob = require('@vercel/blob');
const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');

const POLICIES = Object.freeze({
  billing: { limit: 30, windowMs: 60000 },
  'account-config': { limit: 60, windowMs: 60000 },
  'account-status': { limit: 30, windowMs: 60000 },
  'checkout-status': { limit: 30, windowMs: 60000 },
  'admin-stats': { limit: 10, windowMs: 60000 },
  'admin-tickets': { limit: 20, windowMs: 60000 },
  auth: { limit: 10, windowMs: 60000 },
  support: { limit: 5, windowMs: 600000 },
  checkout: { limit: 5, windowMs: 600000 },
  'zap-ai': { limit: 20, windowMs: 60000 },
  'ai-account': { limit: 10, windowMs: 60000 }
});
const MAX_ENTRIES = 64;
const MAX_BYTES = 16000;

function clientAddress(request) {
  // Vercel overwrites x-vercel-forwarded-for. Never trust caller-controlled
  // x-forwarded-for in a local/reverse-proxy deployment.
  const candidate = process.env.VERCEL === '1'
    ? request.headers?.['x-vercel-forwarded-for']
    : request.socket?.remoteAddress;
  const value = String(candidate || '').split(',')[0].trim();
  return isIP(value) ? value : 'unknown';
}

async function readRecord(result) {
  const reader = result.stream.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('rate_limit_unavailable');
      chunks.push(Buffer.from(value));
    }
    const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (record.v !== 1 || !Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES ||
      record.entries.some(e => !Array.isArray(e) || e.length !== 3 || !/^[a-f0-9]{64}$/.test(e[0]) || !Number.isSafeInteger(e[1]) || e[1] < 0 || !Number.isSafeInteger(e[2]) || e[2] < 1)) throw new Error('rate_limit_unavailable');
    return record.entries;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Fixed 256 shards per policy bound storage growth even when addresses rotate.
// Conditional writes enforce the same count across concurrent server instances.
// Records contain HMAC identifiers and counters, never IPs, credentials or content.
async function consume(bucket, subject, { storage = blob, now = Date.now(), secret = process.env.AUTH_MASTER_KEY } = {}) {
  const policy = POLICIES[bucket];
  secret = String(secret || '').trim();
  if (!policy || !/^[A-Za-z0-9_-]{43}$/.test(secret || '')) throw new Error('rate_limit_unavailable');
  const id = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`zap-rate:${bucket}:${subject}`).digest('hex');
  const pathname = `zap-rate-limits/${bucket}/${id.slice(0, 2)}.json`;
  for (let retry = 0; retry < 6; retry++) {
    const result = await storage.get(pathname, { access: 'private', useCache: false });
    let etag; let entries = [];
    if (result) {
      if (result.statusCode !== 200) throw new Error('rate_limit_unavailable');
      entries = await readRecord(result);
      etag = result.blob?.etag;
      if (!etag) throw new Error('rate_limit_unavailable');
      const metadata = await storage.head(pathname, { access: 'private' });
      if (String(etag).replace(/^W\//, '') !== String(metadata?.etag).replace(/^W\//, '')) continue;
      etag = metadata.etag;
    }
    entries = entries.filter(e => e[1] + policy.windowMs > now);
    let entry = entries.find(e => e[0] === id);
    if (entry && entry[2] >= policy.limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry[1] + policy.windowMs - now) / 1000)) };
    if (!entry) {
      if (entries.length >= MAX_ENTRIES) throw new Error('rate_limit_unavailable');
      entry = [id, now, 0]; entries.push(entry);
    }
    entry[2]++;
    try {
      await storage.put(pathname, JSON.stringify({ v: 1, entries }), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60,
        allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {})
      });
      return { allowed: true, remaining: policy.limit - entry[2] };
    } catch (error) {
      if (!/already exists|precondition|etag mismatch/i.test(String(error?.message || '')) && !(error instanceof blob.BlobPreconditionFailedError)) throw new Error('rate_limit_unavailable');
    }
  }
  throw new Error('rate_limit_unavailable');
}
module.exports = { consume, clientAddress, POLICIES };
