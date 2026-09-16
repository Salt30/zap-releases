const { createHash } = require("node:crypto");
const billing = require("./_billing");
const accounts = require("../server/accounts");
const attempts = require("../server/checkout-attempts");

const PLANS = Object.freeze({
  core: { priceVariable: "STRIPE_CORE_PRICE_ID" },
});


function validCheckoutUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function checkoutCustomer(email, accountId) {
  const customers = await billing.customersByEmail(email);
  const account = await accounts.accountById(accountId);
  if (account?.stripeCustomerId && !customers.some((customer) => customer.id === account.stripeCustomerId)) {
    try {
      const saved = await billing.stripeRequest(`/v1/customers/${encodeURIComponent(account.stripeCustomerId)}`);
      if (billing.validCustomerId(saved?.id) && !saved.deleted) customers.unshift(saved);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  for (const customer of customers) {
    const linkedAccount = String(customer.metadata?.zap_account_id || "");
    if (linkedAccount && linkedAccount !== accountId) {
      const error = new Error("Customer needs support review");
      error.code = "customer_account_conflict";
      throw error;
    }
    const subscriptions = billing.blockingSubscriptions(await billing.subscriptionsForCustomer(customer.id));
    if (subscriptions.length) return { customer, subscriptions };
  }
  if (customers[0]) return { customer: customers[0], subscriptions: [] };
  const customer = await billing.stripeRequest("/v1/customers", {
    method: "POST",
    body: new URLSearchParams({ email }),
    headers: {
      "Idempotency-Key": `zap_guest_customer_${createHash("sha256").update(email).digest("hex")}`,
    },
  });
  if (!billing.validCustomerId(customer?.id)) throw new Error("Invalid customer");
  return { customer, subscriptions: [] };
}

module.exports = async function createCheckout(request, response) {
  if (!await billing.requirePost(request, response, "checkout")) return;
  let body;
  try {
    body = billing.parseBody(request, 1536);
  } catch {
    return response.status(400).json({ error: "Invalid JSON." });
  }
  if (!billing.hasExactKeys(body, ["plan", "email", "checkoutNonce"]) ||
      typeof body.plan !== "string" || typeof body.email !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(String(body.checkoutNonce || ""))) {
    return response.status(400).json({ error: "Invalid checkout request." });
  }
  if (!billing.verifyRequestOrigin(request) || !request.headers.origin ||
      !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"] || "same-origin"))) {
    return response.status(403).json({ error: "Request origin was rejected." });
  }
  const planId = body.plan.toLowerCase();
  const plan = Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
  if (!plan) return response.status(400).json({ error: "Invalid plan." });
  const priceId = process.env[plan.priceVariable] || "";
  const launchFlag = planId === "core"
    ? process.env.STRIPE_CORE_CHECKOUT_ENABLED
    : process.env.STRIPE_PRO_CHECKOUT_ENABLED;
  const configured = /^(?:rk|sk)_live_[A-Za-z0-9]+$/.test(process.env.STRIPE_SECRET_KEY || "") &&
    /^[A-Za-z0-9+/=]{40,200}$/.test(process.env.ENTITLEMENT_PRIVATE_KEY || "") &&
    launchFlag === "true" && /^price_[A-Za-z0-9]+$/.test(priceId);
  if (!configured) return response.status(503).json({ error: "This plan is not available yet." });

  let stage = "request_validation";
  try {
    const email = accounts.normalizeEmail(body.email);
    const origin = billing.configuredSiteOrigin();
    const accountId = accounts.accountIdForEmail(email);
    stage = "customer_lookup";
    const { customer, subscriptions } = await checkoutCustomer(email, accountId);
    if (subscriptions.length) {
      const openSession = subscriptions.some((subscription) => subscription.status === "incomplete")
        ? await billing.openCheckoutForCustomer(customer.id)
        : null;
      const nonceHash = createHash('sha256').update(body.checkoutNonce).digest('hex');
      if (openSession?.metadata?.plan === planId && openSession.metadata.checkout_proof === nonceHash && validCheckoutUrl(openSession.url)) {
        return response.status(200).json({ kind: "checkout", url: openSession.url, resumed: true });
      }
      return response.status(200).json({
        kind: "account",
        url: "/account?mode=signin&billing=existing",
        message: "A subscription or checkout already exists for this email. Sign in instead of paying again.",
      });
    }

    // An open session exists before Stripe creates an incomplete subscription.
    // Never create a competing session, or reveal another browser's private URL.
    const openSession = await billing.openCheckoutForCustomer(customer.id);
    const nonceHash = createHash('sha256').update(body.checkoutNonce).digest('hex');
    if (openSession) {
      if (openSession.metadata?.plan === planId && openSession.metadata?.checkout_proof === nonceHash && validCheckoutUrl(openSession.url)) {
        return response.status(200).json({ kind: 'checkout', url: openSession.url, resumed: true });
      }
      throw Object.assign(new Error('checkout_in_progress'), { code: 'checkout_in_progress' });
    }
    const attempt = await attempts.reserve(accountId, planId, customer.id, priceId, body.checkoutNonce);
    const createdAt = attempt.createdAt;
    const reference = createHash("sha256").update(`${accountId}:${attempt.proof}:${createdAt}`).digest("hex").slice(0, 32);
    const form = new URLSearchParams({
      mode: "subscription",
      success_url: `${origin}/account?purchase=complete&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#pricing`,
      client_reference_id: `purchase_${reference}`,
      customer: customer.id,
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "custom_text[submit][message]": "No free trial or money-back guarantee. Subscription renews monthly until canceled. Cancellation stops future renewals and does not refund the current paid period. Mandatory legal rights still apply.",
      billing_address_collection: "auto",
      integration_identifier: `driptype_${attempt.integration}`,
      expires_at: String(attempt.expiresAt),
      "metadata[checkout_proof]": attempt.proof,
      "metadata[plan]": planId,
      "metadata[purchase_flow]": "payment_first_v1",
      "subscription_data[metadata][plan]": planId,
      "subscription_data[metadata][purchase_flow]": "payment_first_v1",
    });
    const idempotency = createHash("sha256").update(`${accountId}:${attempt.proof}:${createdAt}`).digest("hex");
    stage = "checkout_session_create";
    const session = await billing.stripeRequest("/v1/checkout/sessions", {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": `zap_checkout_${idempotency}` },
    });
    const valid = /^cs_live_[A-Za-z0-9_]+$/.test(String(session?.id || "")) &&
      validCheckoutUrl(session?.url) && Number.isSafeInteger(session?.expires_at) && session.expires_at > createdAt;
    if (!valid) throw new Error("Invalid checkout response");
    return response.status(200).json({ kind: "checkout", url: session.url });
  } catch (error) {
    console.error("Checkout endpoint error", {
      code: error.code || "checkout_failed",
      operation: error.operation || "checkout_flow",
      stage,
    });
    if (error.code === 'checkout_in_progress') {
      return response.status(409).json({ error: 'A checkout is already open for this email. Return to that payment tab, or wait up to 35 minutes for it to expire before starting another.' });
    }
    if (error.code === "customer_account_conflict") {
      return response.status(409).json({ error: "This email needs support review before another payment can be started." });
    }
    if (error.message === "invalid_email") {
      return response.status(400).json({ error: "Enter a valid email address." });
    }
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
