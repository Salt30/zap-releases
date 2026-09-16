const accounts = require("../server/accounts");

function configured() {
  return accounts.storageConfigured();
}

async function authenticatedUser(request) {
  const account = await accounts.accountForRequest(request);
  if (!account) return null;
  return {
    userId: account.accountId,
    email: account.email,
    stripeCustomerId: account.stripeCustomerId,
    stripeSubscriptionId: account.stripeSubscriptionId,
    stripeSubscriptionStatus: account.stripeSubscriptionStatus,
    stripeSubscriptionPlan: account.stripeSubscriptionPlan,
    stripeEventCreated: account.stripeEventCreated,
    stripeCheckoutUrl: account.stripeCheckoutUrl || null,
    stripeCheckoutPlan: account.stripeCheckoutPlan || null,
    stripeCheckoutExpiresAt: account.stripeCheckoutExpiresAt || null,
  };
}

async function requireUser(request, response) {
  if (!configured()) {
    response.status(503).json({ error: "Zap accounts are temporarily unavailable." });
    return null;
  }
  try {
    const account = await authenticatedUser(request);
    if (!account) {
      response.status(401).json({ error: "Sign in to your Zap account to continue." });
      return null;
    }
    return account;
  } catch (error) {
    console.error("Account authentication failed", { code: "auth_failed" });
    response.status(401).json({ error: "Your sign-in could not be verified. Please sign in again." });
    return null;
  }
}

function adminEmails() {
  return new Set(String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)));
}

function adminUserIds() {
  return new Set(String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((userId) => userId.trim())
    .filter(accounts.validAccountId));
}

async function requireAdmin(request, response) {
  const account = await requireUser(request, response);
  if (!account) return null;
  const allowedEmails = adminEmails();
  const allowedUserIds = adminUserIds();
  if (!allowedEmails.size || !allowedUserIds.size) {
    response.status(503).json({ error: "The support console is temporarily unavailable." });
    return null;
  }
  if (!allowedEmails.has(account.email) || !allowedUserIds.has(account.userId)) {
    response.status(403).json({ error: "This account is not authorized for the support console." });
    return null;
  }
  return account;
}

module.exports = {
  accountById: accounts.accountById,
  authenticatedUser,
  adminEmails,
  adminUserIds,
  configured,
  requireAdmin,
  requireUser,
  updateBillingMetadata: accounts.updateBillingMetadata,
};
