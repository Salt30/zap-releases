const { createHash, randomBytes } = require("node:crypto");
const auth = require("./_auth");
const billing = require("./_billing");

const PLANS = Object.freeze({
  core: { priceVariable: "STRIPE_CORE_PRICE_ID" },
  pro: { priceVariable: "STRIPE_PRO_PRICE_ID" },
});

const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 8;

function integrationIdentifier() {
  const suffix = [...randomBytes(8)]
    .map((value) => String.fromCharCode(97 + (value % 26)))
    .join("");
  return `driptype_${suffix}`;
}

function clientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 128);
}

function isRateLimited(request) {
  const now = Date.now();
  const address = clientAddress(request);
  const current = rateLimits.get(address);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(address, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT;
}

function getSiteOrigin(request) {
  const configured = process.env.PUBLIC_SITE_URL;
  if (!configured) throw new Error("PUBLIC_SITE_URL is required");
  const url = new URL(configured);
  const allowedHosts = new Set(["tryzap.net", "www.tryzap.net", "drip-type.vercel.app"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password || url.pathname !== "/") {
    throw new Error("PUBLIC_SITE_URL is not an approved HTTPS origin");
  }
  return url.origin;
}

module.exports = async function createCheckout(request, response) {
  if (!billing.requirePost(request, response)) return;
  if (isRateLimited(request)) {
    response.setHeader("Retry-After", "60");
    return response.status(429).json({ error: "Too many attempts. Please wait and try again." });
  }

  let body;
  try {
    body = billing.parseBody(request, 1024);
  } catch {
    return response.status(400).json({ error: "Invalid JSON." });
  }
  if (!billing.hasExactKeys(body, ["plan"]) || typeof body.plan !== "string") {
    return response.status(400).json({ error: "Invalid checkout request." });
  }
  const planId = body.plan.toLowerCase();
  const plan = PLANS[planId];
  if (!plan) return response.status(400).json({ error: "Invalid plan." });
  const priceId = process.env[plan.priceVariable] || "";

  const launchFlag =
    planId === "core"
      ? process.env.STRIPE_CORE_CHECKOUT_ENABLED
      : process.env.STRIPE_PRO_CHECKOUT_ENABLED;
  const hasStripeKey = /^(?:rk|sk)_live_[A-Za-z0-9]+$/.test(process.env.STRIPE_SECRET_KEY || "");
  const hasSigningKey = /^[A-Za-z0-9+/=]{40,200}$/.test(process.env.ENTITLEMENT_PRIVATE_KEY || "");
  if (!hasStripeKey || !hasSigningKey || launchFlag !== "true" || !/^price_[A-Za-z0-9]+$/.test(priceId)) {
    return response.status(503).json({ error: "This plan is not available yet." });
  }

  try {
    const origin = getSiteOrigin(request);
    const requestOrigin = request.headers.origin;
    const fetchSite = String(request.headers["sec-fetch-site"] || "same-origin");
    if ((requestOrigin && requestOrigin !== origin) || !["same-origin", "none"].includes(fetchSite)) {
      return response.status(403).json({ error: "Request origin was rejected." });
    }
    const account = await auth.requireUser(request, response);
    if (!account) return;
    const { customer, subscription } = await billing.accountSubscription(account);
    if (subscription) {
      if (subscription.status === "incomplete") {
        return response.status(409).json({
          error: "A checkout is already in progress for this account. Finish it or try again after it expires.",
        });
      }
      const portal = await billing.createPortalSession(customer.id);
      return response.status(200).json({
        kind: "portal",
        url: portal.url,
        message: "This account already has a subscription. Opening billing management instead of charging again.",
      });
    }
    const existingCheckout = await billing.openCheckoutForCustomer(customer.id);
    if (existingCheckout) {
      return response.status(200).json({
        kind: "checkout",
        url: existingCheckout.url,
        message: "Returning to the checkout already open for this account instead of creating another.",
      });
    }
    const checkoutCreatedAt = Math.floor(Date.now() / 1000);
    const form = new URLSearchParams({
      mode: "subscription",
      success_url: `${origin}/account?purchase=complete`,
      cancel_url: `${origin}/account?plan=${encodeURIComponent(planId)}&checkout=cancelled`,
      customer: customer.id,
      client_reference_id: account.userId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "custom_text[submit][message]": "No free trial or money-back guarantee. Subscription renews monthly until canceled. Cancellation stops future renewals and does not refund the current paid period. Mandatory legal rights still apply.",
      billing_address_collection: "auto",
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      integration_identifier: integrationIdentifier(),
      expires_at: String(checkoutCreatedAt + 30 * 60),
      "metadata[zap_account_id]": account.userId,
      "metadata[plan]": planId,
      "metadata[zap_account]": billing.accountKey(account.userId),
      "subscription_data[metadata][zap_account_id]": account.userId,
      "subscription_data[metadata][plan]": planId,
      "subscription_data[metadata][zap_account]": billing.accountKey(account.userId),
    });
    const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
    const idempotency = createHash("sha256")
      .update(`${account.userId}:${bucket}`)
      .digest("hex");
    const session = await billing.stripeRequest("/v1/checkout/sessions", {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": `zap_checkout_${idempotency}` },
    });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(session?.url || "")) {
      throw new Error("Invalid checkout URL");
    }
    return response.status(200).json({ kind: "checkout", url: session.url });
  } catch (error) {
    console.error("Checkout endpoint error", { code: error.code || "checkout_failed" });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
