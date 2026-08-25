const auth = require("./_auth");
const billing = require("./_billing");

module.exports = async function accountStatus(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.limitRequest(request, response, "account-status")) return;
  const account = await auth.requireUser(request, response);
  if (!account) return;
  try {
    const { subscription } = await billing.accountSubscription(account);
    let plan = null;
    if (subscription && ["active", "trialing"].includes(subscription.status)) {
      plan = billing.planForSubscription(subscription);
    }
    return response.status(200).json({
      email: account.email,
      subscription: subscription ? {
        status: subscription.status,
        plan,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      } : null,
    });
  } catch (error) {
    console.error("Account status failed", { code: error.code || "account_status_failed" });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
};
