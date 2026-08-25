const auth = require("./_auth");
const billing = require("./_billing");
const ticketStore = require("../server/tickets");

function accountConfig(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.limitRequest(request, response, "account-config")) return;
  return response.status(200).json({
    configured: auth.configured(),
    publishableKey: auth.configured() ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY : "",
  });
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

const routes = Object.freeze({
  config: accountConfig,
  status: accountStatus,
  portal: createAccountPortal,
  activation: createAppActivation,
  tickets: adminTickets,
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
