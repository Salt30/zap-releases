(() => {
  const buttons = [...document.querySelectorAll("[data-checkout-plan]")];
  const dialog = document.getElementById("checkout-dialog");
  const form = document.getElementById("checkout-form");
  const email = document.getElementById("checkout-email");
  const title = document.getElementById("checkout-title");
  const summary = document.getElementById("checkout-summary");
  const error = document.getElementById("checkout-error");
  const submit = document.getElementById("checkout-submit");
  const close = document.getElementById("checkout-close");
  if (!buttons.length || !dialog || !form || !email) return;

  const plans = Object.freeze({
    core: { name: "Core", price: "$9.99/month" },
    pro: { name: "Pro", price: "$25/month" },
  });
  let selectedPlan = "";
  let trigger = null;
  const memoryNonces = new Map();

  function nonce(plan) {
    const key = `drip_checkout_nonce_${plan}`;
    let value = memoryNonces.get(key);
    try { value = sessionStorage.getItem(key) || value; } catch { /* Storage can be unavailable in private browsing. */ }
    if (!/^[a-f0-9-]{36}$/u.test(value || "")) {
      value = crypto.randomUUID();
      memoryNonces.set(key, value);
      try { sessionStorage.setItem(key, value); } catch { /* Keep retry protection in this page's memory. */ }
    }
    return value;
  }

  function open(plan, button) {
    selectedPlan = plan;
    trigger = button;
    const selected = plans[plan];
    title.textContent = `Get Zap ${selected.name}`;
    summary.querySelector("span").textContent = selected.name;
    summary.querySelector("strong").textContent = selected.price;
    error.textContent = "";
    submit.textContent = "Continue to secure payment";
    submit.disabled = false;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => email.focus());
  }

  function dismiss() {
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    trigger?.focus();
  }

  async function configure() {
    try {
      const response = await fetch("/api/checkout-config", { headers: { Accept: "application/json" } });
      const config = await response.json();
      buttons.forEach((button) => {
        const plan = button.dataset.checkoutPlan;
        const enabled = Boolean(config.plans?.[plan]);
        button.textContent = enabled ? `Get ${plans[plan].name}` : "Launching soon";
        button.disabled = !enabled;
      });
    } catch {
      buttons.forEach((button) => {
        button.textContent = "Launching soon";
        button.disabled = true;
      });
    }
  }

  buttons.forEach((button) => button.addEventListener("click", () => {
    if (!button.disabled) open(button.dataset.checkoutPlan, button);
  }));
  close.addEventListener("click", dismiss);
  dialog.addEventListener("close", () => trigger?.focus());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dismiss();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    error.textContent = "";
    submit.disabled = true;
    submit.textContent = "Opening Stripe…";
    try {
      const response = await fetch("/api/create-checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: selectedPlan,
          email: email.value.trim().toLowerCase(),
          checkoutNonce: nonce(selectedPlan),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Secure payment could not be opened.");
      if (result.kind === "account" && /^\/account\?/.test(result.url || "")) {
        window.location.assign(result.url);
        return;
      }
      if (result.kind !== "checkout" || !/^https:\/\/checkout\.stripe\.com\//.test(result.url || "")) {
        throw new Error("The secure payment URL was rejected.");
      }
      window.location.assign(result.url);
    } catch (caught) {
      error.textContent = caught.message || "Secure payment could not be opened.";
      submit.disabled = false;
      submit.textContent = "Continue to secure payment";
    }
  });

  configure();
})();
