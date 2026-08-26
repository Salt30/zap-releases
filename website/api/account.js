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
      return response.status(400).json({ error: "Use a valid email and a password with 6+ characters using a mix of letters, numbers, or symbols." });
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
      return response.status(400).json({ error: "Use a password with 6+ characters using a mix of letters, numbers, or symbols." });
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
    const { subscription } = await billing.existingAccountSubscription(account);
    let plan = null;
    if (subscription?.status === "active") {
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
    const { customer, subscription } = await billing.existingAccountSubscription(account);
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
    const { subscription } = await billing.existingAccountSubscription(account);
    if (subscription?.status !== "active") {
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

async function stripeList(path, parameters, maximumPages = 50) {
  const data = [];
  let startingAfter = "";
  let complete = true;
  for (let page = 0; page < maximumPages; page += 1) {
    const query = new URLSearchParams(parameters);
    query.set("limit", "100");
    if (startingAfter) query.set("starting_after", startingAfter);
    const result = await billing.stripeRequest(`${path}?${query}`);
    const pageData = Array.isArray(result?.data) ? result.data : [];
    data.push(...pageData);
    if (!result?.has_more) return { data, complete };
    startingAfter = String(pageData.at(-1)?.id || "");
    if (!startingAfter) throw new Error("stripe_pagination_failed");
  }
  complete = false;
  return { data, complete };
}

function timestamp(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : "";
}

function recent(value, days, now = Date.now()) {
  const parsed = timestamp(value);
  return parsed > 0 && parsed >= now - days * 24 * 60 * 60 * 1000;
}

function recurringMonthlyCents(subscription) {
  return (Array.isArray(subscription?.items?.data) ? subscription.items.data : []).reduce((total, item) => {
    const price = item?.price;
    const amount = Number(price?.unit_amount ?? price?.unit_amount_decimal);
    const quantity = Number(item?.quantity || 1);
    const intervalCount = Math.max(1, Number(price?.recurring?.interval_count || 1));
    if (!Number.isFinite(amount) || !Number.isFinite(quantity) || amount < 0 || quantity < 0) return total;
    const interval = price?.recurring?.interval;
    const divisor = interval === "year" ? 12 * intervalCount
      : interval === "week" ? (52 / 12) * intervalCount
        : interval === "day" ? (365 / 12) * intervalCount
          : intervalCount;
    return total + Math.round((amount * quantity) / divisor);
  }, 0);
}

function subscriptionPlan(subscription) {
  try {
    return billing.planForSubscription(subscription);
  } catch {
    return null;
  }
}

function accountMetrics(summary, now = Date.now()) {
  const source = Array.isArray(summary.accounts) ? summary.accounts : [];
  return {
    total: Number(summary.total || source.length),
    readable: source.length,
    unreadable: Number(summary.unreadableCount || 0),
    new7d: source.filter((account) => recent(account.createdAt, 7, now)).length,
    new30d: source.filter((account) => recent(account.createdAt, 30, now)).length,
    active30d: source.filter((account) => recent(account.lastLoginAt, 30, now)).length,
    connectedToStripe: source.filter((account) => account.stripeCustomerId).length,
  };
}

function supportMetrics(tickets) {
  const source = Array.isArray(tickets) ? tickets : [];
  return {
    available: true,
    totalVisible: source.length,
    open: source.filter((ticket) => ticket.status === "open").length,
    inProgress: source.filter((ticket) => ticket.status === "in_progress").length,
    resolved: source.filter((ticket) => ticket.status === "resolved").length,
    new7d: source.filter((ticket) => recent(ticket.createdAt, 7)).length,
  };
}

function fallbackBillingMetrics(accountList) {
  const active = accountList.filter((account) => account.stripeSubscriptionStatus === "active");
  return {
    available: false,
    message: "Stripe reporting permissions are incomplete. User and support statistics are still current.",
    currency: "usd",
    mrrCents: null,
    collectedRevenueCents: null,
    revenue30dCents: null,
    refundsCents: null,
    activeSubscriptions: active.length,
    trials: accountList.filter((account) => account.stripeSubscriptionStatus === "trialing").length,
    pastDue: accountList.filter((account) => account.stripeSubscriptionStatus === "past_due").length,
    pendingCancellation: 0,
    cancelled30d: 0,
    failedPayments30d: 0,
    activeDevices: null,
    planBreakdown: {
      core: active.filter((account) => account.stripeSubscriptionPlan === "core").length,
      pro: active.filter((account) => account.stripeSubscriptionPlan === "pro").length,
    },
    complete: false,
  };
}

function stripeMetrics(subscriptionsResult, chargesResult, now = Date.now()) {
  const subscriptions = subscriptionsResult.data;
  const charges = chargesResult.data;
  const active = subscriptions.filter((subscription) => subscription.status === "active");
  const paid = charges.filter((charge) => charge.status === "succeeded" && charge.paid);
  const currencySet = new Set([
    ...paid.map((charge) => charge.currency),
    ...active.flatMap((subscription) => (subscription.items?.data || []).map((item) => item.price?.currency)),
  ].filter(Boolean));
  const currency = currencySet.size === 1 ? [...currencySet][0] : currencySet.size ? "mixed" : "usd";
  const thirtyDaysAgoSeconds = Math.floor((now - 30 * 24 * 60 * 60 * 1000) / 1000);
  const collected = paid.reduce((sum, charge) => sum + Math.max(0, Number(charge.amount_captured || 0) - Number(charge.amount_refunded || 0)), 0);
  const revenue30d = paid.filter((charge) => Number(charge.created || 0) >= thirtyDaysAgoSeconds)
    .reduce((sum, charge) => sum + Math.max(0, Number(charge.amount_captured || 0) - Number(charge.amount_refunded || 0)), 0);
  const refunds = paid.reduce((sum, charge) => sum + Math.max(0, Number(charge.amount_refunded || 0)), 0);
  const planBreakdown = { core: 0, pro: 0 };
  active.forEach((subscription) => {
    const plan = subscriptionPlan(subscription);
    if (plan) planBreakdown[plan] += 1;
  });
  return {
    available: true,
    message: currency === "mixed" ? "Multiple charge currencies were found; combined currency totals need separate review." : "",
    currency,
    mrrCents: active.filter((subscription) => subscription.status === "active")
      .reduce((sum, subscription) => sum + recurringMonthlyCents(subscription), 0),
    collectedRevenueCents: collected,
    revenue30dCents: revenue30d,
    refundsCents: refunds,
    activeSubscriptions: active.length,
    trials: subscriptions.filter((subscription) => subscription.status === "trialing").length,
    pastDue: subscriptions.filter((subscription) => subscription.status === "past_due").length,
    pendingCancellation: active.filter((subscription) => subscription.cancel_at_period_end).length,
    cancelled30d: subscriptions.filter((subscription) => (
      subscription.status === "canceled" && Number(subscription.canceled_at || 0) >= thirtyDaysAgoSeconds
    )).length,
    failedPayments30d: charges.filter((charge) => (
      charge.status === "failed" && Number(charge.created || 0) >= thirtyDaysAgoSeconds
    )).length,
    activeDevices: active.reduce((total, subscription) => total + [1, 2, 3]
      .filter((slot) => subscription.metadata?.[`dt_d${slot}`]).length, 0),
    planBreakdown,
    complete: Boolean(subscriptionsResult.complete && chargesResult.complete),
  };
}

function businessTrends(accountList, charges, now = Date.now()) {
  const months = [];
  const cursor = new Date(now);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - offset, 1));
    months.push({
      month: monthKey(date),
      label: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date),
      revenueCents: 0,
      signups: 0,
    });
  }
  const byMonth = new Map(months.map((month) => [month.month, month]));
  accountList.forEach((account) => {
    const bucket = byMonth.get(monthKey(account.createdAt));
    if (bucket) bucket.signups += 1;
  });
  charges.filter((charge) => charge.status === "succeeded" && charge.paid).forEach((charge) => {
    const bucket = byMonth.get(monthKey(Number(charge.created || 0) * 1000));
    if (bucket) bucket.revenueCents += Math.max(0, Number(charge.amount_captured || 0) - Number(charge.amount_refunded || 0));
  });
  return months;
}

async function adminStats(request, response) {
  billing.secureResponse(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.limitRequest(request, response, "admin-stats")) return;
  const admin = await auth.requireAdmin(request, response);
  if (!admin) return;

  let accountSummary;
  try {
    accountSummary = await accounts.listAccountSummaries();
  } catch (error) {
    console.error("Admin account metrics failed", { code: error.message || "account_metrics_failed" });
    return response.status(503).json({ error: "Account statistics are temporarily unavailable." });
  }
  // Reserved example.com accounts with these prefixes are production smoke
  // probes, never customers. Keep release verification from polluting business
  // metrics or the recent-user list.
  const accountList = accountSummary.accounts.filter((account) => (
    !/^flow-(?:probe|guard)-\d+@example\.com$/u.test(String(account.email || ""))
  ));
  const excludedProbeAccounts = accountSummary.accounts.length - accountList.length;
  const accountStats = accountMetrics({
    ...accountSummary,
    accounts: accountList,
    total: Math.max(0, accountSummary.total - excludedProbeAccounts),
  });
  let tickets = [];
  let support = { available: false, totalVisible: 0, open: 0, inProgress: 0, resolved: 0, new7d: 0 };
  try {
    tickets = await ticketStore.listTickets();
    support = supportMetrics(tickets);
  } catch (error) {
    console.error("Admin support metrics failed", { code: error.name || error.message || "support_metrics_failed" });
  }

  let billingStats = fallbackBillingMetrics(accountList);
  let charges = [];
  let subscriptions = [];
  try {
    const subscriptionQuery = new URLSearchParams({ status: "all" });
    subscriptionQuery.append("expand[]", "data.items.data.price");
    const [subscriptionsResult, chargesResult] = await Promise.all([
      stripeList("/v1/subscriptions", subscriptionQuery),
      stripeList("/v1/charges", new URLSearchParams()),
    ]);
    subscriptions = subscriptionsResult.data;
    charges = chargesResult.data;
    billingStats = stripeMetrics(subscriptionsResult, chargesResult);
  } catch (error) {
    console.error("Admin Stripe metrics unavailable", { code: error.code || "stripe_metrics_failed" });
  }

  const subscriptionByAccount = new Map();
  subscriptions.forEach((subscription) => {
    const accountId = String(subscription.metadata?.zap_account_id || "");
    if (!accounts.validAccountId(accountId)) return;
    const previous = subscriptionByAccount.get(accountId);
    if (!previous || Number(subscription.created || 0) > Number(previous.created || 0)) {
      subscriptionByAccount.set(accountId, subscription);
    }
  });
  const recentAccounts = [...accountList]
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    .slice(0, 50)
    .map((account) => {
      const subscription = subscriptionByAccount.get(account.accountId);
      return {
        email: account.email,
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt,
        plan: subscription ? subscriptionPlan(subscription) : account.stripeSubscriptionPlan,
        status: subscription?.status || account.stripeSubscriptionStatus || "free",
      };
    });
  const conversionRate = accountStats.total
    ? Math.round((billingStats.activeSubscriptions / accountStats.total) * 1000) / 10
    : 0;
  return response.status(200).json({
    generatedAt: new Date().toISOString(),
    accounts: { ...accountStats, conversionRate, recent: recentAccounts },
    billing: billingStats,
    support,
    trends: businessTrends(accountList, charges),
  });
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
  stats: adminStats,
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
