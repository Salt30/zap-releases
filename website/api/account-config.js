const auth = require("./_auth");
const billing = require("./_billing");

module.exports = function accountConfig(request, response) {
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
};
