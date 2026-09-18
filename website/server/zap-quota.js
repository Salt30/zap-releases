const blob = require('@vercel/blob');
const { createHash } = require('node:crypto');

// One rolling record per subscription; no prompts, images, or account details.
async function reserve(subscriptionId, storage = blob, now = Date.now(), limit = 100) {
  const pathname = `zap-ai-usage/${createHash('sha256').update(subscriptionId).digest('hex')}.json`;
  const day = new Date(now).toISOString().slice(0, 10);
  for (let retry = 0; retry < 5; retry++) {
    const existing = await storage.get(pathname, { access: 'private', useCache: false });
    let etag; let count = 0;
    if (existing) {
      if (existing.statusCode !== 200) throw new Error('quota_unavailable');
      const reader = existing.stream.getReader(); const chunks = []; let size = 0;
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 512) throw new Error('quota_unavailable'); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.day) || !Number.isSafeInteger(record.count) || record.count < 0) throw new Error('quota_unavailable');
      count = record.day === day ? record.count : 0;
      const metadata = await storage.head(pathname, { access: 'private' });
      if (!existing.blob?.etag || String(existing.blob.etag).replace(/^W\//, '') !== String(metadata?.etag).replace(/^W\//, '')) continue;
      etag = metadata.etag;
    }
    if (count >= limit) throw new Error('quota_exceeded');
    try {
      await storage.put(pathname, JSON.stringify({ day, count: count + 1 }), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json',
        cacheControlMaxAge: 60, allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {})
      });
      return { remaining: limit - count - 1 };
    } catch (error) {
      if (!/already exists|precondition|etag mismatch/i.test(String(error?.message || '')) && !(error instanceof blob.BlobPreconditionFailedError)) throw error;
    }
  }
  throw new Error('quota_unavailable');
}
module.exports = { reserve };
