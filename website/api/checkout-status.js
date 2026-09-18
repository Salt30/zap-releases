const billing = require("./_billing");
const accounts = require("../server/accounts");

module.exports = async function checkoutStatus(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!await billing.limitRequest(request, response, "checkout-status")) return;
  const query = request.query || {};
  if (!billing.hasExactKeys(query, ["session_id"]) || !billing.validCheckoutSessionId(query.session_id)) {
    return response.status(400).json({ error: "Invalid checkout session" });
  }
  try {
    const { session, plan } = await billing.paidCheckoutSession(query.session_id);
    const email = accounts.normalizeEmail(session.customer_details?.email || session.customer?.email || "");
    return response.status(200).json({ paid: true, plan, email });
  } catch (error) {
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
