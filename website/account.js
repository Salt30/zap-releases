(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const requestedPlan = ["core", "pro"].includes(params.get("plan")) ? params.get("plan") : "";
  const requestedDevice = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(params.get("connect_device") || "")
    ? params.get("connect_device") : "";
  let mode = params.get("mode") === "signup" ? "signup" : "signin";
  let pendingSignUp = null;
  let pendingPasswordReset = null;
  let resetStep = "code";
  let accountStatus = null;

  function show(id) {
    ["account-loading", "auth-card", "dashboard", "account-unavailable"].forEach((candidate) => {
      $(candidate).hidden = candidate !== id;
    });
  }

  function message(error) {
    const first = error?.errors?.[0] || error?.clerkError?.errors?.[0];
    return first?.longMessage || first?.message || error?.message || "Something went wrong. Please try again.";
  }

  function frontendDomain(key) {
    const encoded = key.replace(/^pk_(?:test|live)_/, "");
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const decoded = atob(padded).replace(/\$$/, "");
    if (!/^[a-z0-9.-]+$/i.test(decoded)) throw new Error("Invalid account configuration");
    return decoded;
  }

  function loadClerk(publishableKey) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.dataset.clerkPublishableKey = publishableKey;
      script.src = `https://${frontendDomain(publishableKey)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error("The account service could not be loaded."));
      document.head.appendChild(script);
    });
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
      ? "Verify your email once, then website purchases connect directly to Drip Type."
      : "Sign in before checkout so your purchase appears in Drip Type.";
    $("auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("password").autocomplete = signup ? "new-password" : "current-password";
    $("strength").hidden = !signup;
    $("auth-error").textContent = "";
  }

  function passwordScore(value) {
    if (value.length < 6) return 0;
    let score = 1;
    if (value.length >= 10) score += 1;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) score += 1;
    if (value.length >= 14 || /[^A-Za-z0-9]/.test(value)) score += 1;
    if (/^(password|qwerty|123456|letmein|abcdef|driptype)/i.test(value) || /(.)\1{4}/.test(value)) score = Math.min(score, 1);
    return Math.min(4, score);
  }

  function updateStrength() {
    const score = passwordScore($("password").value);
    const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
    $("strength-meter").value = score;
    $("strength-label").textContent = labels[score];
  }

  function updateResetStrength() {
    const score = passwordScore($("reset-password").value);
    const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
    $("reset-strength-meter").value = score;
    $("reset-strength-label").textContent = labels[score];
  }

  function showPrimaryAuth() {
    pendingPasswordReset = null;
    resetStep = "code";
    $("verify-form").hidden = true;
    $("reset-form").hidden = true;
    $("auth-form").hidden = false;
    $("sign-in-tab").disabled = false;
    $("sign-up-tab").disabled = false;
    $("reset-error").textContent = "";
    setMode("signin");
  }

  function renderResetStep() {
    const passwordStep = resetStep === "password";
    $("reset-code-step").hidden = passwordStep;
    $("reset-password-step").hidden = !passwordStep;
    $("reset-submit").textContent = passwordStep ? "Set new password" : "Verify reset code";
    $(passwordStep ? "reset-password" : "reset-code").focus();
  }

  async function token() {
    return window.Clerk?.session ? window.Clerk.session.getToken() : null;
  }

  async function api(path, options = {}) {
    const sessionToken = await token();
    const response = await fetch(path, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "The request failed.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function renderDashboard() {
    show("dashboard");
    $("account-email").textContent = window.Clerk.user?.primaryEmailAddress?.emailAddress || "Zap account";
    $("dashboard-error").textContent = "";
    try {
      accountStatus = await api("/api/account-status");
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
        $("subscription-copy").textContent = "Choose Core or Pro. Your account will prevent accidental duplicate subscriptions.";
      }
      $("plan-actions").hidden = Boolean(subscription);
      $("manage-actions").hidden = !subscription;
      $("connect-card").hidden = !(requestedDevice && active);
      if (requestedPlan && !subscription) {
        $("plan-message").textContent = `Continue with ${requestedPlan === "pro" ? "Pro" : "Core"}. Stripe shows the exact renewal price before you confirm.`;
      }
    } catch (error) {
      $("dashboard-error").textContent = message(error);
    }
  }

  async function finishSession(sessionId) {
    if (!sessionId) throw new Error("The account session could not be started.");
    await window.Clerk.setActive({ session: sessionId });
    await renderDashboard();
  }

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const emailAddress = $("email").value.trim().toLowerCase();
    const password = $("password").value;
    $("auth-error").textContent = "";
    if (!emailAddress || password.length < 6) {
      $("auth-error").textContent = "Enter a valid email and a password with at least 6 characters.";
      return;
    }
    const button = $("auth-submit");
    button.disabled = true;
    button.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
    try {
      if (mode === "signup") {
        pendingSignUp = await window.Clerk.client.signUp.create({ emailAddress, password });
        if (pendingSignUp.status === "complete") {
          await finishSession(pendingSignUp.createdSessionId);
        } else {
          pendingSignUp = await pendingSignUp.prepareEmailAddressVerification({ strategy: "email_code" });
          $("auth-form").hidden = true;
          $("sign-in-tab").disabled = true;
          $("sign-up-tab").disabled = true;
          $("verify-form").hidden = false;
          $("verification-code").focus();
        }
      } else {
        const signIn = await window.Clerk.client.signIn.create({ identifier: emailAddress, password });
        if (signIn.status !== "complete") throw new Error("Additional verification is required. Please follow the account prompt and try again.");
        await finishSession(signIn.createdSessionId);
      }
    } catch (error) {
      $("auth-error").textContent = message(error);
    } finally {
      button.disabled = false;
      setMode(mode);
    }
  });

  $("verify-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("verify-error").textContent = "";
    try {
      pendingSignUp = await pendingSignUp.attemptEmailAddressVerification({ code: $("verification-code").value.trim() });
      if (pendingSignUp.status !== "complete") throw new Error("That code did not complete verification.");
      await finishSession(pendingSignUp.createdSessionId);
    } catch (error) {
      $("verify-error").textContent = message(error);
    }
  });

  $("restart-auth").addEventListener("click", () => {
    pendingSignUp = null;
    showPrimaryAuth();
  });
  $("sign-in-tab").addEventListener("click", () => setMode("signin"));
  $("sign-up-tab").addEventListener("click", () => setMode("signup"));
  $("password").addEventListener("input", updateStrength);
  $("toggle-password").addEventListener("click", () => {
    const visible = $("password").type === "text";
    $("password").type = visible ? "password" : "text";
    $("toggle-password").textContent = visible ? "Show" : "Hide";
    $("toggle-password").setAttribute("aria-label", visible ? "Show password" : "Hide password");
  });
  $("forgot-password").addEventListener("click", async () => {
    const emailAddress = $("email").value.trim().toLowerCase();
    $("auth-error").textContent = "";
    if (!emailAddress || !$("email").checkValidity()) {
      $("auth-error").textContent = "Enter the email address for your Zap account first.";
      $("email").focus();
      return;
    }
    const button = $("forgot-password");
    button.disabled = true;
    button.textContent = "Sending reset code…";
    try {
      pendingPasswordReset = await window.Clerk.client.signIn.create({
        strategy: "reset_password_email_code",
        identifier: emailAddress,
      });
      resetStep = "code";
      $("auth-form").hidden = true;
      $("verify-form").hidden = true;
      $("reset-form").hidden = false;
      $("sign-in-tab").disabled = true;
      $("sign-up-tab").disabled = true;
      renderResetStep();
    } catch (error) {
      $("auth-error").textContent = message(error);
    } finally {
      button.disabled = false;
      button.textContent = "Forgot password?";
    }
  });
  $("reset-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("reset-error").textContent = "";
    const button = $("reset-submit");
    button.disabled = true;
    try {
      if (!pendingPasswordReset) throw new Error("Start the password reset again.");
      if (resetStep === "code") {
        const code = $("reset-code").value.trim();
        if (!/^\d{4,8}$/.test(code)) throw new Error("Enter the reset code from your email.");
        pendingPasswordReset = await pendingPasswordReset.attemptFirstFactor({
          strategy: "reset_password_email_code",
          code,
        });
        resetStep = "password";
        renderResetStep();
      } else {
        const password = $("reset-password").value;
        if (password.length < 6) throw new Error("Use a password with at least 6 characters.");
        pendingPasswordReset = await pendingPasswordReset.resetPassword({ password });
        if (pendingPasswordReset.status !== "complete") {
          throw new Error("Additional verification is required before the password can be changed.");
        }
        await finishSession(pendingPasswordReset.createdSessionId);
      }
    } catch (error) {
      $("reset-error").textContent = message(error);
    } finally {
      button.disabled = false;
    }
  });
  $("cancel-reset").addEventListener("click", showPrimaryAuth);
  $("reset-password").addEventListener("input", updateResetStrength);
  $("toggle-reset-password").addEventListener("click", () => {
    const visible = $("reset-password").type === "text";
    $("reset-password").type = visible ? "password" : "text";
    $("toggle-reset-password").textContent = visible ? "Show" : "Hide";
    $("toggle-reset-password").setAttribute("aria-label", visible ? "Show new password" : "Hide new password");
  });
  $("sign-out").addEventListener("click", async () => {
    await window.Clerk.signOut();
    setMode("signin");
    show("auth-card");
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
      const response = await fetch("/api/account-config", { headers: { Accept: "application/json" } });
      const config = await response.json();
      if (!response.ok || !config.configured || !config.publishableKey) {
        show("account-unavailable");
        return;
      }
      await loadClerk(config.publishableKey);
      await window.Clerk.load();
      if (window.Clerk.user) await renderDashboard();
      else {
        setMode(mode);
        show("auth-card");
      }
    } catch (error) {
      show("account-unavailable");
      $("account-unavailable").querySelector("p").textContent = message(error);
    }
  }
  updateStrength();
  updateResetStrength();
  boot();
})();
