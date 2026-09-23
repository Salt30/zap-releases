const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const billing = require('../website/api/_billing');
const accounts = require('../website/server/accounts');
const { findSecrets } = require('./secret-patterns');

(async () => {
  const originalFetch = global.fetch;
  const originalStripeKey = process.env.STRIPE_SECRET_KEY;
  const originalMaster = process.env.AUTH_MASTER_KEY;
  let requests = [];
  global.fetch = async (url) => { requests.push(new URL(url)); return { ok: true, json: async () => ({ data: [] }) }; };
  process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'x'.repeat(40);
  process.env.AUTH_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  try {
    const ids = [
      [billing.validCustomerId, 'cus_example'],
      [billing.validCheckoutSessionId, 'cs_live_example'],
      [billing.validDeviceId, crypto.randomUUID()],
      [billing.validRefreshToken, 'sub_example.' + 'x'.repeat(43)],
      [accounts.validAccountId, 'acct_' + 'x'.repeat(32)],
    ];
    for (const [validate, valid] of ids) {
      assert.equal(validate(valid), true);
      for (const invalid of [[valid], { $ne: null }, null, 1, valid + "' OR '1'='1", '../'+valid, valid+'?limit=1000']) {
        assert.equal(validate(invalid), false, 'Untrusted identifier accepted');
      }
    }
    for (const invalid of [["alice@example.com"], { $ne: null }, "admin@example.com' OR '1'='1", 'a@example.com;DROP TABLE accounts']) {
      assert.throws(() => accounts.normalizeEmail(invalid), /invalid_email/);
    }
    // Punctuation in valid email addresses is data, not an excuse to strip it.
    const email = "o'connor+tag@example.com";
    assert.equal(accounts.normalizeEmail(email), email);
    assert.match(accounts.accountIdForEmail(email), /^acct_[A-Za-z0-9_-]{32}$/);
    // Even a hostile value reaching the low-level Stripe helper stays one value.
    const payload = "victim@example.com&limit=1000&customer=cus_attacker' OR '1'='1";
    await billing.customersByEmail(payload);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, 'https://api.stripe.com');
    assert.equal(requests[0].pathname, '/v1/customers');
    assert.deepEqual([...requests[0].searchParams.keys()], ['email','limit']);
    assert.equal(requests[0].searchParams.get('email'), payload.toLowerCase());
    assert.equal(requests[0].searchParams.get('limit'), '100');
    requests = [];
    await assert.rejects(() => billing.customersByEmail([email]), /Invalid email/);
    await assert.rejects(() => billing.subscriptionsForCustomer("cus_x' OR 1=1--"), /Invalid customer/);
    for (const key of ['__proto__','constructor','toString']) {
      const values = JSON.parse(`{"${key}":{"polluted":true}}`);
      assert.equal(billing.hasExactKeys(values, ['email','password']), false);
      await assert.rejects(() => accounts.updateBillingMetadata('acct_'+'x'.repeat(32), values), /invalid_billing_metadata/);
    }
    assert.equal(requests.length, 0, 'Rejected input reached an upstream service');
    assert.equal({}.polluted, undefined);
  } finally {
    global.fetch = originalFetch;
    for (const [name,value] of [['STRIPE_SECRET_KEY',originalStripeKey],['AUTH_MASTER_KEY',originalMaster]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  // Generate fake secrets at runtime: test fixtures never embed usable credentials.
  const fake = crypto.randomBytes(32).toString('hex');
  for (const name of ['NVIDIA_API_KEY','AUTH_MASTER_KEY','SUPPORT_DATA_KEY','STRIPE_SECRET_KEY','BLOB_READ_WRITE_TOKEN','VERCEL_TOKEN','apiKey']) {
    for (const source of [`${name}=${fake}`, JSON.stringify({[name]:fake}), `'${name}': '${fake}'`]) {
      const matches = findSecrets(source, 'fixture/config.json');
      assert(matches.some(match => match.detector === 'assigned credential'), `Missed ${name}`);
      assert(!JSON.stringify(matches).includes(fake), 'Scanner exposed a credential');
    }
  }
  assert(findSecrets('nvapi-' + fake, 'fixture/compiled.js').some(item => item.detector === 'NVIDIA key'));
  assert.equal(findSecrets("const endpoint = 'https://api.stripe.com'; const key = process.env.NVIDIA_API_KEY;", 'fixture/app.js').length, 0);
  const placeholder = 'long-lived-token-must-not-be-used';
  assert.equal(findSecrets(`VERCEL_TOKEN: '${placeholder}'`, 'scripts/verify-source.js').length, 0);
  assert.equal(findSecrets(`VERCEL_TOKEN: '${placeholder}'`, 'production.js').length, 1);
  console.log('Injection boundaries passed: scalar IDs, email validation, encoded Stripe parameters, metadata allowlists, and redacted credential detection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
