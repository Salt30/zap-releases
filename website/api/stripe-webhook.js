const { createHmac, timingSafeEqual } = require("node:crypto");
const auth = require("./_auth");
const billing = require("./_billing");

const MAX_BODY_BYTES = 128 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

function secureResponse(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function webhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!/^whsec_[A-Za-z0-9_-]{20,}$/.test(secret)) throw new Error("Webhook is not configured");
  return secret;
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(rawBody, signatureHeader, now = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) {
    throw new Error("Invalid webhook body");
  }
  const fields = String(signatureHeader || "").split(",").map((part) => part.trim());
  const timestampField = fields.find((part) => part.startsWith("t="));
  const timestamp = Number(timestampField?.slice(2));
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS || !signatures.length) {
    throw new Error("Invalid webhook signature");
  }
  const expected = createHmac("sha256", webhookSecret())
    .update(String(timestamp))
    .update(".")
    .update(rawBody)
    .digest("hex");
  if (!signatures.some((candidate) => safeHexEqual(candidate, expected))) {
    throw new Error("Invalid webhook signature");
  }
}

async function rawRequestBody(request) {
  const declared = Number(request.headers?.["content-length"] || 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new Error("Invalid webhook body");
  }
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === "string") return Buffer.from(request.body, "utf8");
  if (request.body !== undefined && request.body !== null) throw new Error("Webhook body was already parsed");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Invalid webhook body");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function validEvent(event) {
  return event && typeof event === "object" && !Array.isArray(event) &&
    /^evt_[A-Za-z0-9]+$/.test(String(event.id || "")) &&
    typeof event.type === "string" && Number.isSafeInteger(event.created) &&
    event.data && typeof event.data === "object" &&
    event.data.object && typeof event.data.object === "object" && !Array.isArray(event.data.object);
}

async function mirrorSubscriptionEvent(event) {
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return;
  let subscription = event.data.object;
  const userId = String(subscription.metadata?.zap_account_id || "");
  if (!/^acct_[A-Za-z0-9_-]{32}$/u.test(userId) || !/^sub_[A-Za-z0-9]+$/.test(String(subscription.id || ""))) {
    return;
  }
  const account = await auth.accountById(userId);
  if (!account) return;
  // Trials are intentionally unsupported. If one is ever created outside the
  // approved Checkout path, cancel it immediately so it cannot grant access or
  // turn into a surprise future charge.
  if (subscription.status === "trialing") {
    subscription = await billing.stripeRequest(
      `/v1/subscriptions/${encodeURIComponent(subscription.id)}`,
      { method: "DELETE" },
    );
    if (subscription?.status !== "canceled") throw new Error("Trial cancellation failed");
  }
  const previousCreated = Number(account.stripeEventCreated || 0);
  if (Number.isSafeInteger(previousCreated) && previousCreated > event.created) return;
  const plan = ["core", "pro"].includes(subscription.metadata?.plan) ? subscription.metadata.plan : null;
  await auth.updateBillingMetadata(userId, {
    stripeCustomerId: /^cus_[A-Za-z0-9]+$/.test(String(subscription.customer || ""))
      ? subscription.customer
      : account.stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: /^[a-z_]{1,40}$/u.test(String(subscription.status || ""))
      ? subscription.status
      : "unknown",
    stripeSubscriptionPlan: plan,
    stripeEventCreated: event.created,
    stripeEventId: event.id,
  });
}

async function stripeWebhook(request, response) {
  secureResponse(response);
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  const contentType = String(request.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return response.status(415).json({ error: "Unsupported webhook content" });
  let event;
  try {
    const rawBody = await rawRequestBody(request);
    verifySignature(rawBody, request.headers?.["stripe-signature"]);
    event = JSON.parse(rawBody.toString("utf8"));
    if (!validEvent(event)) return response.status(400).json({ error: "Invalid webhook event" });
  } catch {
    return response.status(400).json({ error: "Webhook was rejected" });
  }
  try {
    await mirrorSubscriptionEvent(event);
    return response.status(200).json({ received: true });
  } catch {
    console.error("Stripe webhook processing failed", { type: "temporary_processing_failure" });
    return response.status(503).json({ error: "Webhook is temporarily unavailable" });
  }
}

stripeWebhook.config = { api: { bodyParser: false } };
Object.assign(stripeWebhook, { mirrorSubscriptionEvent, rawRequestBody, verifySignature });
module.exports = stripeWebhook;
