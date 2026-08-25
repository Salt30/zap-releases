const { createClerkClient } = require("@clerk/backend");

const AUTHORIZED_PARTIES = Object.freeze([
  "https://tryzap.net",
  "https://www.tryzap.net",
  "https://drip-type.vercel.app",
]);

function configured() {
  return /^pk_(?:test|live)_[A-Za-z0-9_-]+$/.test(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "") &&
    /^sk_(?:test|live)_[A-Za-z0-9_-]+$/.test(process.env.CLERK_SECRET_KEY || "");
}

function clerkClient() {
  if (!configured()) throw new Error("Account service is not configured");
  return createClerkClient({
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });
}

function requestUrl(request) {
  const host = String(request.headers?.host || "tryzap.net").toLowerCase();
  const allowedHosts = new Set(["tryzap.net", "www.tryzap.net", "drip-type.vercel.app"]);
  const origin = allowedHosts.has(host) ? `https://${host}` : "https://tryzap.net";
  return new URL(String(request.url || "/"), origin).toString();
}

function webRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, String(item)));
    else if (value !== undefined) headers.set(name, String(value));
  }
  return new Request(requestUrl(request), { method: request.method || "GET", headers });
}

async function authenticatedUser(request) {
  const client = clerkClient();
  const state = await client.authenticateRequest(webRequest(request), {
    acceptsToken: "session_token",
    authorizedParties: AUTHORIZED_PARTIES,
  });
  if (!state.isAuthenticated) return null;
  const auth = state.toAuth();
  if (!/^user_[A-Za-z0-9]+$/.test(String(auth.userId || ""))) return null;
  const user = await client.users.getUser(auth.userId);
  const primary = user.emailAddresses?.find((entry) => entry.id === user.primaryEmailAddressId);
  const email = String(primary?.emailAddress || "").trim().toLowerCase();
  if (!email || primary?.verification?.status !== "verified") return null;
  return { client, user, userId: user.id, email };
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
    console.error("Account authentication failed", { code: error.code || "auth_failed" });
    response.status(401).json({ error: "Your sign-in could not be verified. Please sign in again." });
    return null;
  }
}

module.exports = {
  AUTHORIZED_PARTIES,
  authenticatedUser,
  clerkClient,
  configured,
  requireUser,
};
