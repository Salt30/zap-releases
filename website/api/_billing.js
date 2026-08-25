const {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} = require("node:crypto");

const ACTIVE_SUBSCRIPTION_STATES = new Set(["active", "trialing"]);
const BLOCKING_SUBSCRIPTION_STATES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);
const ALLOWED_PLANS = new Set(["core", "pro"]);
const MAX_DEVICES = 3;
const ENTITLEMENT_TTL_SECONDS = 72 * 60 * 60;
const STRIPE_API_VERSION = "2026-07-29.dahlia";
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const MAX_JSON_BODY_BYTES = 4096;
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

function validRefreshToken(value) {
  return /^sub_[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/.test(String(value || ""));
}

function validCustomerId(value) {
  return /^cus_[A-Za-z0-9]+$/.test(String(value || ""));
}

function validSubscriptionId(value) {
  return /^sub_[A-Za-z0-9]+$/.test(String(value || ""));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value) || !Array.isArray(expectedKeys)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isJsonRequest(request) {
  const contentType = String(request.headers?.["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return contentType === "application/json";
}

function parseBody(request, maximumBytes = MAX_JSON_BODY_BYTES) {
  const limit = Number.isSafeInteger(maximumBytes) && maximumBytes > 0
    ? maximumBytes
    : MAX_JSON_BODY_BYTES;
  let body = request.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > limit) throw new Error("Request body is too large");
    body = JSON.parse(body);
  }
  if (!isPlainObject(body)) throw new Error("Request body must be a JSON object");
  let encoded;
  try {
    encoded = JSON.stringify(body);
  } catch {
    throw new Error("Request body must be serializable JSON");
  }
  if (Buffer.byteLength(encoded, "utf8") > limit) throw new Error("Request body is too large");
  return body;
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
  if (!isJsonRequest(request)) {
    response.status(415).json({ error: "Content-Type must be application/json" });
    return false;
  }
  const rawLength = request.headers?.["content-length"];
  const declaredLength = rawLength === undefined ? 0 : Number(rawLength);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    response.status(400).json({ error: "Invalid Content-Length" });
    return false;
  }
  if (declaredLength > MAX_JSON_BODY_BYTES) {
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

async function openCheckoutForCustomer(customerId) {
  if (!validCustomerId(customerId)) throw new Error("Invalid customer");
  const query = new URLSearchParams({ customer: customerId, status: "open", limit: "10" });
  const result = await stripeRequest(`/v1/checkout/sessions?${query}`);
  const now = Math.floor(Date.now() / 1000);
  return (Array.isArray(result?.data) ? result.data : []).find((session) => (
    session?.mode === "subscription" &&
    /^https:\/\/checkout\.stripe\.com\//.test(session?.url || "") &&
    Number(session?.expires_at || 0) > now
  )) || null;
}

async function subscriptionById(subscriptionId) {
  if (!validSubscriptionId(subscriptionId)) {
    throw new Error("Invalid subscription");
  }
  return stripeRequest(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

async function subscriptionsForCustomer(customerId) {
  if (!validCustomerId(customerId)) throw new Error("Invalid customer");
  const query = new URLSearchParams({ customer: customerId, status: "all", limit: "100" });
  const result = await stripeRequest(`/v1/subscriptions?${query}`);
  return Array.isArray(result?.data) ? result.data : [];
}

function blockingSubscriptions(subscriptions) {
  return subscriptions.filter((item) => BLOCKING_SUBSCRIPTION_STATES.has(item?.status));
}

async function customerById(customerId) {
  if (!validCustomerId(customerId)) throw new Error("Invalid customer");
  const customer = await stripeRequest(`/v1/customers/${encodeURIComponent(customerId)}`);
  if (customer?.deleted) throw new Error("Invalid customer");
  return customer;
}

async function linkCustomerToAccount(customer, account) {
  if (!validCustomerId(customer?.id) || !/^acct_[A-Za-z0-9_-]{32}$/u.test(String(account?.userId || ""))) {
    throw new Error("Invalid account customer link");
  }
  if (
    customer.metadata?.zap_account_id === account.userId &&
    customer.metadata?.zap_account === accountKey(account.userId)
  ) return customer;
  return stripeRequest(`/v1/customers/${encodeURIComponent(customer.id)}`, {
    method: "POST",
    body: new URLSearchParams({
      "metadata[zap_account_id]": account.userId,
      "metadata[zap_account]": accountKey(account.userId),
    }),
    headers: { "Idempotency-Key": `zap_customer_link_${accountKey(account.userId)}` },
  });
}

function accountKey(userId) {
  return createHash("sha256").update(String(userId)).digest("base64url").slice(0, 32);
}

async function ensureAccountCustomer(account) {
  const savedId = String(account.stripeCustomerId || "");
  if (validCustomerId(savedId)) {
    try {
      return await linkCustomerToAccount(await customerById(savedId), account);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  const body = new URLSearchParams({
    email: account.email,
    "metadata[zap_account_id]": account.userId,
    "metadata[zap_account]": accountKey(account.userId),
  });
  let customer = await stripeRequest("/v1/customers", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": `zap_customer_${accountKey(account.userId)}` },
  });
  if (!validCustomerId(customer?.id)) throw new Error("Invalid customer");
  customer = await linkCustomerToAccount(customer, account);
  const auth = require("./_auth");
  await auth.updateBillingMetadata(account.userId, { stripeCustomerId: customer.id });
  return customer;
}

async function accountSubscription(account) {
  const customer = await ensureAccountCustomer(account);
  const subscriptions = await subscriptionsForCustomer(customer.id);
  const blocking = blockingSubscriptions(subscriptions)
    .sort((left, right) => Number(right.created || 0) - Number(left.created || 0));
  if (blocking.length > 1) {
    const error = new Error("Multiple subscriptions need support review");
    error.code = "duplicate_subscriptions";
    throw error;
  }
  return { customer, subscription: blocking[0] || null };
}

async function createPortalSession(customerId, returnPath = "/account") {
  if (!validCustomerId(customerId)) throw new Error("Invalid customer");
  const safePath = /^\/[A-Za-z0-9/_?=&.-]*$/.test(returnPath) ? returnPath : "/account";
  const portal = await stripeRequest("/v1/billing_portal/sessions", {
    method: "POST",
    body: new URLSearchParams({
      customer: customerId,
      return_url: `${configuredSiteOrigin()}${safePath}`,
    }),
  });
  if (!/^https:\/\/billing\.stripe\.com\//.test(portal?.url || "")) {
    throw new Error("Invalid portal URL");
  }
  return portal;
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

function privateSigningKey() {
  const encoded = process.env.ENTITLEMENT_PRIVATE_KEY || "";
  if (!/^[A-Za-z0-9+/=]{40,200}$/.test(encoded)) {
    throw new Error("Entitlement signing key is not configured");
  }
  return createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
}

function signedAppActivation(account, subscription, plan, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "EdDSA", kid: "drip-type-v1", typ: "JWT" }));
  const payloadObject = {
    v: 1,
    purpose: "app_activation",
    iss: "https://tryzap.net",
    aud: "com.salt30.driptype",
    account: accountKey(account.userId),
    subscription: subscription.id,
    plan,
    device: deviceHash(deviceId),
    nonce: randomBytes(16).toString("base64url"),
    iat: now,
    exp: now + 5 * 60,
  };
  const payload = base64url(JSON.stringify(payloadObject));
  const signingInput = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput), privateSigningKey()).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function subscriptionForAppActivation(token, deviceId) {
  if (typeof token !== "string" || token.length > 2048 || !validDeviceId(deviceId)) {
    throw new Error("Invalid activation credential");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Invalid activation credential");
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid activation credential");
  }
  const signature = Buffer.from(parts[2], "base64url");
  const signatureValid = verify(
    null,
    Buffer.from(signingInput),
    createPublicKey(privateSigningKey()),
    signature,
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    !signatureValid ||
    header?.alg !== "EdDSA" ||
    payload?.purpose !== "app_activation" ||
    payload?.iss !== "https://tryzap.net" ||
    payload?.aud !== "com.salt30.driptype" ||
    payload?.device !== deviceHash(deviceId) ||
    !validSubscriptionId(payload?.subscription) ||
    !ALLOWED_PLANS.has(payload?.plan) ||
    !Number.isSafeInteger(payload?.iat) ||
    !Number.isSafeInteger(payload?.exp) ||
    payload.exp <= now ||
    payload.iat > now + 30 ||
    payload.exp - payload.iat > 5 * 60
  ) {
    throw new Error("Invalid activation credential");
  }
  const subscription = await subscriptionById(payload.subscription);
  assertSubscriptionActive(subscription);
  const plan = planForSubscription(subscription);
  if (plan !== payload.plan) throw new Error("Subscription plan mismatch");
  return { subscription, plan };
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
  if (error?.code === "duplicate_subscriptions") {
    return { status: 409, message: "We found more than one subscription for this email. Contact support before purchasing again." };
  }
  if (/Device limit reached/.test(message)) return { status: 409, message };
  if (/not active/.test(message)) return { status: 402, message: "Subscription is not active" };
  if (/Invalid|rejected|not complete|mismatch|not approved/.test(message)) {
    return { status: 403, message: "Subscription could not be verified" };
  }
  return { status: 503, message: "Subscription service is temporarily unavailable" };
}

Object.assign(apiNotFound, {
  accountKey,
  accountSubscription,
  blockingSubscriptions,
  configuredSiteOrigin,
  createPortalSession,
  ensureAccountCustomer,
  hasExactKeys,
  isJsonRequest,
  parseBody,
  publicError,
  planForSubscription,
  limitRequest,
  linkCustomerToAccount,
  openCheckoutForCustomer,
  requirePost,
  saveRefreshCredential,
  secureResponse,
  signedEntitlement,
  signedAppActivation,
  stripeRequest,
  subscriptionForAppActivation,
  subscriptionForRefresh,
  subscriptionsForCustomer,
  validCustomerId,
  validDeviceId,
  validRefreshToken,
  verifyRequestOrigin,
});

module.exports = apiNotFound;
