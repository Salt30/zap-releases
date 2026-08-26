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

function validCheckoutUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" &&
      !url.username && !url.password;
  } catch {
    return false;
  }
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

  let checkoutStage = "request_validation";
  try {
    checkoutStage = "origin_validation";
    const origin = getSiteOrigin(request);
    const requestOrigin = request.headers.origin;
    const fetchSite = String(request.headers["sec-fetch-site"] || "same-origin");
    if ((requestOrigin && requestOrigin !== origin) || !["same-origin", "none"].includes(fetchSite)) {
      return response.status(403).json({ error: "Request origin was rejected." });
    }
    const account = await auth.requireUser(request, response);
    if (!account) return;
    checkoutStage = "subscription_lookup";
    const { customer, subscription } = await billing.existingAccountSubscription(account);
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
    const checkoutCreatedAt = Math.floor(Date.now() / 1000);
    const pendingCheckoutIsOpen = validCheckoutUrl(account.stripeCheckoutUrl) &&
      Number.isSafeInteger(account.stripeCheckoutExpiresAt) &&
      account.stripeCheckoutExpiresAt > checkoutCreatedAt;
    if (pendingCheckoutIsOpen && account.stripeCheckoutPlan !== planId) {
      return response.status(409).json({
        error: `A ${account.stripeCheckoutPlan === "pro" ? "Pro" : "Core"} checkout is already open. Finish it or try again after it expires.`,
      });
    }
    if (pendingCheckoutIsOpen) {
      return response.status(200).json({
        kind: "checkout",
        url: account.stripeCheckoutUrl,
        message: "Returning to the checkout already open for this account instead of creating another.",
      });
    }
    const form = new URLSearchParams({
      mode: "subscription",
      success_url: `${origin}/account?purchase=complete`,
      cancel_url: `${origin}/account?plan=${encodeURIComponent(planId)}&checkout=cancelled`,
      client_reference_id: account.userId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "custom_text[submit][message]": "No free trial or money-back guarantee. Subscription renews monthly until canceled. Cancellation stops future renewals and does not refund the current paid period. Mandatory legal rights still apply.",
      billing_address_collection: "auto",
      integration_identifier: integrationIdentifier(),
      expires_at: String(checkoutCreatedAt + 30 * 60),
      "metadata[zap_account_id]": account.userId,
      "metadata[plan]": planId,
      "metadata[zap_account]": billing.accountKey(account.userId),
      "subscription_data[metadata][zap_account_id]": account.userId,
      "subscription_data[metadata][plan]": planId,
      "subscription_data[metadata][zap_account]": billing.accountKey(account.userId),
    });
    if (customer) {
      form.set("customer", customer.id);
      form.set("customer_update[address]", "auto");
      form.set("customer_update[name]", "auto");
    } else {
      form.set("customer_email", account.email);
    }
    const bucket = Math.floor(Date.now() / (30 * 60 * 1000));
    const idempotency = createHash("sha256")
      .update(`${account.userId}:${bucket}`)
      .digest("hex");
    checkoutStage = "checkout_session_create";
    const session = await billing.stripeRequest("/v1/checkout/sessions", {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": `zap_checkout_${idempotency}` },
    });
    const responseChecks = {
      liveSessionId: /^cs_live_[A-Za-z0-9_]+$/.test(String(session?.id || "")),
      hostedUrl: validCheckoutUrl(session?.url),
      futureExpiry: Number.isSafeInteger(session?.expires_at) && session.expires_at > checkoutCreatedAt,
    };
    checkoutStage = "checkout_response_validation";
    if (!Object.values(responseChecks).every(Boolean)) {
      console.error("Checkout response validation failed", responseChecks);
      const error = new Error("Invalid checkout response");
      error.code = "invalid_checkout_response";
      error.operation = "validate_checkout_response";
      throw error;
    }
    checkoutStage = "pending_checkout_persist";
    try {
      await auth.updateBillingMetadata(account.userId, {
        stripeCheckoutUrl: session.url,
        stripeCheckoutPlan: planId,
        stripeCheckoutExpiresAt: session.expires_at,
      });
    } catch (error) {
      const safeMessage = /^[a-z0-9_]{1,80}$/u.test(String(error?.message || ""))
        ? error.message
        : String(error?.message || "storage_provider_error")
          .replace(/https?:\/\/\S+/gu, "[url]")
          .replace(/[A-Za-z0-9_-]{20,}/gu, "[redacted]")
          .slice(0, 160);
      console.error("Pending checkout persistence failed", {
        name: String(error?.name || "Error").slice(0, 80),
        code: safeMessage,
      });
      throw error;
    }
    return response.status(200).json({ kind: "checkout", url: session.url });
  } catch (error) {
    console.error("Checkout endpoint error", {
      code: error.code || "checkout_failed",
      operation: error.operation || "checkout_flow",
      stage: checkoutStage,
    });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
