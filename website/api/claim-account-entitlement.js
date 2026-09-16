const billing = require("./_billing");

module.exports = async function claimAccountEntitlement(request, response) {
  if (!await billing.requirePost(request, response)) return;
  if (!billing.verifyRequestOrigin(request)) {
    return response.status(403).json({ error: "Request origin was rejected" });
  }
  let body;
  try {
    body = billing.parseBody(request, 3072);
  } catch {
    return response.status(400).json({ error: "Invalid JSON" });
  }
  if (!(billing.hasExactKeys(body, ["activationToken", "deviceId"]) || billing.hasExactKeys(body, ["activationToken", "deviceId", "codeVerifier"])) ||
      typeof body.activationToken !== "string" ||
      !billing.validDeviceId(body.deviceId)) {
    return response.status(400).json({ error: "Invalid activation request" });
  }
  try {
    const verified = await billing.subscriptionForAppActivation(body.activationToken, body.deviceId, body.codeVerifier);
    const saved = await billing.saveRefreshCredential(verified.subscription, body.deviceId);
    const entitlement = billing.signedEntitlement(saved.subscription, verified.plan, body.deviceId);
    return response.status(200).json({
      refreshToken: saved.refreshToken,
      entitlement: entitlement.token,
      plan: verified.plan,
      expiresAt: new Date(entitlement.payload.exp * 1000).toISOString(),
    });
  } catch (error) {
    console.error("Account entitlement claim failed", { code: error.code || "claim_failed" });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
