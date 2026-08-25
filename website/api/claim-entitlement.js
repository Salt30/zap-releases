module.exports = function claimEntitlement(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(410).json({
    error: "Session-link activation has been retired. Sign in at tryzap.net/account to connect Drip Type securely.",
  });
};
