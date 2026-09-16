const billing = require("./_billing");

module.exports = async function refreshEntitlement(request, response) {
  if (!await billing.requirePost(request, response)) return;
  let body;
  try {
    body = billing.parseBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON" });
  }
  if (!billing.hasExactKeys(body, ["refreshToken", "deviceId"]) ||
      typeof body.refreshToken !== "string" || typeof body.deviceId !== "string" ||
      !billing.validRefreshToken(body.refreshToken) || !billing.validDeviceId(body.deviceId)) {
    return response.status(400).json({ error: "Invalid refresh request" });
  }
  const { refreshToken, deviceId } = body;
  try {
    const verified = await billing.subscriptionForRefresh(refreshToken, deviceId);
    const entitlement = billing.signedEntitlement(verified.subscription, verified.plan, deviceId);
    return response.status(200).json({
      entitlement: entitlement.token,
      plan: verified.plan,
      expiresAt: new Date(entitlement.payload.exp * 1000).toISOString(),
    });
  } catch (error) {
    console.error("Entitlement refresh failed", {
      code: error.code || "refresh_failed",
      status: error.status || 0,
    });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
