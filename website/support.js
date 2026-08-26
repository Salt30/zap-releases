(() => {
  const form = document.getElementById("support-form");
  const status = document.getElementById("support-status");
  const button = document.getElementById("support-submit");
  if (!form || !status || !button) return;

  let startedAt = Date.now();
  let submissionId = crypto.randomUUID();
  let submitting = false;

  const setStatus = (message, state = "") => {
    status.textContent = message;
    status.dataset.state = state;
  };

  form.addEventListener("input", () => {
    if (!submitting) submissionId = crypto.randomUUID();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    const values = new FormData(form);
    const payload = {
      name: String(values.get("name") || ""),
      email: String(values.get("email") || ""),
      category: String(values.get("category") || ""),
      platform: String(values.get("platform") || ""),
      appVersion: String(values.get("appVersion") || ""),
      subject: String(values.get("subject") || ""),
      description: String(values.get("description") || ""),
      privacyAccepted: values.get("privacyAccepted") === "on",
      companyWebsite: String(values.get("companyWebsite") || ""),
      startedAt,
      submissionId,
    };

    submitting = true;
    button.disabled = true;
    button.textContent = "Submitting ticket…";
    setStatus("Sending your issue securely…", "pending");
    try {
      const response = await fetch("/api/support-ticket", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.ticketId) {
        throw new Error(result.error || "Your ticket could not be submitted.");
      }
      form.reset();
      startedAt = Date.now();
      submissionId = crypto.randomUUID();
      setStatus(`Ticket ${result.ticketId} is in. We’ll reply to the email you provided.`, "success");
      button.disabled = false;
      button.textContent = "Submit another ticket";
    } catch (error) {
      setStatus(error.message || "Your ticket could not be submitted. Please try again.", "error");
      button.disabled = false;
      button.textContent = "Submit ticket";
    } finally {
      submitting = false;
    }
  });
})();
