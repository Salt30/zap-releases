const auth = require("./_auth");
const billing = require("./_billing");

module.exports = async function createAppActivation(request, response) {
  if (!billing.requirePost(request, response)) return;
  if (!billing.verifyRequestOrigin(request)) {
    return response.status(403).json({ error: "Request origin was rejected" });
  }
  let body;
  try {
    body = billing.parseBody(request, 512);
  } catch {
    return response.status(400).json({ error: "Invalid JSON" });
  }
  if (!billing.hasExactKeys(body, ["deviceId"]) || !billing.validDeviceId(body.deviceId)) {
    return response.status(400).json({ error: "Invalid device connection request" });
  }
  const account = await auth.requireUser(request, response);
  if (!account) return;
  try {
    const { subscription } = await billing.accountSubscription(account);
    if (!subscription || !["active", "trialing"].includes(subscription.status)) {
      return response.status(402).json({ error: "This account does not have an active subscription." });
    }
    const plan = billing.planForSubscription(subscription);
    const token = billing.signedAppActivation(account, subscription, plan, body.deviceId);
    return response.status(200).json({
      url: `driptype://account?token=${encodeURIComponent(token)}`,
      expiresIn: 300,
    });
  } catch (error) {
    console.error("App activation creation failed", { code: error.code || "activation_failed" });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
