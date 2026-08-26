(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const requestedPlan = ["core", "pro"].includes(params.get("plan")) ? params.get("plan") : "";
  const requestedDevice = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(params.get("connect_device") || "")
    ? params.get("connect_device") : "";
  let mode = params.get("mode") === "signup" ? "signup" : "signin";
  let accountStatus = null;

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
    $("auth-title").textContent = signup ? "Create your account." : "Welcome back.";
    $("auth-copy").textContent = signup
      ? "Create one private Zap account, then website purchases connect directly to Drip Type."
      : "Sign in before checkout so your purchase appears in Drip Type.";
    $("auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("password").autocomplete = signup ? "new-password" : "current-password";
    $("strength").hidden = !signup;
    $("auth-error").textContent = "";
  }

  function passwordScore(value) {
    if (value.length < 6) return 0;
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
    $("recovery-card").hidden = false;
  }

  async function renderDashboard() {
    show("dashboard");
    $("dashboard-error").textContent = "";
    try {
      accountStatus = await api("/api/account-status");
      $("account-email").textContent = accountStatus.email || "Zap account";
      const subscription = accountStatus.subscription;
      const active = subscription && ["active", "trialing"].includes(subscription.status);
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
        $("subscription-copy").textContent = "Choose Core or Pro. Your account prevents accidental duplicate subscriptions.";
      }
      $("plan-actions").hidden = Boolean(subscription);
      $("manage-actions").hidden = !subscription;
      $("connect-card").hidden = !(requestedDevice && active);
      if (requestedPlan && !subscription) {
        $("plan-message").textContent = `Continue with ${requestedPlan === "pro" ? "Pro" : "Core"}. Stripe shows the exact renewal price before you confirm.`;
      }
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
    if (!email || password.length < 6 || (mode === "signup" && passwordScore(password) < 2)) {
      $("auth-error").textContent = "Enter a valid email and a password with 6+ characters using a mix of letters, numbers, or symbols.";
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
      setMode(mode);
    }
  });

  $("sign-in-tab").addEventListener("click", () => setMode("signin"));
  $("sign-up-tab").addEventListener("click", () => setMode("signup"));
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
      $("reset-error").textContent = "Enter the account email, complete recovery code, and a 6+ character password using a mix of letters, numbers, or symbols.";
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
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    $("recovery-card").hidden = true;
    setMode("signin");
    show("auth-card");
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
  });

  async function openCheckout(plan, button) {
    $("dashboard-error").textContent = "";
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Opening secure checkout…";
    try {
      const result = await api("/api/create-checkout", { method: "POST", body: JSON.stringify({ plan }) });
      if (!/^https:\/\/(?:checkout|billing)\.stripe\.com\//.test(result.url || "")) throw new Error("The billing URL was rejected.");
      window.location.assign(result.url);
    } catch (error) {
      $("dashboard-error").textContent = message(error);
      button.disabled = false;
      button.textContent = original;
    }
  }
  document.querySelectorAll("[data-account-plan]").forEach((button) => {
    button.addEventListener("click", () => openCheckout(button.dataset.accountPlan, button));
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
        body: JSON.stringify({ deviceId: requestedDevice }),
      });
      if (!/^driptype:\/\/account\?token=/.test(result.url || "")) throw new Error("The app connection URL was rejected.");
      window.location.assign(result.url);
      button.textContent = "Connection sent to Drip Type";
    } catch (error) {
      $("dashboard-error").textContent = message(error);
      button.disabled = false;
      button.textContent = "Connect app";
    }
  });

  async function boot() {
    try {
      const config = await api("/api/account-config");
      if (!config.configured || config.passwordMinLength !== 6) throw new Error("Accounts are not configured.");
      await renderDashboard();
    } catch (error) {
      show("account-unavailable");
      $("account-unavailable").querySelector("p").textContent = message(error);
    }
  }
  updateStrength("password", "strength-meter", "strength-label");
  updateStrength("reset-password", "reset-strength-meter", "reset-strength-label");
  boot();
})();
