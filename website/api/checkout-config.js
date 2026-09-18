const billing = require("./_billing");
const auth = require("./_auth");

module.exports = function checkoutConfig(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method && request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!billing.hasExactKeys(request.query || {}, [])) {
    return response.status(400).json({ error: "Unexpected query parameters" });
  }
  const hasSecret = /^(?:rk|sk)_live_[A-Za-z0-9]+$/.test(process.env.STRIPE_SECRET_KEY || "");
  const hasSigningKey = /^[A-Za-z0-9+/=]{40,200}$/.test(process.env.ENTITLEMENT_PRIVATE_KEY || "");
  const hasCorePrice = /^price_[A-Za-z0-9]+$/.test(process.env.STRIPE_CORE_PRICE_ID || "");
  const hasProPrice = /^price_[A-Za-z0-9]+$/.test(process.env.STRIPE_PRO_PRICE_ID || "");
  response.status(200).json({
    plans: {
      core: auth.configured() && hasSecret && hasSigningKey && hasCorePrice && process.env.STRIPE_CORE_CHECKOUT_ENABLED === "true",
      pro: false,
    },
  });
};
