const assert = require('node:assert/strict');

const createCheckout = require('../website/api/create-checkout');
const claimEntitlement = require('../website/api/claim-entitlement');
const refreshEntitlement = require('../website/api/refresh-entitlement');
const createPortal = require('../website/api/create-portal');
const checkoutStatus = require('../website/api/checkout-status');
const checkoutConfig = require('../website/api/checkout-config');
const supportTicket = require('../website/api/support-ticket');

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

let nextTestAddress = 1;

function postRequest(body, overrides = {}) {
  const encoded = JSON.stringify(body);
  return {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(encoded)),
      'x-forwarded-for': `203.0.113.${nextTestAddress++}`,
    },
    socket: {},
    ...overrides,
  };
}

function supportRequest(body, origin = 'https://tryzap.net') {
  const request = postRequest(body);
  request.headers.origin = origin;
  request.headers['sec-fetch-site'] = 'same-origin';
  return request;
}

async function expectStatus(handler, request, expectedStatus, expectedMessage) {
  const response = mockResponse();
  await handler(request, response);
  assert.equal(response.statusCode, expectedStatus);
  if (expectedMessage) assert.match(response.body?.error || '', expectedMessage);
}

(async () => {
  const deviceId = '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b';
  const sessionId = `cs_live_${'A'.repeat(24)}`;
  const refreshToken = `sub_fixture.${'a'.repeat(40)}`;

  await expectStatus(
    createCheckout,
    postRequest({ plan: 'pro', admin: true }),
    400,
    /Invalid checkout request/,
  );
  await expectStatus(
    claimEntitlement,
    postRequest({ sessionId, deviceId, plan: 'pro' }),
    400,
    /Invalid activation request/,
  );
  await expectStatus(
    refreshEntitlement,
    postRequest({ refreshToken, deviceId, extra: true }),
    400,
    /Invalid refresh request/,
  );
  await expectStatus(
    createPortal,
    postRequest({ refreshToken, deviceId, returnUrl: 'https://example.com' }),
    400,
    /Invalid portal request/,
  );
  await expectStatus(
    checkoutStatus,
    {
      method: 'GET',
      query: { session_id: sessionId, extra: 'value' },
      headers: { 'x-forwarded-for': '203.0.113.211' },
      socket: {},
    },
    400,
    /Invalid checkout session/,
  );
  await expectStatus(
    checkoutConfig,
    { method: 'GET', query: { debug: '1' }, headers: {}, socket: {} },
    400,
    /Unexpected query parameters/,
  );
  await expectStatus(
    refreshEntitlement,
    postRequest(
      { refreshToken, deviceId },
      { headers: { 'content-type': 'text/plain', 'x-forwarded-for': '203.0.113.212' } },
    ),
    415,
    /application\/json/,
  );
  await expectStatus(
    claimEntitlement,
    postRequest({ sessionId, deviceId }, {
      headers: {
        'content-type': 'application/json',
        'content-length': '4097',
        'x-forwarded-for': '203.0.113.213',
      },
    }),
    413,
    /too large/,
  );

  const originalSiteUrl = process.env.PUBLIC_SITE_URL;
  const originalResendKey = process.env.RESEND_API_KEY;
  const originalFetch = global.fetch;
  process.env.PUBLIC_SITE_URL = 'https://tryzap.net';
  process.env.RESEND_API_KEY = `re_${'a'.repeat(32)}`;
  const supportBody = {
    name: 'Taylor Example',
    email: 'taylor@example.com',
    category: 'bug',
    platform: 'windows',
    appVersion: '1.7.0',
    subject: 'Shortcut does not open Composer',
    description: 'After changing the shortcut, Composer does not open until the app restarts.',
    privacyAccepted: true,
    companyWebsite: '',
    startedAt: Date.now() - 5_000,
    submissionId: '12345678-1234-4abc-8abc-1234567890ab',
  };
  try {
    await expectStatus(
      supportTicket,
      supportRequest({ ...supportBody, unexpected: true }),
      400,
      /Invalid ticket request/,
    );
    await expectStatus(
      supportTicket,
      supportRequest(supportBody, 'https://attacker.example'),
      403,
      /origin was rejected/,
    );

    const deliveries = [];
    global.fetch = async (url, options) => {
      deliveries.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }),
      };
    };
    const response = mockResponse();
    await supportTicket(supportRequest(supportBody), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, ticketId: '12345678' });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].url, 'https://api.resend.com/emails');
    assert.equal(deliveries[0].options.method, 'POST');
    assert.equal(deliveries[0].options.headers['Idempotency-Key'], `support-ticket/${supportBody.submissionId}`);
    const delivered = JSON.parse(deliveries[0].options.body);
    assert.deepEqual(delivered.to, ['support@tryzap.net']);
    assert.equal(delivered.reply_to, supportBody.email);
    assert.match(delivered.from, /tickets@tryzap\.net/);
    assert.match(delivered.text, /Reply to this message to respond directly/);
  } finally {
    global.fetch = originalFetch;
    if (originalSiteUrl === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = originalSiteUrl;
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendKey;
  }

  console.log('Billing and support API schema, origin, and delivery-boundary verification passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
