const billing = require("./_billing");

module.exports = async function checkoutStatus(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.limitRequest(request, response, "checkout-status")) return;
  const sessionId = String(request.query?.session_id || "");
  if (!billing.validCheckoutSessionId(sessionId)) {
    return response.status(400).json({ error: "Invalid checkout session" });
  }
  try {
    const { plan } = await billing.verifiedCheckout(sessionId);
    return response.status(200).json({ confirmed: true, plan });
  } catch (error) {
    console.error("Checkout verification failed", {
      code: error.code || "verification_failed",
      status: error.status || 0,
    });
    return response.status(403).json({ error: "Checkout could not be verified" });
  }
};
