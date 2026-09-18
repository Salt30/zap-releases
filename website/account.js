(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  let requestedPlan = "";
  const purchaseSession = /^cs_live_[A-Za-z0-9_]+$/.test(params.get("session_id") || "")
    ? params.get("session_id") : "";
  const requestedDevice = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(params.get("connect_device") || "")
    ? params.get("connect_device") : "";
  const purchaseComplete = params.get("purchase") === "complete" && Boolean(purchaseSession);
  const connectionState = /^[A-Za-z0-9_-]{43}$/.test(params.get('connect_state') || '') ? params.get('connect_state') : '';
  const connectionChallenge = /^[A-Za-z0-9_-]{43}$/.test(params.get('connect_challenge') || '') ? params.get('connect_challenge') : '';
  const existingBilling = params.get("billing") === "existing";
  let mode = params.get("mode") === "signin"
    ? "signin"
    : purchaseComplete ? "signup" : "signin";
  let accountStatus = null;
  let sessionRevision = 0;
  let purchaseClaimed = false;

  const plans = Object.freeze({
    core: { name: "Core", price: "$9.99/month" },
    pro: { name: "Pro", price: "$25/month" },
  });

  function setFlowStep(step) {
    document.querySelectorAll(".flow-steps li").forEach((item, index) => {
      item.classList.toggle("active", index + 1 === step);
    });
  }

  function show(id) {
    ["account-loading", "auth-card", "dashboard", "account-unavailable"].forEach((candidate) => {
      $(candidate).hidden = candidate !== id;
    });
  }

  function message(error) {
    return error?.message || "Something went wrong. Please try again.";
  }

  function setMode(nextMode) {
    mode = nextMode;
    const signup = mode === "signup";
    $("sign-in-tab").classList.toggle("active", !signup);
    $("sign-up-tab").classList.toggle("active", signup);
    $("sign-in-tab").setAttribute("aria-selected", String(!signup));
    $("sign-up-tab").setAttribute("aria-selected", String(signup));
    $("sign-in-tab").tabIndex = signup ? -1 : 0;
    $("sign-up-tab").tabIndex = signup ? 0 : -1;
    $("auth-title").textContent = signup
      ? purchaseComplete ? "Payment complete. Create your account." : "Create your account."
      : "Sign in.";
    $("auth-copy").textContent = signup
      ? purchaseComplete ? "Set a password, then your paid access activates automatically." : "Your account connects your purchase to Zap."
      : existingBilling ? "A subscription already exists for this email. Sign in so you are not charged twice." : "Use the account connected to your Zap purchase.";
    $("auth-submit").textContent = signup
      ? purchaseComplete ? "Create account and activate" : "Create account"
      : purchaseComplete ? "Sign in and activate" : "Sign in";
    $("password").autocomplete = signup ? "new-password" : "current-password";
    $("password").minLength = signup ? 12 : 1;
    $("password").placeholder = signup ? "12+ characters" : "Your password";
    $("strength").hidden = !signup;
    $("auth-error").textContent = "";
    $("auth-step").textContent = purchaseComplete ? "Step 2 of 3" : "Account access";
    setFlowStep(purchaseComplete ? 2 : 1);
  }

  function passwordScore(value) {
    if (value.length < 12) return 0;
    if (/^(password|qwerty|123456|letmein|abcdef|driptype|tryzap)/i.test(value) || /(.)\1{4}/.test(value)) return 0;
    let score = 1;
    const characterGroups = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
      .filter((pattern) => pattern.test(value)).length;
    if (value.length >= 8) score += 1;
    if (characterGroups >= 2) score += 1;
    if (value.length >= 12 || characterGroups >= 3) score += 1;
    return Math.min(4, score);
  }

  function updateStrength(inputId, meterId, labelId) {
    const score = passwordScore($(inputId).value);
    $(meterId).value = score;
    $(labelId).textContent = ["Too short", "Weak", "Fair", "Good", "Strong"][score];
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "The request failed.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function displayRecovery(code) {
    $("recovery-code-output").textContent = code;
    $("copy-recovery").textContent = "Copy backup code";
    $("dismiss-recovery").textContent = purchaseComplete ? "I've saved it — continue to download" : "I've saved it";
    $("recovery-card").hidden = false;
    $("plan-actions").hidden = true;
    $("purchase-card").hidden = true;
    setFlowStep(purchaseComplete ? 3 : 2);
  }

  async function claimPurchase() {
    if (!purchaseSession || purchaseClaimed) return;
    const result = await api("/api/claim-purchase", {
      method: "POST",
      body: JSON.stringify({ sessionId: purchaseSession }),
    });
    if (!result.claimed || !["core", "pro"].includes(result.plan)) {
      throw new Error("Your payment could not be connected to this account.");
    }
    requestedPlan = result.plan;
    purchaseClaimed = true;
    window.history.replaceState({}, "", "/account?purchase=complete");
  }

  async function renderDashboard() {
    const revision = sessionRevision;
    show("dashboard");
    $("dashboard-error").textContent = "";
    try {
      if (purchaseSession && !purchaseClaimed) await claimPurchase();
      const nextStatus = await api("/api/account-status");
      if (revision !== sessionRevision) return;
      accountStatus = nextStatus;
      $("account-email").textContent = accountStatus.email || "Zap account";
      const subscription = accountStatus.subscription;
      const active = subscription?.status === "active";
      $("subscription-dot").classList.toggle("active", Boolean(active));
      if (active) {
        const name = subscription.plan === "pro" ? "Pro" : "Core";
        $("subscription-title").textContent = `${name} is active`;
        $("subscription-copy").textContent = subscription.cancelAtPeriodEnd
          ? "Canceled for renewal; access continues through the paid period."
          : "Billing and app access are connected to this account.";
      } else if (subscription) {
        $("subscription-title").textContent = "Billing attention needed";
        $("subscription-copy").textContent = `Status: ${String(subscription.status).replace(/_/g, " ")}. Open billing management before starting another checkout.`;
      } else {
        $("subscription-title").textContent = "No paid subscription yet";
        $("subscription-copy").textContent = "Choose a plan and pay first. Then return here to connect the purchase.";
      }
      $("purchase-card").hidden = !active || Boolean(requestedDevice);
      $("plan-actions").hidden = Boolean(subscription) || !$("recovery-card").hidden;
      $("manage-actions").hidden = !subscription;
      $("connect-card").hidden = !(requestedDevice && active);
      if (active) {
        $("purchase-title").textContent = purchaseComplete ? "Payment complete." : "Download Zap.";
        $("purchase-copy").textContent = "Install Zap, open Billing in the app, and choose Sign in.";
      }
      setFlowStep(active ? 3 : purchaseComplete ? 2 : 1);
    } catch (error) {
      if (error.status === 401) {
        setMode(mode);
        show("auth-card");
      } else {
        $("dashboard-error").textContent = message(error);
      }
    }
  }

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    const password = $("password").value;
    $("auth-error").textContent = "";
    if (!email || !password || (mode === "signup" && (password.length < 12 || passwordScore(password) < 2))) {
      $("auth-error").textContent = "Enter a valid email and a password with 12+ characters using a mix of letters, numbers, or symbols.";
      return;
    }
    const button = $("auth-submit");
    button.disabled = true;
    button.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
    try {
      const result = await api(mode === "signup" ? "/api/register" : "/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      $("password").value = "";
      await renderDashboard();
      if (result.recoveryCode) displayRecovery(result.recoveryCode);
    } catch (error) {
      $("auth-error").textContent = message(error);
    } finally {
      button.disabled = false;
      button.textContent = mode === "signup"
        ? purchaseComplete ? "Create account and activate" : "Create account"
        : purchaseComplete ? "Sign in and activate" : "Sign in";
    }
  });

  $("sign-in-tab").addEventListener("click", () => setMode("signin"));
  $("sign-up-tab").addEventListener("click", () => {
    if (purchaseComplete) setMode("signup");
  });
  const accountTabs = [$("sign-in-tab"), $("sign-up-tab")];
  accountTabs.forEach((tab, index) => tab.addEventListener("keydown", (event) => {
    const next = event.key === "ArrowRight" ? (index + 1) % accountTabs.length
      : event.key === "ArrowLeft" ? (index - 1 + accountTabs.length) % accountTabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? accountTabs.length - 1 : -1;
    if (next < 0) return;
    if (!purchaseComplete && next === 1) return;
    event.preventDefault();
    setMode(next === 0 ? "signin" : "signup");
    accountTabs[next].focus();
  }));
  $("password").addEventListener("input", () => updateStrength("password", "strength-meter", "strength-label"));
  $("toggle-password").addEventListener("click", () => {
    const visible = $("password").type === "text";
    $("password").type = visible ? "password" : "text";
    $("toggle-password").textContent = visible ? "Show" : "Hide";
    $("toggle-password").setAttribute("aria-label", visible ? "Show password" : "Hide password");
  });

  $("forgot-password").addEventListener("click", () => {
    $("auth-form").hidden = true;
    $("reset-form").hidden = false;
    $("sign-in-tab").disabled = true;
    $("sign-up-tab").disabled = true;
    $("reset-email").value = $("email").value.trim().toLowerCase();
    $("reset-error").textContent = "";
    $("reset-code").focus();
  });

  $("cancel-reset").addEventListener("click", () => {
    $("reset-form").hidden = true;
    $("auth-form").hidden = false;
    $("sign-in-tab").disabled = false;
    $("sign-up-tab").disabled = false;
    setMode("signin");
  });

  $("reset-password").addEventListener("input", () => updateStrength("reset-password", "reset-strength-meter", "reset-strength-label"));
  $("toggle-reset-password").addEventListener("click", () => {
    const visible = $("reset-password").type === "text";
    $("reset-password").type = visible ? "password" : "text";
    $("toggle-reset-password").textContent = visible ? "Show" : "Hide";
    $("toggle-reset-password").setAttribute("aria-label", visible ? "Show new password" : "Hide new password");
  });

  $("reset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("reset-email").value.trim().toLowerCase();
    const recoveryCode = $("reset-code").value.trim();
    const password = $("reset-password").value;
    $("reset-error").textContent = "";
    if (!email || !/^ZAP-[A-Za-z0-9_-]{32}$/.test(recoveryCode) || passwordScore(password) < 2) {
      $("reset-error").textContent = "Enter the account email, complete recovery code, and a 12+ character password using a mix of letters, numbers, or symbols.";
      return;
    }
    const button = $("reset-submit");
    button.disabled = true;
    try {
      const result = await api("/api/recover-account", {
        method: "POST",
        body: JSON.stringify({ email, recoveryCode, password }),
      });
      $("reset-code").value = "";
      $("reset-password").value = "";
      await renderDashboard();
      displayRecovery(result.recoveryCode);
    } catch (error) {
      $("reset-error").textContent = message(error);
    } finally {
      button.disabled = false;
    }
  });

  $("sign-out").addEventListener("click", async () => {
    sessionRevision++;
    $('sign-out').disabled = true;
    try { await api("/api/logout", { method: "POST", body: "{}" }); }
    catch { $('dashboard-error').textContent = 'Sign-out could not be confirmed. Check your connection and try again.'; $('sign-out').disabled = false; return; }
    accountStatus = null;
    $('account-email').textContent = '';
    $('password').value = ''; $('reset-password').value = ''; $('reset-code').value = '';
    $('recovery-code-output').textContent = '';
    $("recovery-card").hidden = true;
    setMode("signin");
    show("auth-card");
    $('sign-out').disabled = false;
  });

  $("copy-recovery").addEventListener("click", async () => {
    const code = $("recovery-code-output").textContent;
    try {
      await navigator.clipboard.writeText(code);
      $("copy-recovery").textContent = "Copied";
    } catch {
      $("copy-recovery").textContent = "Select and copy the code above";
    }
  });
  $("dismiss-recovery").addEventListener("click", () => {
    $("recovery-code-output").textContent = "";
    $("recovery-card").hidden = true;
    renderDashboard();
  });
  $("manage-billing").addEventListener("click", async () => {
    const button = $("manage-billing");
    button.disabled = true;
    try {
      const result = await api("/api/create-account-portal", { method: "POST", body: "{}" });
      if (!/^https:\/\/billing\.stripe\.com\//.test(result.url || "")) throw new Error("The billing URL was rejected.");
      window.location.assign(result.url);
    } catch (error) {
      $("dashboard-error").textContent = message(error);
      button.disabled = false;
    }
  });
  $("connect-app").addEventListener("click", async () => {
    const button = $("connect-app");
    button.disabled = true;
    button.textContent = "Creating secure link…";
    try {
      const result = await api("/api/create-app-activation", {
        method: "POST",
        body: JSON.stringify({ deviceId: requestedDevice, ...(connectionState && connectionChallenge ? { state: connectionState, challenge: connectionChallenge } : {}) }),
      });
      if (!/^driptype:\/\/account\?token=/.test(result.url || "")) throw new Error("The app connection URL was rejected.");
      window.location.assign(result.url);
      button.textContent = "Connection sent to Zap";
    } catch (error) {
      $("dashboard-error").textContent = message(error);
      button.disabled = false;
      button.textContent = "Connect app";
    }
  });

  async function boot() {
    try {
      const windows = /Windows/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "");
      if (windows) {
        $("download-app").href = "https://drip-type-updates.vercel.app/Drip-Type-1.7.4-windows.exe";
        $("download-app").textContent = "Download for Windows";
      }
      const config = await api("/api/account-config");
      if (!config.configured) throw new Error("Accounts are not configured.");
      if (purchaseComplete) {
        const purchase = await api(`/api/checkout-status?session_id=${encodeURIComponent(purchaseSession)}`);
        if (!purchase.paid || !plans[purchase.plan]) throw new Error("Payment could not be verified.");
        requestedPlan = purchase.plan;
        $("email").value = purchase.email;
        $("email").readOnly = true;
        $("auth-plan-name").textContent = plans[requestedPlan].name;
        $("auth-plan-price").textContent = plans[requestedPlan].price;
        $("auth-plan").hidden = false;
        setMode(mode);
      } else {
        $("sign-up-tab").hidden = true;
        $("sign-in-tab").classList.add("only-tab");
      }
      await renderDashboard();
    } catch (error) {
      show("account-unavailable");
      $("account-unavailable").querySelector("p").textContent = message(error);
    }
  }
  updateStrength("password", "strength-meter", "strength-label");
  updateStrength("reset-password", "reset-strength-meter", "reset-strength-label");
  setMode(mode);
  boot();
})();
