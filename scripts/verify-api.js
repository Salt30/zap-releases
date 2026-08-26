const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const createCheckout = require('../website/api/create-checkout');
const claimEntitlement = require('../website/api/claim-entitlement');
const refreshEntitlement = require('../website/api/refresh-entitlement');
const createPortal = require('../website/api/create-portal');
const checkoutStatus = require('../website/api/checkout-status');
const checkoutConfig = require('../website/api/checkout-config');
const supportTicket = require('../website/api/support-ticket');
const ticketStore = require('../website/server/tickets');
const accountStore = require('../website/server/accounts');
const accountRouter = require('../website/api/account');
const { config: accountConfig, status: accountStatus,
  portal: createAccountPortal, activation: createAppActivation,
  stats: adminStats, tickets: adminTickets } = accountRouter.routes;
const claimAccountEntitlement = require('../website/api/claim-account-entitlement');
const stripeWebhook = require('../website/api/stripe-webhook');
const auth = require('../website/api/_auth');
const billing = require('../website/api/_billing');

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
    410,
    /retired/,
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
    410,
    /retired/,
  );
  await expectStatus(
    checkoutConfig,
    { method: 'GET', query: { debug: '1' }, headers: {}, socket: {} },
    400,
    /Unexpected query parameters/,
  );
  await expectStatus(
    claimAccountEntitlement,
    postRequest({ activationToken: 'not-a-token', deviceId, extra: true }),
    400,
    /Invalid activation request/,
  );
  await expectStatus(
    createAppActivation,
    postRequest({ deviceId, returnUrl: 'https://attacker.example' }),
    400,
    /Invalid device connection request/,
  );
  await expectStatus(
    createAccountPortal,
    postRequest({ returnUrl: 'https://attacker.example' }),
    400,
    /Invalid portal request/,
  );
  await expectStatus(
    accountConfig,
    { method: 'POST', query: {}, headers: {}, socket: {} },
    405,
    /Method not allowed/,
  );
  await expectStatus(
    accountRouter,
    { method: 'GET', query: { action: 'config', debug: '1' }, headers: {}, socket: {} },
    404,
    /Not found/,
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
    410,
    /retired/,
  );

  const originalSiteUrl = process.env.PUBLIC_SITE_URL;
  const originalFetch = global.fetch;
  const originalAuthRequireUser = auth.requireUser;
  const originalAccountSubscription = billing.accountSubscription;
  const originalExistingAccountSubscription = billing.existingAccountSubscription;
  const originalCreatePortalSession = billing.createPortalSession;
  const originalStripeRequest = billing.stripeRequest;
  const originalOpenCheckoutForCustomer = billing.openCheckoutForCustomer;
  const originalStripeKey = process.env.STRIPE_SECRET_KEY;
  const originalCorePrice = process.env.STRIPE_CORE_PRICE_ID;
  const originalCoreEnabled = process.env.STRIPE_CORE_CHECKOUT_ENABLED;
  const originalSigningKey = process.env.ENTITLEMENT_PRIVATE_KEY;
  const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalSupportDataKey = process.env.SUPPORT_DATA_KEY;
  const originalAuthMasterKey = process.env.AUTH_MASTER_KEY;
  const originalListAccountSummaries = accountStore.listAccountSummaries;
  const originalAccountById = auth.accountById;
  const originalUpdateBillingMetadata = auth.updateBillingMetadata;
  const originalRequireAdmin = auth.requireAdmin;
  const originalCreateTicket = ticketStore.createTicket;
  const originalListTickets = ticketStore.listTickets;
  const originalUpdateTicket = ticketStore.updateTicket;
  process.env.PUBLIC_SITE_URL = 'https://tryzap.net';
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
    process.env.AUTH_MASTER_KEY = Buffer.alloc(32, 11).toString('base64url');
    const accountEmail = 'owner@example.com';
    const accountId = accountStore.accountIdForEmail(accountEmail);
    const accountFixture = {
      version: 1,
      accountId,
      email: accountEmail,
      password: { algorithm: 'scrypt', salt: 'a'.repeat(22), hash: 'b'.repeat(43), N: 32768, r: 8, p: 1 },
      recoveryHash: 'c'.repeat(43),
      sessionVersion: 1,
      failedAttempts: 0,
      lockUntil: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      stripeSubscriptionPlan: null,
      stripeEventCreated: 0,
      stripeEventId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    const encryptedAccount = accountStore.encodeAccount(accountFixture);
    assert.doesNotMatch(encryptedAccount, /owner@example\.com/);
    assert.equal(accountStore.decodeAccount(encryptedAccount, accountId).email, accountEmail);
    const sessionToken = accountStore.sessionToken(accountFixture, 2_000_000_000);
    assert.equal(accountStore.parseSessionToken(sessionToken, 2_000_000_001).sub, accountId);
    assert.equal(accountStore.parseSessionToken(`${sessionToken.slice(0, -1)}x`, 2_000_000_001), null);
    assert.equal(accountStore.passwordScore('A long Correct-Horse 2026!'), 4);
    assert.equal(accountStore.PASSWORD_MIN_LENGTH, 6);
    assert.doesNotThrow(() => accountStore.validatePassword('Zap123', accountEmail));
    assert.throws(() => accountStore.validatePassword('short', accountEmail), /weak_password/);
    assert.throws(() => accountStore.validatePassword('password1234567', accountEmail), /weak_password/);

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
    await expectStatus(
      supportTicket,
      supportRequest({ ...supportBody, description: 'The error contains password=super-secret-value and should never be stored.' }),
      400,
      /Remove passwords/,
    );

    process.env.SUPPORT_DATA_KEY = Buffer.alloc(32, 7).toString('base64url');
    const encryptedTicketFixture = {
      ...supportBody,
      status: 'open',
      audit: [{ action: 'created', at: new Date().toISOString(), actor: 'support-form' }],
      createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const encryptedTicket = ticketStore.encodeTicket(encryptedTicketFixture);
    assert.doesNotMatch(encryptedTicket, /taylor@example\.com/);
    assert.equal(
      ticketStore.decodeTicket(encryptedTicket, supportBody.submissionId).email,
      supportBody.email,
    );
    assert.throws(
      () => ticketStore.decodeTicket(encryptedTicket, '87654321-1234-4abc-8abc-1234567890ab'),
      /decryption_failed/,
    );

    const storedTickets = [];
    ticketStore.createTicket = async (ticket) => storedTickets.push(ticket);
    const response = mockResponse();
    await supportTicket(supportRequest(supportBody), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, ticketId: '12345678' });
    assert.equal(storedTickets.length, 1);
    assert.equal(storedTickets[0].submissionId, supportBody.submissionId);
    assert.equal(storedTickets[0].email, supportBody.email);
    assert.equal(storedTickets[0].description, supportBody.description);

    const adminFixture = { userId: `acct_${'a'.repeat(32)}`, email: 'owner@example.com' };
    auth.requireAdmin = async () => adminFixture;
    ticketStore.listTickets = async () => [{ ...storedTickets[0], status: 'open', audit: [] }];
    const adminListResponse = mockResponse();
    await adminTickets({
      method: 'GET',
      headers: { 'x-forwarded-for': '203.0.113.240' },
      query: {},
      socket: {},
    }, adminListResponse);
    assert.equal(adminListResponse.statusCode, 200);
    assert.equal(adminListResponse.body.tickets.length, 1);
    ticketStore.updateTicket = async (update, actor) => ({ ...storedTickets[0], ...update, actor: actor.userId, audit: [] });
    const adminUpdateResponse = mockResponse();
    const adminUpdateRequest = supportRequest({
      submissionId: supportBody.submissionId,
      status: 'in_progress',
      note: 'Reproduced on Windows.',
    });
    adminUpdateRequest.method = 'PATCH';
    await adminTickets(adminUpdateRequest, adminUpdateResponse);
    assert.equal(adminUpdateResponse.statusCode, 200);
    assert.equal(adminUpdateResponse.body.ticket.status, 'in_progress');
    assert.equal(adminUpdateResponse.body.ticket.actor, adminFixture.userId);

    const now = Date.now();
    process.env.STRIPE_CORE_PRICE_ID = `price_${'p'.repeat(24)}`;
    accountStore.listAccountSummaries = async () => ({
      total: 2,
      unreadableCount: 0,
      accounts: [
        {
          accountId: adminFixture.userId,
          email: adminFixture.email,
          createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: new Date(now).toISOString(),
          lastLoginAt: new Date(now).toISOString(),
          stripeCustomerId: 'cus_adminfixture',
          stripeSubscriptionId: 'sub_adminfixture',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPlan: 'core',
        },
        {
          accountId: `acct_${'b'.repeat(32)}`,
          email: 'student@example.com',
          createdAt: new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: new Date(now).toISOString(),
          lastLoginAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: null,
          stripeSubscriptionPlan: null,
        },
      ],
    });
    billing.stripeRequest = async (path) => {
      if (path.startsWith('/v1/subscriptions?')) {
        return { data: [{
          id: 'sub_adminfixture',
          status: 'active',
          created: Math.floor(now / 1000),
          cancel_at_period_end: false,
          metadata: { zap_account_id: adminFixture.userId, dt_d1: 'device_fixture' },
          items: { data: [{ quantity: 1, price: {
            id: process.env.STRIPE_CORE_PRICE_ID,
            currency: 'usd',
            unit_amount: 999,
            recurring: { interval: 'month', interval_count: 1 },
          } }] },
        }], has_more: false };
      }
      if (path.startsWith('/v1/charges?')) {
        return { data: [{
          id: 'ch_fixture',
          status: 'succeeded',
          paid: true,
          currency: 'usd',
          amount_captured: 999,
          amount_refunded: 100,
          created: Math.floor(now / 1000),
        }], has_more: false };
      }
      throw new Error(`Unexpected Stripe reporting path: ${path}`);
    };
    const adminStatsResponse = mockResponse();
    await adminStats({
      method: 'GET',
      headers: { 'x-forwarded-for': '203.0.113.241' },
      query: {},
      socket: {},
    }, adminStatsResponse);
    assert.equal(adminStatsResponse.statusCode, 200);
    assert.equal(adminStatsResponse.headers['cache-control'], 'no-store');
    assert.equal(adminStatsResponse.body.accounts.total, 2);
    assert.equal(adminStatsResponse.body.accounts.new7d, 1);
    assert.equal(adminStatsResponse.body.accounts.conversionRate, 50);
    assert.equal(adminStatsResponse.body.billing.mrrCents, 999);
    assert.equal(adminStatsResponse.body.billing.collectedRevenueCents, 899);
    assert.equal(adminStatsResponse.body.billing.activeDevices, 1);
    assert.equal(adminStatsResponse.body.billing.planBreakdown.core, 1);
    assert.equal(adminStatsResponse.body.support.open, 1);
    assert.equal(adminStatsResponse.body.trends.at(-1).revenueCents, 899);
    billing.stripeRequest = async () => {
      const error = new Error('Stripe permission required');
      error.code = 'more_permissions_required';
      throw error;
    };
    const degradedStatsResponse = mockResponse();
    await adminStats({
      method: 'GET',
      headers: { 'x-forwarded-for': '203.0.113.242' },
      query: {},
      socket: {},
    }, degradedStatsResponse);
    assert.equal(degradedStatsResponse.statusCode, 200);
    assert.equal(degradedStatsResponse.body.accounts.total, 2);
    assert.equal(degradedStatsResponse.body.billing.available, false);
    assert.equal(degradedStatsResponse.body.billing.mrrCents, null);

    process.env.STRIPE_SECRET_KEY = `sk_live_${'s'.repeat(32)}`;
    process.env.STRIPE_CORE_PRICE_ID = `price_${'p'.repeat(24)}`;
    process.env.STRIPE_CORE_CHECKOUT_ENABLED = 'true';
    process.env.ENTITLEMENT_PRIVATE_KEY = 'A'.repeat(64);
    auth.requireUser = async (_request, response) => {
      response.status(401).json({ error: 'Sign in to your Zap account to continue.' });
      return null;
    };
    await expectStatus(
      createCheckout,
      supportRequest({ plan: 'core' }),
      401,
      /Sign in to your Zap account/,
    );
    auth.requireUser = originalAuthRequireUser;
    const testAccount = { userId: `acct_${'f'.repeat(32)}`, email: 'taylor@example.com' };
    let unexpectedStripeRead = false;
    global.fetch = async () => {
      unexpectedStripeRead = true;
      throw new Error('A new account status check must not contact Stripe.');
    };
    assert.deepEqual(
      await billing.existingAccountSubscription({ ...testAccount, stripeCustomerId: null }),
      { customer: null, subscription: null },
    );
    assert.equal(unexpectedStripeRead, false);
    global.fetch = originalFetch;
    auth.requireUser = async () => testAccount;
    billing.accountSubscription = async () => ({
      customer: { id: 'cus_fixture' },
      subscription: { id: 'sub_fixture', status: 'active' },
    });
    billing.createPortalSession = async () => ({ url: 'https://billing.stripe.com/p/session_fixture' });
    const duplicateResponse = mockResponse();
    await createCheckout(supportRequest({ plan: 'core' }), duplicateResponse);
    assert.equal(duplicateResponse.statusCode, 200);
    assert.equal(duplicateResponse.body.kind, 'portal');
    assert.match(duplicateResponse.body.message, /instead of charging again/);

    const checkoutCalls = [];
    billing.accountSubscription = async () => ({ customer: { id: 'cus_fixture' }, subscription: null });
    billing.openCheckoutForCustomer = async () => null;
    billing.stripeRequest = async (path, options) => {
      checkoutCalls.push({ path, options });
      return { url: 'https://checkout.stripe.com/c/pay_fixture' };
    };
    const checkoutResponse = mockResponse();
    await createCheckout(supportRequest({ plan: 'core' }), checkoutResponse);
    assert.equal(checkoutResponse.statusCode, 200);
    assert.equal(checkoutResponse.body.kind, 'checkout');
    assert.equal(checkoutCalls.length, 1);
    assert.equal(checkoutCalls[0].path, '/v1/checkout/sessions');
    const checkoutForm = Object.fromEntries(checkoutCalls[0].options.body);
    assert.equal(checkoutForm.customer, 'cus_fixture');
    assert.equal(checkoutForm.client_reference_id, testAccount.userId);
    assert.equal(checkoutForm['metadata[zap_account_id]'], testAccount.userId);
    assert.equal(checkoutForm['subscription_data[metadata][zap_account_id]'], testAccount.userId);
    assert.equal(checkoutForm['line_items[0][price]'], process.env.STRIPE_CORE_PRICE_ID);
    assert.match(checkoutForm.cancel_url, /\/account\?plan=core&checkout=cancelled$/);
    assert.equal(checkoutForm.allow_promotion_codes, undefined);
    assert.equal(Object.keys(checkoutForm).some((key) => /trial/i.test(key)), false);
    assert.match(checkoutForm['custom_text[submit][message]'], /No free trial or money-back guarantee/);
    assert.match(checkoutCalls[0].options.headers['Idempotency-Key'], /^zap_checkout_[a-f0-9]{64}$/);
    assert.equal(Number(checkoutForm.expires_at) - Math.floor(Date.now() / 1000) <= 30 * 60, true);

    billing.openCheckoutForCustomer = async () => ({
      url: 'https://checkout.stripe.com/c/pay_existing',
      mode: 'subscription',
    });
    const resumedCheckoutResponse = mockResponse();
    await createCheckout(supportRequest({ plan: 'core' }), resumedCheckoutResponse);
    assert.equal(resumedCheckoutResponse.statusCode, 200);
    assert.equal(resumedCheckoutResponse.body.url, 'https://checkout.stripe.com/c/pay_existing');
    assert.match(resumedCheckoutResponse.body.message, /instead of creating another/);
    assert.equal(checkoutCalls.length, 1);

    process.env.STRIPE_WEBHOOK_SECRET = `whsec_${'w'.repeat(32)}`;
    const webhookUpdates = [];
    auth.accountById = async () => ({ stripeEventCreated: 0, stripeCustomerId: null });
    auth.updateBillingMetadata = async (userId, update) => webhookUpdates.push({ userId, update });
    const webhookEvent = {
      id: 'evt_subscriptionfixture',
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: 'sub_fixture',
        customer: 'cus_fixture',
        status: 'active',
        metadata: { zap_account_id: testAccount.userId, plan: 'core' },
      } },
    };
    const webhookRaw = Buffer.from(JSON.stringify(webhookEvent));
    const webhookTimestamp = Math.floor(Date.now() / 1000);
    const webhookSignature = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
      .update(`${webhookTimestamp}.`)
      .update(webhookRaw)
      .digest('hex');
    const webhookRequest = {
      method: 'POST',
      body: webhookRaw,
      headers: {
        'content-type': 'application/json',
        'content-length': String(webhookRaw.length),
        'stripe-signature': `t=${webhookTimestamp},v1=${webhookSignature}`,
      },
    };
    const webhookResponse = mockResponse();
    await stripeWebhook(webhookRequest, webhookResponse);
    assert.equal(webhookResponse.statusCode, 200);
    assert.equal(webhookUpdates.length, 1);
    assert.equal(webhookUpdates[0].userId, testAccount.userId);
    assert.equal(webhookUpdates[0].update.stripeSubscriptionStatus, 'active');
    const canceledTrials = [];
    billing.stripeRequest = async (path, options) => {
      canceledTrials.push({ path, options });
      return { ...webhookEvent.data.object, status: 'canceled' };
    };
    await stripeWebhook.mirrorSubscriptionEvent({
      ...webhookEvent,
      id: 'evt_trialfixture',
      data: { object: { ...webhookEvent.data.object, status: 'trialing' } },
    });
    assert.equal(canceledTrials.length, 1);
    assert.equal(canceledTrials[0].path, '/v1/subscriptions/sub_fixture');
    assert.equal(canceledTrials[0].options.method, 'DELETE');
    assert.equal(webhookUpdates.at(-1).update.stripeSubscriptionStatus, 'canceled');
    await expectStatus(
      stripeWebhook,
      { ...webhookRequest, headers: { ...webhookRequest.headers, 'stripe-signature': `t=${webhookTimestamp},v1=${'0'.repeat(64)}` } },
      400,
      /rejected/,
    );

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    process.env.ENTITLEMENT_PRIVATE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const subscribed = {
      id: 'sub_fixture',
      status: 'active',
      customer: 'cus_fixture',
      metadata: {},
      items: { data: [{ price: { id: process.env.STRIPE_CORE_PRICE_ID } }] },
    };
    const activationToken = billing.signedAppActivation(testAccount, subscribed, 'core', deviceId);
    const stripeActivationCalls = [];
    global.fetch = async (url, options = {}) => {
      stripeActivationCalls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => subscribed,
      };
    };
    const activationResponse = mockResponse();
    await claimAccountEntitlement(supportRequest({ activationToken, deviceId }), activationResponse);
    assert.equal(activationResponse.statusCode, 200);
    assert.equal(activationResponse.body.plan, 'core');
    assert.match(activationResponse.body.refreshToken, /^sub_fixture\.[A-Za-z0-9_-]{40,}$/);
    assert.equal(stripeActivationCalls.length, 2);
    assert.match(stripeActivationCalls[0].url, /\/v1\/subscriptions\/sub_fixture$/);
    assert.equal(stripeActivationCalls[1].options.method, 'POST');
    await assert.rejects(
      billing.subscriptionForAppActivation(activationToken, '4b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b'),
      /Invalid activation credential/,
    );
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...subscribed, status: 'trialing' }),
    });
    await assert.rejects(
      billing.subscriptionForAppActivation(activationToken, deviceId),
      /not active/,
    );

    auth.requireUser = async (_request, response) => {
      response.status(401).json({ error: 'Sign in to your Zap account to continue.' });
      return null;
    };
    await expectStatus(
      accountStatus,
      { method: 'GET', query: {}, headers: { 'x-forwarded-for': '203.0.113.230' }, socket: {} },
      401,
      /Sign in/,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalSiteUrl === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = originalSiteUrl;
    auth.requireUser = originalAuthRequireUser;
    auth.requireAdmin = originalRequireAdmin;
    billing.accountSubscription = originalAccountSubscription;
    billing.existingAccountSubscription = originalExistingAccountSubscription;
    billing.createPortalSession = originalCreatePortalSession;
    billing.stripeRequest = originalStripeRequest;
    billing.openCheckoutForCustomer = originalOpenCheckoutForCustomer;
    auth.accountById = originalAccountById;
    auth.updateBillingMetadata = originalUpdateBillingMetadata;
    ticketStore.createTicket = originalCreateTicket;
    ticketStore.listTickets = originalListTickets;
    ticketStore.updateTicket = originalUpdateTicket;
    accountStore.listAccountSummaries = originalListAccountSummaries;
    for (const [name, value] of [
      ['STRIPE_SECRET_KEY', originalStripeKey],
      ['STRIPE_CORE_PRICE_ID', originalCorePrice],
      ['STRIPE_CORE_CHECKOUT_ENABLED', originalCoreEnabled],
      ['ENTITLEMENT_PRIVATE_KEY', originalSigningKey],
      ['STRIPE_WEBHOOK_SECRET', originalWebhookSecret],
      ['SUPPORT_DATA_KEY', originalSupportDataKey],
      ['AUTH_MASTER_KEY', originalAuthMasterKey],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  console.log('Account, duplicate-billing, entitlement, and support API verification passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
