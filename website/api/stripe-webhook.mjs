import stripeWebhook from "../server/stripe-webhook-handler.js";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...headers },
  });
}

// The Web Standard `fetch` export receives an unconsumed Request. Reading its
// ArrayBuffer preserves the exact bytes Stripe signed, unlike the legacy
// request/response helper interface, which exposes parsed JSON in `body`.
export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" }, { Allow: "POST" });
    }
    const contentType = String(request.headers.get("content-type") || "")
      .split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonResponse(415, { error: "Unsupported webhook content" });
    }
    let event;
    try {
      const rawBody = Buffer.from(await request.arrayBuffer());
      event = stripeWebhook.parseVerifiedEvent(rawBody, request.headers.get("stripe-signature"));
    } catch (error) {
      console.warn("Stripe webhook rejected", { reason: stripeWebhook.rejectionReason(error) });
      return jsonResponse(400, { error: "Webhook was rejected" });
    }
    try {
      await stripeWebhook.mirrorSubscriptionEvent(event);
      return jsonResponse(200, { received: true });
    } catch {
      console.error("Stripe webhook processing failed", { type: "temporary_processing_failure" });
      return jsonResponse(503, { error: "Webhook is temporarily unavailable" });
    }
  },
};
