const auth = require("./_auth");
const billing = require("./_billing");
const ticketStore = require("../server/tickets");
const accounts = require("../server/accounts");
const { timingSafeEqual } = require("node:crypto");

function cronAuthorized(request) {
  const expected = String(process.env.CRON_SECRET || "");
  const supplied = String(request.headers?.authorization || "");
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(expected) || !supplied.startsWith("Bearer ")) return false;
  const actual = supplied.slice(7);
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function accountConfig(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.limitRequest(request, response, "account-config")) return;
  return response.status(200).json({
    configured: auth.configured(),
    passwordMinLength: accounts.PASSWORD_MIN_LENGTH,
  });
}

function trustedMutation(request) {
  const origin = String(request.headers?.origin || "");
  const fetchSite = String(request.headers?.["sec-fetch-site"] || "same-origin");
  return Boolean(origin) && billing.verifyRequestOrigin(request) && ["same-origin", "none"].includes(fetchSite);
}

function authBody(request, response, keys, maximumBytes = 1024) {
  if (!billing.requirePost(request, response)) return null;
  if (!trustedMutation(request)) {
    response.status(403).json({ error: "Request origin was rejected" });
    return null;
  }
  try {
    const body = billing.parseBody(request, maximumBytes);
    if (!billing.hasExactKeys(body, keys)) throw new Error("invalid_auth_request");
    return body;
  } catch {
    response.status(400).json({ error: "Invalid account request" });
    return null;
  }
}

async function registerAccount(request, response) {
  const body = authBody(request, response, ["email", "password"]);
  if (!body) return;
  try {
    const created = await accounts.createAccount(body.email, body.password);
    accounts.setSessionCookie(response, created.account);
    return response.status(201).json({
      email: created.account.email,
      accountId: created.account.accountId,
      recoveryCode: created.recoveryCode,
    });
  } catch (error) {
    if (error.message === "account_exists") {
      return response.status(409).json({ error: "An account already exists for this email. Sign in instead." });
    }
    if (["invalid_email", "weak_password"].includes(error.message)) {
      return response.status(400).json({ error: "Use a valid email and a strong password with at least 15 characters." });
    }
    console.error("Account registration failed", { code: error.message || "register_failed" });
    return response.status(503).json({ error: "Account creation is temporarily unavailable." });
  }
}

async function loginAccount(request, response) {
  const body = authBody(request, response, ["email", "password"]);
  if (!body) return;
  try {
    const account = await accounts.authenticate(body.email, body.password);
    accounts.setSessionCookie(response, account);
    return response.status(200).json({ email: account.email, accountId: account.accountId });
  } catch (error) {
    if (error.message === "account_locked") {
      return response.status(429).json({ error: "This account is temporarily locked. Wait 15 minutes and try again." });
    }
    if (["invalid_credentials", "invalid_email"].includes(error.message)) {
      return response.status(401).json({ error: "The email or password is incorrect." });
    }
    console.error("Account login failed", { code: error.message || "login_failed" });
    return response.status(503).json({ error: "Sign-in is temporarily unavailable." });
  }
}

async function logoutAccount(request, response) {
  const body = authBody(request, response, []);
  if (!body) return;
  accounts.clearSessionCookie(response);
  return response.status(200).json({ signedOut: true });
}

async function recoverAccount(request, response) {
  const body = authBody(request, response, ["email", "recoveryCode", "password"], 1536);
  if (!body) return;
  try {
    const recovered = await accounts.resetPassword(body.email, body.recoveryCode, body.password);
    accounts.setSessionCookie(response, recovered.account);
    return response.status(200).json({
      email: recovered.account.email,
      accountId: recovered.account.accountId,
      recoveryCode: recovered.recoveryCode,
    });
  } catch (error) {
    if (["invalid_recovery", "invalid_email"].includes(error.message)) {
      return response.status(401).json({ error: "The account or recovery code could not be verified." });
    }
    if (error.message === "weak_password") {
      return response.status(400).json({ error: "Use a stronger password with at least 15 characters." });
    }
    console.error("Account recovery failed", { code: error.message || "recovery_failed" });
    return response.status(503).json({ error: "Account recovery is temporarily unavailable." });
  }
}

async function accountStatus(request, response) {
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
      accountId: account.userId,
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
}

async function createAccountPortal(request, response) {
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
    if (!subscription) {
      return response.status(404).json({ error: "No subscription was found for this account." });
    }
    const portal = await billing.createPortalSession(customer.id);
    return response.status(200).json({ url: portal.url });
  } catch (error) {
    console.error("Account portal failed", { code: error.code || "account_portal_failed" });
    const safe = billing.publicError(error);
    return response.status(safe.status).json({ error: safe.message });
  }
}

async function createAppActivation(request, response) {
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
}

async function adminTickets(request, response) {
  billing.secureResponse(response);
  if (!["GET", "PATCH"].includes(request.method)) {
    response.setHeader("Allow", "GET, PATCH");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.limitRequest(request, response, "admin-tickets")) return;
  const account = await auth.requireAdmin(request, response);
  if (!account) return;
  if (request.method === "GET") {
    try {
      return response.status(200).json({ tickets: await ticketStore.listTickets() });
    } catch (error) {
      console.error("Admin ticket list failed", { code: error.name || error.message || "ticket_list_failed" });
      return response.status(503).json({ error: "Tickets are temporarily unavailable." });
    }
  }
  if (!billing.verifyRequestOrigin(request)) {
    return response.status(403).json({ error: "Request origin was rejected" });
  }
  if (!billing.isJsonRequest(request)) {
    return response.status(415).json({ error: "Content-Type must be application/json" });
  }
  let body;
  try {
    body = billing.parseBody(request, 3072);
  } catch {
    return response.status(400).json({ error: "Invalid ticket update" });
  }
  if (!billing.hasExactKeys(body, ["submissionId", "status", "note"]) ||
      !ticketStore.validId(body.submissionId) || !ticketStore.STATUSES.has(body.status) ||
      typeof body.note !== "string") {
    return response.status(400).json({ error: "Invalid ticket update" });
  }
  try {
    const ticket = await ticketStore.updateTicket(body, account);
    return response.status(200).json({ ticket });
  } catch (error) {
    if (error?.message === "ticket_not_found") {
      return response.status(404).json({ error: "Ticket not found" });
    }
    if (error?.name === "BlobPreconditionFailedError") {
      return response.status(409).json({ error: "This ticket changed. Refresh and try again." });
    }
    console.error("Admin ticket update failed", { code: error.name || error.message || "ticket_update_failed" });
    return response.status(503).json({ error: "The ticket could not be updated." });
  }
}

async function purgeSupportTickets(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!cronAuthorized(request)) return response.status(401).json({ error: "Unauthorized" });
  try {
    return response.status(200).json(await ticketStore.purgeExpiredTickets());
  } catch (error) {
    console.error("Support retention purge failed", { code: error.name || error.message || "purge_failed" });
    return response.status(503).json({ error: "Support retention is temporarily unavailable." });
  }
}

const routes = Object.freeze({
  config: accountConfig,
  register: registerAccount,
  login: loginAccount,
  logout: logoutAccount,
  recover: recoverAccount,
  status: accountStatus,
  portal: createAccountPortal,
  activation: createAppActivation,
  tickets: adminTickets,
  purge: purgeSupportTickets,
});

async function accountRouter(request, response) {
  const query = request.query || {};
  if (!billing.hasExactKeys(query, ["action"]) || !Object.hasOwn(routes, query.action)) {
    return billing(request, response);
  }
  request.query = {};
  return routes[query.action](request, response);
}

accountRouter.routes = routes;
module.exports = accountRouter;
