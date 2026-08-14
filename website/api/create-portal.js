const billing = require("./_billing");

module.exports = async function createPortal(request, response) {
  if (!billing.requirePost(request, response)) return;
  let body;
  try {
    body = billing.parseBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON" });
  }
  const refreshToken = String(body.refreshToken || "");
  const deviceId = String(body.deviceId || "");
  if (!billing.validRefreshToken(refreshToken) || !billing.validDeviceId(deviceId)) {
    return response.status(400).json({ error: "Invalid portal request" });
  }
  try {
    const { subscription } = await billing.subscriptionForRefresh(refreshToken, deviceId);
    const customerId = typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
    if (!/^cus_[A-Za-z0-9]+$/.test(String(customerId || ""))) {
      throw new Error("Invalid customer");
    }
    const form = new URLSearchParams({
      customer: customerId,
      return_url: `${billing.configuredSiteOrigin()}/#pricing`,
    });
    const portal = await billing.stripeRequest("/v1/billing_portal/sessions", {
      method: "POST",
      body: form,
    });
    if (!/^https:\/\/billing\.stripe\.com\//.test(portal.url || "")) {
      throw new Error("Invalid portal URL");
    }
    return response.status(200).json({ url: portal.url });
  } catch (error) {
    console.error("Billing portal failed", {
      code: error.code || "portal_failed",
      status: error.status || 0,
    });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
