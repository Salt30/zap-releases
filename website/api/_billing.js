const {
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
  timingSafeEqual,
} = require("node:crypto");

const ACTIVE_SUBSCRIPTION_STATES = new Set(["active", "trialing"]);
const ALLOWED_PLANS = new Set(["core", "pro"]);
const MAX_DEVICES = 3;
const ENTITLEMENT_TTL_SECONDS = 72 * 60 * 60;
const STRIPE_API_VERSION = "2026-06-24.dahlia";
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const rateLimits = new Map();

const PLAN_CONFIG = Object.freeze({
  core: {
    priceVariable: "STRIPE_CORE_PRICE_ID",
    features: ["composer", "typing", "hotkeys", "templates", "updates"],
  },
  pro: {
    priceVariable: "STRIPE_PRO_PRICE_ID",
    features: [
      "composer",
      "typing",
      "hotkeys",
      "templates",
      "updates",
      "profiles",
      "clipboard",
      "template_library",
      "batch",
      "writing_lab",
    ],
  },
});

function apiNotFound(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(404).json({ error: "Not found" });
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function deviceHash(deviceId) {
  return createHash("sha256").update(deviceId).digest("base64url").slice(0, 40);
}

function refreshHash(refreshSecret) {
  return createHash("sha256").update(refreshSecret).digest("base64url");
}

function validDeviceId(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    String(value || ""),
  );
}

function validCheckoutSessionId(value) {
  return /^cs_live_[A-Za-z0-9_]{20,}$/.test(String(value || ""));
}

function validRefreshToken(value) {
  return /^sub_[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/.test(String(value || ""));
}

function parseBody(request) {
  if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
    return request.body;
  }
  if (typeof request.body === "string" && request.body.length <= 4096) {
    return JSON.parse(request.body);
  }
  return {};
}

function secureResponse(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function clientAddress(request) {
  return String(request.headers?.["x-forwarded-for"] || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 128);
}

function limitRequest(request, response, bucket = "billing") {
  const now = Date.now();
  const key = `${bucket}:${clientAddress(request)}`;
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    if (rateLimits.size > 1000) {
      for (const [candidate, value] of rateLimits) {
        if (now - value.startedAt >= RATE_WINDOW_MS) rateLimits.delete(candidate);
      }
    }
    return true;
  }
  current.count += 1;
  if (current.count <= RATE_LIMIT) return true;
  response.setHeader("Retry-After", "60");
  response.status(429).json({ error: "Too many attempts. Please wait and try again." });
  return false;
}

function requirePost(request, response) {
  secureResponse(response);
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return false;
  }
  if (Number(request.headers["content-length"] || 0) > 4096) {
    response.status(413).json({ error: "Request too large" });
    return false;
  }
  return limitRequest(request, response);
}

function configuredSiteOrigin() {
  const configured = process.env.PUBLIC_SITE_URL;
  if (!configured) throw new Error("PUBLIC_SITE_URL is required");
  const url = new URL(configured);
  const allowedHosts = new Set(["tryzap.net", "www.tryzap.net", "drip-type.vercel.app"]);
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new Error("PUBLIC_SITE_URL is not an approved HTTPS origin");
  }
  return url.origin;
}

function verifyRequestOrigin(request) {
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) return true;
  return requestOrigin === configuredSiteOrigin();
}

function stripeKey() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!/^(?:rk|sk)_live_[A-Za-z0-9]+$/.test(key)) {
    throw new Error("A live Stripe server key is required");
  }
  return key;
}

async function stripeRequest(path, options = {}) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
      ...(options.headers || {}),
    },
    body: options.body,
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error("Stripe request failed");
    error.status = response.status;
    error.code = result?.error?.code || result?.error?.type || "stripe_error";
    throw error;
  }
  return result;
}

async function checkoutSession(sessionId) {
  if (!validCheckoutSessionId(sessionId)) throw new Error("Invalid checkout session");
  return stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`);
}

async function subscriptionById(subscriptionId) {
  if (!/^sub_[A-Za-z0-9]+$/.test(String(subscriptionId || ""))) {
    throw new Error("Invalid subscription");
  }
  return stripeRequest(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

function planForSubscription(subscription, sessionPlan = "") {
  const items = subscription?.items?.data;
  const priceId = items?.[0]?.price?.id || "";
  if (!priceId || items.length !== 1) throw new Error("Invalid subscription items");
  const match = Object.entries(PLAN_CONFIG).find(([, config]) => (
    process.env[config.priceVariable] === priceId
  ));
  if (!match) throw new Error("Subscription price is not approved");
  const plan = match[0];
  if (sessionPlan && sessionPlan !== plan) throw new Error("Subscription plan mismatch");
  return plan;
}

function assertSubscriptionActive(subscription) {
  if (!ACTIVE_SUBSCRIPTION_STATES.has(subscription?.status)) {
    throw new Error("Subscription is not active");
  }
}

async function verifiedCheckout(sessionId) {
  const session = await checkoutSession(sessionId);
  const sessionPlan = String(session?.metadata?.plan || "").toLowerCase();
  if (
    session?.mode !== "subscription" ||
    session?.status !== "complete" ||
    !["paid", "no_payment_required"].includes(session?.payment_status) ||
    !ALLOWED_PLANS.has(sessionPlan)
  ) {
    throw new Error("Checkout is not complete");
  }
  const subscription = typeof session.subscription === "object"
    ? session.subscription
    : await subscriptionById(session.subscription);
  assertSubscriptionActive(subscription);
  const plan = planForSubscription(subscription, sessionPlan);
  return { session, subscription, plan };
}

function privateSigningKey() {
  const encoded = process.env.ENTITLEMENT_PRIVATE_KEY || "";
  if (!/^[A-Za-z0-9+/=]{40,200}$/.test(encoded)) {
    throw new Error("Entitlement signing key is not configured");
  }
  return createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
}

function signedEntitlement(subscription, plan, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "EdDSA", kid: "drip-type-v1", typ: "JWT" }));
  const payloadObject = {
    v: 1,
    iss: "https://tryzap.net",
    aud: "com.salt30.driptype",
    sub: createHash("sha256").update(subscription.id).digest("base64url"),
    plan,
    features: PLAN_CONFIG[plan].features,
    device: deviceHash(deviceId),
    iat: now,
    exp: now + ENTITLEMENT_TTL_SECONDS,
  };
  const payload = base64url(JSON.stringify(payloadObject));
  const signingInput = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput), privateSigningKey()).toString("base64url");
  return { token: `${signingInput}.${signature}`, payload: payloadObject };
}

function deviceSlot(subscription, requestedDeviceHash) {
  const metadata = subscription.metadata || {};
  for (let slot = 1; slot <= MAX_DEVICES; slot += 1) {
    if (metadata[`dt_d${slot}`] === requestedDeviceHash) return slot;
  }
  for (let slot = 1; slot <= MAX_DEVICES; slot += 1) {
    if (!metadata[`dt_d${slot}`]) return slot;
  }
  throw new Error("Device limit reached");
}

async function saveRefreshCredential(subscription, deviceId) {
  const requestedDeviceHash = deviceHash(deviceId);
  const slot = deviceSlot(subscription, requestedDeviceHash);
  const secret = randomBytes(32).toString("base64url");
  const body = new URLSearchParams({
    [`metadata[dt_d${slot}]`]: requestedDeviceHash,
    [`metadata[dt_r${slot}]`]: refreshHash(secret),
  });
  const updated = await stripeRequest(`/v1/subscriptions/${encodeURIComponent(subscription.id)}`, {
    method: "POST",
    body,
  });
  return { subscription: updated, refreshToken: `${subscription.id}.${secret}` };
}

async function subscriptionForRefresh(refreshToken, deviceId) {
  if (!validRefreshToken(refreshToken) || !validDeviceId(deviceId)) {
    throw new Error("Invalid activation credential");
  }
  const separator = refreshToken.indexOf(".");
  const subscriptionId = refreshToken.slice(0, separator);
  const secret = refreshToken.slice(separator + 1);
  const subscription = await subscriptionById(subscriptionId);
  assertSubscriptionActive(subscription);
  const requestedDeviceHash = deviceHash(deviceId);
  const metadata = subscription.metadata || {};
  let valid = false;
  for (let slot = 1; slot <= MAX_DEVICES; slot += 1) {
    if (
      safeEqual(metadata[`dt_d${slot}`] || "", requestedDeviceHash) &&
      safeEqual(metadata[`dt_r${slot}`] || "", refreshHash(secret))
    ) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new Error("Activation credential was rejected");
  const plan = planForSubscription(subscription);
  return { subscription, plan };
}

function publicError(error) {
  const message = String(error?.message || "");
  if (/Device limit reached/.test(message)) return { status: 409, message };
  if (/not active/.test(message)) return { status: 402, message: "Subscription is not active" };
  if (/Invalid|rejected|not complete|mismatch|not approved/.test(message)) {
    return { status: 403, message: "Subscription could not be verified" };
  }
  return { status: 503, message: "Subscription service is temporarily unavailable" };
}

Object.assign(apiNotFound, {
  checkoutSession,
  configuredSiteOrigin,
  parseBody,
  publicError,
  limitRequest,
  requirePost,
  saveRefreshCredential,
  secureResponse,
  signedEntitlement,
  stripeRequest,
  subscriptionForRefresh,
  validCheckoutSessionId,
  validDeviceId,
  validRefreshToken,
  verifiedCheckout,
  verifyRequestOrigin,
});

module.exports = apiNotFound;
