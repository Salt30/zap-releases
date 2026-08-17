const billing = require("./_billing");

module.exports = async function claimEntitlement(request, response) {
  if (!billing.requirePost(request, response)) return;
  if (!billing.verifyRequestOrigin(request)) {
    return response.status(403).json({ error: "Request origin was rejected" });
  }
  let body;
  try {
    body = billing.parseBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON" });
  }
  if (!billing.hasExactKeys(body, ["sessionId", "deviceId"]) ||
      typeof body.sessionId !== "string" || typeof body.deviceId !== "string" ||
      !billing.validCheckoutSessionId(body.sessionId) || !billing.validDeviceId(body.deviceId)) {
    return response.status(400).json({ error: "Invalid activation request" });
  }
  const { sessionId, deviceId } = body;
  try {
    const verified = await billing.verifiedCheckout(sessionId);
    const saved = await billing.saveRefreshCredential(verified.subscription, deviceId);
    const entitlement = billing.signedEntitlement(saved.subscription, verified.plan, deviceId);
    return response.status(200).json({
      refreshToken: saved.refreshToken,
      entitlement: entitlement.token,
      plan: verified.plan,
      expiresAt: new Date(entitlement.payload.exp * 1000).toISOString(),
    });
  } catch (error) {
    console.error("Entitlement claim failed", {
      code: error.code || "claim_failed",
      status: error.status || 0,
    });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
