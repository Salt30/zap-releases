(() => {
  const buttons = [...document.querySelectorAll("[data-checkout-plan]")];
  if (!buttons.length) return;

  const setError = (button, message = "") => {
    let error = button.parentElement.querySelector(".checkout-error");
    if (!error) {
      error = document.createElement("p");
      error.className = "checkout-error";
      error.setAttribute("role", "status");
      button.parentElement.appendChild(error);
    }
    error.textContent = message;
  };

  const configure = async () => {
    try {
      const response = await fetch("/api/checkout-config", {
        headers: { Accept: "application/json" },
      });
      const config = await response.json();
      buttons.forEach((button) => {
        const plan = button.dataset.checkoutPlan;
        const label = button.dataset.checkoutPlan === "core" ? "Start Core" : "Start Pro";
        const enabled = Boolean(config.plans?.[plan]);
        button.textContent = enabled ? label : "Launching soon";
        button.disabled = !enabled;
      });
    } catch {
      buttons.forEach((button) => {
        button.textContent = "Launching soon";
        button.disabled = true;
      });
    }
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      setError(button);
      window.location.assign(`/account?mode=signup&plan=${encodeURIComponent(button.dataset.checkoutPlan)}`);
    });
  });

  configure();
})();
