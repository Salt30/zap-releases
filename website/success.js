(() => {
  const status = document.getElementById("purchase-status");
  const title = document.getElementById("purchase-title");
  const copy = document.getElementById("purchase-copy");
  const activate = document.getElementById("activate-app");
  window.history.replaceState({}, "", "/success");
  status.textContent = "Payment complete";
  title.textContent = "You're ready.";
  copy.textContent = "Continue to your account to download Drip Type and connect your subscription.";
  activate.href = "/account?purchase=complete";
  activate.textContent = "Continue to account";
  activate.hidden = false;
})();
