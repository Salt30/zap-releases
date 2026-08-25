const auth = require("./_auth");
const billing = require("./_billing");

module.exports = async function createAccountPortal(request, response) {
  if (!billing.requirePost(request, response)) return;
  if (!billing.verifyRequestOrigin(request)) {
    return response.status(403).json({ error: "Request origin was rejected" });
  }
  let body;
  try {
    body = billing.parseBody(request, 256);
  } catch {
    return response.status(400).json({ error: "Invalid JSON" });
  }
  if (!billing.hasExactKeys(body, [])) {
    return response.status(400).json({ error: "Invalid portal request" });
  }
  const account = await auth.requireUser(request, response);
  if (!account) return;
  try {
    const { customer, subscription } = await billing.accountSubscription(account);
    if (!subscription) return response.status(404).json({ error: "No subscription was found for this account." });
    const portal = await billing.createPortalSession(customer.id);
    return response.status(200).json({ url: portal.url });
  } catch (error) {
    console.error("Account portal failed", { code: error.code || "account_portal_failed" });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
