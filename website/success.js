(() => {
  const status = document.getElementById("purchase-status");
  const title = document.getElementById("purchase-title");
  const copy = document.getElementById("purchase-copy");
  const activate = document.getElementById("activate-app");
  const download = document.getElementById("download-app");
  const sessionId = new URLSearchParams(window.location.search).get("session_id") || "";

  const fail = (message) => {
    status.textContent = "Verification needed";
    title.textContent = "We couldn’t verify this checkout.";
    copy.textContent = message;
    activate.hidden = true;
  };

  if (!/^cs_live_[A-Za-z0-9_]{20,}$/.test(sessionId)) {
    fail("Return to the Stripe receipt or contact support before trying again.");
    return;
  }

  fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { Accept: "application/json" },
  })
    .then(async (response) => ({ response, result: await response.json() }))
    .then(({ response, result }) => {
      if (!response.ok || !result.confirmed) throw new Error("Checkout was not confirmed.");
      const plan = result.plan === "pro" ? "Pro" : "Core";
      status.textContent = "Payment confirmed";
      title.textContent = `${plan} is ready.`;
      copy.textContent = "Open Drip Type on this Mac to activate your subscription. Your payment details stay with Stripe.";
      activate.href = `driptype://activate?session_id=${encodeURIComponent(sessionId)}`;
      activate.hidden = false;
      download.hidden = false;
    })
    .catch(() => fail("Your payment may still be processing. Refresh this page in a moment or contact support."));
})();
