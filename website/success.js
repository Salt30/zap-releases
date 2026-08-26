(() => {
  const status = document.getElementById("purchase-status");
  const title = document.getElementById("purchase-title");
  const copy = document.getElementById("purchase-copy");
  const activate = document.getElementById("activate-app");
  const download = document.getElementById("download-app");
  window.history.replaceState({}, "", "/success");
  const windows = /Windows/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "");
  if (windows) {
    download.href = "https://drip-type-updates.vercel.app/Drip-Type-1.7.3-windows.exe";
    download.textContent = "Download for Windows";
  }

  status.textContent = "Checkout returned securely";
  title.textContent = "Finish in your Zap account.";
  copy.textContent = "Your signed-in account verifies subscription status directly. No checkout-session identifier is kept in this page, browser history, or app activation link.";
  activate.href = "/account?purchase=complete";
  activate.textContent = "Open secure account";
  activate.hidden = false;
  download.hidden = false;
})();
