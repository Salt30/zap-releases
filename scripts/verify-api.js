const assert = require('node:assert/strict');

const createCheckout = require('../website/api/create-checkout');
const claimEntitlement = require('../website/api/claim-entitlement');
const refreshEntitlement = require('../website/api/refresh-entitlement');
const createPortal = require('../website/api/create-portal');
const checkoutStatus = require('../website/api/checkout-status');
const checkoutConfig = require('../website/api/checkout-config');

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

  console.log('Billing API schema and request-boundary verification passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
