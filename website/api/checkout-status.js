module.exports = function checkoutStatus(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(410).json({
    error: "Public checkout-session lookup has been retired. Subscription status is available only inside the signed-in account.",
  });
};
