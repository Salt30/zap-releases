const { randomBytes, randomUUID } = require("node:crypto");

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
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (Number(request.headers["content-length"] || 0) > 1024) {
    return response.status(413).json({ error: "Request too large." });
  }
  if (isRateLimited(request)) {
    response.setHeader("Retry-After", "60");
    return response.status(429).json({ error: "Too many attempts. Please wait and try again." });
  }

  let body;
  try {
    body = typeof request.body === "string" ? JSON.parse(request.body) : request.body || {};
  } catch {
    return response.status(400).json({ error: "Invalid JSON." });
  }
  const planId = String(body.plan || "").toLowerCase();
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
    const form = new URLSearchParams({
      mode: "subscription",
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#pricing`,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      allow_promotion_codes: "true",
      billing_address_collection: "auto",
      integration_identifier: integrationIdentifier(),
      "metadata[plan]": planId,
      "subscription_data[metadata][plan]": planId,
    });

    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": "2026-06-24.dahlia",
          "Idempotency-Key": randomUUID(),
        },
        body: form,
        signal: AbortSignal.timeout(12_000),
      },
    );

    const session = await stripeResponse.json();
    if (!stripeResponse.ok || !session.url) {
      console.error("Stripe checkout error", {
        status: stripeResponse.status,
        type: session?.error?.type,
        code: session?.error?.code,
      });
      return response.status(502).json({
        error: "Secure checkout could not be started. Please try again.",
      });
    }

    return response.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Checkout endpoint error", { message: error.message });
    return response.status(500).json({
      error: "Secure checkout could not be started. Please try again.",
    });
  }
};
