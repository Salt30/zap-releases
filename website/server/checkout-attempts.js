const blob = require('@vercel/blob');
const { createHash, randomBytes } = require('node:crypto');

const LIFETIME_SECONDS = 35 * 60;
function conflict() {
  const error = new Error('checkout_in_progress');
  error.code = 'checkout_in_progress';
  return error;
}

// A private, conditional-write reservation keeps independently scaled instances
// on one Stripe idempotency key. No email, password or checkout URL is stored.
async function reserve(accountId, plan, customerId, priceId, nonce, storage = blob, now = Math.floor(Date.now() / 1000)) {
  if (!/^acct_[A-Za-z0-9_-]{32}$/.test(accountId) || !['core', 'pro'].includes(plan) ||
      !/^cus_[A-Za-z0-9]+$/.test(customerId) || !/^price_[A-Za-z0-9]+$/.test(priceId)) throw conflict();
  const pathname = `zap-checkout-attempts/${accountId}.json`;
  const proof = createHash('sha256').update(nonce).digest('hex');
  for (let retry = 0; retry < 4; retry++) {
    const existing = await storage.get(pathname, { access: 'private', useCache: false });
    let etag;
    if (existing) {
      if (existing.statusCode !== 200) throw conflict();
      const reader = existing.stream.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 2048) throw conflict();
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const previous = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (previous.v !== 1 || !Number.isSafeInteger(previous.createdAt) ||
          previous.expiresAt !== previous.createdAt + LIFETIME_SECONDS ||
          !/^[a-f0-9]{64}$/.test(previous.proof || '') || !/^[a-z]{8}$/.test(previous.integration || '')) throw conflict();
      if (previous.expiresAt > now) {
        if (previous.plan !== plan || previous.proof !== proof || previous.customerId !== customerId || previous.priceId !== priceId) throw conflict();
        return previous;
      }
      const metadata = await storage.head(pathname, { access: 'private' });
      if (!existing.blob?.etag || String(existing.blob.etag).replace(/^W\//, '') !== String(metadata?.etag).replace(/^W\//, '')) continue;
      etag = metadata.etag;
    }
    const attempt = {
      v: 1, plan, customerId, priceId, proof, createdAt: now,
      expiresAt: now + LIFETIME_SECONDS,
      integration: [...randomBytes(8)].map((byte) => String.fromCharCode(97 + byte % 26)).join(''),
    };
    try {
      await storage.put(pathname, JSON.stringify(attempt), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json',
        cacheControlMaxAge: 60, allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {}),
      });
      return attempt;
    } catch (error) {
      if (!/already exists|precondition|etag mismatch/i.test(String(error?.message || '')) &&
          !(error instanceof blob.BlobPreconditionFailedError)) throw error;
    }
  }
  throw conflict();
}

module.exports = { reserve };
