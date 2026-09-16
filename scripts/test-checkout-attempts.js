const assert = require('node:assert/strict');
const { reserve } = require('../website/server/checkout-attempts');

function memoryStorage() {
  let record = null;
  let revision = 0;
  return {
    get: async () => record ? { statusCode: 200, blob: { etag: String(revision) }, stream: new Response(record).body } : null,
    head: async () => ({ etag: String(revision) }),
    put: async (_path, value, options) => {
      if (record && !options.allowOverwrite) throw new Error('Blob already exists');
      if (options.ifMatch && options.ifMatch !== String(revision)) throw new Error('Precondition failed: ETag mismatch');
      record = value;
      revision++;
    },
  };
}
(async () => {
  const storage = memoryStorage();
  const id = `acct_${'a'.repeat(32)}`;
  const args = [id, 'core', 'cus_fixture', 'price_core', 'browser-proof'];
  const results = await Promise.all(Array.from({ length: 12 }, () => reserve(...args, storage, 1000)));
  results.forEach((result) => assert.deepEqual(result, results[0], 'Parallel requests must reuse one immutable attempt'));
  await assert.rejects(reserve(id, 'pro', 'cus_fixture', 'price_pro', 'other-proof', storage, 1001), /checkout_in_progress/);
  await assert.rejects(reserve(id, 'core', 'cus_fixture', 'price_core', 'other-proof', storage, 1001), /checkout_in_progress/);
  assert.deepEqual(await reserve(...args, storage, 1100), results[0], 'Retries keep identical Stripe request parameters');
  const next = await reserve(id, 'pro', 'cus_fixture', 'price_pro', 'other-proof', storage, 3101);
  assert.equal(next.plan, 'pro');
  assert.equal(next.createdAt, 3101);
  assert.equal(JSON.stringify(next).includes('browser-proof'), false);
  console.log('Durable checkout reservations: concurrent requests, browser isolation, stable retries and expiration passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
